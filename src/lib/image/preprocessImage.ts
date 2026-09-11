import type { PreprocessedImage } from '../../types/image-processing';

/**
 * Image preprocessing for pencil sketch generation.
 *
 * Everything downstream (line extraction, tonal planning, hatching direction) is
 * driven by the maps produced here, so this stage has to be robust on real photos:
 *
 * - Percentile exposure normalisation instead of min/max, so one specular
 *   pixel or a black border cannot flatten the whole tonal range.
 * - Multi-scale structure tensor producing a coherent tangent (flow) field with
 *   a per-pixel confidence value, used to make hatching follow the form.
 * - Line response = colour-dodge detail + percentile-normalised Sobel.
 * - Subject mask built against a *position dependent* background model, so
 *   studio backdrops with vignetting/gradients are actually separated.
 */
export function preprocessImage(imageData: ImageData): PreprocessedImage {
  const { width, height, data } = imageData;
  const pixelCount = width * height;

  // 1. Luminance
  const grayData = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const idx = i * 4;
    grayData[i] = (0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]) / 255.0;
  }

  // 2. Robust exposure normalisation (p1..p99 -> 0..1)
  const low = percentile(grayData, 0.01);
  const high = percentile(grayData, 0.99);
  const range = Math.max(0.02, high - low);
  for (let i = 0; i < pixelCount; i++) {
    const value = (grayData[i] - low) / range;
    grayData[i] = value < 0 ? 0 : value > 1 ? 1 : value;
  }

  // 3. Edge preserving smoothing (removes sensor/JPEG noise, keeps eyes and lips)
  const smoothed = edgePreservingSmooth(grayData, width, height, 2, 0.08);

  // 4. Color dodge detail response: 1 on every real line detail, 0 on flat paper
  const inverted = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) inverted[i] = 1.0 - smoothed[i];
  const blurredInv = gaussianBlur(inverted, width, height, 3.5);

  const edgeData = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const denom = Math.max(0.005, 1.0 - blurredInv[i]);
    const line = 1.0 - Math.min(1.0, smoothed[i] / denom);
    edgeData[i] = line > 0.03 ? Math.min(1, Math.pow((line - 0.03) / 0.97, 0.75) * 1.5) : 0;
  }

  // 5. Sobel gradient + percentile normalisation
  const gradMag = new Float32Array(pixelCount);
  const gradAngle = new Float32Array(pixelCount);
  const rawGx = new Float32Array(pixelCount);
  const rawGy = new Float32Array(pixelCount);

  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = row + x;
      const gx =
        -smoothed[idx - width - 1] + smoothed[idx - width + 1] +
        -2 * smoothed[idx - 1] + 2 * smoothed[idx + 1] +
        -smoothed[idx + width - 1] + smoothed[idx + width + 1];
      const gy =
        -smoothed[idx - width - 1] - 2 * smoothed[idx - width] - smoothed[idx - width + 1] +
        smoothed[idx + width - 1] + 2 * smoothed[idx + width] + smoothed[idx + width + 1];
      rawGx[idx] = gx;
      rawGy[idx] = gy;
      gradMag[idx] = Math.hypot(gx, gy);
    }
  }

  const gradScale = Math.max(0.0005, percentile(gradMag, 0.995));
  const smoothGx = gaussianBlur(rawGx, width, height, 5.0);
  const smoothGy = gaussianBlur(rawGy, width, height, 5.0);
  for (let i = 0; i < pixelCount; i++) {
    gradAngle[i] = Math.atan2(smoothGy[i], smoothGx[i]);
    // Blend the line response with a percentile-normalised Sobel response so
    // faint features survive without letting one strong edge set the scale.
    const sobel = Math.min(1, gradMag[i] / gradScale);
    if (sobel * 0.7 > edgeData[i]) edgeData[i] = sobel * 0.7;
  }

  // 6. Subject mask (position dependent background model)
  const foregroundData = estimateForegroundMask(imageData, edgeData);

  // 7. Tone map (darkness) with a gentle contrast curve that protects highlights
  const toneData = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const darkness = 1.0 - smoothed[i];
    const shaped = darkness <= 0.06 ? 0 : Math.pow((darkness - 0.06) / 0.94, 1.08);
    toneData[i] = shaped < 0 ? 0 : shaped > 1 ? 1 : shaped;
  }

  // 8. Saliency (subject + centre + detail)
  const saliencyData = new Float32Array(pixelCount);
  const cx = width * 0.5;
  const cy = height * 0.45;
  const maxRadiusSq = Math.pow(Math.hypot(cx, cy), 2);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      const distSq = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      const centre = Math.exp(-distSq / (maxRadiusSq * 0.4));
      saliencyData[idx] = Math.min(1, foregroundData[idx] * 0.5 + centre * 0.2 + edgeData[idx] * 0.3);
    }
  }

  // 9. Multi-scale structure tensor -> tangent flow field
  const flowMap = buildFlowField(smoothed, width, height);

  return {
    width,
    height,
    grayscaleMap: { width, height, data: grayData },
    edgeMap: { width, height, data: edgeData },
    toneMap: { width, height, data: toneData },
    saliencyMap: { width, height, data: saliencyData },
    gradientMap: { width, height, magnitude: gradMag, angle: gradAngle },
    foregroundMap: { width, height, data: foregroundData },
    flowMap,
  };
}

