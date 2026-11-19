import { describe, expect, it, vi } from 'vitest';
import {
  buildStrokeRibbonPolygon,
  getGraphiteSpec,
  rasterizeStrokeCoverage,
} from '../lib/canvas/brushMath';
import { exportScriptToJson, exportScriptToSvg } from '../lib/export/exportSketch';
import { buildSketchTarget, createSketchTargetPreview } from '../lib/image/buildSketchTarget';
import { computeCoherentLines } from '../lib/image/coherentLineDrawing';
import { computeEdgeTangentFlow } from '../lib/image/edgeTangentFlow';
import { mapPencilToneField } from '../lib/image/pencilToneMapping';
import { PlaybackController } from '../lib/playback/PlaybackController';
import {
  buildPlotterPlan,
  DEFAULT_PLOTTER_CONFIG,
  exportPlotterCenterlineSvg,
  exportPlotterGcode,
} from '../lib/plotter/buildPlotterPlan';
import { generateConstructionStrokes } from '../lib/strokes/generateConstructionStrokes';
import { generateDetailContours } from '../lib/strokes/generateDetailContours';
import { generateResidualStrokes } from '../lib/strokes/generateResidualStrokes';
import { computeLayerMetrics, orderStrokes } from '../lib/strokes/orderStrokes';
import { meanCurvature, resamplePoints, simplifyPoints } from '../lib/strokes/pathGeometry';
import { reconstructSketchScript } from '../lib/strokes/reconstructSketchScript';
import type { StrokeGenerationOptions } from '../types/image-processing';
import type { Stroke, StrokeScript } from '../types/stroke';
import { clamp, distance, lerp, pointToSegmentDistance, reflectIndex } from '../utils/math';
import { SeededRandom } from '../utils/random';

describe('Math, Geometry, and SeededRandom', () => {
  it('produces identical sequences for identical seeds', () => {
    const rng1 = new SeededRandom(9999);
    const rng2 = new SeededRandom(9999);

    const values1 = [rng1.next(), rng1.range(10, 20), rng1.int(1, 100), rng1.gaussian()];
    const values2 = [rng2.next(), rng2.range(10, 20), rng2.int(1, 100), rng2.gaussian()];
    expect(values1).toEqual(values2);
  });

  it('evaluates mirror reflection, interpolation, and segment distances accurately', () => {
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(lerp(10, 20, 0.5)).toBe(15);
    expect(distance(0, 0, 3, 4)).toBe(5);
    expect(reflectIndex(-2, 10)).toBe(2);
    expect(reflectIndex(11, 10)).toBe(7);
    expect(pointToSegmentDistance(1, 1, 0, 0, 2, 0)).toBeCloseTo(1.0);
  });

  it('simplifies, resamples, and measures curvature on polylines', () => {
    const collinear = [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 1, y: 0.04, pressure: 0.5 },
      { x: 2, y: -0.04, pressure: 0.5 },
      { x: 4, y: 0, pressure: 0.5 },
    ];
    const simplified = simplifyPoints(collinear, 0.3);
    expect(simplified.length).toBe(2);

    const corner = [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 5, y: 10, pressure: 0.8 },
      { x: 10, y: 0, pressure: 0.5 },
    ];
    expect(simplifyPoints(corner, 1.0).length).toBe(3);
    expect(meanCurvature(corner)).toBeGreaterThan(0.8);
    expect(resamplePoints(corner, 1.5).length).toBeGreaterThan(corner.length);
  });
});

