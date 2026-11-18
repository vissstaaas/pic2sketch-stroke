import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const { decodePng, encodePng, resizeRaster } = await import('./harness/png.ts');
const { FakeCanvas } = await import('./harness/canvas2d.ts');
const { reconstructSketchScript, PAPER_BACKGROUND } = await import(
  '../src/lib/strokes/reconstructSketchScript.ts'
);
const { SketchCanvasEngine } = await import('../src/lib/canvas/SketchCanvasEngine.ts');
const { exportScriptToSvg } = await import('../src/lib/export/exportSketch.ts');

const SAMPLE = process.argv[2] || 'samples/pasted-1-768.png';
const OUT_DIR = process.argv[3] || 'tools/out';
const MAX_DIM = Number(process.env.SKETCH_MAX_DIM || 768);
const SEED = Number(process.env.SKETCH_SEED || 12345);
const PRESET = process.env.SKETCH_PRESET || 'classic';

const OPTIONS = {
  maxProcessingSize: MAX_DIM,
  targetStrokeCount: 9500,
  contourSensitivity: 0.58,
  shadingDensity: 0.65,
  backgroundSuppression: 0.6,
  minStrokeLength: 4,
  maxStrokeLength: 120,
  speedPreset: 'normal',
  stylePreset: PRESET,
  paperGrain: 0.32,
  seed: SEED,
};

mkdirSync(OUT_DIR, { recursive: true });
const source = decodePng(readFileSync(SAMPLE));
const resized = resizeRaster(source, MAX_DIM);
console.log(
  '[input]',
  basename(SAMPLE),
  `${source.width}x${source.height} -> ${resized.width}x${resized.height}`,
  `preset=${PRESET}`
);

function mapToPng(map, invert = false) {
  const data = new Uint8ClampedArray(map.length * 4);
  for (let i = 0; i < map.length; i++) {
    const value = Math.max(0, Math.min(1, invert ? 1 - map[i] : map[i]));
    const gray = Math.round(value * 255);
    data[i * 4] = gray;
    data[i * 4 + 1] = gray;
    data[i * 4 + 2] = gray;
    data[i * 4 + 3] = 255;
  }
  return encodePng({ width: resized.width, height: resized.height, data });
}

function renderStrokes(script, filterFn) {
  const canvas = new FakeCanvas();
  const engine = new SketchCanvasEngine({
    canvas,
    width: resized.width,
    height: resized.height,
    pixelRatio: 1,
    background: PAPER_BACKGROUND,
  });
  const filtered = filterFn ? script.strokes.filter(filterFn) : script.strokes;
  engine.loadScript({
    ...script,
    strokes: filtered.map((stroke, index) => ({ ...stroke, order: index })),
  });
  if (filtered.length) engine.drawUntil(filtered.length - 1);
  return canvas;
}

const startedGen = Date.now();
const reconstructed = reconstructSketchScript(
  { width: resized.width, height: resized.height, data: resized.data },
  { width: source.width, height: source.height, mimeType: 'image/png' },
  OPTIONS
);
if (!reconstructed) {
  throw new Error('Sketch reconstruction cancelled unexpectedly');
}
const { script, target } = reconstructed;
console.log(
  '[pipeline]',
  `${Date.now() - startedGen}ms`,
  `total=${script.strokes.length}`,
  JSON.stringify(script.generation.layerMetrics)
);

writeFileSync(join(OUT_DIR, '00-source.png'), encodePng(resized));
writeFileSync(join(OUT_DIR, '01-sketch-target.png'), mapToPng(target.darkness, true));
writeFileSync(join(OUT_DIR, '02-detail-map.png'), mapToPng(target.detail, true));
writeFileSync(join(OUT_DIR, '03-foreground.png'), mapToPng(target.foreground, false));

const startedRender = Date.now();
const fullCanvas = renderStrokes(script);
writeFileSync(join(OUT_DIR, '10-full.png'), fullCanvas.toPng());
writeFileSync(
  join(OUT_DIR, '11-tonal.png'),
  renderStrokes(script, (s) => s.kind === 'hatching' || s.kind === 'crossHatching').toPng()
);
writeFileSync(
  join(OUT_DIR, '12-details.png'),
  renderStrokes(script, (s) => s.kind !== 'hatching' && s.kind !== 'crossHatching').toPng()
);
writeFileSync(join(OUT_DIR, '13-vector.svg'), exportScriptToSvg(script));
console.log('[render]', `${Date.now() - startedRender}ms`);

// Measure paper luminance from paper background RGB (#fbf8f1 -> ~0.976)
const paperLum = (0.299 * 251 + 0.587 * 248 + 0.114 * 241) / 255;
let absoluteError = 0;
let targetMean = 0;
let renderedMean = 0;
let targetSquared = 0;
let renderedSquared = 0;
let crossProduct = 0;

for (let i = 0; i < target.darkness.length; i++) {
  const lum =
    0.299 * fullCanvas.px[i * 4] +
    0.587 * fullCanvas.px[i * 4 + 1] +
    0.114 * fullCanvas.px[i * 4 + 2];
  const rendered = Math.max(0, Math.min(1, (paperLum - lum) / paperLum));
  absoluteError += Math.abs(target.darkness[i] - rendered);
  targetMean += target.darkness[i];
  renderedMean += rendered;
  targetSquared += target.darkness[i] * target.darkness[i];
  renderedSquared += rendered * rendered;
  crossProduct += target.darkness[i] * rendered;
}

const count = target.darkness.length;
const covariance = crossProduct / count - (targetMean / count) * (renderedMean / count);
const targetVariance = targetSquared / count - (targetMean / count) ** 2;
const renderedVariance = renderedSquared / count - (renderedMean / count) ** 2;
const correlation = covariance / Math.sqrt(Math.max(1e-10, targetVariance * renderedVariance));

console.log(
  '[quality]',
  `MAE=${(absoluteError / count).toFixed(4)}`,
  `correlation=${correlation.toFixed(4)}`,
  `targetMean=${(targetMean / count).toFixed(4)}`,
  `renderedMean=${(renderedMean / count).toFixed(4)}`
);
console.log('[output]', OUT_DIR);
