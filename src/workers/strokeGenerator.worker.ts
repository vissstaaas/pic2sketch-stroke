import { reconstructSketchScript } from '../lib/strokes/reconstructSketchScript';
import type {
  StrokeWorkerPhase,
  StrokeWorkerRequest,
  StrokeWorkerResponse,
} from '../types/image-processing';

let currentRequestId: string | null = null;
let isCancelled = false;

self.onmessage = (event: MessageEvent<StrokeWorkerRequest>) => {
  const request = event.data;

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
      const result = reconstructSketchScript(imageData, meta, options, {
        onProgress: (phase, progress, message) => {
          postProgress(requestId, phase, progress, message);
        },
        shouldCancel: () => isCancelled || currentRequestId !== requestId,
      });

      if (!result || isCancelled) return;

      const response: StrokeWorkerResponse = {
        type: 'complete',
        requestId,
        script: result.script,
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
          detail: err instanceof Error ? err.stack : undefined,
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
