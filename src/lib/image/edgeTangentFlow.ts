import { clamp, clamp01, reflectIndex } from '../../utils/math';
import { computePercentile, computeSobelGradients, gaussianBlur } from './filters';

export interface EdgeTangentFlow {
  tangent: Float32Array;
  tangentX: Float32Array;
  tangentY: Float32Array;
  coherence: Float32Array;
  gradientNorm: Float32Array;
}

/**
 * Computes a smooth, boundary-preserving Edge Tangent Flow (ETF) field
 * following Kang et al. (2007) "Coherent Line Drawing", accelerated via
 * separable directional bilateral passes with dipole sign alignment.
 */
export function computeEdgeTangentFlow(
  grayscale: Float32Array,
  width: number,
  height: number,
  iterations = 2
): EdgeTangentFlow {
  const size = width * height;
  const baseBlur = gaussianBlur(grayscale, width, height, 1.05);
  const { gradX, gradY, magnitude } = computeSobelGradients(baseBlur, width, height);

  const p99 = Math.max(1e-4, computePercentile(magnitude, 0.99));
  const gradientNorm = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    gradientNorm[i] = clamp01(magnitude[i] / p99);
  }

  // Multi-scale structure tensor initialization captures both fine strands and broad form.
  const fineTensor = computeTensorOrientation(baseBlur, width, height, 1.5);
  const coarseBlur = gaussianBlur(grayscale, width, height, 2.4);
  const coarseTensor = computeTensorOrientation(coarseBlur, width, height, 3.6);

  let tx = new Float32Array(size);
  let ty = new Float32Array(size);
  const coherence = new Float32Array(size);

  for (let i = 0; i < size; i++) {
    const useFine = fineTensor.coherence[i] >= coarseTensor.coherence[i] * 0.92;
    const angle = useFine ? fineTensor.tangent[i] : coarseTensor.tangent[i];
    coherence[i] = clamp01(Math.max(fineTensor.coherence[i], coarseTensor.coherence[i] * 0.9));
    tx[i] = Math.cos(angle);
    ty[i] = Math.sin(angle);
  }

  const radius = clamp(Math.round(Math.min(width, height) / 150), 2, 5);
  const spatialSigma = radius * 0.65;
  const spatialKernel = new Float32Array(radius * 2 + 1);
  for (let k = -radius; k <= radius; k++) {
    spatialKernel[k + radius] = Math.exp(-(k * k) / (2 * spatialSigma * spatialSigma));
  }

  const tempX = new Float32Array(size);
  const tempY = new Float32Array(size);
  const nextX = new Float32Array(size);
  const nextY = new Float32Array(size);

  for (let iter = 0; iter < iterations; iter++) {
    // Horizontal ETF pass
    for (let y = 0; y < height; y++) {
      const rowOffset = y * width;
      for (let x = 0; x < width; x++) {
        const centerIdx = rowOffset + x;
        const cx = tx[centerIdx];
        const cy = ty[centerIdx];
        const centerMag = gradientNorm[centerIdx];

        let sumX = 0;
        let sumY = 0;
        for (let k = -radius; k <= radius; k++) {
          const neighborIdx = rowOffset + reflectIndex(x + k, width);
          const nx = tx[neighborIdx];
          const ny = ty[neighborIdx];
          const dot = cx * nx + cy * ny;
          const sign = dot >= 0 ? 1 : -1;
          const magDelta = 3.5 * (gradientNorm[neighborIdx] - centerMag);
          const weightMag = 0.5 * (1 + magDelta / (1 + Math.abs(magDelta)));
          const weightDir = k === 0 ? 1 : Math.max(0.08, Math.abs(dot));
          const w = spatialKernel[k + radius] * weightMag * weightDir;
          sumX += nx * sign * w;
          sumY += ny * sign * w;
        }
        const norm = Math.sqrt(sumX * sumX + sumY * sumY);
        if (norm > 1e-6) {
          tempX[centerIdx] = sumX / norm;
          tempY[centerIdx] = sumY / norm;
        } else {
          tempX[centerIdx] = cx;
          tempY[centerIdx] = cy;
        }
      }
    }

    // Vertical ETF pass
    for (let y = 0; y < height; y++) {
      const rowOffset = y * width;
      for (let x = 0; x < width; x++) {
        const centerIdx = rowOffset + x;
        const cx = tempX[centerIdx];
        const cy = tempY[centerIdx];
        const centerMag = gradientNorm[centerIdx];

        let sumX = 0;
        let sumY = 0;
        for (let k = -radius; k <= radius; k++) {
          const neighborIdx = reflectIndex(y + k, height) * width + x;
          const nx = tempX[neighborIdx];
          const ny = tempY[neighborIdx];
          const dot = cx * nx + cy * ny;
          const sign = dot >= 0 ? 1 : -1;
          const magDelta = 3.5 * (gradientNorm[neighborIdx] - centerMag);
          const weightMag = 0.5 * (1 + magDelta / (1 + Math.abs(magDelta)));
          const weightDir = k === 0 ? 1 : Math.max(0.08, Math.abs(dot));
          const w = spatialKernel[k + radius] * weightMag * weightDir;
          sumX += nx * sign * w;
          sumY += ny * sign * w;
        }
        const norm = Math.sqrt(sumX * sumX + sumY * sumY);
        if (norm > 1e-6) {
          nextX[centerIdx] = sumX / norm;
          nextY[centerIdx] = sumY / norm;
        } else {
          nextX[centerIdx] = cx;
          nextY[centerIdx] = cy;
        }
      }
    }

    tx.set(nextX);
    ty.set(nextY);
  }

  // Fallback where gradients vanish completely: align gently with -38 deg natural right-hand slant.
  const fallbackX = Math.cos(-0.66);
  const fallbackY = Math.sin(-0.66);
  const tangent = new Float32Array(size);

  for (let i = 0; i < size; i++) {
    if (coherence[i] < 0.015 && gradientNorm[i] < 0.015 && Math.hypot(gradX[i], gradY[i]) < 1e-5) {
      tx[i] = fallbackX;
      ty[i] = fallbackY;
    }
    tangent[i] = Math.atan2(ty[i], tx[i]);
  }

  return {
    tangent,
    tangentX: tx,
    tangentY: ty,
    coherence,
    gradientNorm,
  };
}

function computeTensorOrientation(
  smoothed: Float32Array,
  width: number,
  height: number,
  tensorSigma: number
): { tangent: Float32Array; coherence: Float32Array } {
  const size = width * height;
  const jxx = new Float32Array(size);
  const jxy = new Float32Array(size);
  const jyy = new Float32Array(size);

  for (let y = 0; y < height; y++) {
    const yPrev = reflectIndex(y - 1, height) * width;
    const yCurr = y * width;
    const yNext = reflectIndex(y + 1, height) * width;
    for (let x = 0; x < width; x++) {
      const xPrev = reflectIndex(x - 1, width);
      const xNext = reflectIndex(x + 1, width);
      const gx = (smoothed[yCurr + xNext] - smoothed[yCurr + xPrev]) * 0.5;
      const gy = (smoothed[yNext + x] - smoothed[yPrev + x]) * 0.5;
      const idx = yCurr + x;
      jxx[idx] = gx * gx;
      jxy[idx] = gx * gy;
      jyy[idx] = gy * gy;
    }
  }

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