/**
 * Multi-scale structure tensor. Returns the dominant edge tangent direction and
 * a coherence value (0 = isotropic texture, 1 = strong single orientation).
 * Hair, cloth folds and contours are coherent; skin and walls are not.
 */
function buildFlowField(
  gray: Float32Array,
  width: number,
  height: number
): NonNullable<PreprocessedImage['flowMap']> {
  const scales = [1.6, 4.0, 8.0];
  const pixelCount = width * height;
  let bestCoherence = new Float32Array(pixelCount);
  let bestAngle = new Float32Array(pixelCount);
  let bestScale = new Float32Array(pixelCount);

  for (const sigma of scales) {
    const s = gaussianBlur(gray, width, height, sigma);
    const jxx = new Float32Array(pixelCount);
    const jxy = new Float32Array(pixelCount);
    const jyy = new Float32Array(pixelCount);

    for (let y = 1; y < height - 1; y++) {
      const row = y * width;
      for (let x = 1; x < width - 1; x++) {
        const i = row + x;
        const gx = (s[i + 1] - s[i - 1]) * 0.5;
        const gy = (s[i + width] - s[i - width]) * 0.5;
        jxx[i] = gx * gx;
        jxy[i] = gx * gy;
        jyy[i] = gy * gy;
      }
    }

    const tensorSigma = sigma * 1.6;
    const sxx = gaussianBlur(jxx, width, height, tensorSigma);
    const sxy = gaussianBlur(jxy, width, height, tensorSigma);
    const syy = gaussianBlur(jyy, width, height, tensorSigma);

    for (let i = 0; i < pixelCount; i++) {
      const trace = sxx[i] + syy[i];
      if (trace < 1e-7) continue;
      const diff = sxx[i] - syy[i];
      const coherence = Math.hypot(diff, 2 * sxy[i]) / trace;
      if (coherence > bestCoherence[i]) {
        // Gradient direction; the tangent (isophote) is perpendicular to it.
        const gradientAngle = 0.5 * Math.atan2(2 * sxy[i], diff);
        bestCoherence[i] = coherence;
        bestAngle[i] = gradientAngle + Math.PI * 0.5;
        bestScale[i] = sigma;
      }
    }
  }

  // Enforce spatial coherence: orientational (doubled angle) smoothing removes
  // the pixel-wise flip-flop that makes streamlines zig-zag between neighbours.
  const cos2 = new Float32Array(pixelCount);
  const sin2 = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const double = bestAngle[i] * 2;
    cos2[i] = Math.cos(double) * bestCoherence[i];
    sin2[i] = Math.sin(double) * bestCoherence[i];
  }
  const smoothCos = gaussianBlur(cos2, width, height, 3.0);
  const smoothSin = gaussianBlur(sin2, width, height, 3.0);
  const coherentAngle = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    coherentAngle[i] = 0.5 * Math.atan2(smoothSin[i], smoothCos[i]);
  }

  return { width, height, angle: coherentAngle, coherence: bestCoherence, scale: bestScale };
}

