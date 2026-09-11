import type { PlaybackFrameState, Stroke, StrokeScript } from '../../types/stroke';
import { PencilBrush } from './PencilBrush';

export interface SketchCanvasEngineOptions {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  pixelRatio?: number;
  background?: string;
}

export interface DrawStrokeOptions {
  progress: number;
  speedScale?: number;
}

/**
 * Self-contained 2D Canvas rendering engine for stroke-by-stroke pencil sketch playback.
 * Does NOT reveal a pre-rendered final image or use masks; renders authentic strokes deterministically.
 */
export class SketchCanvasEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width: number;
  private height: number;
  private pixelRatio: number;
  private background: string;
  private brush: PencilBrush;
  private script: StrokeScript | null = null;
  private renderedStrokeIndex = -1;
  private baseImageData: ImageData | null = null;
  private baseStrokeIndex = -1;

  constructor(options: SketchCanvasEngineOptions) {
    this.canvas = options.canvas;
    const context = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new Error('无法初始化 Canvas 2D 上下文');
    }
    this.ctx = context;
    this.width = options.width;
    this.height = options.height;
    this.pixelRatio = options.pixelRatio || (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
    this.background = options.background || '#fbf9f5';
    this.brush = new PencilBrush();

    this.applySize();
    this.drawPaperBackground();
    this.captureBaseSnapshot();
  }

  private applySize(): void {
    // Resizing resets the backing store, so any cached base frame is invalid.
    this.invalidateBaseSnapshot();
    this.canvas.width = Math.round(this.width * this.pixelRatio);
    this.canvas.height = Math.round(this.height * this.pixelRatio);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(this.pixelRatio, this.pixelRatio);
  }

  loadScript(script: StrokeScript): void {
    this.script = script;
    this.renderedStrokeIndex = -1;
    this.width = script.canvas.width;
    this.height = script.canvas.height;
    if (script.canvas.background) {
      this.background = script.canvas.background;
    }
    this.applySize();
    this.drawPaperBackground();
    this.captureBaseSnapshot();
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.renderedStrokeIndex = -1;
    this.invalidateBaseSnapshot();
  }

  drawPaperBackground(): void {
    this.invalidateBaseSnapshot();
    this.ctx.save();
    // Warm, natural sketch paper background
    this.ctx.fillStyle = this.background;
    this.ctx.fillRect(0, 0, this.width, this.height);

    // Subtle paper tooth texture
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.015)';
    const seed = this.script?.generation.seed || 42;
    const step = 8;
    for (let y = 0; y < this.height; y += step) {
      for (let x = 0; x < this.width; x += step) {
        if (((x * 17 + y * 31 + seed) % 100) > 65) {
          this.ctx.fillRect(x, y, 1, 1);
        }
      }
    }
    this.ctx.restore();
    this.captureBaseSnapshot();
  }

  drawStroke(stroke: Stroke, options?: DrawStrokeOptions): void {
    const progress = options?.progress ?? 1.0;
    const seed = (this.script?.generation.seed || 100) + stroke.order * 37;

    this.brush.render({
      ctx: this.ctx,
      stroke,
      points: stroke.points,
      brush: stroke.brush,
      seed,
      progress,
    });
  }

  /**
   * Redraws all strokes from 0 up to target stroke index.
   */
  drawUntil(targetIndex: number): void {
    this.clear();
    this.drawPaperBackground();

    if (!this.script || this.script.strokes.length === 0) {
      return;
    }

    const clampedTarget = Math.max(-1, Math.min(this.script.strokes.length - 1, targetIndex));
    for (let i = 0; i <= clampedTarget; i++) {
      const stroke = this.script.strokes[i];
      this.drawStroke(stroke, { progress: 1.0 });
    }

    this.renderedStrokeIndex = clampedTarget;
    this.captureBaseSnapshot();
  }

  /**
   * Called on every playback tick. The completed-strokes snapshot is restored
   * before drawing the active stroke so partial frames never accumulate ink.
   */
  renderFrame(state: PlaybackFrameState): void {
    if (!this.script || this.script.strokes.length === 0) return;

    const requestedIndex = Number.isFinite(state.currentStrokeIndex)
      ? Math.trunc(state.currentStrokeIndex)
      : 0;
    if (requestedIndex < 0) {
      this.drawUntil(-1);
      return;
    }

    const currentStrokeIndex = Math.min(this.script.strokes.length - 1, requestedIndex);
    const currentStrokeProgress = Number.isFinite(state.currentStrokeProgress)
      ? Math.max(0, Math.min(1, state.currentStrokeProgress))
      : 0;
    const completedBeforeIndex = currentStrokeIndex - 1;

    if (currentStrokeProgress >= 1) {
      this.ensureCompletedBase(currentStrokeIndex);
      return;
    }

    // A playback tick may jump across many short strokes. Extend the cached
    // completed frame incrementally, then draw only the current partial stroke.
    this.ensureCompletedBase(completedBeforeIndex);

    const currentStroke = this.script.strokes[currentStrokeIndex];
    if (currentStroke) {
      this.drawStroke(currentStroke, { progress: currentStrokeProgress });
    }

    this.renderedStrokeIndex = completedBeforeIndex;
  }

  exportPng(): string {
    return this.canvas.toDataURL('image/png');
  }

  resize(width: number, height: number, pixelRatio?: number): void {
    this.width = width;
    this.height = height;
    if (pixelRatio !== undefined) {
      this.pixelRatio = pixelRatio;
    }
    const previousIndex = this.renderedStrokeIndex;
    this.applySize();
    if (this.script) {
      this.drawUntil(previousIndex);
    } else {
      this.drawPaperBackground();
    }
  }

  dispose(): void {
    this.clear();
    this.script = null;
  }

  private invalidateBaseSnapshot(): void {
    this.baseImageData = null;
    this.baseStrokeIndex = -1;
  }

  private captureBaseSnapshot(): void {
    try {
      this.baseImageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
      this.baseStrokeIndex = this.renderedStrokeIndex;
    } catch {
      // ImageData may be unavailable in a constrained test/runtime context.
      // Playback remains correct by rebuilding from the script when needed.
      this.invalidateBaseSnapshot();
    }
  }

  private restoreBaseSnapshot(strokeIndex: number): boolean {
    if (!this.baseImageData || this.baseStrokeIndex !== strokeIndex) return false;

    try {
      this.ctx.putImageData(this.baseImageData, 0, 0);
      return true;
    } catch {
      this.invalidateBaseSnapshot();
      return false;
    }
  }

  private ensureCompletedBase(strokeIndex: number): void {
    if (!this.script) return;
    const target = Math.max(-1, Math.min(this.script.strokes.length - 1, strokeIndex));
    if (this.restoreBaseSnapshot(target)) {
      this.renderedStrokeIndex = target;
      return;
    }

    if (this.baseImageData && this.baseStrokeIndex < target) {
      const start = this.baseStrokeIndex + 1;
      const restored = this.restoreBaseSnapshot(this.baseStrokeIndex);
      if (restored) {
        for (let i = start; i <= target; i++) {
          this.drawStroke(this.script.strokes[i], { progress: 1 });
        }
        this.renderedStrokeIndex = target;
        this.captureBaseSnapshot();
        return;
      }
    }

    this.drawUntil(target);
  }
}
