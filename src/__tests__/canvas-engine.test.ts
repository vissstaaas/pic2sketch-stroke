import { describe, expect, it } from 'vitest';
import { SketchCanvasEngine } from '../lib/canvas/SketchCanvasEngine';
import type { PlaybackFrameState, StrokeScript } from '../types/stroke';

class FakeContext {
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  lineCap = 'round';
  lineJoin = 'round';
  private ink = 0;

  setTransform(): void {}
  scale(): void {}
  save(): void {}
  restore(): void {}
  clearRect(): void {
    this.ink = 0;
  }
  fillRect(): void {}
  globalAlpha = 1;
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  quadraticCurveTo(): void {}
  arc(): void {}
  closePath(): void {}
  stroke(): void {
    this.ink += 1;
  }
  fill(): void {
    this.ink += 1;
  }

  getImageData(_x: number, _y: number, width: number, height: number): ImageData {
    const data = new Uint8ClampedArray([this.ink]);
    return { width, height, data } as unknown as ImageData;
  }

  putImageData(imageData: ImageData): void {
    this.ink = imageData.data[0] || 0;
  }

  getInk(): number {
    return this.ink;
  }
}

class FakeCanvas {
  width = 0;
  height = 0;
  style = { width: '', height: '' };
  readonly context = new FakeContext();

  getContext(): CanvasRenderingContext2D {
    return this.context as unknown as CanvasRenderingContext2D;
  }

  toDataURL(): string {
    return `data:image/png;base64,${this.context.getInk()}`;
  }
}

function createScript(): StrokeScript {
  return {
    version: '1.0',
    sourceImage: { width: 40, height: 40, processedWidth: 40, processedHeight: 40, mimeType: 'image/png' },
    canvas: { width: 40, height: 40, background: '#fbf9f5', padding: 0 },
    generation: {
      seed: 7,
      createdAt: new Date(0).toISOString(),
      options: {} as StrokeScript['generation']['options'],
      strokeCount: 2,
    },
    strokes: [0, 1].map((order) => ({
      id: `stroke-${order}`,
      kind: 'contour' as const,
      layer: 'outline' as const,
      order,
      points: [
        { x: 4 + order * 10, y: 6, pressure: 0.5 },
        { x: 26 + order * 10, y: 24, pressure: 0.8 },
      ],
      brush: { width: 1.5, opacity: 0.5, hardness: 0.6, grain: 0.4, jitter: 0.2 },
      durationMs: 100,
      priority: 1,
      sourceConfidence: 1,
    })),
  };
}

function frame(currentStrokeIndex: number, currentStrokeProgress: number): PlaybackFrameState {
  return {
    status: 'playing',
    currentStrokeIndex,
    currentStrokeProgress,
    totalStrokes: 2,
    progress: (currentStrokeIndex + currentStrokeProgress) / 2,
    speed: 1,
  };
}

describe('SketchCanvasEngine frame caching', () => {
  it('does not accumulate the active stroke when the same partial frame is rendered repeatedly', () => {
    const canvas = new FakeCanvas();
    const engine = new SketchCanvasEngine({ canvas: canvas as unknown as HTMLCanvasElement, width: 40, height: 40, pixelRatio: 1 });
    engine.loadScript(createScript());

    engine.renderFrame(frame(0, 0.45));
    const firstPartialInk = canvas.context.getInk();
    engine.renderFrame(frame(0, 0.45));

    expect(canvas.context.getInk()).toBe(firstPartialInk);
  });

  it('keeps completed frames idempotent and exports the current canvas', () => {
    const canvas = new FakeCanvas();
    const engine = new SketchCanvasEngine({ canvas: canvas as unknown as HTMLCanvasElement, width: 40, height: 40, pixelRatio: 1 });
    engine.loadScript(createScript());

    engine.renderFrame(frame(0, 1));
    const completedFirstStrokeInk = canvas.context.getInk();
    engine.renderFrame(frame(1, 0.5));
    const partialSecondStrokeInk = canvas.context.getInk();
    engine.renderFrame(frame(1, 0.5));
    expect(canvas.context.getInk()).toBe(partialSecondStrokeInk);

    engine.renderFrame(frame(0, 1));
    expect(canvas.context.getInk()).toBe(completedFirstStrokeInk);
    expect(engine.exportPng()).toMatch(/^data:image\/png;base64,/);
  });

  it('extends the completed snapshot when playback jumps across strokes', () => {
    const canvas = new FakeCanvas();
    const engine = new SketchCanvasEngine({ canvas: canvas as unknown as HTMLCanvasElement, width: 40, height: 40, pixelRatio: 1 });
    engine.loadScript(createScript());

    engine.renderFrame(frame(1, 0.5));
    const jumpedInk = canvas.context.getInk();
    engine.renderFrame(frame(1, 0.5));

    expect(jumpedInk).toBeGreaterThan(1);
    expect(canvas.context.getInk()).toBe(jumpedInk);
  });
});
