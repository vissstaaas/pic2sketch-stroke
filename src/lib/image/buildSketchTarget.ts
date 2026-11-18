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

  const low = computePercentile(rawGray, 0.01);
  const high = computePercentile(rawGray, 0.99);
  const dynamicRange = Math.max(0.08, high - low);
  const normalized = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    normalized[i] = clamp01((rawGray[i] - low) / dynamicRange);
  }

  const grayscale = bilateralSmooth(normalized, width, height, 1.4 * scale, 0.06);
  const etf = computeEdgeTangentFlow(grayscale, width, height, 2);
  const foreground = estimateSubjectMask(imageData, etf.gradientNorm);

  const fdogLines = computeCoherentLines(grayscale, width, height, etf, {
    sensitivity,
    scale,
  });

  // Single-ridge silhouette detector for low-contrast bright boundaries (shoulders, collars, pleats):
  // Only fires at true gradient maxima perpendicular to ETF AND where grayscale is light (> 0.52),
  // preventing double-outline halos around dark eyebrows, eyes, or lips.
  const crispSilhouette = new Float32Array(size);
  const { gradientNorm, tangentX, tangentY } = etf;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const g = gradientNorm[i];
      if (g < 0.105 || grayscale[i] < 0.52) continue;
      const nx = -tangentY[i];
      const ny = tangentX[i];
      const front = sampleBilinear(gradientNorm, width, height, x + nx, y + ny);
      const back = sampleBilinear(gradientNorm, width, height, x - nx, y - ny);
      if (g >= front * 0.99 && g >= back * 0.99) {
        crispSilhouette[i] =
          smoothstep(0.52, 0.76, grayscale[i]) *
          smoothstep(0.105, 0.36, g) *
          (0.4 + 0.6 * etf.coherence[i]) *
          0.52;
      }
    }
  }

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

  const lineWeight = stylePreset === 'lineart' ? 1.14 : stylePreset === 'dramatic' ? 0.96 : 1.0;

  for (let i = 0; i < size; i++) {
    const fg = foreground[i];
    const bgToneFactor = lerpScalar(1, fg * fg, bgSuppression * 0.96);
    const bgLineFactor = lerpScalar(1, 0.14 + 0.86 * fg, bgSuppression * 0.86);

    const dodgeLightness = clamp01(grayscale[i] / Math.max(0.028, 1 - blurredInverted[i]));
    const dodgeSoft = Math.pow(1 - dodgeLightness, 0.86) * 0.54;
    const microDark = clamp01((localMean[i] - grayscale[i]) * 4.5);

    const crispLine = clamp01(
      Math.max(
        fdogLines[i] * 0.94,
        microDark * 0.8,
        crispSilhouette[i],
        dodgeSoft * (0.38 + 0.62 * fdogLines[i])
      ) *
        lineWeight *
        bgLineFactor
    );

    const sourceDark = 1 - grayscale[i];
    const gentleFormGate = smoothstep(0.08, 0.42, sourceDark);
    const deepMassGate = smoothstep(0.45, 0.82, sourceDark);
    const calibratedTone = clamp01(
      rawTone[i] * (0.34 * gentleFormGate + 0.66 * deepMassGate) * bgToneFactor
    );

    let combined = 1 - (1 - crispLine) * (1 - calibratedTone);
    if (crispLine < 0.015 && calibratedTone < 0.012) {
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
