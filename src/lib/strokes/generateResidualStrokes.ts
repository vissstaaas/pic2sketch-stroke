import { gaussianBlur, type SketchTarget } from '../image/buildSketchTarget';
import type { StrokeGenerationOptions } from '../../types/image-processing';
import type { Stroke, StrokeLayer, StrokePoint } from '../../types/stroke';
import type { SeededRandom } from '../../utils/random';

interface TonalPass {
  spacing: number;
  length: number;
  width: number;
  opacity: number;
  threshold: number;
  quota: number;
  layer: StrokeLayer;
  baseAngle: number;
  repeats: number;
}

interface Candidate {
  x: number;
  y: number;
  score: number;
  angleJitter: number;
}

/**
 * Reconstructs the hidden target with real, replayable graphite strokes.
 * Each pass compares the simulated paper against the target and spends its
 * stroke budget only where darkness is still missing.
 */
export function generateResidualStrokes(
  target: SketchTarget,
  options: StrokeGenerationOptions,
  rng: SeededRandom
): Stroke[] {
  const { width, height, darkness, detail, tangent, coherence } = target;
  const achieved = new Float32Array(width * height);
  const scale = clamp(Math.max(width, height) / 768, 0.45, 1.5);
  const budget = Math.max(100, Math.floor(options.targetStrokeCount * 0.84));
  const density = clamp(options.shadingDensity, 0.2, 1);
  const coarseTone = gaussianBlur(target.tone, width, height, Math.max(1, 2.8 * scale));
  const midTone = gaussianBlur(target.tone, width, height, Math.max(0.7, 1.35 * scale));
  const passes: TonalPass[] = [
    {
      spacing: 17 * scale,
      length: 34 * scale,
      width: 5.2 * scale,
      opacity: 0.14,
      threshold: 0.075,
      quota: Math.round(budget * 0.14),
      layer: 'lightTone',
      baseAngle: -0.52,
      repeats: 3,
    },
    {
      spacing: 10.5 * scale,
      length: 23 * scale,
      width: 3.25 * scale,
      opacity: 0.17,
      threshold: 0.052,
      quota: Math.round(budget * 0.22),
      layer: 'midTone',
      baseAngle: 0.48,
      repeats: 3,
    },
    {
      spacing: 6.4 * scale,
      length: 14 * scale,
      width: 1.85 * scale,
      opacity: 0.2,
      threshold: 0.036,
      quota: Math.round(budget * 0.28),
      layer: 'darkTone',
      baseAngle: -0.36,
      repeats: 3,
    },
    {
      spacing: 4.1 * scale,
      length: 8.5 * scale,
      width: 1.05 * scale,
      opacity: 0.24,
      threshold: 0.026,
      quota: Math.round(budget * 0.22),
      layer: 'finalAccent',
      baseAngle: 0.7,
      repeats: 2,
    },
    {
      spacing: 3.15 * scale,
      length: 6.2 * scale,
      width: 0.78 * scale,
      opacity: 0.29,
      threshold: 0.014,
      quota: Math.round(budget * 0.14),
      layer: 'finalAccent',
      baseAngle: -0.66,
      repeats: 4,
    },
  ];

  const strokes: Stroke[] = [];
  let id = 0;

  for (let passIndex = 0; passIndex < passes.length; passIndex++) {
    const pass = passes[passIndex];
    const passTarget = passIndex === 0 ? coarseTone : passIndex === 1 ? midTone : darkness;
    const candidates = buildCandidates(target, passTarget, achieved, pass, rng);
    let used = 0;

    for (const candidate of candidates) {
      if (used >= pass.quota || strokes.length >= budget) break;
      const index = Math.round(candidate.y) * width + Math.round(candidate.x);
      const residual = localResidual(passTarget, achieved, width, height, candidate.x, candidate.y, pass.width * 0.8);
      if (residual < pass.threshold / density) continue;

      const localTone = passTarget[index] ?? 0;
      const reliableFlow = (coherence[index] ?? 0) > 0.1;
      const angle = reliableFlow
        ? tangent[index] + candidate.angleJitter * 0.16
        : pass.baseAngle + candidate.angleJitter * 0.24;
      const length = pass.length * clamp(0.7 + residual * 1.25 + localTone * 0.22, 0.65, 1.55);
      const opacity = clamp(pass.opacity + residual * 0.22, 0.1, passIndex >= 3 ? 0.52 : 0.36);
      const points = buildStrokePoints(
        target,
        passTarget,
        achieved,
        candidate.x,
        candidate.y,
        angle,
        length,
        pass.width,
        pass.threshold / density,
        rng
      );
      if (points.length < 2) continue;

      const confidence = clamp(localTone * 0.65 + detail[index] * 0.35, 0.05, 1);
      const stroke: Stroke = {
        id: `tone-${passIndex}-${++id}`,
        kind: passIndex >= 2 ? 'crossHatching' : 'hatching',
        layer: pass.layer,
        order: 0,
        points,
        brush: {
          width: pass.width,
          opacity,
          hardness: Math.min(0.9, 0.48 + passIndex * 0.09),
          grain: 0.28,
          jitter: 0.06 * scale,
        },
        durationMs: clamp(Math.round(length * 1.8), 28, 95),
        priority: 25 + passIndex * 12 + Math.round(confidence * 10),
        sourceConfidence: confidence,
      };

      strokes.push(stroke);
      rasterizeStroke(achieved, width, height, stroke);
      used++;
    }
  }

  return strokes;
}