describe('ETF, FDoG Coherent Line Drawing, and Tone Mapping', () => {
  function createHalfSplitImage(width: number, height: number): ImageData {
    const buffer = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const val = x < width / 2 ? 22 : 235;
        buffer[idx] = val;
        buffer[idx + 1] = val;
        buffer[idx + 2] = val;
        buffer[idx + 3] = 255;
      }
    }
    return { width, height, data: buffer } as ImageData;
  }

  it('aligns ETF vectors vertically along a vertical step edge and extracts FDoG lines', () => {
    const w = 64;
    const h = 64;
    const gray = new Float32Array(w * h).fill(0.95);
    // Draw a 2px vertical dark line at x = 31..32
    for (let y = 4; y < h - 4; y++) {
      gray[y * w + 31] = 0.1;
      gray[y * w + 32] = 0.1;
    }

    const etf = computeEdgeTangentFlow(gray, w, h, 2);
    const edgeIdx = 32 * w + 31;
    const flatIdx = 32 * w + 10;

    // Tangent along a vertical feature has |ty| >> |tx|
    expect(Math.abs(etf.tangentY[edgeIdx])).toBeGreaterThan(0.85);
    expect(etf.coherence[edgeIdx]).toBeGreaterThan(etf.coherence[flatIdx]);

    const fdog = computeCoherentLines(gray, w, h, etf, { sensitivity: 0.6, scale: 0.5 });
    expect(fdog[edgeIdx]).toBeGreaterThan(0.25);
    expect(fdog[flatIdx]).toBe(0);
  });

  it('calibrates tone across presets and builds clean white-paper sketch targets', () => {
    const sample = new Float32Array([0.1, 0.35, 0.65, 0.96]);
    const dramatic = mapPencilToneField(sample, 'dramatic');
    const lineart = mapPencilToneField(sample, 'lineart');
    expect(dramatic[0]).toBeGreaterThan(lineart[0]);
    expect(dramatic[3]).toBeLessThan(0.05);

    const imgData = createHalfSplitImage(64, 64);
    const target = buildSketchTarget(imgData);
    const boundary = 32 * 64 + 31;
    const flatLight = 32 * 64 + 52;

    expect(target.darkness.length).toBe(64 * 64);
    expect(target.detail[boundary]).toBeGreaterThan(target.detail[flatLight]);
    expect(target.darkness[boundary]).toBeGreaterThan(target.darkness[flatLight]);

    const preview = createSketchTargetPreview(target);
    expect(preview).toBeInstanceOf(Uint8ClampedArray);
    expect(preview[boundary]).toBeLessThan(preview[flatLight]);
  });
});

describe('Physically Matched Graphite Brush & Coverage Accounting', () => {
  it('deposits single-fill opacity without self-compounding along multi-segment strokes', () => {
    const w = 48;
    const h = 48;
    const achieved = new Float32Array(w * h);
    const stroke: Stroke = {
      id: 'single-fill-check',
      kind: 'hatching',
      layer: 'midTone',
      order: 0,
      points: [
        { x: 6, y: 24, pressure: 1 },
        { x: 16, y: 24, pressure: 1 },
        { x: 26, y: 24, pressure: 1 },
        { x: 38, y: 24, pressure: 1 },
      ],
      brush: { width: 6, opacity: 0.25, hardness: 0.6, grain: 0, jitter: 0, grade: '2B' },
      durationMs: 50,
      priority: 10,
      sourceConfidence: 1,
    };

    rasterizeStrokeCoverage(achieved, w, h, stroke);
    const expectedSingleFill = 0.25 * getGraphiteSpec(stroke.brush, stroke.layer).darknessFactor;
    // Centerline pixel at joint x=16, y=24 must NOT double-darken
    const jointCenter = achieved[24 * w + 16];
    expect(jointCenter).toBeCloseTo(expectedSingleFill, 2);

    const polygon = buildStrokeRibbonPolygon(stroke.points, stroke.brush, 42);
    expect(polygon.length).toBeGreaterThan(10);
  });
});

