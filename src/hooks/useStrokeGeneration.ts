import { useCallback, useEffect, useRef, useState } from 'react';
import { loadImageFromFile } from '../lib/image/loadImage';
import { resizeImageToProcessingSize } from '../lib/image/resizeImage';
import type {
  StrokeGenerationOptions,
  StrokeWorkerRequest,
  StrokeWorkerResponse,
  UploadImageMeta,
} from '../types/image-processing';
import type { StrokeScript } from '../types/stroke';

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
  targetStrokeCount: 9500,
  contourSensitivity: 0.58,
  shadingDensity: 0.65,
  backgroundSuppression: 0.6,
  minStrokeLength: 4,
  maxStrokeLength: 120,
  speedPreset: 'normal',
  stylePreset: 'classic',
  paperGrain: 0.32,
};

interface CachedSource {
  image: HTMLImageElement;
  meta: UploadImageMeta;
  objectUrl: string;
}

export function useStrokeGeneration() {
  const [state, setState] = useState<StrokeGenerationState>({
    status: 'idle',
    progress: 0,
  });
  const [sourcePreviewUrl, setSourcePreviewUrl] = useState<string | null>(null);
  const [sourceMeta, setSourceMeta] = useState<UploadImageMeta | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const cachedSourceRef = useRef<CachedSource | null>(null);

  const terminateWorker = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    activeRequestIdRef.current = null;
  }, []);

  const revokeSourceUrl = useCallback(() => {
    if (cachedSourceRef.current?.objectUrl) {
      URL.revokeObjectURL(cachedSourceRef.current.objectUrl);
      cachedSourceRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      terminateWorker();
      revokeSourceUrl();
    };
  }, [terminateWorker, revokeSourceUrl]);

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
      status: prev.script ? 'ready' : 'idle',
      progress: prev.script ? 1 : 0,
      phase: undefined,
      message: '已取消当前生成任务',
    }));
  }, [terminateWorker]);

  const reset = useCallback(() => {
    terminateWorker();
    setState({
      status: 'idle',
      progress: 0,
    });
  }, [terminateWorker]);

  const dispatchToWorker = useCallback(
    async (
      image: HTMLImageElement,
      meta: UploadImageMeta,
      options: StrokeGenerationOptions
    ): Promise<StrokeScript> => {
      terminateWorker();

      setState((prev) => ({
        ...prev,
        status: 'loading',
        progress: 0.1,
        phase: 'resizing',
        message: '正在标准化画幅与采样网格...',
        error: undefined,
      }));

      const { imageData } = resizeImageToProcessingSize(image, options.maxProcessingSize);

      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      activeRequestIdRef.current = requestId;

      const worker = new Worker(
        new URL('../workers/strokeGenerator.worker.ts', import.meta.url),
        { type: 'module' }
      );
      workerRef.current = worker;

      setState((prev) => ({
        ...prev,
        status: 'generating',
        progress: 0.14,
        phase: 'preprocessing',
        message: '正在启动素描笔触重建引擎...',
      }));

      return await new Promise<StrokeScript>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<StrokeWorkerResponse>) => {
          const resp = e.data;
          if (resp.requestId !== requestId) return;

          if (resp.type === 'progress') {
            setState((prev) => ({
              ...prev,
              status: 'generating',
              progress: resp.progress,
              phase: resp.phase,
              message: resp.message,
            }));
          } else if (resp.type === 'complete') {
            terminateWorker();
            setState({
              status: 'ready',
              progress: 1.0,
              phase: 'completed',
              message: `已生成 ${resp.script.strokes.length} 条分层笔触`,
              script: resp.script,
            });
            resolve(resp.script);
          } else if (resp.type === 'error') {
            terminateWorker();
            setState({
              status: 'error',
              progress: 0,
              error: resp.error.message,
            });
            reject(new Error(resp.error.message));
          }
        };

        worker.onerror = (err) => {
          terminateWorker();
          const msg = err.message || '后台笔触计算线程异常中断';
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
        // Zero-copy transfer of the underlying ArrayBuffer to the worker thread
        worker.postMessage(req, [imageData.data.buffer]);
      });
    },
    [terminateWorker]
  );

  const generateFromFile = useCallback(
    async (
      file: File,
      customOptions?: Partial<StrokeGenerationOptions>
    ): Promise<StrokeScript> => {
      terminateWorker();

      setState({
        status: 'loading',
        progress: 0.05,
        phase: 'loading',
        message: '正在解码原图...',
      });

      const mergedOptions: StrokeGenerationOptions = {
        ...DEFAULT_OPTIONS,
        ...customOptions,
      };

      try {
        const { meta, image } = await loadImageFromFile(file);
        revokeSourceUrl();
        const previewUrl = URL.createObjectURL(file);
        cachedSourceRef.current = { image, meta, objectUrl: previewUrl };
        setSourcePreviewUrl(previewUrl);
        setSourceMeta(meta);

        return await dispatchToWorker(image, meta, mergedOptions);
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
    [terminateWorker, revokeSourceUrl, dispatchToWorker]
  );

  const regenerateWithOptions = useCallback(
    async (customOptions: Partial<StrokeGenerationOptions>): Promise<StrokeScript | null> => {
      const cached = cachedSourceRef.current;
      if (!cached) return null;
      const mergedOptions: StrokeGenerationOptions = {
        ...DEFAULT_OPTIONS,
        ...customOptions,
      };
      try {
        return await dispatchToWorker(cached.image, cached.meta, mergedOptions);
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
    [dispatchToWorker]
  );

  return {
    state,
    sourcePreviewUrl,
    sourceMeta,
    hasLoadedSource: !!sourceMeta,
    generateFromFile,
    regenerateWithOptions,
    cancel,
    reset,
  };
}
