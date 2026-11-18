import type { StrokeGenerationOptions } from '../../types/image-processing';
import type { Stroke, StrokePoint } from '../../types/stroke';
import { clamp } from '../../utils/math';
import type { SeededRandom } from '../../utils/random';
import type { SketchTarget } from '../image/buildSketchTarget';
import { computePercentile, gaussianBlur } from '../image/filters';
import { pathLength, simplifyPoints, taperEnds } from './pathGeometry';
import { thinEdgeMap, traceEdgePaths } from './traceEdgePaths';

/**
 * Generates light 2H geometric block-in construction strokes (`structure` layer)
 * using the true ETF surface normal so ridges never split into hollow double lines.
 */
export function generateConstructionStrokes(
  target: SketchTarget,
  options: StrokeGenerationOptions,
  rng: SeededRandom
): Stroke[] {
  const { width, height, structuralEdge, foreground, tangentX, tangentY } = target;
  if (width < 32 || height < 32) return [];

  const scale = clamp(Math.max(width, height) / 768, 0.45, 1.6);
  const macroField = gaussianBlur(structuralEdge, width, height, 1.2 * scale);

  const normalX = new Float32Array(macroField.length);
  const normalY = new Float32Array(macroField.length);
  for (let i = 0; i < macroField.length; i++) {
    normalX[i] = -tangentY[i];
    normalY[i] = tangentX[i];
  }

  const thinned = thinEdgeMap(macroField, normalX, normalY, width, height);

  const highThreshold = clamp(computePercentile(thinned, 0.72, 0.015), 0.05, 0.24);
  const minLen = Math.max(16 * scale, options.minStrokeLength * 2.5 * scale);
  const maxLen = Math.max(85 * scale, options.maxStrokeLength * 1.45 * scale);

  const chains = traceEdgePaths(thinned, normalX, normalY, width, height, {
    highThreshold,
    lowThreshold: Math.max(0.018, highThreshold * 0.35),
    minLength: minLen,
    maxLength: maxLen,
    subject: foreground,
    subjectGate: options.backgroundSuppression > 0.35 ? 0.22 : 0,
  });

  const maxStructureStrokes = clamp(Math.round(options.targetStrokeCount * 0.022), 6, 42);
  const paperGrain = clamp(options.paperGrain ?? 0.35, 0, 1);
  const strokes: Stroke[] = [];

  for (let i = 0; i < chains.length && strokes.length < maxStructureStrokes; i++) {
    const chain = chains[i];
    const simplified = simplifyPoints(chain.points, Math.max(2.4, 4.0 * scale));
    if (simplified.length < 2) continue;

    const extended = addLightOverstroke(simplified, width, height, 3.0 * scale);
    for (const pt of extended) {
      pt.pressure = clamp(pt.pressure * 0.52, 0.15, 0.45);
    }
    taperEnds(extended, 2);

    const len = pathLength(extended);
    if (len < minLen * 0.75) continue;

    strokes.push({
      id: `struct-${strokes.length + 1}`,
      kind: 'construction',
      layer: 'structure',
      order: 0,
      points: extended,
      brush: {
        width: 0.8 * scale,
        opacity: clamp(0.08 + chain.strength * 0.07, 0.07, 0.14),
        hardness: 0.88,
        grain: clamp(0.18 + paperGrain * 0.25, 0.1, 0.5),
        jitter: rng.range(0.02, 0.045) * scale,
        grade: '2H',
      },
      durationMs: clamp(Math.round(len * 1.3), 28, 110),
      priority: Math.round(50 + Math.min(40, len / Math.max(1, scale * 3))),
      sourceConfidence: clamp(chain.strength, 0.1, 1),
    });
  }

  return strokes;
}

function addLightOverstroke(
  points: StrokePoint[],
  width: number,
  height: number,
  extension: number
): StrokePoint[] {
  if (points.length < 2 || extension <= 0.5) return points;

  const first = points[0];
  const second = points[1];
  const startDx = first.x - second.x;
  const startDy = first.y - second.y;
  const startLen = Math.hypot(startDx, startDy) || 1;

  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  const endDx = last.x - prev.x;
  const endDy = last.y - prev.y;
  const endLen = Math.hypot(endDx, endDy) || 1;

  const startTip: StrokePoint = {
    x: Math.round(clamp(first.x + (startDx / startLen) * extension, 1, width - 2) * 10) / 10,
    y: Math.round(clamp(first.y + (startDy / startLen) * extension, 1, height - 2) * 10) / 10,
    pressure: 0.15,
  };
  const endTip: StrokePoint = {
    x: Math.round(clamp(last.x + (endDx / endLen) * extension, 1, width - 2) * 10) / 10,
    y: Math.round(clamp(last.y + (endDy / endLen) * extension, 1, height - 2) * 10) / 10,
    pressure: 0.15,
  };

  return [startTip, ...points, endTip];
}
