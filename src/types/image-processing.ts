import type { StrokeScript } from './stroke';

export interface UploadImageMeta {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
}

export type SketchStylePreset = 'classic' | 'portrait' | 'lineart' | 'dramatic';

export interface StrokeGenerationOptions {
  maxProcessingSize: number;
  targetStrokeCount: number;
  contourSensitivity: number;
  shadingDensity: number;
  backgroundSuppression: number;
  minStrokeLength: number;
  maxStrokeLength: number;
  speedPreset: 'slow' | 'normal' | 'fast';
  stylePreset?: SketchStylePreset;
  paperGrain?: number;
  seed?: number;
}

export type StrokeWorkerPhase =
  | 'preprocessing'
  | 'structure'
  | 'contours'
  | 'shading'
  | 'ordering'
  | 'finalizing';

export type StrokeWorkerRequest =
  | {
      type: 'generate';
      requestId: string;
      imageData: ImageData;
      meta: UploadImageMeta;
      options: StrokeGenerationOptions;
    }
  | {
      type: 'cancel';
      requestId: string;
    };

export type StrokeWorkerResponse =
  | {
      type: 'progress';
      requestId: string;
      phase: StrokeWorkerPhase;
      progress: number;
      message?: string;
    }
  | {
      type: 'complete';
      requestId: string;
      script: StrokeScript;
    }
  | {
      type: 'error';
      requestId: string;
      error: {
        code: string;
        message: string;
        detail?: unknown;
      };
    };