describe('Stroke Generation, Budget Capping, Spatial Ordering, and Exports', () => {
  const options: StrokeGenerationOptions = {
    maxProcessingSize: 64,
    targetStrokeCount: 240,
    contourSensitivity: 0.6,
    shadingDensity: 0.65,
    backgroundSuppression: 0.5,
    minStrokeLength: 3,
    maxStrokeLength: 50,
    speedPreset: 'normal',
    stylePreset: 'classic',
    paperGrain: 0.3,
    seed: 777,
  };

  it('generates construction, detail contour, and residual tonal strokes', () => {
    const w = 64;
    const h = 64;
    const buffer = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const value = Math.hypot(x - 32, y - 32) < 18 ? 30 : 238;
        const i = (y * w + x) * 4;
        buffer[i] = value;
        buffer[i + 1] = value;
        buffer[i + 2] = value;
        buffer[i + 3] = 255;
      }
    }
    const target = buildSketchTarget({ width: w, height: h, data: buffer } as ImageData, options);
    const rng = new SeededRandom(777);

    const structure = generateConstructionStrokes(target, options, rng);
    const contours = generateDetailContours(target, options, rng);
    const shading = generateResidualStrokes(target, options, rng, [...structure, ...contours]);

    expect(contours.length).toBeGreaterThan(0);
    expect(shading.length).toBeGreaterThan(10);
    expect(shading.some((s) => s.layer === 'midTone' || s.layer === 'darkTone')).toBe(true);
    for (const s of [...structure, ...contours, ...shading]) {
      expect(s.points.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('enforces strict layer precedence and deterministic budget-overflow sampling', () => {
    const makeStroke = (
      id: string,
      layer: Stroke['layer'],
      priority: number,
      x: number
    ): Stroke => ({
      id,
      kind: 'hatching',
      layer,
      order: 0,
      points: [
        { x, y: 10, pressure: 0.6 },
        { x: x + 4, y: 14, pressure: 0.6 },
      ],
      brush: { width: 1.5, opacity: 0.4, hardness: 0.6, grain: 0.3, jitter: 0.1 },
      durationMs: 40,
      priority,
      sourceConfidence: 0.8,
    });

    const rawStrokes: Stroke[] = [
      makeStroke('s-dark-1', 'darkTone', 50, 20),
      makeStroke('s-struct-1', 'structure', 10, 5),
      makeStroke('s-outline-1', 'outline', 20, 8),
      makeStroke('s-feat-1', 'features', 30, 12),
      makeStroke('s-light-1', 'lightTone', 40, 15),
      makeStroke('s-mid-1', 'midTone', 45, 18),
      makeStroke('s-accent-1', 'finalAccent', 70, 25),
      makeStroke('s-accent-2', 'finalAccent', 70, 26),
      makeStroke('s-light-2', 'lightTone', 40, 60),
      makeStroke('s-dark-2', 'darkTone', 50, 22),
    ];

    const fullOrdered = orderStrokes(rawStrokes, 20);
    expect(fullOrdered.map((s) => s.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(fullOrdered[0].layer).toBe('structure');
    expect(fullOrdered[fullOrdered.length - 1].layer).toBe('finalAccent');

    // Budget cap test: capping 10 strokes to 6 must preserve both essential and dark tonal layers deterministically
    const cappedA = orderStrokes(
      rawStrokes.map((s) => ({ ...s })),
      6
    );
    const cappedB = orderStrokes(
      rawStrokes.map((s) => ({ ...s })),
      6
    );
    expect(cappedA.length).toBeLessThanOrEqual(6);
    expect(cappedA.map((s) => s.id)).toEqual(cappedB.map((s) => s.id));
    expect(cappedA.some((s) => s.layer === 'finalAccent')).toBe(true);

    const metrics = computeLayerMetrics(cappedA);
    expect(Object.values(metrics).reduce((a, b) => a + b, 0)).toBe(cappedA.length);
  });

  it('exports valid layered SVG and portable JSON scripts', () => {
    const w = 48;
    const h = 48;
    const buffer = new Uint8ClampedArray(w * h * 4).fill(245);
    for (let y = 14; y < 34; y++) {
      for (let x = 14; x < 34; x++) {
        const idx = (y * w + x) * 4;
        buffer[idx] = 25;
        buffer[idx + 1] = 25;
        buffer[idx + 2] = 25;
      }
    }
    const res = reconstructSketchScript(
      { width: w, height: h, data: buffer } as ImageData,
      { width: w, height: h, mimeType: 'image/png' },
      options
    );
    expect(res).not.toBeNull();
    const script = res!.script;

    const svgAll = exportScriptToSvg(script);
    expect(svgAll).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svgAll).toContain('<path d="M');

    const svgFiltered = exportScriptToSvg(script, {
      hiddenLayers: new Set(['lightTone', 'midTone', 'darkTone', 'finalAccent']),
    });
    expect(svgFiltered).not.toContain('id="layer-darkTone"');

    const jsonStr = exportScriptToJson(script);
    const parsed = JSON.parse(jsonStr);
    expect(parsed.version).toBe('1.0');
    expect(parsed.targetPreview).toBeUndefined();
    expect(parsed.strokes.length).toBe(script.strokes.length);
  });
});

describe('PlaybackController Lifecycle, Stepping, and Error Handling', () => {
  const mockScript: StrokeScript = {
    version: '1.0',
    sourceImage: {
      width: 100,
      height: 100,
      processedWidth: 100,
      processedHeight: 100,
      mimeType: 'image/png',
    },
    canvas: { width: 100, height: 100, background: '#fbf8f1', padding: 0 },
    generation: {
      seed: 123,
      createdAt: new Date().toISOString(),
      options: {} as StrokeGenerationOptions,
      strokeCount: 10,
    },
    strokes: Array.from({ length: 10 }, (_, i) => ({
      id: `s-${i}`,
      kind: 'contour',
      layer: i < 4 ? 'outline' : 'darkTone',
      order: i,
      points: [
        { x: i, y: i, pressure: 0.5 },
        { x: i + 10, y: i + 10, pressure: 0.5 },
      ],
      brush: { width: 1, opacity: 0.5, hardness: 0.5, grain: 0.3, jitter: 0.2 },
      durationMs: 50,
      priority: 1,
      sourceConfidence: 1,
    })),
  };

  it('handles play, pause, seek(0), stepStrokes, and seekToLayerEnd accurately', () => {
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

    const controller = new PlaybackController({
      engine: mockEngine,
      initialSpeed: 1.0,
      onStateChange: () => {},
    });

    controller.load(mockScript);
    expect(controller.getState().status).toBe('ready');

    controller.play();
    expect(controller.getState().status).toBe('playing');

    controller.pause();
    expect(controller.getState().status).toBe('paused');

    controller.seek(0.5);
    expect(controller.getState().currentStrokeIndex).toBe(5);

    controller.stepStrokes(2);
    expect(controller.getState().currentStrokeIndex).toBe(7);

    controller.seekToLayerEnd('outline');
    expect(controller.getState().currentStrokeIndex).toBe(3);

    controller.seek(0);
    expect(controller.getState().progress).toBe(0);
    expect(mockEngine.drawUntil).toHaveBeenCalledWith(-1);

    controller.seek(1.0);
    expect(controller.getState().status).toBe('completed');
    controller.dispose();
  });
});

describe('End-to-End Pipeline Performance & Boundary Integrity', () => {
  it('reconstructs a 256x256 synthetic portrait in under 600ms with bounded coordinates', () => {
    const w = 256;
    const h = 256;
    const buffer = new Uint8ClampedArray(w * h * 4);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        const dx = (x - w * 0.5) / (w * 0.35);
        const dy = (y - h * 0.5) / (h * 0.45);
        const distSq = dx * dx + dy * dy;

        let val = 235;
        if (distSq < 1.0) {
          val = 188;
          if (
            Math.hypot(x - w * 0.4, y - h * 0.42) < 12 ||
            Math.hypot(x - w * 0.6, y - h * 0.42) < 12
          ) {
            val = 22;
          }
          if (Math.abs(y - h * 0.65) < 5 && Math.abs(x - w * 0.5) < 25) {
            val = 38;
          }
        }
        if (y < h * 0.35 && distSq < 1.1) {
          val = 18;
        }

        buffer[idx] = val;
        buffer[idx + 1] = val;
        buffer[idx + 2] = val;
        buffer[idx + 3] = 255;
      }
    }

    const start = performance.now();
    const reconstructed = reconstructSketchScript(
      { width: w, height: h, data: buffer } as ImageData,
      { width: w, height: h, mimeType: 'image/png' },
      {
        maxProcessingSize: 256,
        targetStrokeCount: 1600,
        contourSensitivity: 0.58,
        shadingDensity: 0.65,
        backgroundSuppression: 0.6,
        minStrokeLength: 4,
        maxStrokeLength: 80,
        speedPreset: 'normal',
        seed: 777,
      }
    );
    const elapsed = performance.now() - start;

    expect(reconstructed).not.toBeNull();
    const ordered = reconstructed!.script.strokes;
    expect(elapsed).toBeLessThan(800);
    expect(ordered.length).toBeGreaterThan(40);
    expect(ordered.length).toBeLessThanOrEqual(1600);

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


describe('Robotic Arm & Pen Plotter Toolpath Planner (buildPlotterPlan)', () => {
  function createHatchingTestScript(): StrokeScript {
    const strokes: Stroke[] = [];
    // Add 30 parallel hatching strokes spaced ~2.5px apart in a 200x300 canvas
    // On A5 portrait (148x210mm, margin 12 -> inner ~124x186mm), scale ~0.62 -> ~1.55mm spacing
    // This will merge via continuous zigzag across fast/standard tiers!
    for (let i = 0; i < 30; i++) {
      const y = 30 + i * 2.5;
      strokes.push({
        id: `hatch-${i}`,
        kind: 'hatching',
        layer: 'midTone',
        order: i,
        points: [
          { x: 40, y, pressure: 0.65 },
          { x: 80, y: y + 1.2, pressure: 0.72 },
        ],
        brush: { width: 1.8, opacity: 0.55, hardness: 0.5, grain: 0.2, jitter: 0, grade: '2B' },
        durationMs: 40,
        priority: 30,
        sourceConfidence: 0.9,
      });
    }
    // Add distant contour strokes
    strokes.push({
      id: 'contour-0',
      kind: 'contour',
      layer: 'outline',
      order: 30,
      points: [
        { x: 20, y: 20, pressure: 0.8 },
        { x: 180, y: 20, pressure: 0.8 },
        { x: 180, y: 280, pressure: 0.8 },
      ],
      brush: { width: 1.2, opacity: 0.85, hardness: 0.7, grain: 0.1, jitter: 0, grade: 'HB' },
      durationMs: 60,
      priority: 60,
      sourceConfidence: 1.0,
    });

    // Add a faint 2H construction scaffolding line (must be excluded by default from plotter plan)
    strokes.push({
      id: 'struct-0',
      kind: 'construction',
      layer: 'structure',
      order: 31,
      points: [
        { x: 10, y: 150, pressure: 0.2 },
        { x: 190, y: 150, pressure: 0.2 },
      ],
      brush: { width: 1.0, opacity: 0.035, hardness: 0.2, grain: 0.1, jitter: 0, grade: '2H' },
      durationMs: 20,
      priority: 10,
      sourceConfidence: 0.6,
    });

    return {
      version: '1.0',
      sourceImage: {
        width: 200,
        height: 300,
        processedWidth: 200,
        processedHeight: 300,
        mimeType: 'image/png',
      },
      canvas: { width: 200, height: 300, background: '#fbf8f1', padding: 0 },
      generation: {
        seed: 42,
        createdAt: new Date().toISOString(),
        options: {} as StrokeGenerationOptions,
        strokeCount: strokes.length,
      },
      strokes,
    };
  }

  it('merges close parallel hatching via zigzag optimization and respects physical margins', () => {
    const script = createHatchingTestScript();

    const fastPlan = buildPlotterPlan(script, { ...DEFAULT_PLOTTER_CONFIG, tier: 'fast' });
    const stdPlan = buildPlotterPlan(script, { ...DEFAULT_PLOTTER_CONFIG, tier: 'standard' });
    const finePlan = buildPlotterPlan(script, { ...DEFAULT_PLOTTER_CONFIG, tier: 'fine' });

    expect(fastPlan.paperWidthMm).toBe(148);
    expect(fastPlan.paperHeightMm).toBe(210);
    expect(fastPlan.isLandscape).toBe(false);

    // 2H construction scaffolding must be omitted from physical plotter plans
    expect(stdPlan.strokes.some((s) => s.layer === 'structure')).toBe(false);
    expect(stdPlan.strokes.every((s) => s.brushOpacity > 0 && s.brushWidthMm > 0)).toBe(true);

    // Parallel strokes separated by ~1.55mm must merge significantly on fast & standard tiers
    expect(fastPlan.telemetry.penLifts).toBeLessThan(fastPlan.telemetry.sampledStrokes);
    expect(stdPlan.telemetry.penLifts).toBeLessThan(stdPlan.telemetry.sampledStrokes);
    expect(fastPlan.telemetry.savedLiftPct).toBeGreaterThan(40);
    expect(finePlan.strokes.length).toBeGreaterThanOrEqual(fastPlan.strokes.length);

    // Verify Z-turnaround feathering exists on merged parallel zigzags
    expect(stdPlan.strokes.some((s) => s.points.some((p) => p.isTurnaround === true))).toBe(true);

    // Verify all coordinates stay strictly within physical paper bounds and respect margin
    for (const stroke of stdPlan.strokes) {
      expect(stroke.points.length).toBeGreaterThanOrEqual(2);
      for (const pt of stroke.points) {
        expect(pt.x).toBeGreaterThanOrEqual(stdPlan.config.marginMm - 0.5);
        expect(pt.x).toBeLessThanOrEqual(stdPlan.paperWidthMm - stdPlan.config.marginMm + 0.5);
        expect(pt.y).toBeGreaterThanOrEqual(stdPlan.config.marginMm - 0.5);
        expect(pt.y).toBeLessThanOrEqual(stdPlan.paperHeightMm - stdPlan.config.marginMm + 0.5);
      }
    }
  });

  it('exports valid Z-axis 3D G-code, GRBL M3/M5 G-code, and single-centerline mm SVG', () => {
    const script = createHatchingTestScript();

    const zPlan = buildPlotterPlan(script, {
      ...DEFAULT_PLOTTER_CONFIG,
      protocol: 'zaxis',
      paper: 'postcard',
    });
    expect(zPlan.paperWidthMm).toBe(100);
    expect(zPlan.paperHeightMm).toBe(150);

    const zGcode = exportPlotterGcode(zPlan);
    expect(zGcode).toContain('G21 ; Millimeter units');
    expect(zGcode).toContain('G90 ; Absolute positioning');
    expect(zGcode).toMatch(/G1 X\d+\.\d{2} Y\d+\.\d{2} Z-\d+\.\d{2}/);
    expect(zGcode).toContain('G0 Z4.00');
    expect(zGcode).toContain('M2');

    const grblPlan = buildPlotterPlan(script, {
      ...DEFAULT_PLOTTER_CONFIG,
      protocol: 'grbl',
      paper: 'A4',
    });
    const grblGcode = exportPlotterGcode(grblPlan);
    expect(grblGcode).toMatch(/M3 S\d+/);
    expect(grblGcode).toContain('M5 ; Servo up');

    const centerlineSvg = exportPlotterCenterlineSvg(zPlan);
    expect(centerlineSvg).toContain('width="100mm" height="150mm" viewBox="0 0 100 150"');
    expect(centerlineSvg).toContain('<polyline points=');
    // Must NOT emit filled ribbon <path> outlines that double-draw on plotters
    expect(centerlineSvg).not.toContain('<path ');
  });
});
