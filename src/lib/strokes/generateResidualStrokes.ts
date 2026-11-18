import type { StrokeGenerationOptions } from '../../types/image-processing';
import type { PencilGrade, Stroke, StrokeLayer, StrokePoint } from '../../types/stroke';
import { clamp, clamp01 } from '../../utils/math';
import type { SeededRandom } from '../../utils/random';
import { createRasterScratch, rasterizeStrokeCoverage } from '../canvas/brushMath';
import { gaussianBlur, type SketchTarget } from '../image/buildSketchTarget';

interface TonalPassConfig {
  spacing: number;
  length: number;
  width: number;
  opacity: number;
  threshold: number;
  quotaRatio: number;
  layer: StrokeLayer;
  grade: PencilGrade;
  crossOffsetRad: number;
  fallbackAngleRad: number;
  repeats: number;
}

interface TonalCandidate {
  x: number;
  y: number;
  score: number;
  jitterRad: number;
}

/**
 * Coarse-to-fine greedy residual tonal planner with ETF streamline tracing,
 * multi-angle cross-hatching, and zero-allocation sparse ribbon coverage accounting.
 */
export function generateResidualStrokes(
  target: SketchTarget,
  options: StrokeGenerationOptions,
  rng: SeededRandom,
  preLaidStrokes?: readonly Stroke[]
): Stroke[] {
  const { width, height, darkness, detail, foreground, tangent, tangentX, tangentY, coherence } =
    target;
  const achieved = new Float32Array(width * height);
  const rasterScratch = createRasterScratch(width, height);

  if (preLaidStrokes && preLaidStrokes.length > 0) {
    for (const s of preLaidStrokes) {
      rasterizeStrokeCoverage(
        achieved,
        width,
        height,
        {
          ...s,
          brush: { ...s.brush, opacity: s.brush.opacity * 0.7 },
        },
        rasterScratch
      );
    }
  }

  const scale = clamp(Math.max(width, height) / 768, 0.45, 1.6);
  const stylePreset = options.stylePreset ?? 'classic';
  const tonalShare = stylePreset === 'lineart' ? 0.42 : stylePreset === 'portrait' ? 0.76 : 0.78;
  const budget = Math.max(60, Math.floor(options.targetStrokeCount * tonalShare));
  const density = clamp(options.shadingDensity, 0.2, 1);
  const bgSuppression = clamp01(options.backgroundSuppression);
  const paperGrain = clamp01(options.paperGrain ?? 0.35);

  const minAllowedLen = Math.max(2.2, options.minStrokeLength * 0.7 * scale);
  const maxAllowedLen = Math.max(minAllowedLen + 4, options.maxStrokeLength * scale);

  const broadTone = gaussianBlur(target.tone, width, height, Math.max(1.0, 2.5 * scale));
  const midFormTone = gaussianBlur(target.tone, width, height, Math.max(0.7, 1.2 * scale));

  // Pass 0 & 1 include low thresholds (0.018 / 0.025) so delicate skin half-tones,
  // neck shadows, and white-garment pleats receive translucent HB/2B form modeling.
  const passes: TonalPassConfig[] = [
    {
      spacing: 14.0 * scale,
      length: clamp(35 * scale, minAllowedLen, maxAllowedLen),
      width: 4.8 * scale,
      opacity: 0.1,
      threshold: 0.022,
      quotaRatio: 0.16,
      layer: 'lightTone',
      grade: 'HB',
      crossOffsetRad: 0,
      fallbackAngleRad: -0.66,
      repeats: 3,
    },
    {
      spacing: 9.0 * scale,
      length: clamp(24 * scale, minAllowedLen, maxAllowedLen),
      width: 3.0 * scale,
      opacity: 0.16,
      threshold: 0.032,
      quotaRatio: 0.23,
      layer: 'midTone',
      grade: '2B',
      crossOffsetRad: 0.58,
      fallbackAngleRad: -0.08,
      repeats: 3,
    },
    {
      spacing: 5.6 * scale,
      length: clamp(15 * scale, minAllowedLen, maxAllowedLen),
      width: 1.85 * scale,
      opacity: 0.24,
      threshold: 0.028,
      quotaRatio: 0.26,
      layer: 'darkTone',
      grade: '4B',
      crossOffsetRad: -0.46,
      fallbackAngleRad: -1.12,
      repeats: 3,
    },
    {
      spacing: 3.8 * scale,
      length: clamp(9.2 * scale, minAllowedLen, maxAllowedLen),
      width: 1.12 * scale,
      opacity: 0.3,
      threshold: 0.02,
      quotaRatio: 0.2,
      layer: 'finalAccent',
      grade: '4B',
      crossOffsetRad: 0.24,
      fallbackAngleRad: 0.52,
      repeats: 3,
    },
    {
      spacing: 2.8 * scale,
      length: clamp(6.4 * scale, minAllowedLen, maxAllowedLen),
      width: 0.82 * scale,
      opacity: 0.36,
      threshold: 0.013,
      quotaRatio: 0.14,
      layer: 'finalAccent',
      grade: '6B',
      crossOffsetRad: 0,
      fallbackAngleRad: -0.62,
      repeats: 4,
    },
  ];

  const strokes: Stroke[] = [];
  let serial = 0;

  for (let passIndex = 0; passIndex < passes.length; passIndex++) {
    const pass = passes[passIndex];
    const passQuota = Math.max(8, Math.round(budget * pass.quotaRatio));
    const passTarget = passIndex === 0 ? broadTone : passIndex === 1 ? midFormTone : darkness;
    const effectiveThreshold = pass.threshold / Math.pow(density, 0.85);

    const candidates = samplePassCandidates(
      width,
      height,
      passTarget,
      detail,
      foreground,
      achieved,
      pass,
      effectiveThreshold,
      bgSuppression,
      rng
    );

    let placedInPass = 0;
    for (const candidate of candidates) {
      if (placedInPass >= passQuota || strokes.length >= budget) break;

      const idx = Math.round(candidate.y) * width + Math.round(candidate.x);
      const residual = computeLocalResidual(
        passTarget,
        achieved,
        width,
        height,
        candidate.x,
        candidate.y,
        pass.width * 0.72
      );
      if (residual < effectiveThreshold) continue;

      const localCoherence = coherence[idx] ?? 0;
      const localTone = passTarget[idx] ?? 0;

      let baseAngle: number;
      let streamlineFollowWeight: number;
      if (localCoherence > 0.36) {
        baseAngle = tangent[idx] + pass.crossOffsetRad * 0.18 + candidate.jitterRad * 0.1;
        streamlineFollowWeight = 0.88;
      } else if (localCoherence > 0.12) {
        baseAngle = tangent[idx] + pass.crossOffsetRad * 0.75 + candidate.jitterRad * 0.14;
        streamlineFollowWeight = 0.45;
      } else {
        baseAngle = pass.fallbackAngleRad + candidate.jitterRad * 0.2;
        streamlineFollowWeight = 0.15;
      }

      const desiredLength = clamp(
        pass.length * clamp(0.72 + residual * 1.15 + localTone * 0.2, 0.65, 1.48),
        minAllowedLen,
        maxAllowedLen
      );

      // Scale opacity gently down for ultra-light skin/garment half-tones so strokes whisper
      const maxOpacity = passIndex >= 4 ? 0.65 : passIndex >= 3 ? 0.52 : 0.4;
      const adaptiveBaseOpacity =
        residual < 0.06 ? Math.min(pass.opacity, residual * 1.65 + 0.035) : pass.opacity;
      const opacity = clamp(adaptiveBaseOpacity + residual * 0.28, 0.045, maxOpacity);

      const points = traceStreamlineHatch(
        width,
        height,
        passTarget,
        achieved,
        tangentX,
        tangentY,
        coherence,
        candidate.x,
        candidate.y,
        baseAngle,
        streamlineFollowWeight,
        desiredLength,
        pass.width,
        effectiveThreshold,
        rng
      );
      if (points.length < 2) continue;

      const confidence = clamp(localTone * 0.68 + (detail[idx] ?? 0) * 0.32, 0.05, 1);
      const stroke: Stroke = {
        id: `tone-${passIndex}-${++serial}`,
        kind: passIndex >= 1 && Math.abs(pass.crossOffsetRad) > 0.2 ? 'crossHatching' : 'hatching',
        layer: pass.layer,
        order: 0,
        points,
        brush: {
          width: pass.width,
          opacity,
          hardness: Math.min(0.92, 0.46 + passIndex * 0.1),
          grain: clamp(0.18 + paperGrain * 0.32, 0.1, 0.55),
          jitter: 0.048 * scale,
          grade: pass.grade,
        },
        durationMs: clamp(Math.round(desiredLength * 1.7), 24, 96),
        priority: 24 + passIndex * 12 + Math.round(confidence * 10),
        sourceConfidence: confidence,
      };

      strokes.push(stroke);
      rasterizeStrokeCoverage(achieved, width, height, stroke, rasterScratch);
      placedInPass++;
    }
  }

  return strokes;
}

