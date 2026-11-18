import type {
  PlaybackFrameState,
  PlaybackStatus,
  StrokeLayer,
  StrokeScript,
} from '../../types/stroke';
import type { SketchCanvasEngine } from '../canvas/SketchCanvasEngine';

export interface PlaybackControllerOptions {
  engine: SketchCanvasEngine;
  script?: StrokeScript;
  initialSpeed?: number;
  onStateChange: (state: PlaybackFrameState) => void;
  onComplete?: () => void;
  onError?: (error: Error) => void;
}

export class PlaybackController {
  private engine: SketchCanvasEngine;
  private script: StrokeScript | null = null;
  private status: PlaybackStatus = 'idle';
  private currentStrokeIndex = 0;
  private currentStrokeProgress = 0;
  private speed = 1.0;
  private errorMessage?: string;
  private onStateChange: (state: PlaybackFrameState) => void;
  private onComplete?: () => void;
  private onError?: (error: Error) => void;

  private animationFrameId: number | null = null;
  private lastFrameTimestamp = 0;

  constructor(options: PlaybackControllerOptions) {
    this.engine = options.engine;
    this.speed = options.initialSpeed ?? 1.0;
    this.onStateChange = options.onStateChange;
    this.onComplete = options.onComplete;
    this.onError = options.onError;

    if (options.script) {
      this.load(options.script);
    }
  }

  load(script: StrokeScript): void {
    this.stopLoop();
    this.script = script;
    this.currentStrokeIndex = 0;
    this.currentStrokeProgress = 0;
    this.errorMessage = undefined;
    this.status = 'ready';
    this.engine.loadScript(script);
    this.emitState();
  }

  play(): void {
    if (!this.script || this.script.strokes.length === 0) return;

    if (this.status === 'completed' || this.status === 'error') {
      this.replay();
      return;
    }

    if (this.status === 'paused' || this.status === 'ready') {
      this.errorMessage = undefined;
      this.status = 'playing';
      this.lastFrameTimestamp = performance.now();
      this.emitState();
      this.startLoop();
    }
  }

  pause(): void {
    if (this.status !== 'playing') return;
    this.stopLoop();
    this.status = 'paused';
    this.emitState();
  }

  resume(): void {
    if (this.status === 'paused') {
      this.play();
    }
  }

  replay(): void {
    if (!this.script) return;
    this.stopLoop();
    this.currentStrokeIndex = 0;
    this.currentStrokeProgress = 0;
    this.errorMessage = undefined;
    this.engine.clear();
    this.engine.drawPaperBackground();
    this.status = 'playing';
    this.lastFrameTimestamp = performance.now();
    this.emitState();
    this.startLoop();
  }

  seek(targetProgress: number): void {
    if (!this.script || this.script.strokes.length === 0) return;

    const clamped = Math.max(0, Math.min(1, targetProgress));
    const total = this.script.strokes.length;

    if (clamped <= 0) {
      this.currentStrokeIndex = 0;
      this.currentStrokeProgress = 0;
      this.engine.drawUntil(-1);
      if (this.status === 'completed') this.status = 'paused';
      this.emitState();
      return;
    }

    const strokeIndex = Math.min(total - 1, Math.floor(clamped * total));
    this.currentStrokeIndex = strokeIndex;
    this.currentStrokeProgress = 1.0;

    this.engine.drawUntil(strokeIndex);

    if (this.currentStrokeIndex >= total - 1 && clamped >= 0.999) {
      this.status = 'completed';
      this.stopLoop();
      this.onComplete?.();
    } else if (this.status === 'completed') {
      this.status = 'paused';
    }

    this.emitState();
  }

  /** Steps forward or backward by an exact stroke count, pausing active playback. */
  stepStrokes(delta: number): void {
    if (!this.script || this.script.strokes.length === 0 || delta === 0) return;
    this.stopLoop();

    const total = this.script.strokes.length;
    const completedCount =
      this.currentStrokeProgress >= 1 ? this.currentStrokeIndex + 1 : this.currentStrokeIndex;
    const nextCompletedCount = Math.max(0, Math.min(total, completedCount + Math.trunc(delta)));

    if (nextCompletedCount === 0) {
      this.currentStrokeIndex = 0;
      this.currentStrokeProgress = 0;
      this.status = 'paused';
      this.engine.drawUntil(-1);
    } else {
      this.currentStrokeIndex = nextCompletedCount - 1;
      this.currentStrokeProgress = 1.0;
      this.engine.drawUntil(this.currentStrokeIndex);
      if (nextCompletedCount >= total) {
        this.status = 'completed';
        this.onComplete?.();
      } else {
        this.status = 'paused';
      }
    }

    this.emitState();
  }

