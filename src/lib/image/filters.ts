import { clamp, clamp01, clampIndex, reflectIndex } from '../../utils/math';

export interface SobelField {
  gradX: Float32Array;
  gradY: Float32Array;
  magnitude: Float32Array;
}

export function gaussianBlur(
  source: Float32Array,
  width: number,
  height: number,
  sigma: number
): Float32Array {
  if (sigma <= 0.05 || width <= 1 || height <= 1) return source.slice();

  const radius = Math.max(1, Math.ceil(sigma * 2.5));
  const kernel = new Float32Array(radius * 2 + 1);
  let kernelSum = 0;
  const invTwoSigmaSq = 1 / (2 * sigma * sigma);

  for (let k = -radius; k <= radius; k++) {
    const weight = Math.exp(-k * k * invTwoSigmaSq);
    kernel[k + radius] = weight;
    kernelSum += weight;
  }
  for (let i = 0; i < kernel.length; i++) {
    kernel[i] /= kernelSum;
  }

  const horizontal = new Float32Array(source.length);
  const output = new Float32Array(source.length);
  const kernelLen = radius * 2 + 1;

  const xIndices = new Int32Array(width + radius * 2);
  for (let i = 0; i < xIndices.length; i++) {
    xIndices[i] = reflectIndex(i - radius, width);
  }
  const yRowOffsets = new Int32Array(height + radius * 2);
  for (let i = 0; i < yRowOffsets.length; i++) {
    yRowOffsets[i] = reflectIndex(i - radius, height) * width;
  }

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let j = 0; j < kernelLen; j++) {
        acc += source[rowOffset + xIndices[x + j]] * kernel[j];
      }
      horizontal[rowOffset + x] = acc;
    }
  }

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let j = 0; j < kernelLen; j++) {
        acc += horizontal[yRowOffsets[y + j] + x] * kernel[j];
      }
      output[rowOffset + x] = acc;
    }
  }

  return output;
}

/**
 * LUT-accelerated separable bilateral filter: suppresses skin/backdrop grain
 * without invoking `Math.exp` inside inner pixel loops.
 */
export function bilateralSmooth(
  source: Float32Array,
  width: number,
  height: number,
  spatialSigma = 1.45,
  rangeSigma = 0.062
): Float32Array {
  if (width <= 2 || height <= 2) return source.slice();

  const radius = Math.max(1, Math.min(3, Math.ceil(spatialSigma * 1.8)));
  const spatialWeights = new Float32Array(radius * 2 + 1);
  const invSpatial = 1 / (2 * spatialSigma * spatialSigma);
  for (let k = -radius; k <= radius; k++) {
    spatialWeights[k + radius] = Math.exp(-k * k * invSpatial);
  }

  const lutBins = 256;
  const rangeLut = new Float32Array(lutBins + 1);
  const invRange = 1 / (2 * rangeSigma * rangeSigma);
  for (let i = 0; i <= lutBins; i++) {
    const d = i / lutBins;
    rangeLut[i] = Math.exp(-d * d * invRange);
  }

  const horizontal = new Float32Array(source.length);
  const output = new Float32Array(source.length);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const center = source[rowOffset + x];
      let sum = 0;
      let weightSum = 0;
      for (let k = -radius; k <= radius; k++) {
        const sample = source[rowOffset + reflectIndex(x + k, width)];
        const lutIdx = Math.min(lutBins, (Math.abs(sample - center) * lutBins) | 0);
        const weight = spatialWeights[k + radius] * rangeLut[lutIdx];
        sum += sample * weight;
        weightSum += weight;
      }
      horizontal[rowOffset + x] = sum / Math.max(1e-6, weightSum);
    }
  }

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const center = horizontal[rowOffset + x];
      let sum = 0;
      let weightSum = 0;
      for (let k = -radius; k <= radius; k++) {
        const sample = horizontal[reflectIndex(y + k, height) * width + x];
        const lutIdx = Math.min(lutBins, (Math.abs(sample - center) * lutBins) | 0);
        const weight = spatialWeights[k + radius] * rangeLut[lutIdx];
        sum += sample * weight;
        weightSum += weight;
      }
      output[rowOffset + x] = sum / Math.max(1e-6, weightSum);
    }
  }

  return output;
}

export function computeSobelGradients(
  source: Float32Array,
  width: number,
  height: number
): SobelField {
  const size = width * height;
  const gradX = new Float32Array(size);
  const gradY = new Float32Array(size);
  const magnitude = new Float32Array(size);

  for (let y = 0; y < height; y++) {
    const yPrev = reflectIndex(y - 1, height) * width;
    const yCurr = y * width;
    const yNext = reflectIndex(y + 1, height) * width;

    for (let x = 0; x < width; x++) {
      const xPrev = reflectIndex(x - 1, width);
      const xNext = reflectIndex(x + 1, width);

      const gx =
        -source[yPrev + xPrev] +
        source[yPrev + xNext] -
        2 * source[yCurr + xPrev] +
        2 * source[yCurr + xNext] -
        source[yNext + xPrev] +
        source[yNext + xNext];

      const gy =
        -source[yPrev + xPrev] -
        2 * source[yPrev + x] -
        source[yPrev + xNext] +
        source[yNext + xPrev] +
        2 * source[yNext + x] +
        source[yNext + xNext];

      const index = yCurr + x;
      gradX[index] = gx;
      gradY[index] = gy;
      magnitude[index] = Math.sqrt(gx * gx + gy * gy);
    }
  }

  return { gradX, gradY, magnitude };
}

export function sampleBilinear(
  source: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number
): number {
  if (width <= 0 || height <= 0) return 0;
  const clampedX = clamp(x, 0, width - 1.0001);
  const clampedY = clamp(y, 0, height - 1.0001);
  const x0 = clampedX | 0;
  const y0 = clampedY | 0;
  const x1 = clampIndex(x0 + 1, width);
  const y1 = clampIndex(y0 + 1, height);
  const tx = clampedX - x0;
  const ty = clampedY - y0;

  const row0 = y0 * width;
  const row1 = y1 * width;
  const top = source[row0 + x0] * (1 - tx) + source[row0 + x1] * tx;
  const bottom = source[row1 + x0] * (1 - tx) + source[row1 + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

export function computePercentile(
  source: Float32Array,
  fraction: number,
  minPositiveThreshold = -Infinity
): number {
  const step = Math.max(1, Math.floor(source.length / 32000));
  const samples: number[] = [];
  for (let i = 0; i < source.length; i += step) {
    const val = source[i];
    if (val > minPositiveThreshold) samples.push(val);
  }
  if (samples.length === 0) return 0;
  samples.sort((a, b) => a - b);
  const targetIdx = Math.round(clamp01(fraction) * (samples.length - 1));
  return samples[targetIdx] ?? 0;
}
