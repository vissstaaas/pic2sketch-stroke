import type { SketchTarget } from '../image/buildSketchTarget';
import type { StrokeGenerationOptions } from '../../types/image-processing';
import type { Stroke, StrokeKind, StrokeLayer } from '../../types/stroke';
import type { SeededRandom } from '../../utils/random';
import { resamplePoints, simplifyPoints, taperEnds } from './pathGeometry';
import { thinEdgeMap, traceEdgePaths } from './traceEdgePaths';

/** Adds a restrained final pass for silhouettes and high-confidence features. */
export function generateDetailContours(
  target: SketchTarget,
  options: StrokeGenerationOptions,
  rng: SeededRandom
): Stroke[] {
  const { width, height, detail, darkness } = target;
  const normalX = new Float32Array(detail.length);
  const normalY = new Float32Array(detail.length);

  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      normalX[i] =
        -detail[i - width - 1] + detail[i - width + 1] +
        -2 * detail[i - 1] + 2 * detail[i + 1] +
        -detail[i + width - 1] + detail[i + width + 1];
      normalY[i] =
        -detail[i - width - 1] - 2 * detail[i - width] - detail[i - width + 1] +
        detail[i + width - 1] + 2 * detail[i + width] + detail[i + width + 1];
    }
  }

  const thinned = thinEdgeMap(detail, normalX, normalY, width, height);
  const high = clamp(percentileNonZero(thinned, 0.58), 0.075, 0.28);
  const scale = clamp(Math.max(width, height) / 768, 0.45, 1.5);
  const chains = traceEdgePaths(thinned, normalX, normalY, width, height, {
    highThreshold: high,
    lowThreshold: Math.max(0.02, high * 0.2),
    minLength: Math.max(2.6, options.minStrokeLength * 0.65 * scale),
    maxLength: Math.max(45, options.maxStrokeLength * 1.15 * scale),
  }).sort((a, b) => {
    const scoreA = a.strength * (0.65 + Math.min(35, a.length) / 100);
    const scoreB = b.strength * (0.65 + Math.min(35, b.length) / 100);
    return scoreB - scoreA;
  });

  const maxStrokes = Math.max(30, Math.floor(options.targetStrokeCount * 0.16));
  const strokes: Stroke[] = [];
  for (let i = 0; i < chains.length && strokes.length < maxStrokes; i++) {
    const chain = chains[i];
    const simplified = simplifyPoints(chain.points, Math.max(0.55, 0.9 * scale));
    const points = resamplePoints(simplified, Math.max(1.4, 2.2 * scale));
    if (points.length < 2) continue;
    taperEnds(points, 4);

    const mid = points[Math.floor(points.length / 2)];
    const index = clampIndex(Math.round(mid.y) * width + Math.round(mid.x), detail.length);
    const strength = clamp(Math.max(chain.strength, detail[index]), 0, 1);
    const centreX = Math.abs(mid.x / width - 0.5);
    const centreY = Math.abs(mid.y / height - 0.46);
    const centralFeature = centreX < 0.28 && centreY < 0.3 && chain.length < width * 0.28;

    let kind: StrokeKind = 'contour';
    let layer: StrokeLayer = 'outline';
    let priority = 46;
    if (centralFeature) {
      kind = 'feature';
      layer = 'features';
      priority = 68;
    } else if (strength > 0.72 && darkness[index] > 0.45) {
      kind = 'accent';
      layer = 'finalAccent';
      priority = 82;
    }

    strokes.push({
      id: `detail-${strokes.length + 1}`,
      kind,
      layer,
      order: 0,
      points,
      brush: {
        width: (0.72 + strength * 0.72) * scale,
        opacity: clamp(0.32 + strength * 0.5, 0.34, 0.78),
        hardness: 0.72,
        grain: 0.2,
        jitter: rng.range(0.015, 0.055) * scale,
      },
      durationMs: clamp(Math.round(chain.length * 2.1), 32, 150),
      priority,
      sourceConfidence: strength,
    });
  }

  return strokes;
}

function percentileNonZero(source: Float32Array, fraction: number): number {
  const step = Math.max(1, Math.floor(source.length / 24000));
  const values: number[] = [];
  for (let i = 0; i < source.length; i += step) {
    if (source[i] > 0.01) values.push(source[i]);
  }
  if (values.length === 0) return 0.2;
  values.sort((a, b) => a - b);
  return values[Math.round(clamp(fraction, 0, 1) * (values.length - 1))];
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function clampIndex(index: number, length: number): number {
  return index < 0 ? 0 : index >= length ? length - 1 : index;
}