/**
 * Subject mask against a position dependent background model.
 *
 * A plain global colour distance fails on any backdrop with a gradient or
 * vignette (exactly the studio case). This fits a coarse background colour
 * field from the image border and compares each pixel against the local
 * estimate, then cleans the result morphologically.
 */
function estimateForegroundMask(imageData: ImageData, edgeData: Float32Array): Float32Array {
  const { width, height, data } = imageData;
  const pixelCount = width * height;
  const band = Math.max(3, Math.round(Math.min(width, height) * 0.05));

  // --- sample the border as the background reference set ---
  const samples: { x: number; y: number; r: number; g: number; b: number }[] = [];
  const stride = Math.max(1, Math.floor((width + height) / 400));
  for (let y = 0; y < height; y += stride) {
    for (const x of [0, band - 1, width - band, width - 1]) {
      if (x < 0 || x >= width) continue;
      const idx = (y * width + x) * 4;
      samples.push({ x, y, r: data[idx] / 255, g: data[idx + 1] / 255, b: data[idx + 2] / 255 });
    }
  }
  for (let x = 0; x < width; x += stride) {
    for (const y of [0, band - 1, height - band, height - 1]) {
      if (y < 0 || y >= height) continue;
      const idx = (y * width + x) * 4;
      samples.push({ x, y, r: data[idx] / 255, g: data[idx + 1] / 255, b: data[idx + 2] / 255 });
    }
  }

  // --- coarse inverse-distance background colour field ---
  const gw = 24;
  const gh = Math.max(2, Math.round((gw * height) / Math.max(1, width)));
  const bgField = new Float32Array(gw * gh * 3);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const px = ((gx + 0.5) / gw) * width;
      const py = ((gy + 0.5) / gh) * height;
      let wr = 0, wg = 0, wb = 0, wsum = 0;
      for (const sample of samples) {
        const d2 = (sample.x - px) * (sample.x - px) + (sample.y - py) * (sample.y - py);
        const weight = 1 / (d2 + 64);
        wr += sample.r * weight; wg += sample.g * weight; wb += sample.b * weight; wsum += weight;
      }
      const o = (gy * gw + gx) * 3;
      bgField[o] = wr / wsum; bgField[o + 1] = wg / wsum; bgField[o + 2] = wb / wsum;
    }
  }

  const distance = new Float32Array(pixelCount);
  let distanceSum = 0;
  let distanceCount = 0;
  for (let y = 0; y < height; y++) {
    const fy = ((y + 0.5) / height) * gh - 0.5;
    const y0 = Math.max(0, Math.min(gh - 1, Math.floor(fy)));
    const y1 = Math.max(0, Math.min(gh - 1, y0 + 1));
    const ty = Math.max(0, Math.min(1, fy - y0));
    for (let x = 0; x < width; x++) {
      const fx = ((x + 0.5) / width) * gw - 0.5;
      const x0 = Math.max(0, Math.min(gw - 1, Math.floor(fx)));
      const x1 = Math.max(0, Math.min(gw - 1, x0 + 1));
      const tx = Math.max(0, Math.min(1, fx - x0));

      const o00 = (y0 * gw + x0) * 3, o10 = (y0 * gw + x1) * 3;
      const o01 = (y1 * gw + x0) * 3, o11 = (y1 * gw + x1) * 3;
      const lerp = (a: number, b: number, c: number, d: number) =>
        (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
      const br = lerp(bgField[o00], bgField[o10], bgField[o01], bgField[o11]);
      const bg = lerp(bgField[o00 + 1], bgField[o10 + 1], bgField[o01 + 1], bgField[o11 + 1]);
      const bb = lerp(bgField[o00 + 2], bgField[o10 + 2], bgField[o01 + 2], bgField[o11 + 2]);

      const idx = (y * width + x) * 4;
      const r = data[idx] / 255, g = data[idx + 1] / 255, b = data[idx + 2] / 255;
      // Colour distance from the *local* backdrop, plus a gradient term so that
      // detail-rich background texture is never treated as flat backdrop.
      const colourDistance = Math.hypot(r - br, g - bg, b - bb) / Math.sqrt(3);
      const d = Math.max(colourDistance, edgeData[y * width + x] * 0.35);
      distance[y * width + x] = d;
      if (x < band || x >= width - band || y < band || y >= height - band) {
        distanceSum += d;
        distanceCount++;
      }
    }
  }

  const borderMean = distanceSum / Math.max(1, distanceCount);
  let borderVar = 0;
  for (let y = 0; y < height; y++) {
    if (y >= band && y < height - band) continue;
    for (let x = 0; x < width; x++) {
      const d = distance[y * width + x] - borderMean;
      borderVar += d * d;
    }
  }
  for (let y = band; y < height - band; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= band && x < width - band) continue;
      const d = distance[y * width + x] - borderMean;
      borderVar += d * d;
    }
  }
  const borderStd = Math.sqrt(borderVar / Math.max(1, distanceCount));
  const threshold = Math.max(0.055, Math.min(0.2, borderMean + borderStd * 3.0 + 0.03));

  // --- flood fill the backdrop inward from the border ---
  const backgroundLike = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) backgroundLike[i] = distance[i] <= threshold ? 1 : 0;

  const background = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let head = 0, tail = 0;
  const push = (index: number) => {
    if (backgroundLike[index] && !background[index]) {
      background[index] = 1;
      queue[tail++] = index;
    }
  };
  for (let x = 0; x < width; x++) { push(x); push((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { push(y * width); push(y * width + width - 1); }
  while (head < tail) {
    const current = queue[head++];
    const cx = current % width;
    if (cx > 0) push(current - 1);
    if (cx + 1 < width) push(current + 1);
    if (current >= width) push(current - width);
    if (current + width < pixelCount) push(current + width);
  }

  const subject = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) subject[i] = background[i] ? 0 : 1;

  // --- morphological close then open, to kill speckle and fill pinholes ---
  const closed = morphological(subject, width, height, 2, true);
  const opened = morphological(closed, width, height, 2, false);
  for (let i = 0; i < pixelCount; i++) subject[i] = opened[i] > 0.5 ? 1 : 0;

  // --- fill holes, then keep components comparable to the main subject ---
  const visited = new Uint8Array(pixelCount);
  const components: number[][] = [];
  for (let start = 0; start < pixelCount; start++) {
    if (!subject[start] || visited[start]) continue;
    let size = 0;
    const members: number[] = [];
    let localHead = 0;
    queue[0] = start;
    let localTail = 1;
    visited[start] = 1;
    while (localHead < localTail) {
      const current = queue[localHead++];
      members.push(current);
      size++;
      const cx = current % width;
      const neighbours = [
        cx > 0 ? current - 1 : -1,
        cx + 1 < width ? current + 1 : -1,
        current >= width ? current - width : -1,
        current + width < pixelCount ? current + width : -1,
      ];
      for (const neighbour of neighbours) {
        if (neighbour >= 0 && subject[neighbour] && !visited[neighbour]) {
          visited[neighbour] = 1;
          queue[localTail++] = neighbour;
        }
      }
    }
    components.push(members);
  }
  components.sort((a, b) => b.length - a.length);
  const largest = components.length ? components[0].length : 0;
  const keep = new Uint8Array(pixelCount);
  for (const component of components) {
    if (component.length >= Math.max(24, largest * 0.05)) {
      for (const index of component) keep[index] = 1;
    }
  }
  for (let i = 0; i < pixelCount; i++) subject[i] = keep[i];

  // --- feather the mask so strokes fade out instead of stopping dead ---
  const feathered = gaussianBlur(subject, width, height, 1.5);
  let subjectCount = 0;
  for (let i = 0; i < pixelCount; i++) {
    const value = feathered[i] < 0 ? 0 : feathered[i] > 1 ? 1 : feathered[i];
    subject[i] = value;
    if (value > 0.5) subjectCount++;
  }

  // --- sanity fallback: a mask that keeps (almost) nothing or everything is wrong ---
  const fraction = subjectCount / pixelCount;
  if (fraction < 0.02 || fraction > 0.94) subject.fill(1);

  return subject;
}

function morphological(source: Float32Array, width: number, height: number, radius: number, closing: boolean): Float32Array {
  const temp = new Float32Array(source.length);
  const out = new Float32Array(source.length);
  const inner = closing; // close = dilate then erode; open = erode then dilate
  // horizontal
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let value = source[row + x];
      for (let k = -radius; k <= radius; k++) {
        const nx = Math.max(0, Math.min(width - 1, x + k));
        const candidate = source[row + nx];
        value = inner ? Math.max(value, candidate) : Math.min(value, candidate);
      }
      temp[row + x] = value;
    }
  }
  // vertical, inverted order for the second half of the operation
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let value = temp[y * width + x];
      for (let k = -radius; k <= radius; k++) {
        const ny = Math.max(0, Math.min(height - 1, y + k));
        const candidate = temp[ny * width + x];
        value = !inner ? Math.max(value, candidate) : Math.min(value, candidate);
      }
      out[y * width + x] = value;
    }
  }
  return out;
}

