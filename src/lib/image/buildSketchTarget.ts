export interface SketchTarget {
  width: number;
  height: number;
  /** Normalized source luminance, 0 is black and 1 is white. */
  grayscale: Float32Array;
  /** Desired graphite darkness, 0 is untouched paper and 1 is black. */
  darkness: Float32Array;
  /** Broad shadow mass, excluding fine line detail. */
  tone: Float32Array;
  /** High-frequency pencil detail used by the contour pass. */
  detail: Float32Array;
  /** Local surface tangent used to orient tonal strokes. */
  tangent: Float32Array;
  /** Reliability of the tangent direction, from 0 to 1. */
  coherence: Float32Array;
}

export function createSketchTargetPreview(target: SketchTarget): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(target.darkness.length);
  for (let i = 0; i < target.darkness.length; i++) {
    pixels[i] = Math.round((1 - clamp01(target.darkness[i])) * 255);
  }
  return pixels;
}

/**
 * Builds a hidden pencil-sketch target with traditional image processing.
 *
 * The base is the same grayscale -> invert -> blur -> color-dodge family used
 * by pic2sketch. A restrained shadow-mass term keeps dark hair and deep folds
 * from turning into empty white interiors, which plain color dodge tends to do.
 */
export function buildSketchTarget(imageData: ImageData): SketchTarget {
  const { width, height, data } = imageData;
  const size = width * height;
  const rawGray = new Float32Array(size);

  for (let i = 0; i < size; i++) {
    const p = i * 4;
    rawGray[i] = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) / 255;
  }

  const low = percentile(rawGray, 0.01);
  const high = percentile(rawGray, 0.99);
  const range = Math.max(0.08, high - low);
  const normalized = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    normalized[i] = clamp01((rawGray[i] - low) / range);
  }

  const grayscale = gaussianBlur(normalized, width, height, 0.75);
  const inverted = new Float32Array(size);
  for (let i = 0; i < size; i++) inverted[i] = 1 - grayscale[i];

  const dodgeSigma = clamp(Math.min(width, height) / 58, 3.2, 11.5);
  const blurredInverted = gaussianBlur(inverted, width, height, dodgeSigma);
  const localGray = gaussianBlur(grayscale, width, height, 1.15);
  const darkness = new Float32Array(size);
  const tone = new Float32Array(size);
  const detail = new Float32Array(size);

  for (let i = 0; i < size; i++) {
    // Standard color dodge: gray / (1 - blur(invert(gray))).
    const dodgeLightness = clamp01(grayscale[i] / Math.max(0.025, 1 - blurredInverted[i]));
    const dodgeDetail = Math.pow(1 - dodgeLightness, 0.76);

    // Dark-on-light micro detail protects pupils, lashes, lips and hair strands.
    const microDetail = clamp01((localGray[i] - grayscale[i]) * 5.2);
    const lineDetail = clamp01(Math.max(dodgeDetail, microDetail));

    // Only genuinely deep source tones receive broad graphite mass. This keeps
    // a flat gray studio background close to paper while retaining dark hair.
    const sourceDarkness = 1 - grayscale[i];
    const shadowGate = smoothstep(0.46, 0.86, sourceDarkness);
    const shadowMass = Math.pow(sourceDarkness, 1.18) * shadowGate * 0.68;

    let target = 1 - (1 - lineDetail) * (1 - shadowMass);
    if (lineDetail < 0.012 && shadowMass < 0.025) target = 0;

    detail[i] = lineDetail;
    tone[i] = clamp01(shadowMass);
    darkness[i] = clamp01(Math.pow(target, 0.9));
  }

  const { tangent, coherence } = buildStructureTensor(grayscale, width, height);
  return { width, height, grayscale, darkness, tone, detail, tangent, coherence };
}

function buildStructureTensor(
  gray: Float32Array,
  width: number,
  height: number
): { tangent: Float32Array; coherence: Float32Array } {
  const size = width * height;
  const source = gaussianBlur(gray, width, height, 1.15);
  const jxx = new Float32Array(size);
  const jxy = new Float32Array(size);
  const jyy = new Float32Array(size);

  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const gx = (source[i + 1] - source[i - 1]) * 0.5;
      const gy = (source[i + width] - source[i - width]) * 0.5;
      jxx[i] = gx * gx;
      jxy[i] = gx * gy;
      jyy[i] = gy * gy;
    }
  }

  const tensorSigma = clamp(Math.min(width, height) / 220, 1.8, 4.0);
  const sxx = gaussianBlur(jxx, width, height, tensorSigma);
  const sxy = gaussianBlur(jxy, width, height, tensorSigma);
  const syy = gaussianBlur(jyy, width, height, tensorSigma);
  const tangent = new Float32Array(size);
  const coherence = new Float32Array(size);

  for (let i = 0; i < size; i++) {
    const trace = sxx[i] + syy[i];
    if (trace < 1e-8) continue;
    const diff = sxx[i] - syy[i];
    coherence[i] = clamp01(Math.hypot(diff, 2 * sxy[i]) / trace);
    tangent[i] = 0.5 * Math.atan2(2 * sxy[i], diff) + Math.PI * 0.5;
  }

  return { tangent, coherence };
}

export function gaussianBlur(
  source: Float32Array,
  width: number,
  height: number,
  sigma: number
): Float32Array {
  if (sigma <= 0.05) return source.slice();
  const radius = Math.max(1, Math.ceil(sigma * 2.5));
  const kernel = new Float32Array(radius * 2 + 1);
  let kernelSum = 0;
  for (let x = -radius; x <= radius; x++) {
    const weight = Math.exp(-(x * x) / (2 * sigma * sigma));
    kernel[x + radius] = weight;
    kernelSum += weight;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= kernelSum;

  const temp = new Float32Array(source.length);
  const result = new Float32Array(source.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let value = 0;
      for (let k = -radius; k <= radius; k++) {
        value += source[row + clampIndex(x + k, width)] * kernel[k + radius];
      }
      temp[row + x] = value;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let value = 0;
      for (let k = -radius; k <= radius; k++) {
        value += temp[clampIndex(y + k, height) * width + x] * kernel[k + radius];
      }
      result[y * width + x] = value;
    }
  }
  return result;
}

function percentile(source: Float32Array, fraction: number): number {
  const step = Math.max(1, Math.floor(source.length / 30000));
  const values: number[] = [];
  for (let i = 0; i < source.length; i += step) values.push(source[i]);
  values.sort((a, b) => a - b);
  return values[Math.round(clamp01(fraction) * Math.max(0, values.length - 1))] ?? 0;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / Math.max(1e-6, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clampIndex(index: number, length: number): number {
  return index < 0 ? 0 : index >= length ? length - 1 : index;
}
