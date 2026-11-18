import type { PlaybackFrameState, Stroke, StrokeLayer, StrokeScript } from '../../types/stroke';
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
  private hiddenLayers = new Set<StrokeLayer>();

  constructor(options: SketchCanvasEngineOptions) {
    this.canvas = options.canvas;
    const context = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new Error('无法初始化 Canvas 2D 渲染上下文');
    }
    this.ctx = context;
    this.width = options.width;
    this.height = options.height;
    this.pixelRatio =
      options.pixelRatio || (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
    this.background = options.background || '#fbf8f1';
    this.brush = new PencilBrush();

    this.applySize();
    this.drawPaperBackground();
    this.captureBaseSnapshot();
  }

  private applySize(): void {
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

  setHiddenLayers(layers: ReadonlySet<StrokeLayer>): void {
    this.hiddenLayers = new Set(layers);
    const target = this.renderedStrokeIndex;
    this.invalidateBaseSnapshot();
    if (this.script) {
      this.drawUntil(target);
    } else {
      this.drawPaperBackground();
    }
  }

  getHiddenLayers(): ReadonlySet<StrokeLayer> {
    return this.hiddenLayers;
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.renderedStrokeIndex = -1;
    this.invalidateBaseSnapshot();
  }

  drawPaperBackground(): void {
    this.invalidateBaseSnapshot();
    this.ctx.save();
    this.ctx.fillStyle = this.background;
    this.ctx.fillRect(0, 0, this.width, this.height);

    const seed = this.script?.generation.seed || 42;
    const grain = this.script?.generation.options.paperGrain ?? 0.35;
    if (grain > 0.02) {
      const darkSpeckAlpha = (0.008 + grain * 0.016).toFixed(4);
      const warmFiberAlpha = (0.006 + grain * 0.012).toFixed(4);
      const step = 7;

      this.ctx.fillStyle = `rgba(42, 36, 30, ${darkSpeckAlpha})`;
      for (let y = 0; y < this.height; y += step) {
        for (let x = 0; x < this.width; x += step) {
          const hash = ((x * 73856093) ^ (y * 19349663) ^ seed) >>> 0;
          if ((hash % 100) < 28) {
            const ox = hash % 5;
            const oy = (hash >>> 4) % 5;
            this.ctx.fillRect(x + ox, y + oy, 1, 1);
          }
        }
      }

      this.ctx.fillStyle = `rgba(140, 122, 98, ${warmFiberAlpha})`;
      for (let y = 3; y < this.height; y += step * 2) {
        for (let x = 2; x < this.width; x += step * 2) {
          const hash = ((x * 83492791) ^ (y * 2971215073) ^ (seed + 17)) >>> 0;
          if ((hash % 100) < 22) {
            this.ctx.fillRect(x, y, 2, 1);
          }
        }
      }
    }

    this.ctx.restore();
    this.captureBaseSnapshot();
  }

  drawStroke(stroke: Stroke, options?: DrawStrokeOptions): void {
    if (this.hiddenLayers.has(stroke.layer)) return;
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

  drawUntil(targetIndex: number): void {
    this.clear();
    this.drawPaperBackground();

    if (!this.script || this.script.strokes.length === 0 || targetIndex < 0) {
      return;
    }

    const clampedTarget = Math.min(this.script.strokes.length - 1, targetIndex);
    for (let i = 0; i <= clampedTarget; i++) {
      this.drawStroke(this.script.strokes[i], { progress: 1.0 });
    }

    this.renderedStrokeIndex = clampedTarget;
    this.captureBaseSnapshot();
  }

  renderFrame(state: PlaybackFrameState): void {
    if (!this.script || this.script.strokes.length === 0) return;

    const requestedIndex = Number.isFinite(state.currentStrokeIndex)
      ? Math.trunc(state.currentStrokeIndex)
      : 0;
    if (requestedIndex < 0 || (requestedIndex === 0 && state.currentStrokeProgress <= 0)) {
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
      if (this.restoreBaseSnapshot(this.baseStrokeIndex)) {
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
