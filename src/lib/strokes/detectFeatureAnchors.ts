import type { PreprocessedImage, StrokeGenerationOptions } from '../../types/image-processing';
import type { Stroke, StrokeKind, StrokeLayer } from '../../types/stroke';
import type { SeededRandom } from '../../utils/random';
import { resamplePoints, simplifyPoints, taperEnds } from './pathGeometry';
import { thinEdgeMap, traceEdgePaths } from './traceEdgePaths';
import type { StrokeGenerationContext } from './generateShadingStrokes';

/**
 * Focal accents: eyes, pupils, nostrils, lips and the darkest creases.
 *
 * The previous implementation emitted up to 70-point scribble chains with a
 * median turning angle of 45 degrees, which read as dirt over the face. These
 * are now ordinary direction-coherent chains, restricted to the focal zone and
 * to genuinely dark, high-response detail, and they skip anything the contour
 * pass already drew.
 */
export function detectFeatureAnchors(
  preprocessed: PreprocessedImage,
  options: StrokeGenerationOptions,
  rng: SeededRandom,
  context?: StrokeGenerationContext
): Stroke[] {
  const { width, height, edgeMap, toneMap, saliencyMap, foregroundMap } = preprocessed;
  const sensitivity = clamp(options.contourSensitivity, 0.05, 1);
  const suppression = clamp(options.backgroundSuppression, 0, 1);
  const sizeScale = clamp(Math.max(width, height) / 768, 0.55, 1.25);

  const maxStrokes = Math.max(4, Math.round(options.targetStrokeCount * 0.15));
  if (maxStrokes === 0) return [];

  const region = {
    minX: Math.floor(width * 0.15),
    maxX: Math.ceil(width * 0.85),
    minY: Math.floor(height * 0.1),
    maxY: Math.ceil(height * 0.82),
  };

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
  const high = 0.5 - 0.2 * sensitivity;
  const low = high * 0.55;

  const chains = traceEdgePaths(thinned, normalX, normalY, width, height, {
    highThreshold: high,
    lowThreshold: low,
    minLength: Math.max(8, options.minStrokeLength * 2),
    maxLength: Math.min(220, Math.max(70, options.maxStrokeLength * 1.8 * sizeScale)),
    region,
    subject: foregroundMap?.data,
    subjectGate: 0.12 + 0.5 * suppression,
    claimed: context?.claimed,
  });

  const strokes: Stroke[] = [];
  let strokeIdCounter = 0;

  for (const chain of chains) {
    if (strokes.length >= maxStrokes) break;

    let toneSum = 0;
    let saliencySum = 0;
    let strengthSum = 0;
    for (const point of chain.points) {
      const index = clampIndex(Math.round(point.y) * width + Math.round(point.x), width * height);
      toneSum += toneMap.data[index] ?? 0;
      saliencySum += saliencyMap.data[index] ?? 0;
      strengthSum += edgeMap.data[index] ?? 0;
    }
    const count = Math.max(1, chain.points.length);
    const meanTone = toneSum / count;
    const meanSaliency = saliencySum / count;
    if (meanSaliency < 0.34 && meanTone < 0.42) continue;

    const simplified = simplifyPoints(chain.points, 1.2);
    const resampled = resamplePoints(simplified, Math.max(2, 3 * sizeScale));
    if (resampled.length < 2) continue;
    taperEnds(resampled, 4);

    const dark = meanTone > 0.6 || strengthSum / count > 0.55;
    const kind: StrokeKind = dark ? 'accent' : 'feature';
    const layer: StrokeLayer = dark ? 'finalAccent' : 'features';
    const brushWidth = (dark ? 1.45 : 1.1) * sizeScale * (0.94 + rng.range(-0.05, 0.12));
    const opacity = dark ? 0.72 : 0.52;

    strokes.push({
      id: `feat-${++strokeIdCounter}`,
      kind,
      layer,
      order: 0,
      points: resampled,
      brush: {
        width: brushWidth,
        opacity,
        hardness: 0.72,
        grain: 0.15,
        jitter: rng.range(0.01, 0.025),
      },
      durationMs: Math.max(45, Math.min(140, resampled.length * 5)),
      priority: dark ? 82 : 38,
      sourceConfidence: meanSaliency,
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