function samplePassCandidates(
  width: number,
  height: number,
  passTarget: Float32Array,
  detail: Float32Array,
  foreground: Float32Array,
  achieved: Float32Array,
  pass: TonalPassConfig,
  effectiveThreshold: number,
  bgSuppression: number,
  rng: SeededRandom
): TonalCandidate[] {
  const candidates: TonalCandidate[] = [];
  const spacing = Math.max(2.2, pass.spacing);

  for (let repeat = 0; repeat < pass.repeats; repeat++) {
    const offsetX = ((repeat + 0.31) / pass.repeats) * spacing;
    const offsetY = (((repeat * 0.618034) % 1) + 0.19) * spacing;

    for (let y = offsetY; y < height - 1; y += spacing) {
      for (let x = offsetX; x < width - 1; x += spacing) {
        const px = clamp(x + rng.range(-spacing * 0.3, spacing * 0.3), 1, width - 2);
        const py = clamp(y + rng.range(-spacing * 0.3, spacing * 0.3), 1, height - 2);
        const idx = Math.round(py) * width + Math.round(px);

        if (bgSuppression > 0.3 && (foreground[idx] ?? 1) < 0.08 && passTarget[idx] < 0.12) {
          continue;
        }

        const residual = Math.max(0, passTarget[idx] - achieved[idx]);
        if (residual < effectiveThreshold * 0.65) continue;

        const score =
          residual * (0.85 + 0.15 * (foreground[idx] ?? 1)) +
          detail[idx] * 0.1 +
          rng.next() * 0.006;

        candidates.push({
          x: px,
          y: py,
          score,
          jitterRad: rng.range(-1, 1),
        });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

function traceStreamlineHatch(
  width: number,
  height: number,
  passTarget: Float32Array,
  achieved: Float32Array,
  tangentX: Float32Array,
  tangentY: Float32Array,
  coherence: Float32Array,
  centerX: number,
  centerY: number,
  initialAngle: number,
  followWeight: number,
  totalLength: number,
  brushWidth: number,
  threshold: number,
  rng: SeededRandom
): StrokePoint[] {
  const halfSteps = clamp(Math.ceil((totalLength * 0.5) / Math.max(1.6, brushWidth * 0.85)), 2, 8);
  const stepLen = totalLength / (halfSteps * 2);
  const subtleArc = rng.range(-0.04, 0.04);

  type RawSample = StrokePoint & { active: boolean };

  const marchHalf = (sign: 1 | -1): RawSample[] => {
    const out: RawSample[] = [];
    let x = centerX;
    let y = centerY;
    let dirX = Math.cos(initialAngle) * sign;
    let dirY = Math.sin(initialAngle) * sign;

    for (let s = 1; s <= halfSteps; s++) {
      const idx =
        clamp(Math.round(y), 0, height - 1) * width + clamp(Math.round(x), 0, width - 1);
      const coh = coherence[idx] ?? 0;
      const blend = followWeight * clamp01(coh * 1.4);

      if (blend > 0.05) {
        let fx = tangentX[idx];
        let fy = tangentY[idx];
        if (fx * dirX + fy * dirY < 0) {
          fx = -fx;
          fy = -fy;
        }
        dirX = dirX * (1 - blend) + fx * blend;
        dirY = dirY * (1 - blend) + fy * blend;
      }

      const cosArc = Math.cos(subtleArc * sign);
      const sinArc = Math.sin(subtleArc * sign);
      const rx = dirX * cosArc - dirY * sinArc;
      const ry = dirX * sinArc + dirY * cosArc;
      const norm = Math.hypot(rx, ry) || 1;
      dirX = rx / norm;
      dirY = ry / norm;

      x += dirX * stepLen;
      y += dirY * stepLen;

      if (x < 0.5 || y < 0.5 || x > width - 1.5 || y > height - 1.5) break;

      const pIdx = Math.round(y) * width + Math.round(x);
      const residual = Math.max(0, passTarget[pIdx] - achieved[pIdx]);
      const u = 0.5 + (sign * s) / (halfSteps * 2);
      const taper = Math.pow(Math.sin(Math.PI * clamp(u, 0.03, 0.97)), 0.48);
      const pressure = clamp(0.16 + taper * (0.36 + residual * 0.64), 0.16, 1);

      out.push({
        x: Math.round(x * 10) / 10,
        y: Math.round(y * 10) / 10,
        pressure,
        active: residual > threshold * 0.28 || passTarget[pIdx] > threshold * 1.25,
      });
    }
    return out;
  };

  const centerIdx =
    clamp(Math.round(centerY), 0, height - 1) * width +
    clamp(Math.round(centerX), 0, width - 1);
  const centerResidual = Math.max(0, passTarget[centerIdx] - achieved[centerIdx]);
  const centerSample: RawSample = {
    x: Math.round(centerX * 10) / 10,
    y: Math.round(centerY * 10) / 10,
    pressure: clamp(0.45 + centerResidual * 0.55, 0.22, 1),
    active: true,
  };

  const backward = marchHalf(-1).reverse();
  const forward = marchHalf(1);
  const samples = [...backward, centerSample, ...forward];
  if (samples.length < 2) return [];

  const seedIdx = backward.length;
  let start = seedIdx;
  let end = seedIdx;
  while (start > 0 && samples[start - 1].active) start--;
  while (end + 1 < samples.length && samples[end + 1].active) end++;

  if (end - start < 1) {
    if (start > 0) start--;
    else if (end + 1 < samples.length) end++;
  }

  const trimmed = samples.slice(start, end + 1);
  if (trimmed.length < 2) return [];

  return trimmed.map(({ x, y, pressure }) => ({ x, y, pressure }));
}

function computeLocalResidual(
  target: Float32Array,
  achieved: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number
): number {
  const r = Math.max(1, Math.round(radius));
  const cx = Math.round(x);
  const cy = Math.round(y);
  let sum = 0;
  let weightSum = 0;

  for (let dy = -r; dy <= r; dy++) {
    const py = cy + dy;
    if (py < 0 || py >= height) continue;
    const row = py * width;
    for (let dx = -r; dx <= r; dx++) {
      const px = cx + dx;
      if (px < 0 || px >= width) continue;
      const weight = 1 / (1 + dx * dx + dy * dy);
      sum += Math.max(0, target[row + px] - achieved[row + px]) * weight;
      weightSum += weight;
    }
  }
  return sum / Math.max(1e-6, weightSum);
}
