import type { SketchStylePreset } from '../../types/image-processing';
import { clamp, clamp01, smoothstep } from '../../utils/math';
import { gaussianBlur } from './filters';

interface ToneDistributionWeights {
  brightWeight: number;
  midWeight: number;
  darkWeight: number;
  sigmaBright: number;
  midLow: number;
  midHigh: number;
  muDark: number;
  sigmaDark: number;
  maxDarkness: number;
}

const PRESET_DISTRIBUTIONS: Record<SketchStylePreset, ToneDistributionWeights> = {
  // Lu et al. (2012) empirical natural pencil drawing histogram weights (w1, w2, w3)
  classic: {
    brightWeight: 0.56,
    midWeight: 0.29,
    darkWeight: 0.15,
    sigmaBright: 0.085,
    midLow: 0.36,
    midHigh: 0.92,
    muDark: 0.28,
    sigmaDark: 0.11,
    maxDarkness: 0.84,
  },
  portrait: {
    brightWeight: 0.64,
    midWeight: 0.24,
    darkWeight: 0.12,
    sigmaBright: 0.075,
    midLow: 0.42,
    midHigh: 0.94,
    muDark: 0.3,
    sigmaDark: 0.11,
    maxDarkness: 0.82,
  },
  lineart: {
    brightWeight: 0.82,
    midWeight: 0.13,
    darkWeight: 0.05,
    sigmaBright: 0.055,
    midLow: 0.58,
    midHigh: 0.96,
    muDark: 0.42,
    sigmaDark: 0.1,
    maxDarkness: 0.52,
  },
  dramatic: {
    brightWeight: 0.44,
    midWeight: 0.31,
    darkWeight: 0.25,
    sigmaBright: 0.095,
    midLow: 0.28,
    midHigh: 0.88,
    muDark: 0.22,
    sigmaDark: 0.12,
    maxDarkness: 0.92,
  },
};

/**
 * Calibrates raw photo luminance into authentic pencil-on-paper tone darkness
 * via parametric three-component histogram matching (Laplacian paper highlights +
 * Uniform mid-tones + Gaussian charcoal darks, adapted from Lu et al., NPAR 2012),
 * blended with direct tonal preservation so flat synthetic inputs stay faithful.
 */
export function mapPencilToneField(
  grayscale: Float32Array,
  preset: SketchStylePreset = 'classic'
): Float32Array {
  const params = PRESET_DISTRIBUTIONS[preset];
  const bins = 256;

  // Source empirical CDF
  const sourceHist = new Float32Array(bins);
  const step = Math.max(1, Math.floor(grayscale.length / 65536));
  let sampleCount = 0;
  for (let i = 0; i < grayscale.length; i += step) {
    const bin = clamp(Math.round(clamp01(grayscale[i]) * (bins - 1)), 0, bins - 1);
    sourceHist[bin]++;
    sampleCount++;
  }

  const sourceCdf = new Float32Array(bins);
  let cumulative = 0;
  for (let b = 0; b < bins; b++) {
    cumulative += sourceHist[b] / Math.max(1, sampleCount);
    sourceCdf[b] = cumulative;
  }

  // Target parametric pencil lightness PDF & CDF (0 = black graphite, 1 = paper white)
  const targetPdf = new Float32Array(bins);
  let pdfSum = 0;
  for (let b = 0; b < bins; b++) {
    const v = b / (bins - 1);
    const pBright = (1 / params.sigmaBright) * Math.exp(-(1 - v) / params.sigmaBright);
    const pMid =
      v >= params.midLow && v <= params.midHigh
        ? 1 / Math.max(0.05, params.midHigh - params.midLow)
        : 0;
    const pDark =
      (1 / (Math.sqrt(2 * Math.PI) * params.sigmaDark)) *
      Math.exp(-((v - params.muDark) ** 2) / (2 * params.sigmaDark ** 2));

    const density =
      params.brightWeight * pBright +
      params.midWeight * pMid +
      params.darkWeight * pDark;
    targetPdf[b] = density;
    pdfSum += density;
  }

  const targetCdf = new Float32Array(bins);
  let targetAcc = 0;
  for (let b = 0; b < bins; b++) {
    targetAcc += targetPdf[b] / Math.max(1e-6, pdfSum);
    targetCdf[b] = targetAcc;
  }

  // Build monotonic LUT from source luminance bin -> matched pencil lightness
  const matchedLightnessLut = new Float32Array(bins);
  let targetCursor = 0;
  for (let b = 0; b < bins; b++) {
    const prob = sourceCdf[b];
    while (targetCursor < bins - 1 && targetCdf[targetCursor] < prob) {
      targetCursor++;
    }
    matchedLightnessLut[b] = targetCursor / (bins - 1);
  }

  // Blend parametric histogram match with direct tonal curve so low-entropy/synthetic
  // images never suffer artificial histogram stretching on flat white backgrounds.
  const toneDarkness = new Float32Array(grayscale.length);
  for (let i = 0; i < grayscale.length; i++) {
    const lum = clamp01(grayscale[i]);
    const bin = clamp(Math.round(lum * (bins - 1)), 0, bins - 1);
    const matchedDarkness = 1 - matchedLightnessLut[bin];
    const directDarkness = Math.pow(clamp01(1 - lum), 1.16);

    // Highlight paper gate: near-white regions (> 0.92 luminance) stay clean paper.
    const highlightGate = 1 - smoothstep(0.86, 0.965, lum);
    const blended = (matchedDarkness * 0.52 + directDarkness * 0.48) * highlightGate;
    toneDarkness[i] = clamp01(blended * params.maxDarkness);
  }

  return toneDarkness;
}

