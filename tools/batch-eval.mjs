import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.(ts|js|mjs|json)$/.test(specifier)) {
      try {
        return nextResolve(specifier + '.ts', context);
      } catch {}
    }
    return nextResolve(specifier, context);
  },
});

const { decodePng, encodePng, resizeRaster } = await import('./harness/png.ts');
const { FakeCanvas } = await import('./harness/canvas2d.ts');
const { reconstructSketchScript, PAPER_BACKGROUND } = await import(
  '../src/lib/strokes/reconstructSketchScript.ts'
);
const { SketchCanvasEngine } = await import('../src/lib/canvas/SketchCanvasEngine.ts');

const IN_DIR = process.argv[2];
const OUT_DIR = process.argv[3];
const REGEX_STR = process.argv[4] || '';
const PRESET_NAME = process.argv[5] || 'classic';
const MAX_SIZE = Number(process.argv[6] || 768);

if (!IN_DIR || !OUT_DIR) {
  console.error('Usage: node tools/batch-eval.mjs <inDir> <outDir> [regex] [preset] [maxSize]');
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const re = REGEX_STR ? new RegExp(REGEX_STR) : null;

const files = readdirSync(IN_DIR)
  .filter((f) => f.endsWith('.png') && !f.startsWith('_') && (!re || re.test(f)))
  .sort();

const PRESET_CONFIGS = {
  classic: {
    stylePreset: 'classic',
    targetStrokeCount: 9500,
    contourSensitivity: 0.58,
    shadingDensity: 0.66,
    backgroundSuppression: 0.52,
  },
  portrait: {
    stylePreset: 'portrait',
    targetStrokeCount: 10500,
    contourSensitivity: 0.54,
    shadingDensity: 0.62,
    backgroundSuppression: 0.72,
  },
  pet: {
    stylePreset: 'pet',
    targetStrokeCount: 11000,
    contourSensitivity: 0.6,
    shadingDensity: 0.68,
    backgroundSuppression: 0.64,
  },
  landscape: {
    stylePreset: 'landscape',
    targetStrokeCount: 10800,
    contourSensitivity: 0.5,
    shadingDensity: 0.7,
    backgroundSuppression: 0.1,
  },
  architecture: {
    stylePreset: 'architecture',
    targetStrokeCount: 12000,
    contourSensitivity: 0.68,
    shadingDensity: 0.72,
    backgroundSuppression: 0.48,
  },
  botanical: {
    stylePreset: 'botanical',
    targetStrokeCount: 10500,
    contourSensitivity: 0.6,
    shadingDensity: 0.66,
    backgroundSuppression: 0.65,
  },
  lineart: {
    stylePreset: 'lineart',
    targetStrokeCount: 4600,
    contourSensitivity: 0.68,
    shadingDensity: 0.34,
    backgroundSuppression: 0.76,
  },
  dramatic: {
    stylePreset: 'dramatic',
    targetStrokeCount: 12000,
    contourSensitivity: 0.6,
    shadingDensity: 0.82,
    backgroundSuppression: 0.45,
  },
};

const OPTIONS = {
  maxProcessingSize: MAX_SIZE,
  minStrokeLength: 4,
  maxStrokeLength: 120,
  speedPreset: 'normal',
  paperGrain: 0.32,
  seed: 12345,
  ...(PRESET_CONFIGS[PRESET_NAME] || PRESET_CONFIGS.classic),
};

const paperLum = (0.299 * 251 + 0.587 * 248 + 0.114 * 241) / 255;
const summary = [];

for (const file of files) {
  const name = basename(file, '.png');
  const srcRaw = decodePng(readFileSync(join(IN_DIR, file)));
  const resized = resizeRaster(srcRaw, OPTIONS.maxProcessingSize);

  const t0 = Date.now();
  const res = reconstructSketchScript(
    { width: resized.width, height: resized.height, data: resized.data },
    { width: srcRaw.width, height: srcRaw.height, mimeType: 'image/png' },
    OPTIONS
  );
  const genMs = Date.now() - t0;
  const { script, target } = res;

  const renderFiltered = (fn) => {
    const canvas = new FakeCanvas();
    const engine = new SketchCanvasEngine({
      canvas,
      width: resized.width,
      height: resized.height,
      pixelRatio: 1,
      background: PAPER_BACKGROUND,
    });
    const list = fn ? script.strokes.filter(fn) : script.strokes;
    engine.loadScript({
      ...script,
      strokes: list.map((s, idx) => ({ ...s, order: idx })),
    });
    if (list.length > 0) engine.drawUntil(list.length - 1);
    return canvas;
  };

  const fullCanvas = renderFiltered(null);
  const lineCanvas = renderFiltered((s) => s.kind !== 'hatching' && s.kind !== 'crossHatching');

  const itemDir = join(OUT_DIR, name);
  mkdirSync(itemDir, { recursive: true });
  writeFileSync(join(itemDir, '00-source.png'), encodePng(resized));
  writeFileSync(join(itemDir, '10-full.png'), fullCanvas.toPng());
  writeFileSync(join(itemDir, '12-lines.png'), lineCanvas.toPng());

  const targetPng = new Uint8ClampedArray(target.darkness.length * 4);
  for (let i = 0; i < target.darkness.length; i++) {
    const g = Math.round((1 - Math.max(0, Math.min(1, target.darkness[i]))) * 255);
    targetPng[i * 4] = g;
    targetPng[i * 4 + 1] = g;
    targetPng[i * 4 + 2] = g;
    targetPng[i * 4 + 3] = 255;
  }
  writeFileSync(
    join(itemDir, '01-target.png'),
    encodePng({ width: resized.width, height: resized.height, data: targetPng })
  );

  const n = target.darkness.length;
  let mae = 0;
  let tSum = 0;
  let rSum = 0;
  let tSq = 0;
  let rSq = 0;
  let trSum = 0;
  let bleedPixels = 0;
  let cleanPaperPixels = 0;
  let smudgePixels = 0;

  const renderedArr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lum =
      0.299 * fullCanvas.px[i * 4] +
      0.587 * fullCanvas.px[i * 4 + 1] +
      0.114 * fullCanvas.px[i * 4 + 2];
    const r = Math.max(0, Math.min(1, (paperLum - lum) / paperLum));
    renderedArr[i] = r;
    const t = target.darkness[i];
    mae += Math.abs(t - r);
    tSum += t;
    rSum += r;
    tSq += t * t;
    rSq += r * r;
    trSum += t * r;

    if (t < 0.015) {
      cleanPaperPixels++;
      if (r > 0.065) bleedPixels++;
    }
    if (r > t + 0.22 && t < 0.35) {
      smudgePixels++;
    }
  }

  const w = resized.width;
  const h = resized.height;
  let gTSum = 0,
    gRSum = 0,
    gTSq = 0,
    gRSq = 0,
    gTR = 0,
    gCount = 0;
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      const gTx = target.darkness[i + 1] - target.darkness[i - 1];
      const gTy = target.darkness[i + w] - target.darkness[i - w];
      const gRx = renderedArr[i + 1] - renderedArr[i - 1];
      const gRy = renderedArr[i + w] - renderedArr[i - w];
      const gt = Math.hypot(gTx, gTy);
      const gr = Math.hypot(gRx, gRy);
      gTSum += gt;
      gRSum += gr;
      gTSq += gt * gt;
      gRSq += gr * gr;
      gTR += gt * gr;
      gCount++;
    }
  }

  const cov = trSum / n - (tSum / n) * (rSum / n);
  const tVar = tSq / n - (tSum / n) ** 2;
  const rVar = rSq / n - (rSum / n) ** 2;
  const corr = cov / Math.sqrt(Math.max(1e-10, tVar * rVar));

  const gCov = gTR / gCount - (gTSum / gCount) * (gRSum / gCount);
  const gTVar = gTSq / gCount - (gTSum / gCount) ** 2;
  const gRVar = gRSq / gCount - (gRSum / gCount) ** 2;
  const gradCorr = gCov / Math.sqrt(Math.max(1e-10, gTVar * gRVar));

  const bleedRate = cleanPaperPixels > 0 ? bleedPixels / cleanPaperPixels : 0;
  const smudgeRate = smudgePixels / n;

  const row = {
    name,
    preset: PRESET_NAME,
    maxSize: MAX_SIZE,
    genMs,
    strokes: script.strokes.length,
    mae: Number((mae / n).toFixed(4)),
    corr: Number(corr.toFixed(4)),
    gradCorr: Number(gradCorr.toFixed(4)),
    bleedPct: Number((bleedRate * 100).toFixed(2)),
    smudgePct: Number((smudgeRate * 100).toFixed(2)),
    targetMean: Number((tSum / n).toFixed(4)),
    renderedMean: Number((rSum / n).toFixed(4)),
    layers: script.generation.layerMetrics,
  };
  summary.push(row);
  console.log(
    `[${summary.length}/${files.length}] ${name.padEnd(30)} (${PRESET_NAME}@${MAX_SIZE}) MAE=${row.mae} corr=${row.corr} grad=${row.gradCorr} bleed=${row.bleedPct}% smudge=${row.smudgePct}% (${genMs}ms)`
  );
}

writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
const avg = (k) => (summary.reduce((s, r) => s + r[k], 0) / Math.max(1, summary.length)).toFixed(4);
console.log(
  `\n=== AGGREGATE (${summary.length} photos, ${PRESET_NAME}@${MAX_SIZE}) === MAE=${avg('mae')} corr=${avg('corr')} gradCorr=${avg('gradCorr')} bleedPct=${avg('bleedPct')}% smudgePct=${avg('smudgePct')}%`
);
