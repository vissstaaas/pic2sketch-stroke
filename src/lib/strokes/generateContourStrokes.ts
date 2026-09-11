import type { PreprocessedImage, StrokeGenerationOptions } from '../../types/image-processing';
import type { Stroke, StrokeKind, StrokeLayer } from '../../types/stroke';
import type { SeededRandom } from '../../utils/random';
import { resamplePoints, simplifyPoints, taperEnds } from './pathGeometry';
import { thinEdgeMap, traceEdgePaths } from './traceEdgePaths';
import type { StrokeGenerationContext } from './generateShadingStrokes';

/**
 * Contour and silhouette line work.
 *
 * Rebuilt on a proper vectorisation chain: non-maximum suppression thins the
 * line response to a single ridge, hysteresis keeps strong structure while
 * following weak detail, and a sub-pixel fan tracker keeps every path
 * direction-coherent instead of hopping between unrelated edges.
 */
export function generateContourStrokes(
  preprocessed: PreprocessedImage,
  options: StrokeGenerationOptions,
  rng: SeededRandom,
  context?: StrokeGenerationContext
): Stroke[] {
  const { width, height, edgeMap, toneMap, saliencyMap, foregroundMap } = preprocessed;
  const sensitivity = clamp(options.contourSensitivity, 0.05, 1);
  const suppression = clamp(options.backgroundSuppression, 0, 1);
  const sizeScale = clamp(Math.max(width, height) / 768, 0.55, 1.25);

  const maxStrokes = Math.max(4, Math.round(options.targetStrokeCount * 0.32));

  // Ridge normal = direction of steepest change of the line response itself.
  const normalX = new Float32Array(width * height);
  const normalY = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const index = row + x;
      normalX[index] =
        -edgeMap.data[index - width - 1] + edgeMap.data[index - width + 1] +
        -2 * edgeMap.data[index - 1] + 2 * edgeMap.data[index + 1] +
        -edgeMap.data[index + width - 1] + edgeMap.data[index + width + 1];
      normalY[index] =
        -edgeMap.data[index - width - 1] - 2 * edgeMap.data[index - width] - edgeMap.data[index - width + 1] +
        edgeMap.data[index + width - 1] + 2 * edgeMap.data[index + width] + edgeMap.data[index + width + 1];
    }
  }

  const thinned = thinEdgeMap(edgeMap.data, normalX, normalY, width, height);
  const high = 0.34 - 0.16 * sensitivity;
  const low = high * 0.42;

  const chains = traceEdgePaths(thinned, normalX, normalY, width, height, {
    highThreshold: high,
    lowThreshold: low,
    minLength: Math.max(6, options.minStrokeLength * 1.6),
    maxLength: Math.min(460, Math.max(110, options.maxStrokeLength * 2.6 * sizeScale)),
    subject: foregroundMap?.data,
    subjectGate: 0.12 + 0.5 * suppression,
    claimed: context?.claimed,
  });

  const strokes: Stroke[] = [];
  let strokeIdCounter = 0;
  const maxLength = Math.max(12, options.maxStrokeLength * sizeScale);

  // A few light construction lines: the longest silhouettes are laid in first,
  // exactly like blocking in a drawing.
  const constructionCount = Math.min(6, Math.floor(chains.length * 0.06));
  for (let i = 0; i < constructionCount && strokes.length < maxStrokes; i++) {
    const chain = chains[i];
    const simplified = simplifyPoints(chain.points, 4.0);
    const resampled = resamplePoints(simplified, Math.max(4, maxLength / 12));
    if (resampled.length < 2) continue;
    taperEnds(resampled, 4);
    strokes.push({
      id: `structure-layout-${++strokeIdCounter}`,
      kind: 'construction',
      layer: 'structure',
      order: 0,
      points: resampled.map((point) => ({ ...point, pressure: 0.18 })),
      brush: { width: 1.0 * sizeScale, opacity: 0.13, hardness: 0.4, grain: 0.1, jitter: 0.02 },
      durationMs: 70,
      priority: 5,
      sourceConfidence: 0.8,
    });
  }

  for (const chain of chains) {
    if (strokes.length >= maxStrokes) break;
    if (chain.length < Math.max(6, options.minStrokeLength * 1.6)) continue;

    const simplified = simplifyPoints(chain.points, 1.5);
    const resampled = resamplePoints(simplified, Math.max(2.5, 3.5 * sizeScale));
    if (resampled.length < 2) continue;
    taperEnds(resampled, 5);

    const mid = resampled[Math.floor(resampled.length / 2)];
    const mapIndex = clampIndex(Math.round(mid.y) * width + Math.round(mid.x), width * height);
    const midTone = toneMap.data[mapIndex] ?? 0.5;
    const midSaliency = saliencyMap.data[mapIndex] ?? 0.5;
    const midEdge = edgeMap.data[mapIndex] ?? 0.5;

    let kind: StrokeKind = 'contour';
    let layer: StrokeLayer = 'outline';
    let priority = 22;
    if (midTone > 0.78 && midSaliency > 0.5) {
      kind = 'accent';
      layer = 'finalAccent';
      priority = 76;
    } else if (midSaliency > 0.45 && midEdge > 0.24) {
      kind = 'feature';
      layer = 'features';
      priority = 36;
    }

    const strength = Math.min(1, chain.strength);
    const brushWidth = (1.05 + strength * 0.45) * sizeScale * (0.94 + rng.range(-0.06, 0.14));
    const opacity = Math.min(0.9, 0.6 + strength * 0.4);

    strokes.push({
      id: `contour-${++strokeIdCounter}`,
      kind,
      layer,
      order: 0,
      points: resampled,
      brush: {
        width: brushWidth,
        opacity,
        hardness: 0.85, // high hardness for solid line
        grain: 0.0,     // ZERO grain for pure vector-like stroke
        jitter: 0.0,    // ZERO jitter
      },
      durationMs: Math.max(50, Math.min(170, resampled.length * 6)),
      priority,
      sourceConfidence: strength,
    });
  }

  return strokes;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function clampIndex(index: number, size: number): number {
  return index < 0 ? 0 : index >= size ? size - 1 : index;
}
