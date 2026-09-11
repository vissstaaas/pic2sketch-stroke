import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const { decodePng, encodePng, resizeRaster } = await import('./harness/png.ts');
const { FakeCanvas } = await import('./harness/canvas2d.ts');
const { buildSketchTarget } = await import('../src/lib/image/buildSketchTarget.ts');
const { generateResidualStrokes } = await import('../src/lib/strokes/generateResidualStrokes.ts');
const { generateDetailContours } = await import('../src/lib/strokes/generateDetailContours.ts');
const { orderStrokes } = await import('../src/lib/strokes/orderStrokes.ts');
const { SketchCanvasEngine } = await import('../src/lib/canvas/SketchCanvasEngine.ts');
const { SeededRandom } = await import('../src/utils/random.ts');

const SAMPLE = process.argv[2] || 'samples/pasted-2.png';
const OUT_DIR = process.argv[3] || 'tools/out';
const MAX_DIM = Number(process.env.SKETCH_MAX_DIM || 768);
const SEED = Number(process.env.SKETCH_SEED || 12345);
const BACKGROUND = '#fbf9f5';
const OPTIONS = {
  maxProcessingSize: MAX_DIM, targetStrokeCount: 9000, contourSensitivity: 0.5,
  shadingDensity: 0.6, backgroundSuppression: 0.5, minStrokeLength: 4,
  maxStrokeLength: 120, speedPreset: 'normal',
};

let resized;
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

function renderStrokes(strokes) {
  const canvas = new FakeCanvas();
  const engine = new SketchCanvasEngine({
    canvas, width: resized.width, height: resized.height, pixelRatio: 1, background: BACKGROUND,
  });
  engine.loadScript({
    version: '1.0',
    sourceImage: { width: resized.width, height: resized.height, processedWidth: resized.width, processedHeight: resized.height, mimeType: 'image/png' },
    canvas: { width: resized.width, height: resized.height, background: BACKGROUND, padding: 0 },
    generation: { seed: SEED, createdAt: new Date().toISOString(), options: OPTIONS, strokeCount: strokes.length },
    strokes: strokes.map((stroke, index) => ({ ...stroke, order: index })),
  });
  if (strokes.length) engine.drawUntil(strokes.length - 1);
  return canvas;
}

mkdirSync(OUT_DIR, { recursive: true });
const source = decodePng(readFileSync(SAMPLE));
resized = resizeRaster(source, MAX_DIM);
console.log('[input]', basename(SAMPLE), source.width + 'x' + source.height, '->', resized.width + 'x' + resized.height);

let started = Date.now();
const target = buildSketchTarget({ width: resized.width, height: resized.height, data: resized.data });
console.log('[target]', Date.now() - started + 'ms');

const rng = new SeededRandom(SEED);
started = Date.now();
const tonal = generateResidualStrokes(target, OPTIONS, rng);
const details = generateDetailContours(target, OPTIONS, rng);
const ordered = orderStrokes([...details, ...tonal], OPTIONS.targetStrokeCount);
console.log('[strokes]', Date.now() - started + 'ms', 'tone=' + tonal.length, 'detail=' + details.length, 'total=' + ordered.length);

writeFileSync(join(OUT_DIR, '00-source.png'), encodePng(resized));
writeFileSync(join(OUT_DIR, '01-sketch-target.png'), mapToPng(target.darkness, true));
writeFileSync(join(OUT_DIR, '02-detail-map.png'), mapToPng(target.detail, true));

started = Date.now();
const canvas = renderStrokes(ordered);
writeFileSync(join(OUT_DIR, '10-full.png'), canvas.toPng());
writeFileSync(join(OUT_DIR, '11-tonal.png'), renderStrokes(tonal).toPng());
writeFileSync(join(OUT_DIR, '12-details.png'), renderStrokes(details).toPng());
console.log('[render]', Date.now() - started + 'ms');

let absoluteError = 0;
let targetMean = 0;
let renderedMean = 0;
let targetSquared = 0;
let renderedSquared = 0;
let crossProduct = 0;
for (let i = 0; i < target.darkness.length; i++) {
  const rendered = 1 - (0.299 * canvas.px[i * 4] + 0.587 * canvas.px[i * 4 + 1] + 0.114 * canvas.px[i * 4 + 2]);
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
console.log('[quality]', 'MAE=' + (absoluteError / target.darkness.length).toFixed(4),
  'correlation=' + correlation.toFixed(4),
  'targetMean=' + (targetMean / target.darkness.length).toFixed(4),
  'renderedMean=' + (renderedMean / target.darkness.length).toFixed(4));
console.log('[output]', OUT_DIR);
