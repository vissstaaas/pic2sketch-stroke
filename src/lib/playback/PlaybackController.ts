import type { PlaybackFrameState, PlaybackStatus, StrokeScript } from '../../types/stroke';
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
    this.status = 'ready';
    this.engine.loadScript(script);
    this.emitState();
  }

  play(): void {
    if (!this.script || this.script.strokes.length === 0) return;

    if (this.status === 'completed') {
      this.replay();
      return;
    }

    if (this.status === 'paused' || this.status === 'ready') {
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

  setSpeed(newSpeed: number): void {
    this.speed = Math.max(0.1, Math.min(32, newSpeed));
    this.emitState();
  }

  getState(): PlaybackFrameState {
    const total = this.script ? this.script.strokes.length : 0;
    let progress = 0;
    if (total > 0) {
      progress = Math.min(1, (this.currentStrokeIndex + this.currentStrokeProgress) / total);
    }

    return {
      status: this.status,
      currentStrokeIndex: this.currentStrokeIndex,
      currentStrokeProgress: this.currentStrokeProgress,
      totalStrokes: total,
      progress,
      speed: this.speed,
    };
  }

  private emitState(): void {
    this.onStateChange(this.getState());
  }

  /** ~75 seconds for the whole drawing at 1x, clamped to a sane range. */
  private baseStrokesPerSecond(): number {
    const total = this.script ? this.script.strokes.length : 0;
    if (total <= 0) return 35;
    return Math.max(30, Math.min(300, total / 75));
  }

  private getRaf(): (callback: FrameRequestCallback) => number {
    if (typeof requestAnimationFrame !== 'undefined') {
      return requestAnimationFrame;
    }
    return (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number;
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

      // Advance at a rate that finishes the drawing in a watchable time whatever
      // the script size is (a 6000 stroke script at a fixed 35/s took 3 minutes).
      const strokesToAdvance = this.baseStrokesPerSecond() * (elapsedMs / 1000.0) * this.speed;

      const nextPosition = this.currentStrokeIndex + this.currentStrokeProgress + strokesToAdvance;
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
