import type { StrokeGenerationOptions } from './image-processing';

export type StrokeKind =
  | 'construction'
  | 'contour'
  | 'feature'
  | 'hatching'
  | 'crossHatching'
  | 'accent';

export type StrokeLayer =
  | 'structure'
  | 'outline'
  | 'features'
  | 'lightTone'
  | 'midTone'
  | 'darkTone'
  | 'finalAccent';

export interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
  timeOffsetMs?: number;
}

export interface BrushStyle {
  width: number;
  opacity: number;
  hardness: number;
  grain: number;
  jitter: number;
}

export interface Stroke {
  id: string;
  kind: StrokeKind;
  layer: StrokeLayer;
  order: number;
  points: StrokePoint[];
  brush: BrushStyle;
  durationMs: number;
  priority: number;
  sourceConfidence: number;
}

export interface SketchTargetPreview {
  width: number;
  height: number;
  /** White-paper grayscale pixels: 0 is black graphite and 255 is paper. */
  pixels: Uint8ClampedArray;
}

export interface StrokeScript {
  version: '1.0';
  sourceImage: {
    width: number;
    height: number;
    processedWidth: number;
    processedHeight: number;
    mimeType: string;
  };
  canvas: {
    width: number;
    height: number;
    background: string;
    padding: number;
  };
  generation: {
    seed: number;
    createdAt: string;
    options: StrokeGenerationOptions;
    strokeCount: number;
  };
  /** Diagnostic-only target image. It is never drawn into the playback canvas. */
  targetPreview?: SketchTargetPreview;
  strokes: Stroke[];
}

export type PlaybackStatus =
  | 'idle'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'completed'
  | 'error';

export interface PlaybackFrameState {
  status: PlaybackStatus;
  currentStrokeIndex: number;
  currentStrokeProgress: number;
  totalStrokes: number;
  progress: number;
  speed: number;
}