function buildCandidates(
  target: SketchTarget,
  passTarget: Float32Array,
  achieved: Float32Array,
  pass: TonalPass,
  rng: SeededRandom
): Candidate[] {
  const { width, height, detail } = target;
  const candidates: Candidate[] = [];
  const spacing = Math.max(2.4, pass.spacing);

  for (let repeat = 0; repeat < pass.repeats; repeat++) {
    const offsetX = ((repeat + 0.35) / pass.repeats) * spacing;
    const offsetY = (((repeat * 0.618) % 1) + 0.2) * spacing;
    for (let y = offsetY; y < height; y += spacing) {
      for (let x = offsetX; x < width; x += spacing) {
        const jitterX = rng.range(-spacing * 0.28, spacing * 0.28);
        const jitterY = rng.range(-spacing * 0.28, spacing * 0.28);
        const px = clamp(x + jitterX, 1, width - 2);
        const py = clamp(y + jitterY, 1, height - 2);
        const index = Math.round(py) * width + Math.round(px);
        const residual = Math.max(0, passTarget[index] - achieved[index]);
        const score = residual + detail[index] * 0.12 + rng.next() * 0.008;
        if (score >= pass.threshold * 0.7) {
          candidates.push({ x: px, y: py, score, angleJitter: rng.range(-1, 1) });
        }
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

function buildStrokePoints(
  target: SketchTarget,
  passTarget: Float32Array,
  achieved: Float32Array,
  centerX: number,
  centerY: number,
  angle: number,
  length: number,
  width: number,
  threshold: number,
  rng: SeededRandom
): StrokePoint[] {
  const { width: imageWidth, height } = target;
  const directionX = Math.cos(angle);
  const directionY = Math.sin(angle);
  const normalX = -directionY;
  const normalY = directionX;
  const steps = Math.max(4, Math.min(13, Math.ceil(length / Math.max(1.8, width * 0.8))));
  const bend = rng.range(-0.06, 0.06) * length;
  const samples: Array<StrokePoint & { active: boolean }> = [];

  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const along = (u - 0.5) * length;
    const curve = Math.sin((u - 0.5) * Math.PI) * bend;
    const x = centerX + directionX * along + normalX * curve;
    const y = centerY + directionY * along + normalY * curve;
    if (x < 0.5 || y < 0.5 || x > imageWidth - 1.5 || y > height - 1.5) continue;

    const index = Math.round(y) * imageWidth + Math.round(x);
    const residual = Math.max(0, passTarget[index] - achieved[index]);
    const taper = Math.pow(Math.sin(Math.PI * clamp(u, 0.02, 0.98)), 0.45);
    const pressure = clamp(0.16 + taper * (0.38 + residual * 0.62), 0.16, 1);
    samples.push({
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      pressure,
      active: residual > threshold * 0.32 || passTarget[index] > threshold * 1.35,
    });
  }

  if (samples.length < 2) return [];
  const center = Math.floor(samples.length / 2);
  let seed = center;
  while (seed > 0 && !samples[seed].active) seed--;
  if (!samples[seed].active) {
    seed = center + 1;
    while (seed < samples.length && !samples[seed].active) seed++;
  }
  if (seed >= samples.length || !samples[seed].active) return [];

  let start = seed;
  let end = seed;
  while (start > 0 && samples[start - 1].active) start--;
  while (end + 1 < samples.length && samples[end + 1].active) end++;
  if (end - start < 1) {
    if (start > 0 && samples[start - 1]) start--;
    else if (end + 1 < samples.length) end++;
  }
  return samples.slice(start, end + 1).map(({ x, y, pressure }) => ({ x, y, pressure }));
}

function rasterizeStroke(
  achieved: Float32Array,
  width: number,
  height: number,
  stroke: Stroke
): void {
  for (let p = 1; p < stroke.points.length; p++) {
    const a = stroke.points[p - 1];
    const b = stroke.points[p];
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(distance / 0.75));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const pressure = a.pressure + (b.pressure - a.pressure) * t;
      const radius = Math.max(0.45, stroke.brush.width * pressure * 0.5);
      depositDisk(achieved, width, height, x, y, radius, stroke.brush.opacity);
    }
  }
}

function depositDisk(
  achieved: Float32Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  opacity: number
): void {
  const minX = Math.max(0, Math.floor(cx - radius - 1));
  const maxX = Math.min(width - 1, Math.ceil(cx + radius + 1));
  const minY = Math.max(0, Math.floor(cy - radius - 1));
  const maxY = Math.min(height - 1, Math.ceil(cy + radius + 1));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const coverage = clamp(radius + 0.55 - distance, 0, 1);
      if (coverage <= 0) continue;
      const index = y * width + x;
      const alpha = opacity * coverage;
      achieved[index] = 1 - (1 - achieved[index]) * (1 - alpha);
    }
  }
}

function localResidual(
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
    for (let dx = -r; dx <= r; dx++) {
      const px = cx + dx;
      if (px < 0 || px >= width) continue;
      const weight = 1 / (1 + dx * dx + dy * dy);
      const index = py * width + px;
      sum += Math.max(0, target[index] - achieved[index]) * weight;
      weightSum += weight;
    }
  }
  return sum / Math.max(1e-6, weightSum);
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}
