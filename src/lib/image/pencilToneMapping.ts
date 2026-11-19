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
  highlightStart: number;
  highlightEnd: number;
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
    highlightStart: 0.86,
    highlightEnd: 0.965,
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
    highlightStart: 0.85,
    highlightEnd: 0.96,
  },
  pet: {
    brightWeight: 0.58,
    midWeight: 0.28,
    darkWeight: 0.14,
    sigmaBright: 0.082,
    midLow: 0.38,
    midHigh: 0.93,
    muDark: 0.26,
    sigmaDark: 0.11,
    maxDarkness: 0.86,
    highlightStart: 0.87,
    highlightEnd: 0.97,
  },
  landscape: {
    brightWeight: 0.48,
    midWeight: 0.35,
    darkWeight: 0.17,
    sigmaBright: 0.095,
    midLow: 0.32,
    midHigh: 0.94,
    muDark: 0.27,
    sigmaDark: 0.115,
    maxDarkness: 0.86,
    highlightStart: 0.91,
    highlightEnd: 0.985,
  },
  architecture: {
    brightWeight: 0.52,
    midWeight: 0.31,
    darkWeight: 0.17,
    sigmaBright: 0.085,
    midLow: 0.34,
    midHigh: 0.91,
    muDark: 0.25,
    sigmaDark: 0.11,
    maxDarkness: 0.88,
    highlightStart: 0.88,
    highlightEnd: 0.975,
  },
  botanical: {
    brightWeight: 0.58,
    midWeight: 0.3,
    darkWeight: 0.12,
    sigmaBright: 0.08,
    midLow: 0.38,
    midHigh: 0.95,
    muDark: 0.29,
    sigmaDark: 0.11,
    maxDarkness: 0.82,
    highlightStart: 0.9,
    highlightEnd: 0.982,
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
    highlightStart: 0.84,
    highlightEnd: 0.955,
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
    highlightStart: 0.87,
    highlightEnd: 0.97,
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
  // Use mid-quantile CDF so heavily populated dark/bright bins never skew to the bin ceiling.
  const matchedLightnessLut = new Float32Array(bins);
  let targetCursor = 0;
  for (let b = 0; b < bins; b++) {
    const prevCdf = b > 0 ? sourceCdf[b - 1] : 0;
    const prob = 0.5 * (prevCdf + sourceCdf[b]);
    while (targetCursor < bins - 1 && targetCdf[targetCursor] < prob) {
      targetCursor++;
    }
    matchedLightnessLut[b] = targetCursor / (bins - 1);
  }

  // Blend parametric histogram match with direct tonal curve and bound histogram warp
  // so extreme low-key, high-key, or synthetic images stay faithful to physical luminance.
  const toneDarkness = new Float32Array(grayscale.length);
  for (let i = 0; i < grayscale.length; i++) {
    const lum = clamp01(grayscale[i]);
    const bin = clamp(Math.round(lum * (bins - 1)), 0, bins - 1);
    const directDarkness = Math.pow(clamp01(1 - lum), 1.15);
    const rawMatched = 1 - matchedLightnessLut[bin];
    const matchedDarkness = clamp(rawMatched, directDarkness - 0.18, directDarkness + 0.18);

    // Highlight paper gate: near-white regions stay clean paper (tuned per genre preset).
    const highlightGate = 1 - smoothstep(params.highlightStart, params.highlightEnd, lum);
    const blended = (matchedDarkness * 0.5 + directDarkness * 0.5) * highlightGate;
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

  // Smooth RGB slightly with 3x3 box filter before backdrop check so 8-bit sensor/JPEG grain
  // on dark studio walls (e.g. low-key portraits) never blocks flood-fill continuity.
  const smoothRgb = new Float32Array(size * 3);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - 1) * width;
    const y1 = y * width;
    const y2 = Math.min(height - 1, y + 1) * width;
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - 1);
      const x2 = Math.min(width - 1, x + 1);
      const idxs = [y0 + x0, y0 + x, y0 + x2, y1 + x0, y1 + x, y1 + x2, y2 + x0, y2 + x, y2 + x2];
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (let k = 0; k < 9; k++) {
        const p = idxs[k] * 4;
        sr += data[p];
        sg += data[p + 1];
        sb += data[p + 2];
      }
      const o = (y1 + x) * 3;
      smoothRgb[o] = sr / (9 * 255);
      smoothRgb[o + 1] = sg / (9 * 255);
      smoothRgb[o + 2] = sb / (9 * 255);
    }
  }

  const tryPushSample = (x: number, y: number) => {
    const idx = y * width + x;
    if (gradientNorm[idx] > 0.12) return;
    const o = idx * 3;
    const r = smoothRgb[o];
    const g = smoothRgb[o + 1];
    const b = smoothRgb[o + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    borderSamples.push({ x, y, r, g, b, lum });
  };

  for (let x = 0; x < width; x += stride) {
    tryPushSample(x, 0);
    tryPushSample(x, Math.min(height - 1, margin));
  }

  if (borderSamples.length < 8) return mask;

  // Compute top-border reference color so side-border samples only join if they belong
  // to the SAME continuous studio backdrop (prevents eating dark hills below a bright sky!).
  let topR = 0;
  let topG = 0;
  let topB = 0;
  for (const s of borderSamples) {
    topR += s.r;
    topG += s.g;
    topB += s.b;
  }
  topR /= borderSamples.length;
  topG /= borderSamples.length;
  topB /= borderSamples.length;

  // Measure top-border color variance: uniform studio walls / clean skies have very low std-dev,
  // whereas patchy outdoor tree bokeh / foliage has high variance and should not be Swiss-cheesed.
  let topVarSum = 0;
  for (const s of borderSamples) {
    const dr = s.r - topR;
    const dg = s.g - topG;
    const db = s.b - topB;
    topVarSum += (dr * dr + dg * dg + db * db) / 3;
  }
  const topBorderStd = Math.sqrt(topVarSum / Math.max(1, borderSamples.length));
  const backdropConfidence = 1 - smoothstep(0.085, 0.21, topBorderStd);
  if (backdropConfidence < 0.08) return mask;

  const tryPushSideSample = (x: number, y: number) => {
    const idx = y * width + x;
    if (gradientNorm[idx] > 0.12) return;
    const o = idx * 3;
    const r = smoothRgb[o];
    const g = smoothRgb[o + 1];
    const b = smoothRgb[o + 2];
    const diffFromTop = Math.hypot(r - topR, g - topG, b - topB) / Math.SQRT2;
    if (diffFromTop > 0.2) return;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    borderSamples.push({ x, y, r, g, b, lum });
  };

  for (let y = 0; y < Math.floor(height * 0.85); y += stride) {
    tryPushSideSample(0, y);
    tryPushSideSample(Math.min(width - 1, margin), y);
    tryPushSideSample(width - 1, y);
    tryPushSideSample(Math.max(0, width - 1 - margin), y);
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
      if (gradientNorm[idx] > 0.125) continue;
      const gx = clamp(Math.floor((x / width) * gridW), 0, gridW - 1);
      const o = (gy * gridW + gx) * 3;
      const so = idx * 3;
      const r = smoothRgb[so];
      const g = smoothRgb[so + 1];
      const b = smoothRgb[so + 2];

      const colorDiff = Math.hypot(r - bgGrid[o], g - bgGrid[o + 1], b - bgGrid[o + 2]) / Math.SQRT2;
      if (colorDiff < 0.175) {
        backdropCandidate[idx] = 1;
      }
    }
  }

  // Border-seeded BFS flood fill with neighbor-to-neighbor color continuity:
  // follows smooth studio vignettes (light, colored, OR dark) without ring cutoffs,
  // while stopping cleanly at any subject silhouette edge.
  const visitedBg = new Uint8Array(size);
  const queue = new Int32Array(size);
  let head = 0;
  let tail = 0;

  const trySeed = (idx: number) => {
    if (backdropCandidate[idx] && !visitedBg[idx] && gradientNorm[idx] < 0.11) {
      visitedBg[idx] = 1;
      queue[tail++] = idx;
    }
  };

  const tryStep = (fromIdx: number, toIdx: number) => {
    if (!backdropCandidate[toIdx] || visitedBg[toIdx]) return;
    const p0 = fromIdx * 3;
    const p1 = toIdx * 3;
    const dr = smoothRgb[p0] - smoothRgb[p1];
    const dg = smoothRgb[p0 + 1] - smoothRgb[p1 + 1];
    const db = smoothRgb[p0 + 2] - smoothRgb[p1 + 2];
    if (dr * dr + dg * dg + db * db > 0.024 * 0.024 * 2) return;
    visitedBg[toIdx] = 1;
    queue[tail++] = toIdx;
  };

  for (let x = 0; x < width; x++) {
    trySeed(x);
  }
  for (let y = 0; y < Math.floor(height * 0.85); y++) {
    const leftIdx = y * width;
    const rightIdx = y * width + width - 1;
    const lo = leftIdx * 3;
    const ro = rightIdx * 3;
    if (Math.hypot(smoothRgb[lo] - topR, smoothRgb[lo + 1] - topG, smoothRgb[lo + 2] - topB) / Math.SQRT2 < 0.2) {
      trySeed(leftIdx);
    }
    if (Math.hypot(smoothRgb[ro] - topR, smoothRgb[ro + 1] - topG, smoothRgb[ro + 2] - topB) / Math.SQRT2 < 0.2) {
      trySeed(rightIdx);
    }
  }

  while (head < tail) {
    const curr = queue[head++];
    const cx = curr % width;
    if (cx > 0) tryStep(curr, curr - 1);
    if (cx + 1 < width) tryStep(curr, curr + 1);
    if (curr >= width) tryStep(curr, curr - width);
    if (curr + width < size) tryStep(curr, curr + width);
  }

  const bgRatio = tail / size;
  // Sanity guard: if flood-fill ate nearly the whole image (> 86%) or almost nothing (< 3%), leave untouched.
  if (bgRatio < 0.03 || bgRatio > 0.86) {
    return mask;
  }

  const bgMaskValue = clamp01(1 - backdropConfidence);
  for (let i = 0; i < size; i++) {
    mask[i] = visitedBg[i] ? bgMaskValue : 1;
  }

  return gaussianBlur(mask, width, height, 4.2);
}
