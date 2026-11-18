import type {
  StrokeGenerationOptions,
  StrokeWorkerPhase,
  UploadImageMeta,
} from '../../types/image-processing';
import type { StrokeScript } from '../../types/stroke';
import { SeededRandom } from '../../utils/random';
import {
  buildSketchTarget,
  createSketchTargetPreview,
  type SketchTarget,
} from '../image/buildSketchTarget';
import { generateConstructionStrokes } from './generateConstructionStrokes';
import { generateDetailContours } from './generateDetailContours';
import { generateResidualStrokes } from './generateResidualStrokes';
import { computeLayerMetrics, orderStrokes } from './orderStrokes';

export interface ReconstructCallbacks {
  onProgress?: (phase: StrokeWorkerPhase, progress: number, message: string) => void;
  shouldCancel?: () => boolean;
}

export interface ReconstructResult {
  script: StrokeScript;
  target: SketchTarget;
}

export const PAPER_BACKGROUND = '#fbf8f1';

/**
 * Pure domain pipeline orchestrating multi-field target analysis, 2H block-in,
 * FDoG contour extraction, ETF streamline cross-hatching, and spatial ordering.
 */
export function reconstructSketchScript(
  imageData: ImageData,
  meta: Pick<UploadImageMeta, 'width' | 'height' | 'mimeType'>,
  options: StrokeGenerationOptions,
  callbacks?: ReconstructCallbacks
): ReconstructResult | null {
  const startedAt = performance.now();
  const seed =
    typeof options.seed === 'number' && Number.isFinite(options.seed)
      ? Math.abs(Math.trunc(options.seed)) % 10000000
      : Math.floor(Math.random() * 1000000);
  const rng = new SeededRandom(seed);

  callbacks?.onProgress?.(
    'preprocessing',
    0.16,
    '正在构建 ETF 切向流场、FDoG 线稿与三峰铅笔色调场...'
  );
  if (callbacks?.shouldCancel?.()) return null;

  const target = buildSketchTarget(imageData, options);

  callbacks?.onProgress?.('structure', 0.34, '正在用 2H 硬铅勾勒几何起稿构图线...');
  if (callbacks?.shouldCancel?.()) return null;
  const constructionStrokes = generateConstructionStrokes(target, options, rng);

  callbacks?.onProgress?.('contours', 0.52, '正在沿 FDoG 脊线追踪主体轮廓与精细特征...');
  if (callbacks?.shouldCancel?.()) return null;
  const contourStrokes = generateDetailContours(target, options, rng);

  callbacks?.onProgress?.(
    'shading',
    0.74,
    '正在沿切向流线执行多铅笔分级交叉排线与残差补笔...'
  );
  if (callbacks?.shouldCancel?.()) return null;
  const lineFoundation = [...constructionStrokes, ...contourStrokes];
  const tonalStrokes = generateResidualStrokes(target, options, rng, lineFoundation);

  callbacks?.onProgress?.('ordering', 0.92, '正在按学院素描层次与手腕空间轨迹编排笔顺...');
  if (callbacks?.shouldCancel?.()) return null;
  const ordered = orderStrokes(
    [...constructionStrokes, ...contourStrokes, ...tonalStrokes],
    options.targetStrokeCount
  );

  const layerMetrics = computeLayerMetrics(ordered);
  const elapsedMs = Math.round(performance.now() - startedAt);

  callbacks?.onProgress?.('finalizing', 1.0, `素描重建完成，共 ${ordered.length} 笔`);

  const script: StrokeScript = {
    version: '1.0',
    sourceImage: {
      width: meta.width,
      height: meta.height,
      processedWidth: imageData.width,
      processedHeight: imageData.height,
      mimeType: meta.mimeType,
    },
    canvas: {
      width: imageData.width,
      height: imageData.height,
      background: PAPER_BACKGROUND,
      padding: 0,
    },
    generation: {
      seed,
      createdAt: new Date().toISOString(),
      options: { ...options, seed },
      strokeCount: ordered.length,
      layerMetrics,
      elapsedMs,
    },
    targetPreview: {
      width: target.width,
      height: target.height,
      pixels: createSketchTargetPreview(target),
    },
    strokes: ordered,
  };

  return { script, target };
}