function percentile(source: Float32Array, fraction: number): number {
  const step = Math.max(1, Math.floor(source.length / 20000));
  const values: number[] = [];
  for (let i = 0; i < source.length; i += step) values.push(source[i]);
  values.sort((a, b) => a - b);
  const index = Math.min(values.length - 1, Math.max(0, Math.round(fraction * (values.length - 1))));
  return values[index];
}

function edgePreservingSmooth(
  src: Float32Array,
  width: number,
  height: number,
  spatialRadius = 2,
  rangeSigma = 0.08
): Float32Array {
  const dst = new Float32Array(src.length);
  const rangeCoeff = -1.0 / (2.0 * rangeSigma * rangeSigma);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const centerIdx = row + x;
      const centerVal = src[centerIdx];
      let weightSum = 0;
      let valSum = 0;

      for (let dy = -spatialRadius; dy <= spatialRadius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        const nRow = ny * width;
        for (let dx = -spatialRadius; dx <= spatialRadius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const neighborVal = src[nRow + nx];
          const diff = neighborVal - centerVal;
          const weight = Math.exp(diff * diff * rangeCoeff) / (1.0 + (dx * dx + dy * dy) * 0.5);
          valSum += neighborVal * weight;
          weightSum += weight;
        }
      }
      dst[centerIdx] = valSum / Math.max(0.0001, weightSum);
    }
  }
  return dst;
}

function gaussianBlur(src: Float32Array, width: number, height: number, sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 2.5));
  const kernelSize = radius * 2 + 1;
  const kernel = new Float32Array(kernelSize);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = w;
    sum += w;
  }
  for (let i = 0; i < kernelSize; i++) kernel[i] /= sum;

  const temp = new Float32Array(src.length);
  const dst = new Float32Array(src.length);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let value = 0;
      for (let k = -radius; k <= radius; k++) {
        value += src[row + Math.min(width - 1, Math.max(0, x + k))] * kernel[k + radius];
      }
      temp[row + x] = value;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let value = 0;
      for (let k = -radius; k <= radius; k++) {
        value += temp[Math.min(height - 1, Math.max(0, y + k)) * width + x] * kernel[k + radius];
      }
      dst[y * width + x] = value;
    }
  }
  return dst;
}
