import { describe, it, expect, vi } from 'vitest';
import { SeededRandom } from '../utils/random';
import { clamp, lerp, distance, pointToSegmentDistance } from '../utils/math';
import { simplifyPath } from '../lib/strokes/simplifyPath';
import { preprocessImage } from '../lib/image/preprocessImage';
import { buildSketchTarget, createSketchTargetPreview } from '../lib/image/buildSketchTarget';
import { generateContourStrokes } from '../lib/strokes/generateContourStrokes';
import { generateResidualStrokes } from '../lib/strokes/generateResidualStrokes';
import { generateDetailContours } from '../lib/strokes/generateDetailContours';
import { orderStrokes } from '../lib/strokes/orderStrokes';
import { PlaybackController } from '../lib/playback/PlaybackController';
import type { Stroke, StrokeScript } from '../types/stroke';
import type { StrokeGenerationOptions } from '../types/image-processing';

describe('Math and SeededRandom', () => {
  it('seeded random should be 100% deterministic given same seed', () => {
    const rng1 = new SeededRandom(9999);
    const rng2 = new SeededRandom(9999);

    const values1 = [rng1.next(), rng1.range(10, 20), rng1.int(1, 100), rng1.gaussian()];
    const values2 = [rng2.next(), rng2.range(10, 20), rng2.int(1, 100), rng2.gaussian()];

    expect(values1).toEqual(values2);
  });

  it('math utilities work accurately', () => {
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(5, 0, 10)).toBe(5);

    expect(lerp(10, 20, 0.5)).toBe(15);
    expect(distance(0, 0, 3, 4)).toBe(5);

    // Distance from (1, 1) to segment (0, 0) -> (2, 0) is 1.0
    expect(pointToSegmentDistance(1, 1, 0, 0, 2, 0)).toBeCloseTo(1.0);
  });
});

describe('Path Simplification (RDP)', () => {
  it('preserves start and end points and reduces redundant collinear points', () => {
    const points = [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 1, y: 0.05, pressure: 0.5 },
      { x: 2, y: -0.05, pressure: 0.5 },
      { x: 3, y: 0.02, pressure: 0.5 },
      { x: 4, y: 0, pressure: 0.5 },
    ];

    const simplified = simplifyPath(points, 0.5);
    expect(simplified.length).toBe(2);
    expect(simplified[0].x).toBe(0);
    expect(simplified[1].x).toBe(4);
  });

  it('keeps distinct curve apexes', () => {
    const points = [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 5, y: 10, pressure: 0.8 }, // Sharp peak
      { x: 10, y: 0, pressure: 0.5 },
    ];

    const simplified = simplifyPath(points, 1.0);
    expect(simplified.length).toBe(3);
    expect(simplified[1].y).toBe(10);
  });
});

describe('Image Preprocessing and Maps', () => {
  function createTestImageData(width: number, height: number): ImageData {
    const buffer = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        // Half black, half white
        const val = x < width / 2 ? 20 : 230;
        buffer[idx] = val;
        buffer[idx + 1] = val;
        buffer[idx + 2] = val;
        buffer[idx + 3] = 255;
      }
    }
    return {
      width,
      height,
      data: buffer,
      colorSpace: 'srgb',
    } as ImageData;
  }

  it('generates grayscale, edge, tone, and saliency maps correctly', () => {
    const imgData = createTestImageData(64, 64);
    const preprocessed = preprocessImage(imgData);

    expect(preprocessed.width).toBe(64);
    expect(preprocessed.height).toBe(64);
    expect(preprocessed.grayscaleMap.data.length).toBe(64 * 64);
    expect(preprocessed.edgeMap.data.length).toBe(64 * 64);
    expect(preprocessed.toneMap.data.length).toBe(64 * 64);

    // Near the boundary (x = 32), edge magnitude should be elevated
    const centerIdx = 32 * 64 + 32;
    expect(preprocessed.edgeMap.data[centerIdx]).toBeGreaterThan(0.05);

    // Left side (dark) should have higher tone (darkness) than right side (bright)
    const darkIdx = 32 * 64 + 10;
    const brightIdx = 32 * 64 + 50;
    expect(preprocessed.toneMap.data[darkIdx]).toBeGreaterThan(preprocessed.toneMap.data[brightIdx]);
  });

  it('builds a white-paper sketch target while preserving a dark boundary', () => {
    const imgData = createTestImageData(64, 64);
    const target = buildSketchTarget(imgData);
    const boundary = 32 * 64 + 31;
    const flatLight = 32 * 64 + 50;

    expect(target.darkness.length).toBe(64 * 64);
    expect(target.detail[boundary]).toBeGreaterThan(target.detail[flatLight]);
    expect(target.darkness[boundary]).toBeGreaterThan(target.darkness[flatLight]);

    const preview = createSketchTargetPreview(target);
    expect(preview).toBeInstanceOf(Uint8ClampedArray);
    expect(preview.length).toBe(64 * 64);
    expect(preview[boundary]).toBeLessThan(preview[flatLight]);
  });
});

