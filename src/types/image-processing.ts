import type { StrokeScript } from './stroke';

export interface UploadImageMeta {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
}

export interface ImageMap {
  width: number;
  height: number;
  data: Float32Array;
}

export interface GradientMap {
  width: number;
  height: number;
  magnitude: Float32Array;
  angle: Float32Array;
}

export interface PreprocessedImage {
  width: number;
  height: number;
  grayscaleMap: ImageMap;
  edgeMap: ImageMap;
  toneMap: ImageMap;
  saliencyMap: ImageMap;
  gradientMap: GradientMap;
  /**
   * Soft foreground confidence map. Values near 0 are background pixels and
   * values near 1 belong to the main subject. Kept optional for compatibility
   * with hand-built test fixtures and older scripts.
   */
  foregroundMap?: ImageMap;
  /**
   * Coherent edge tangent (flow) field. 'angle' is the local form direction,
   * 'coherence' is how reliable that direction is (0 isotropic, 1 strongly
   * oriented) and 'scale' is the structure tensor sigma it was measured at.
   * Hatching and hair strands follow this field instead of a fixed angle.
   */
  flowMap?: {
    width: number;
    height: number;
    angle: Float32Array;
    coherence: Float32Array;
    scale: Float32Array;
  };
}

export interface StrokeGenerationOptions {
  maxProcessingSize: number;
  targetStrokeCount: number;
  contourSensitivity: number;
  shadingDensity: number;
  backgroundSuppression: number;
  minStrokeLength: number;
  maxStrokeLength: number;
  speedPreset: 'slow' | 'normal' | 'fast';
}

export type StrokeWorkerPhase =
  | 'preprocessing'
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