/**
 * Estimates a soft subject confidence map [0..1] by flood-filling low-gradient
 * backdrop regions inward from the top/left/right frame borders.
 *
 * Studio backdrops (e.g. uniform gray walls with subtle vignette) are cleanly
 * separated so `backgroundSuppression` can keep the background crisp paper-white
 * without erasing subtle skin shading inside the subject.
 */
export function estimateSubjectMask(
  imageData: ImageData,
  gradientNorm: Float32Array
): Float32Array {
  const { width, height, data } = imageData;
  const size = width * height;
  const mask = new Float32Array(size).fill(1);
  if (width < 24 || height < 24) return mask;

  // Sample outer frame border (top, left, right — excluding bottom center where busts rest)
  const borderSamples: Array<{ x: number; y: number; r: number; g: number; b: number; lum: number }> = [];
  const stride = Math.max(2, Math.floor((width + height) / 48));
  const margin = Math.max(2, Math.round(Math.min(width, height) * 0.03));

  const tryPushSample = (x: number, y: number) => {
    const idx = y * width + x;
    if (gradientNorm[idx] > 0.14) return;
    const p = idx * 4;
    const r = data[p] / 255;
    const g = data[p + 1] / 255;
    const b = data[p + 2] / 255;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    // Only light-to-mid neutral studio backdrops qualify for automatic paper clearing;
    // genuinely dark subjects touching the frame border must keep their tonal mass.
    if (lum < 0.38) return;
    borderSamples.push({ x, y, r, g, b, lum });
  };

  for (let x = 0; x < width; x += stride) {
    tryPushSample(x, 0);
    tryPushSample(x, Math.min(height - 1, margin));
  }
  for (let y = 0; y < height; y += stride) {
    tryPushSample(0, y);
    tryPushSample(Math.min(width - 1, margin), y);
    tryPushSample(width - 1, y);
    tryPushSample(Math.max(0, width - 1 - margin), y);
  }

  if (borderSamples.length < 12) return mask;

  // Coarse 16x16 inverse-distance interpolated backdrop color model
  const gridW = 16;
  const gridH = 16;
  const bgGrid = new Float32Array(gridW * gridH * 3);
  for (let gy = 0; gy < gridH; gy++) {
    const py = ((gy + 0.5) / gridH) * height;
    for (let gx = 0; gx < gridW; gx++) {
      const px = ((gx + 0.5) / gridW) * width;
      let wr = 0;
      let wg = 0;
      let wb = 0;
      let wsum = 0;
      for (const s of borderSamples) {
        const dSq = (s.x - px) ** 2 + (s.y - py) ** 2;
        const w = 1 / (dSq + 96);
        wr += s.r * w;
        wg += s.g * w;
        wb += s.b * w;
        wsum += w;
      }
      const o = (gy * gridW + gx) * 3;
      bgGrid[o] = wr / wsum;
      bgGrid[o + 1] = wg / wsum;
      bgGrid[o + 2] = wb / wsum;
    }
  }

  const backdropCandidate = new Uint8Array(size);
  for (let y = 0; y < height; y++) {
    const gy = clamp(Math.floor((y / height) * gridH), 0, gridH - 1);
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowOffset + x;
      if (gradientNorm[idx] > 0.11) continue;
      const gx = clamp(Math.floor((x / width) * gridW), 0, gridW - 1);
      const o = (gy * gridW + gx) * 3;
      const p = idx * 4;
      const r = data[p] / 255;
      const g = data[p + 1] / 255;
      const b = data[p + 2] / 255;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum < 0.38) continue;

      const colorDiff = Math.hypot(r - bgGrid[o], g - bgGrid[o + 1], b - bgGrid[o + 2]) / Math.SQRT2;
      if (colorDiff < 0.075) {
        backdropCandidate[idx] = 1;
      }
    }
  }

  // Border-seeded BFS flood fill stops cleanly at the subject silhouette edge.
  const visitedBg = new Uint8Array(size);
  const queue = new Int32Array(size);
  let head = 0;
  let tail = 0;

  const enqueue = (idx: number) => {
    if (backdropCandidate[idx] && !visitedBg[idx]) {
      visitedBg[idx] = 1;
      queue[tail++] = idx;
    }
  };

  for (let x = 0; x < width; x++) {
    enqueue(x);
  }
  for (let y = 0; y < height; y++) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }

  while (head < tail) {
    const curr = queue[head++];
    const cx = curr % width;
    if (cx > 0) enqueue(curr - 1);
    if (cx + 1 < width) enqueue(curr + 1);
    if (curr >= width) enqueue(curr - width);
    if (curr + width < size) enqueue(curr + width);
  }

  const bgRatio = tail / size;
  // Sanity guard: if flood-fill ate nearly the whole image (> 88%) or almost nothing (< 3%), leave untouched.
  if (bgRatio < 0.03 || bgRatio > 0.88) {
    return mask;
  }

  for (let i = 0; i < size; i++) {
    mask[i] = visitedBg[i] ? 0 : 1;
  }

  return gaussianBlur(mask, width, height, 2.2);
}