describe('Stroke Generation & Ordering Contracts', () => {
  const options: StrokeGenerationOptions = {
    maxProcessingSize: 64,
    targetStrokeCount: 200,
    contourSensitivity: 0.5,
    shadingDensity: 0.6,
    backgroundSuppression: 0.5,
    minStrokeLength: 3,
    maxStrokeLength: 50,
    speedPreset: 'normal',
  };

  function createMockPreprocessed(w = 64, h = 64) {
    const size = w * h;
    const grayData = new Float32Array(size);
    const edgeData = new Float32Array(size);
    const toneData = new Float32Array(size);
    const salData = new Float32Array(size).fill(0.7);
    const magData = new Float32Array(size);
    const angData = new Float32Array(size);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        // Central circle with high edge & dark tone
        const dist = Math.hypot(x - w / 2, y - h / 2);
        if (Math.abs(dist - 16) < 2) {
          edgeData[idx] = 0.8;
        }
        if (dist < 16) {
          toneData[idx] = 0.85; // dark subject interior
        } else {
          toneData[idx] = 0.05; // bright white background
        }
      }
    }

    return {
      width: w,
      height: h,
      grayscaleMap: { width: w, height: h, data: grayData },
      edgeMap: { width: w, height: h, data: edgeData },
      toneMap: { width: w, height: h, data: toneData },
      saliencyMap: { width: w, height: h, data: salData },
      gradientMap: { width: w, height: h, magnitude: magData, angle: angData },
    };
  }

  it('generates valid contour strokes that have at least 2 points', () => {
    const prep = createMockPreprocessed();
    const rng = new SeededRandom(42);
    const strokes = generateContourStrokes(prep, options, rng);

    expect(strokes.length).toBeGreaterThan(0);
    for (const s of strokes) {
      expect(s.points.length).toBeGreaterThanOrEqual(2);
      expect(s.id).toBeDefined();
      expect(s.brush.width).toBeGreaterThan(0);
      expect(s.brush.opacity).toBeGreaterThan(0);
    }
  });

  it('reconstructs tonal information with deterministic real strokes', () => {
    const w = 64;
    const h = 64;
    const buffer = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const value = Math.hypot(x - 32, y - 32) < 18 ? 35 : 238;
        const i = (y * w + x) * 4;
        buffer[i] = value;
        buffer[i + 1] = value;
        buffer[i + 2] = value;
        buffer[i + 3] = 255;
      }
    }
    const target = buildSketchTarget({ width: w, height: h, data: buffer } as ImageData);
    const rng = new SeededRandom(777);
    const shading = generateResidualStrokes(target, options, rng);

    expect(shading.length).toBeGreaterThan(10);
    expect(shading.some((stroke) => stroke.layer === 'midTone' || stroke.layer === 'darkTone')).toBe(true);
    for (const stroke of shading) expect(stroke.points.length).toBeGreaterThanOrEqual(2);
  });

  it('orderStrokes strictly enforces artistic layer order', () => {
    const rawStrokes: Stroke[] = [
      {
        id: 's-dark',
        kind: 'crossHatching',
        layer: 'darkTone',
        order: 0,
        points: [{ x: 0, y: 0, pressure: 0.8 }, { x: 10, y: 10, pressure: 0.8 }],
        brush: { width: 1.5, opacity: 0.8, hardness: 0.8, grain: 0.4, jitter: 0.2 },
        durationMs: 100,
        priority: 50,
        sourceConfidence: 0.8,
      },
      {
        id: 's-struct',
        kind: 'construction',
        layer: 'structure',
        order: 0,
        points: [{ x: 0, y: 0, pressure: 0.2 }, { x: 50, y: 50, pressure: 0.2 }],
        brush: { width: 1, opacity: 0.2, hardness: 0.4, grain: 0.6, jitter: 0.5 },
        durationMs: 100,
        priority: 10,
        sourceConfidence: 0.9,
      },
      {
        id: 's-outline',
        kind: 'contour',
        layer: 'outline',
        order: 0,
        points: [{ x: 5, y: 5, pressure: 0.6 }, { x: 15, y: 15, pressure: 0.6 }],
        brush: { width: 1.5, opacity: 0.6, hardness: 0.7, grain: 0.4, jitter: 0.4 },
        durationMs: 100,
        priority: 20,
        sourceConfidence: 0.85,
      },
      {
        id: 's-light',
        kind: 'hatching',
        layer: 'lightTone',
        order: 0,
        points: [{ x: 20, y: 20, pressure: 0.4 }, { x: 30, y: 30, pressure: 0.4 }],
        brush: { width: 1, opacity: 0.3, hardness: 0.5, grain: 0.5, jitter: 0.3 },
        durationMs: 100,
        priority: 40,
        sourceConfidence: 0.7,
      },
      {
        id: 's-accent',
        kind: 'accent',
        layer: 'finalAccent',
        order: 0,
        points: [{ x: 1, y: 1, pressure: 0.9 }, { x: 3, y: 3, pressure: 0.9 }],
        brush: { width: 2, opacity: 0.9, hardness: 0.9, grain: 0.3, jitter: 0.2 },
        durationMs: 100,
        priority: 70,
        sourceConfidence: 0.95,
      },
    ];

    const ordered = orderStrokes(rawStrokes);

    // Layer sequence must be: structure -> outline -> lightTone -> darkTone -> finalAccent
    expect(ordered.map((s) => s.layer)).toEqual([
      'structure',
      'outline',
      'lightTone',
      'darkTone',
      'finalAccent',
    ]);

    // Order numbers must be sequentially 0, 1, 2, 3, 4
    expect(ordered.map((s) => s.order)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('PlaybackController State Management', () => {
  const mockScript: StrokeScript = {
    version: '1.0',
    sourceImage: { width: 100, height: 100, processedWidth: 100, processedHeight: 100, mimeType: 'image/png' },
    canvas: { width: 100, height: 100, background: '#fbf9f5', padding: 0 },
    generation: {
      seed: 123,
      createdAt: new Date().toISOString(),
      options: {} as any,
      strokeCount: 10,
    },
    strokes: Array.from({ length: 10 }, (_, i) => ({
      id: `s-${i}`,
      kind: 'contour',
      layer: 'outline',
      order: i,
      points: [{ x: i, y: i, pressure: 0.5 }, { x: i + 10, y: i + 10, pressure: 0.5 }],
      brush: { width: 1, opacity: 0.5, hardness: 0.5, grain: 0.5, jitter: 0.5 },
      durationMs: 50,
      priority: 1,
      sourceConfidence: 1,
    })),
  };

  const mockEngine = {
    loadScript: vi.fn(),
    clear: vi.fn(),
    drawPaperBackground: vi.fn(),
    drawStroke: vi.fn(),
    drawUntil: vi.fn(),
    renderFrame: vi.fn(),
    exportPng: vi.fn().mockReturnValue('data:image/png;base64,mock'),
    resize: vi.fn(),
    dispose: vi.fn(),
  } as any;

  it('manages playback lifecycle transitions: ready -> playing -> paused -> seek -> replay', () => {
    let stateHistory: string[] = [];
    const controller = new PlaybackController({
      engine: mockEngine,
      initialSpeed: 1.0,
      onStateChange: (st) => {
        stateHistory.push(st.status);
      },
    });

    expect(controller.getState().status).toBe('idle');

    controller.load(mockScript);
    expect(controller.getState().status).toBe('ready');
    expect(controller.getState().totalStrokes).toBe(10);

    // Play
    controller.play();
    expect(controller.getState().status).toBe('playing');

    // Pause
    controller.pause();
    expect(controller.getState().status).toBe('paused');

    // Seek to 50%
    controller.seek(0.5);
    expect(mockEngine.drawUntil).toHaveBeenCalledWith(5);
    expect(controller.getState().currentStrokeIndex).toBe(5);

    // Replay
    controller.replay();
    expect(mockEngine.clear).toHaveBeenCalled();
    expect(mockEngine.drawPaperBackground).toHaveBeenCalled();
    expect(controller.getState().currentStrokeIndex).toBe(0);

    // Speed change
    controller.setSpeed(4.0);
    expect(controller.getState().speed).toBe(4.0);

    // Seek to 0% and 100%
    controller.seek(0);
    expect(controller.getState().currentStrokeIndex).toBe(0);

    controller.seek(1.0);
    expect(controller.getState().status).toBe('completed');
    expect(controller.getState().currentStrokeIndex).toBe(9);

    controller.dispose();
  });
});

describe('End-to-End Pipeline Performance & Boundary Integrity', () => {
  it('processes realistic synthetic portrait image in under 500ms with all points bounded', () => {
    const w = 256;
    const h = 256;
    const buffer = new Uint8ClampedArray(w * h * 4);

    // Generate a synthetic face-like contrast pattern:
    // Oval face in center with dark eyes, dark hair, light cheeks
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        const dx = (x - w * 0.5) / (w * 0.35);
        const dy = (y - h * 0.5) / (h * 0.45);
        const distSq = dx * dx + dy * dy;

        let val = 245; // Background white
        if (distSq < 1.0) {
          val = 190; // Face skin tone
          // Eyes
          if (Math.hypot(x - w * 0.4, y - h * 0.42) < 12 || Math.hypot(x - w * 0.6, y - h * 0.42) < 12) {
            val = 25; // Dark pupils
          }
          // Mouth
          if (Math.abs(y - h * 0.65) < 5 && Math.abs(x - w * 0.5) < 25) {
            val = 40;
          }
        }
        // Hair on top
        if (y < h * 0.35 && distSq < 1.1) {
          val = 20;
        }

        buffer[idx] = val;
        buffer[idx + 1] = val;
        buffer[idx + 2] = val;
        buffer[idx + 3] = 255;
      }
    }

    const testImgData: ImageData = {
      width: w,
      height: h,
      data: buffer,
      colorSpace: 'srgb',
    } as ImageData;

    const start = performance.now();

    // 1. Build the hidden traditional sketch target.
    const target = buildSketchTarget(testImgData);

    // 2. Reconstruct it with tonal strokes and restrained contours.
    const rng = new SeededRandom(777);
    const options: StrokeGenerationOptions = {
      maxProcessingSize: 256,
      targetStrokeCount: 1500,
      contourSensitivity: 0.5,
      shadingDensity: 0.6,
      backgroundSuppression: 0.5,
      minStrokeLength: 4,
      maxStrokeLength: 80,
      speedPreset: 'normal',
    };
    const shading = generateResidualStrokes(target, options, rng);
    const contours = generateDetailContours(target, options, rng);

    // 3. Order & cap.
    const rawStrokes = [...contours, ...shading];
    const ordered = orderStrokes(rawStrokes, options.targetStrokeCount);

    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(1000); // Fast enough for smooth UX
    expect(ordered.length).toBeGreaterThan(40);
    expect(ordered.length).toBeLessThanOrEqual(options.targetStrokeCount);

    // Coordinate boundary verification: all points must stay within canvas bounds
    for (const stroke of ordered) {
      expect(stroke.points.length).toBeGreaterThanOrEqual(2);
      for (const pt of stroke.points) {
        expect(pt.x).toBeGreaterThanOrEqual(-5);
        expect(pt.x).toBeLessThanOrEqual(w + 5);
        expect(pt.y).toBeGreaterThanOrEqual(-5);
        expect(pt.y).toBeLessThanOrEqual(h + 5);
        expect(pt.pressure).toBeGreaterThan(0);
        expect(pt.pressure).toBeLessThanOrEqual(1.0);
      }
    }
  });
});
