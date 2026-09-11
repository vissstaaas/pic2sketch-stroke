import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  StrokeGenerationOptions,
  StrokeWorkerRequest,
  StrokeWorkerResponse,
} from '../types/image-processing';
import type { StrokeScript } from '../types/stroke';
import { loadImageFromFile } from '../lib/image/loadImage';
import { resizeImageToProcessingSize } from '../lib/image/resizeImage';

export interface StrokeGenerationState {
  status: 'idle' | 'loading' | 'generating' | 'ready' | 'error';
  progress: number;
  phase?: string;
  message?: string;
  script?: StrokeScript;
  error?: string;
}

export const DEFAULT_OPTIONS: StrokeGenerationOptions = {
  maxProcessingSize: 768,
  // Similarity is the priority: broad strokes establish mass, then shorter
  // residual strokes preserve eyes, mouth, hair and clothing folds.
  targetStrokeCount: 9000,
  contourSensitivity: 0.5,
  shadingDensity: 0.6,
  backgroundSuppression: 0.5,
  minStrokeLength: 4,
  maxStrokeLength: 120,
  speedPreset: 'normal',
};

export function useStrokeGeneration() {
  const [state, setState] = useState<StrokeGenerationState>({
    status: 'idle',
    progress: 0,
  });

  const workerRef = useRef<Worker | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);

  const terminateWorker = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    activeRequestIdRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      terminateWorker();
    };
  }, [terminateWorker]);

  const cancel = useCallback(() => {
    if (activeRequestIdRef.current && workerRef.current) {
      const cancelReq: StrokeWorkerRequest = {
        type: 'cancel',
        requestId: activeRequestIdRef.current,
      };
      workerRef.current.postMessage(cancelReq);
    }
    terminateWorker();
    setState((prev) => ({
      ...prev,
      status: 'idle',
      progress: 0,
      phase: undefined,
      message: '生成已取消',
    }));
  }, [terminateWorker]);

  const reset = useCallback(() => {
    terminateWorker();
    setState({
      status: 'idle',
      progress: 0,
    });
  }, [terminateWorker]);

  const generateFromFile = useCallback(
    async (file: File, customOptions?: Partial<StrokeGenerationOptions>): Promise<StrokeScript> => {
      terminateWorker();

      setState({
        status: 'loading',
        progress: 0.05,
        phase: 'loading',
        message: '正在读取并解析图片...',
      });

      const options: StrokeGenerationOptions = {
        ...DEFAULT_OPTIONS,
        ...customOptions,
      };

      try {
        const { meta, image } = await loadImageFromFile(file);

        setState({
          status: 'loading',
          progress: 0.1,
          phase: 'resizing',
          message: '正在标准化图片尺寸...',
        });

        const { imageData } = resizeImageToProcessingSize(image, options.maxProcessingSize);

        const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        activeRequestIdRef.current = requestId;

        // Initialize Web Worker
        const worker = new Worker(
          new URL('../workers/strokeGenerator.worker.ts', import.meta.url),
          { type: 'module' }
        );
        workerRef.current = worker;

        setState({
          status: 'generating',
          progress: 0.15,
          phase: 'preprocessing',
          message: '正在启动传统素描重建引擎...',
        });

        return await new Promise<StrokeScript>((resolve, reject) => {
          worker.onmessage = (e: MessageEvent<StrokeWorkerResponse>) => {
            const resp = e.data;
            if (resp.requestId !== requestId) return;

            if (resp.type === 'progress') {
              setState({
                status: 'generating',
                progress: resp.progress,
                phase: resp.phase,
                message: resp.message,
              });
            } else if (resp.type === 'complete') {
              setState({
                status: 'ready',
                progress: 1.0,
                phase: 'completed',
                message: `成功生成 ${resp.script.strokes.length} 条素描笔触`,
                script: resp.script,
              });
              resolve(resp.script);
            } else if (resp.type === 'error') {
              setState({
                status: 'error',
                progress: 0,
                error: resp.error.message,
              });
              reject(new Error(resp.error.message));
            }
          };

          worker.onerror = (err) => {
            const msg = err.message || 'Worker 运行时未知错误';
            setState({
              status: 'error',
              progress: 0,
              error: msg,
            });
            reject(new Error(msg));
          };

          const req: StrokeWorkerRequest = {
            type: 'generate',
            requestId,
            imageData,
            meta,
            options,
          };
          worker.postMessage(req);
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setState({
          status: 'error',
          progress: 0,
          error: msg,
        });
        throw err;
      }
    },
    [terminateWorker]
  );

  return {
    state,
    generateFromFile,
    cancel,
    reset,
  };
}
