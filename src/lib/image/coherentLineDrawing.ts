import { clamp, clamp01 } from '../../utils/math';
import type { EdgeTangentFlow } from './edgeTangentFlow';
import { sampleBilinear } from './filters';

export interface CoherentLineOptions {
  /** 0..1 user sensitivity controlling surround suppression and soft-threshold gain. */
  sensitivity: number;
  /** Resolution scale relative to 768px reference. */
  scale: number;
}

/**
 * Flow-based Difference of Gaussians (FDoG) filter based on Kang et al. (2007).
 *
 * 1. Evaluates a 1D center-surround DoG filter perpendicular to the local ETF tangent.
 * 2. Integrates that response along forward/backward ETF streamlines so fragmented
 *    noisy pixels coalesce into crisp, continuous structural strokes.
 */
export function computeCoherentLines(
  grayscale: Float32Array,
  width: number,
  height: number,
  etf: EdgeTangentFlow,
  options: CoherentLineOptions
): Float32Array {
  const size = width * height;
  const sensitivity = clamp01(options.sensitivity);
  const scale = clamp(options.scale, 0.45, 1.6);

  const sigmaCenter = clamp(0.88 * scale, 0.65, 1.5);
  const sigmaSurround = sigmaCenter * 1.62;
  const rho = 0.982 + sensitivity * 0.015;
  const normalRadius = Math.max(2, Math.ceil(sigmaSurround * 2.4));

  const centerWeights = buildGaussianWeights(normalRadius, sigmaCenter);
  const surroundWeights = buildGaussianWeights(normalRadius, sigmaSurround);

  // Step 1: 1D cross-edge DoG response along the local normal (-ty, tx).
  const crossDog = new Float32Array(size);
  const { tangentX, tangentY } = etf;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowOffset + x;
      const nx = -tangentY[idx];
      const ny = tangentX[idx];

      let inner = grayscale[idx] * centerWeights[0];
      let outer = grayscale[idx] * surroundWeights[0];

      for (let k = 1; k <= normalRadius; k++) {
        const forwardSample = sampleBilinear(grayscale, width, height, x + nx * k, y + ny * k);
        const backwardSample = sampleBilinear(grayscale, width, height, x - nx * k, y - ny * k);
        const pairSum = forwardSample + backwardSample;
        inner += pairSum * centerWeights[k];
        outer += pairSum * surroundWeights[k];
      }

      crossDog[idx] = inner - rho * outer;
    }
  }

  // Step 2: Streamline integration along ETF (forward + backward RK2 walk).
  const flowSteps = 4;
  const stepSize = 1.15 * scale;
  const sigmaFlow = 2.1;
  const flowWeights = buildGaussianWeights(flowSteps, sigmaFlow);

  const lineStrength = new Float32Array(size);
  const sharpness = 14 + sensitivity * 16;
  const noiseFloor = 0.0045 - sensitivity * 0.0025;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowOffset + x;
      let integrated = crossDog[idx] * flowWeights[0];
      let weightTotal = flowWeights[0];

      for (const dirSign of [1, -1] as const) {
        let px = x;
        let py = y;
        let prevDx = tangentX[idx] * dirSign;
        let prevDy = tangentY[idx] * dirSign;

        for (let step = 1; step <= flowSteps; step++) {
          const midX = px + prevDx * stepSize * 0.5;
          const midY = py + prevDy * stepSize * 0.5;
          const midIdx =
            clamp(Math.round(midY), 0, height - 1) * width +
            clamp(Math.round(midX), 0, width - 1);

          let dirX = tangentX[midIdx];
          let dirY = tangentY[midIdx];
          if (dirX * prevDx + dirY * prevDy < 0) {
            dirX = -dirX;
            dirY = -dirY;
          }

          px += dirX * stepSize;
          py += dirY * stepSize;
          prevDx = dirX;
          prevDy = dirY;

          if (px < 0 || py < 0 || px >= width || py >= height) break;

          const w = flowWeights[step];
          integrated += sampleBilinear(crossDog, width, height, px, py) * w;
          weightTotal += w;
        }
      }

      const response = integrated / Math.max(1e-6, weightTotal);
      // Dark pencil edges correspond to negative DoG responses (darker than surround).
      const deficit = -response - noiseFloor;
      if (deficit > 0) {
        lineStrength[idx] = clamp01(Math.tanh(deficit * sharpness));
      }
    }
  }

  return lineStrength;
}

function buildGaussianWeights(radius: number, sigma: number): Float32Array {
  const weights = new Float32Array(radius + 1);
  const invTwoSigmaSq = 1 / (2 * sigma * sigma);
  let total = 0;
  for (let k = 0; k <= radius; k++) {
    const w = Math.exp(-(k * k) * invTwoSigmaSq);
    weights[k] = w;
    total += k === 0 ? w : w * 2;
  }
  for (let k = 0; k <= radius; k++) {
    weights[k] /= Math.max(1e-6, total);
  }
  return weights;
}
