import type { StrokeGenerationOptions } from '../../types/image-processing';
import type { PencilGrade, Stroke, StrokeKind, StrokeLayer } from '../../types/stroke';
import { clamp, clamp01, clampIndex, smoothstep } from '../../utils/math';
import type { SeededRandom } from '../../utils/random';
import type { SketchTarget } from '../image/buildSketchTarget';
import { computePercentile, gaussianBlur } from '../image/filters';
import {
  meanCurvature,
  resamplePoints,
  simplifyPoints,
  taperEnds,
  tuckPointsOffCleanPaper,
} from './pathGeometry';
import { thinEdgeMap, traceEdgePaths } from './traceEdgePaths';

/**
 * Extracts crisp single-centerline silhouettes, facial/focal features, and garment folds
 * using the ETF perpendicular normal `(-tangentY, tangentX)` directly—eliminating
 * the Canny-on-ridge double-contour halo artifact while suppressing repetitive hair/foliage clutter.
 */
export function generateDetailContours(
  target: SketchTarget,
  options: StrokeGenerationOptions,
  rng: SeededRandom
): Stroke[] {
  const { width, height, detail, tone, darkness, foreground, coherence, tangentX, tangentY } =
    target;

  const scale = clamp(Math.max(width, height) / 768, 0.45, 1.6);
  const stylePreset = options.stylePreset ?? 'classic';
  const wideDetailDensity = gaussianBlur(detail, width, height, Math.max(3.5, 9.5 * scale));

  const contourField = new Float32Array(detail.length);
  const normalX = new Float32Array(detail.length);
  const normalY = new Float32Array(detail.length);

  // Architecture preserves crisp straight dark edges (eaves, windows, bridges, railings);
  // Landscape suppresses chaotic dense bush/leaf spaghetti more firmly.
  const clutterGain =
    stylePreset === 'architecture' ? 0.65 : stylePreset === 'landscape' ? 3.8 : 3.0;

  for (let i = 0; i < detail.length; i++) {
    // Suppress chaotic repetitive interior hair/foliage spaghetti (high wideDetailDensity + dark tone + LOW coherence)
    // WITHOUT erasing coherent straight architectural edges, bridge railings, or isolated eyes/noses!
    const chaoticWeight = 1 - smoothstep(0.56, 0.86, coherence[i]);
    const clutterPenalty =
      tone[i] > 0.36 && wideDetailDensity[i] > 0.14
        ? 1 / (1 + (wideDetailDensity[i] - 0.14) * clutterGain * chaoticWeight)
        : 1.0;
    contourField[i] = detail[i] * clutterPenalty;
    normalX[i] = -tangentY[i];
    normalY[i] = tangentX[i];
  }

  const thinned = thinEdgeMap(contourField, normalX, normalY, width, height);

  const sensitivity = clamp01(options.contourSensitivity);
  const bgSuppression = clamp01(options.backgroundSuppression);
  const paperGrain = clamp01(options.paperGrain ?? 0.35);

  const percentileRank = clamp(0.64 - sensitivity * 0.28, 0.3, 0.72);
  const baseHigh = computePercentile(thinned, percentileRank, 0.012);
  const highThreshold = clamp(baseHigh * (1.04 - sensitivity * 0.35), 0.032, 0.23);
  const lowThreshold = Math.max(0.014, highThreshold * (0.26 - sensitivity * 0.08));

  const minLength = Math.max(2.4, options.minStrokeLength * 0.68 * scale);
  const maxLength = Math.max(24, options.maxStrokeLength * 1.15 * scale);

  const chains = traceEdgePaths(thinned, normalX, normalY, width, height, {
    highThreshold,
    lowThreshold,
    minLength,
    maxLength,
    subject: bgSuppression > 0.2 ? foreground : undefined,
    subjectGate: clamp(bgSuppression * 0.35, 0.04, 0.32),
  }).sort((a, b) => {
    const midA = a.points[Math.floor(a.points.length / 2)];
    const midB = b.points[Math.floor(b.points.length / 2)];
    const fgA = foreground[clampIndex(Math.round(midA.y) * width + Math.round(midA.x), foreground.length)] ?? 1;
    const fgB = foreground[clampIndex(Math.round(midB.y) * width + Math.round(midB.x), foreground.length)] ?? 1;
    const scoreA = a.strength * (0.55 + Math.min(55, a.length) / 95) * (0.72 + 0.28 * fgA);
    const scoreB = b.strength * (0.55 + Math.min(55, b.length) / 95) * (0.72 + 0.28 * fgB);
    return scoreB - scoreA;
  });

  const contourShare =
    stylePreset === 'lineart'
      ? 0.54
      : stylePreset === 'architecture'
        ? 0.24
        : stylePreset === 'botanical'
          ? 0.21
          : stylePreset === 'pet'
            ? 0.2
            : stylePreset === 'portrait'
              ? 0.2
              : stylePreset === 'landscape'
                ? 0.15
                : 0.18;
  const maxStrokes = Math.max(36, Math.floor(options.targetStrokeCount * contourShare));
  const strokes: Stroke[] = [];

  const simplifyEps =
    stylePreset === 'architecture' ? Math.max(0.36, 0.54 * scale) : Math.max(0.42, 0.68 * scale);
  const widthScale =
    stylePreset === 'botanical' ? 0.88 : stylePreset === 'architecture' ? 0.94 : 1.0;
  const jitterScale = stylePreset === 'architecture' ? 0.45 : stylePreset === 'pet' ? 0.85 : 1.0;

  for (let i = 0; i < chains.length && strokes.length < maxStrokes; i++) {
    const chain = chains[i];
    const simplified = simplifyPoints(chain.points, simplifyEps);
    const resampled = resamplePoints(simplified, Math.max(1.25, 2.0 * scale));
    const points = tuckPointsOffCleanPaper(resampled, darkness, width, height, 0.6 * scale);
    if (points.length < 2) continue;
    taperEnds(points, 4);

    const mid = points[Math.floor(points.length / 2)];
    const index = clampIndex(Math.round(mid.y) * width + Math.round(mid.x), detail.length);
    const rawStrength = clamp01(Math.max(chain.strength, detail[index]));
    const fg = foreground[index] ?? 1;
    const curvature = meanCurvature(simplified);

    const isIntricateFeature =
      fg > 0.4 &&
      chain.length < Math.min(width, height) * 0.3 &&
      (curvature > 0.16 || (rawStrength > 0.32 && coherence[index] < 0.82));

    let kind: StrokeKind = 'contour';
    let layer: StrokeLayer = 'outline';
    let grade: PencilGrade = 'HB';
    let priority = Math.round(48 + rawStrength * 20);

    if (rawStrength > 0.72 && darkness[index] > 0.46) {
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

    const baseOpacity = isIntricateFeature ? 0.32 : stylePreset === 'architecture' ? 0.28 : 0.25;
    strokes.push({
      id: `detail-${strokes.length + 1}`,
      kind,
      layer,
      order: 0,
      points,
      brush: {
        width: (0.6 + rawStrength * 0.56) * scale * widthScale,
        opacity: clamp(baseOpacity + rawStrength * 0.48, baseOpacity, 0.78),
        hardness:
          grade === '6B'
            ? 0.86
            : stylePreset === 'architecture'
              ? 0.84
              : grade === '2B'
                ? 0.68
                : 0.76,
        grain: clamp(0.14 + paperGrain * 0.22, 0.08, 0.45),
        jitter: rng.range(0.012, 0.04) * scale * jitterScale,
        grade,
      },
      durationMs: clamp(Math.round(chain.length * 2.0), 28, 150),
      priority,
      sourceConfidence: rawStrength,
    });
  }

  return strokes;
}