  /** Seeks directly to the completion of a given drawing layer. */
  seekToLayerEnd(layer: StrokeLayer): void {
    if (!this.script || this.script.strokes.length === 0) return;
    let lastIndex = -1;
    for (let i = 0; i < this.script.strokes.length; i++) {
      if (this.script.strokes[i].layer === layer) {
        lastIndex = i;
      }
    }
    if (lastIndex < 0) return;

    this.stopLoop();
    this.currentStrokeIndex = lastIndex;
    this.currentStrokeProgress = 1.0;
    this.engine.drawUntil(lastIndex);
    this.status = lastIndex >= this.script.strokes.length - 1 ? 'completed' : 'paused';
    this.emitState();
  }

  setSpeed(newSpeed: number): void {
    this.speed = Math.max(0.1, Math.min(32, newSpeed));
    this.emitState();
  }

  getState(): PlaybackFrameState {
    const total = this.script ? this.script.strokes.length : 0;
    let progress = 0;
    let activeLayer: StrokeLayer | undefined;

    if (total > 0 && this.script) {
      progress = Math.min(1, (this.currentStrokeIndex + this.currentStrokeProgress) / total);
      const safeIdx = Math.min(total - 1, Math.max(0, this.currentStrokeIndex));
      activeLayer = this.script.strokes[safeIdx]?.layer;
    }

    return {
      status: this.status,
      currentStrokeIndex: this.currentStrokeIndex,
      currentStrokeProgress: this.currentStrokeProgress,
      totalStrokes: total,
      progress,
      speed: this.speed,
      activeLayer,
      errorMessage: this.errorMessage,
    };
  }

  private emitState(): void {
    this.onStateChange(this.getState());
  }

  private baseStrokesPerSecond(): number {
    const total = this.script ? this.script.strokes.length : 0;
    if (total <= 0) return 35;
    return Math.max(30, Math.min(320, total / 68));
  }

  private getRaf(): (callback: FrameRequestCallback) => number {
    if (typeof requestAnimationFrame !== 'undefined') {
      return requestAnimationFrame;
    }
    return (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16) as unknown as number;
  }

  private getCaf(): (handle: number) => void {
    if (typeof cancelAnimationFrame !== 'undefined') {
      return cancelAnimationFrame;
    }
    return (handle: number) => clearTimeout(handle);
  }

  private startLoop(): void {
    if (this.animationFrameId !== null) return;
    this.lastFrameTimestamp = performance.now();
    const raf = this.getRaf();
    const tick = (timestamp: number) => {
      this.onTick(timestamp);
      if (this.status === 'playing') {
        this.animationFrameId = raf(tick);
      } else {
        this.animationFrameId = null;
      }
    };
    this.animationFrameId = raf(tick);
  }

  private stopLoop(): void {
    if (this.animationFrameId !== null) {
      const caf = this.getCaf();
      caf(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  private onTick(timestamp: number): void {
    if (!this.script || this.status !== 'playing') return;

    const totalStrokes = this.script.strokes.length;
    if (totalStrokes === 0 || this.currentStrokeIndex >= totalStrokes) {
      this.status = 'completed';
      this.stopLoop();
      this.emitState();
      this.onComplete?.();
      return;
    }

    try {
      const elapsedMs = Math.min(100, Math.max(1, timestamp - this.lastFrameTimestamp));
      this.lastFrameTimestamp = timestamp;

      const strokesToAdvance = this.baseStrokesPerSecond() * (elapsedMs / 1000.0) * this.speed;
      const nextPosition =
        this.currentStrokeIndex + this.currentStrokeProgress + strokesToAdvance;

      if (nextPosition >= totalStrokes) {
        this.currentStrokeIndex = totalStrokes - 1;
        this.currentStrokeProgress = 1.0;
        this.engine.renderFrame(this.getState());
        this.status = 'completed';
        this.stopLoop();
        this.emitState();
        this.onComplete?.();
      } else {
        this.currentStrokeIndex = Math.floor(nextPosition);
        this.currentStrokeProgress = nextPosition - this.currentStrokeIndex;
        this.engine.renderFrame(this.getState());
        this.emitState();
      }
    } catch (err: unknown) {
      this.status = 'error';
      this.stopLoop();
      const errorObj = err instanceof Error ? err : new Error(String(err));
      this.errorMessage = errorObj.message;
      this.onError?.(errorObj);
      this.emitState();
    }
  }

  dispose(): void {
    this.stopLoop();
    this.status = 'idle';
    this.script = null;
  }
}
