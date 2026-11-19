import type { SketchStylePreset, StrokeGenerationOptions } from '../../types/image-processing';
import { clamp, clamp01, smoothstep } from '../../utils/math';
import { computeCoherentLines } from './coherentLineDrawing';
import { computeEdgeTangentFlow } from './edgeTangentFlow';
import { bilateralSmooth, computePercentile, gaussianBlur, sampleBilinear } from './filters';
import { estimateSubjectMask, mapPencilToneField } from './pencilToneMapping';

export { gaussianBlur } from './filters';

export interface SketchTarget {
  width: number;
  height: number;
  grayscale: Float32Array;
  darkness: Float32Array;
  tone: Float32Array;
  detail: Float32Array;
  structuralEdge: Float32Array;
  foreground: Float32Array;
  tangent: Float32Array;
  tangentX: Float32Array;
  tangentY: Float32Array;
  coherence: Float32Array;
}

export function createSketchTargetPreview(target: SketchTarget): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(target.darkness.length);
  for (let i = 0; i < target.darkness.length; i++) {
    pixels[i] = Math.round((1 - clamp01(target.darkness[i])) * 255);
  }
  return pixels;
}

export function buildSketchTarget(
  imageData: ImageData,
  options?: Partial<StrokeGenerationOptions>
): SketchTarget {
  const { width, height, data } = imageData;
  const size = width * height;
  const scale = clamp(Math.max(width, height) / 768, 0.45, 1.6);

  const sensitivity = clamp01(options?.contourSensitivity ?? 0.58);
  const bgSuppression = clamp01(options?.backgroundSuppression ?? 0.6);
  const stylePreset: SketchStylePreset = options?.stylePreset ?? 'classic';

  const rawGray = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const p = i * 4;
    rawGray[i] = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) / 255;
  }

  const rawLow = computePercentile(rawGray, 0.01);
  const rawHigh = computePercentile(rawGray, 0.99);
  const rawSpan = rawHigh - rawLow;
  // Normal photos (rawSpan >= 0.14) get full [rawLow..rawHigh] auto-levels;
  // nearly flat synthetic sheets (e.g. 98%-white paper or 99%-black starfield where rawSpan < 0.08)
  // preserve physical luminance instead of stretching tiny differences across [0..1].
  const flatPreserve = 1 - smoothstep(0.05, 0.14, rawSpan);
  const dynamicRange = Math.max(0.08, rawSpan);
  const normalized = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const stretched = clamp01((rawGray[i] - rawLow) / dynamicRange);
    normalized[i] = stretched * (1 - flatPreserve) + rawGray[i] * flatPreserve;
  }

  const grayscale = bilateralSmooth(normalized, width, height, 1.4 * scale, 0.06);
  const etf = computeEdgeTangentFlow(grayscale, width, height, 2);
  const foreground = estimateSubjectMask(imageData, etf.gradientNorm);

  const fdogLines = computeCoherentLines(grayscale, width, height, etf, {
    sensitivity,
    scale,
  });

  // Single-ridge silhouette detector for low-contrast bright boundaries (shoulders, collars, pleats):
  // Requires both a gradient ridge AND a real physical luminance jump (>= 0.052) so smooth skin
  // lighting roll-offs, soft fog/mist peaks, and 8-bit JPEG banding never produce crack/cap artifacts.
  const crispSilhouette = new Float32Array(size);
  const { gradientNorm, tangentX, tangentY } = etf;
  const minSilGrad = stylePreset === 'landscape' ? 0.2 : 0.145;
  const minSilCoh = stylePreset === 'landscape' ? 0.52 : 0.4;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const g = gradientNorm[i];
      if (g < minSilGrad || grayscale[i] < 0.52 || etf.coherence[i] < minSilCoh) continue;
      const nx = -tangentY[i];
      const ny = tangentX[i];
      const lumStep = Math.abs(
        sampleBilinear(grayscale, width, height, x + nx * 1.4, y + ny * 1.4) -
          sampleBilinear(grayscale, width, height, x - nx * 1.4, y - ny * 1.4)
      );
      if (lumStep < 0.056) continue;
      const front = sampleBilinear(gradientNorm, width, height, x + nx, y + ny);
      const back = sampleBilinear(gradientNorm, width, height, x - nx, y - ny);
      if (g >= front * 0.99 && g >= back * 0.99) {
        crispSilhouette[i] =
          smoothstep(0.52, 0.76, grayscale[i]) *
          smoothstep(0.056, 0.145, lumStep) *
          smoothstep(minSilGrad, 0.38, g) *
          (0.4 + 0.6 * etf.coherence[i]) *
          0.52;
      }
    }
  }

  const localAcutance = gaussianBlur(fdogLines, width, height, Math.max(3.0, 9.0 * scale));

  const inverted = new Float32Array(size);
  for (let i = 0; i < size; i++) inverted[i] = 1 - grayscale[i];
  const dodgeSigma = clamp(Math.min(width, height) / 64, 2.6, 9.5);
  const blurredInverted = gaussianBlur(inverted, width, height, dodgeSigma);
  const localMean = gaussianBlur(grayscale, width, height, 1.2 * scale);

  const rawTone = mapPencilToneField(grayscale, stylePreset);

  const darkness = new Float32Array(size);
  const tone = new Float32Array(size);
  const detail = new Float32Array(size);
  const structuralEdge = new Float32Array(size);

  const lineWeight =
    stylePreset === 'lineart'
      ? 1.14
      : stylePreset === 'architecture'
        ? 1.12
        : stylePreset === 'botanical'
          ? 1.05
          : stylePreset === 'pet'
            ? 1.03
            : stylePreset === 'landscape'
              ? 0.9
              : stylePreset === 'dramatic'
                ? 0.98
                : 1.0;

  const bokehStrength = stylePreset === 'landscape' ? 0.1 : stylePreset === 'architecture' ? 0.16 : 0.32;
  const gentleFormStart = stylePreset === 'landscape' || stylePreset === 'botanical' ? 0.045 : 0.08;

  for (let i = 0; i < size; i++) {
    const fg = foreground[i];
    const bgSuppressionStrength = clamp01(bgSuppression * 1.48);
    const bgToneFactor = lerpScalar(1, fg * fg * fg, bgSuppressionStrength);
    const bgLineFactor = lerpScalar(1, 0.08 + 0.92 * fg, clamp01(bgSuppression * 1.15));

    const dodgeLightness = clamp01(grayscale[i] / Math.max(0.028, 1 - blurredInverted[i]));
    const dodgeSoft = Math.pow(1 - dodgeLightness, 0.86) * 0.54;
    const microDark = clamp01((localMean[i] - grayscale[i]) * 4.5);

    const crispLine = clamp01(
      Math.max(
        fdogLines[i] * 0.94,
        microDark * 0.8,
        crispSilhouette[i],
        dodgeSoft * fdogLines[i]
      ) *
        lineWeight *
        bgLineFactor
    );

    const sourceDark = 1 - grayscale[i];
    const gentleFormGate = smoothstep(gentleFormStart, 0.42, sourceDark);
    const deepMassGate = smoothstep(0.45, 0.82, sourceDark);
    // Out-of-focus bokeh regions devoid of structural edges soften gently so in-focus subjects lead
    const bokehFocusFactor =
      1 - bgSuppression * bokehStrength * (1 - smoothstep(0.008, 0.036, localAcutance[i]));
    const calibratedTone = clamp01(
      rawTone[i] *
        (0.34 * gentleFormGate + 0.66 * deepMassGate) *
        bgToneFactor *
        bokehFocusFactor
    );

    let combined = 1 - (1 - crispLine) * (1 - calibratedTone);
    if (combined < 0.018 || (crispLine < 0.016 && calibratedTone < 0.014)) {
      combined = 0;
    }

    detail[i] = crispLine;
    tone[i] = calibratedTone;
    darkness[i] = clamp01(combined);
    structuralEdge[i] = clamp01(
      Math.max(fdogLines[i], crispSilhouette[i] * 1.2) *
        (0.42 + 0.58 * etf.coherence[i]) *
        bgLineFactor
    );
  }

  return {
    width,
    height,
    grayscale,
    darkness,
    tone,
    detail,
    structuralEdge,
    foreground,
    tangent: etf.tangent,
    tangentX: etf.tangentX,
    tangentY: etf.tangentY,
    coherence: etf.coherence,
  };
}

function lerpScalar(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
