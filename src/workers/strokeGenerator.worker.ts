import type {
  StrokeWorkerPhase,
  StrokeWorkerRequest,
  StrokeWorkerResponse,
} from '../types/image-processing';
import type { StrokeScript } from '../types/stroke';
import { buildSketchTarget, createSketchTargetPreview } from '../lib/image/buildSketchTarget';
import { generateResidualStrokes } from '../lib/strokes/generateResidualStrokes';
import { generateDetailContours } from '../lib/strokes/generateDetailContours';
import { orderStrokes } from '../lib/strokes/orderStrokes';
import { SeededRandom } from '../utils/random';

let currentRequestId: string | null = null;
let isCancelled = false;

self.onmessage = async (e: MessageEvent<StrokeWorkerRequest>) => {
  const request = e.data;

  if (request.type === 'cancel') {
    if (request.requestId === currentRequestId) {
      isCancelled = true;
    }
    return;
  }

  if (request.type === 'generate') {
    currentRequestId = request.requestId;
    isCancelled = false;

    try {
      const { imageData, meta, options, requestId } = request;
      const seed = Math.floor(Math.random() * 1000000);
      const rng = new SeededRandom(seed);

      // Phase 1: build a hidden, traditional image-processing target.
      postProgress(requestId, 'preprocessing', 0.18, '正在生成传统铅笔素描目标图...');
      if (isCancelled) return;
      const target = buildSketchTarget(imageData);

      // Phase 2: reconstruct the target from coarse tone to fine tone.
      postProgress(requestId, 'shading', 0.48, '正在把目标图拆解为明暗笔触...');
      if (isCancelled) return;
      const tonalStrokes = generateResidualStrokes(target, options, rng);

      // Phase 3: protect facial features and coherent silhouettes.
      postProgress(requestId, 'contours', 0.76, '正在提取五官与主体细节轮廓...');
      if (isCancelled) return;
      const detailStrokes = generateDetailContours(target, options, rng);

      // Phase 4: artistic layer ordering.
      postProgress(requestId, 'ordering', 0.92, '正在编排逐笔绘制顺序...');
      if (isCancelled) return;
      const rawStrokes = [...detailStrokes, ...tonalStrokes];
      const ordered = orderStrokes(rawStrokes, options.targetStrokeCount);

      // Phase 7: Finalizing
      postProgress(requestId, 'finalizing', 1.0, '传统算法笔触脚本生成完成！');

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
          background: '#fbf9f5',
          padding: 0,
        },
        generation: {
          seed,
          createdAt: new Date().toISOString(),
          options,
          strokeCount: ordered.length,
        },
        targetPreview: {
          width: target.width,
          height: target.height,
          pixels: createSketchTargetPreview(target),
        },
        strokes: ordered,
      };

      const response: StrokeWorkerResponse = {
        type: 'complete',
        requestId,
        script,
      };

      self.postMessage(response);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const response: StrokeWorkerResponse = {
        type: 'error',
        requestId: request.requestId,
        error: {
          code: 'GENERATION_FAILED',
          message,
          detail: err,
        },
      };
      self.postMessage(response);
    }
  }
};

function postProgress(
  requestId: string,
  phase: StrokeWorkerPhase,
  progress: number,
  message: string
): void {
  const msg: StrokeWorkerResponse = {
    type: 'progress',
    requestId,
    phase,
    progress,
    message,
  };
  self.postMessage(msg);
}
