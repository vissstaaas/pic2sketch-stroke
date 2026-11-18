import type { StrokeGenerationOptions } from '../../types/image-processing';
import type { PencilGrade, Stroke, StrokeKind, StrokeLayer } from '../../types/stroke';
import { clamp, clamp01, clampIndex } from '../../utils/math';
import type { SeededRandom } from '../../utils/random';
import type { SketchTarget } from '../image/buildSketchTarget';
import { computePercentile } from '../image/filters';
import { meanCurvature, resamplePoints, simplifyPoints, taperEnds } from './pathGeometry';
import { thinEdgeMap, traceEdgePaths } from './traceEdgePaths';

/**
 * Extracts crisp single-centerline silhouettes, facial/focal features, and garment folds
 * using the ETF perpendicular normal `(-tangentY, tangentX)` directly—eliminating
 * the Canny-on-ridge double-contour halo artifact.
 */
export function generateDetailContours(
  target: SketchTarget,
  options: StrokeGenerationOptions,
  rng: SeededRandom
): Stroke[] {
  const { width, height, detail, tone, darkness, foreground, coherence, tangentX, tangentY } =
    target;

  const contourField = new Float32Array(detail.length);
  const normalX = new Float32Array(detail.length);
  const normalY = new Float32Array(detail.length);

  for (let i = 0; i < detail.length; i++) {
    const deepMassPenalty = tone[i] > 0.48 ? 0.62 : 1.0;
    contourField[i] = detail[i] * deepMassPenalty;
    normalX[i] = -tangentY[i];
    normalY[i] = tangentX[i];
  }

  const thinned = thinEdgeMap(contourField, normalX, normalY, width, height);

  const sensitivity = clamp01(options.contourSensitivity);
  const bgSuppression = clamp01(options.backgroundSuppression);
  const paperGrain = clamp01(options.paperGrain ?? 0.35);
  const stylePreset = options.stylePreset ?? 'classic';

  const percentileRank = clamp(0.64 - sensitivity * 0.28, 0.3, 0.72);
  const baseHigh = computePercentile(thinned, percentileRank, 0.012);
  const highThreshold = clamp(baseHigh * (1.08 - sensitivity * 0.35), 0.038, 0.25);
  const lowThreshold = Math.max(0.015, highThreshold * (0.26 - sensitivity * 0.08));

  const scale = clamp(Math.max(width, height) / 768, 0.45, 1.6);
  const minLength = Math.max(2.6, options.minStrokeLength * 0.7 * scale);
  const maxLength = Math.max(24, options.maxStrokeLength * 1.15 * scale);

  const chains = traceEdgePaths(thinned, normalX, normalY, width, height, {
    highThreshold,
    lowThreshold,
    minLength,
    maxLength,
    subject: bgSuppression > 0.2 ? foreground : undefined,
    subjectGate: clamp(bgSuppression * 0.35, 0.04, 0.32),
  }).sort((a, b) => {
    const scoreA = a.strength * (0.55 + Math.min(55, a.length) / 95);
    const scoreB = b.strength * (0.55 + Math.min(55, b.length) / 95);
    return scoreB - scoreA;
  });

  const contourShare = stylePreset === 'lineart' ? 0.54 : stylePreset === 'portrait' ? 0.2 : 0.18;
  const maxStrokes = Math.max(36, Math.floor(options.targetStrokeCount * contourShare));
  const strokes: Stroke[] = [];

  for (let i = 0; i < chains.length && strokes.length < maxStrokes; i++) {
    const chain = chains[i];
    const simplified = simplifyPoints(chain.points, Math.max(0.48, 0.82 * scale));
    const points = resamplePoints(simplified, Math.max(1.25, 2.0 * scale));
    if (points.length < 2) continue;
    taperEnds(points, 4);

    const mid = points[Math.floor(points.length / 2)];
    const index = clampIndex(Math.round(mid.y) * width + Math.round(mid.x), detail.length);
    const rawStrength = clamp01(Math.max(chain.strength, detail[index]));
    const fg = foreground[index] ?? 1;
    const curvature = meanCurvature(simplified);

    const isIntricateFeature =
      fg > 0.4 &&
      chain.length < Math.min(width, height) * 0.26 &&
      (curvature > 0.2 || (rawStrength > 0.44 && coherence[index] < 0.75));

    let kind: StrokeKind = 'contour';
    let layer: StrokeLayer = 'outline';
    let grade: PencilGrade = 'HB';
    let priority = Math.round(48 + rawStrength * 20);

    if (rawStrength > 0.74 && darkness[index] > 0.48) {
      kind = 'accent';
      layer = 'finalAccent';
      grade = '6B';
      priority = Math.round(82 + rawStrength * 15);
    } else if (isIntricateFeature) {
      kind = 'feature';
      layer = 'features';
      grade = '2B';
      priority = Math.round(66 + rawStrength * 18);
    }

    strokes.push({
      id: `detail-${strokes.length + 1}`,
      kind,
      layer,
      order: 0,
      points,
      brush: {
        width: (0.58 + rawStrength * 0.56) * scale,
        opacity: clamp(0.24 + rawStrength * 0.48, 0.24, 0.76),
        hardness: grade === '6B' ? 0.86 : grade === '2B' ? 0.68 : 0.76,
        grain: clamp(0.14 + paperGrain * 0.22, 0.08, 0.45),
        jitter: rng.range(0.012, 0.04) * scale,
        grade,
      },
      durationMs: clamp(Math.round(chain.length * 2.0), 28, 150),
      priority,
      sourceConfidence: rawStrength,
    });
  }

  return strokes;
}
