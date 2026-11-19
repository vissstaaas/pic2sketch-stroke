import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import os from 'node:os';
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

function resolveMatchedPreset(fileName) {
  if (fileName.startsWith('c01_portrait')) return 'portrait';
  if (fileName.startsWith('c02_pet') || fileName.startsWith('c03_wildlife')) return 'pet';
  if (fileName.startsWith('c04_landscape')) return 'landscape';
  if (fileName.startsWith('c05_arch') || fileName.startsWith('c09_vehicle')) return 'architecture';
  if (
    fileName.startsWith('c06_flora') ||
    fileName.startsWith('c07_food') ||
    fileName.startsWith('c08_stilllife')
  ) {
    return 'botanical';
  }
  if (fileName.startsWith('c10_street')) return 'dramatic';
  if (fileName.startsWith('c11_art')) return 'classic';
  return 'classic';
}

function resolveCategory(fileName) {
  const m = fileName.match(/^(c\d+_[a-z]+)/);
  return m ? m[1] : 'other';
}

if (isMainThread) {
  const IN_DIR = process.argv[2];
  const OUT_DIR = process.argv[3];
  const MODE = process.argv[4] || 'matched'; // 'matched' | 'classic' | preset name
  const MAX_SIZE = Number(process.argv[5] || 768);
  const NUM_WORKERS = Math.min(Number(process.argv[6] || 8), Math.max(2, os.cpus().length - 2));

  if (!IN_DIR || !OUT_DIR) {
    console.error('Usage: node --experimental-strip-types tools/qa-eval-parallel.mjs <inDir> <outDir> [matched|classic|<preset>] [maxSize] [workers]');
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const files = readdirSync(IN_DIR)
    .filter((f) => f.endsWith('.png') && !f.startsWith('_'))
    .sort();

  console.log(`Starting QA eval: ${files.length} images | mode=${MODE} | maxSize=${MAX_SIZE} | workers=${NUM_WORKERS}`);
  const tStart = Date.now();

  const chunks = Array.from({ length: NUM_WORKERS }, () => []);
  files.forEach((f, idx) => chunks[idx % NUM_WORKERS].push(f));

  const results = [];
  let doneCount = 0;

  await Promise.all(
    chunks
      .filter((c) => c.length > 0)
      .map(
        (chunk, wid) =>
          new Promise((resolve, reject) => {
            const w = new Worker(new URL(import.meta.url), {
              workerData: { IN_DIR, OUT_DIR, MODE, MAX_SIZE, files: chunk, wid },
              execArgv: ['--experimental-strip-types'],
            });
            w.on('message', (msg) => {
              if (msg.type === 'item') {
                results.push(msg.row);
                doneCount++;
                if (doneCount % 20 === 0 || doneCount === files.length) {
                  console.log(
                    `  [${doneCount}/${files.length}] latest: ${msg.row.name} (${msg.row.preset}) corr=${msg.row.corr} grad=${msg.row.gradCorr} mae=${msg.row.mae} bleed=${msg.row.bleedPct}% [${msg.row.grade}]`
                  );
                }
              }
            });
            w.on('error', reject);
            w.on('exit', (code) => {
              if (code !== 0) reject(new Error(`Worker ${wid} exited with code ${code}`));
              else resolve();
            });
          })
      )
  );

  results.sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify(results, null, 2));

  const elapsedSec = ((Date.now() - tStart) / 1000).toFixed(1);
  const n = results.length;
  const avg = (k) => (results.reduce((s, r) => s + r[k], 0) / Math.max(1, n)).toFixed(4);
  const passCount = results.filter((r) => r.passed).length;
  const excCount = results.filter((r) => r.grade === 'A+').length;
  const goodCount = results.filter((r) => r.grade === 'A').length;
  const passOnlyCount = results.filter((r) => r.grade === 'B').length;
  const failCount = n - passCount;

  console.log(`\n=============================================================`);
  console.log(`QA SUMMARY (${n} real photos | mode=${MODE}@${MAX_SIZE} | ${elapsedSec}s wall-time)`);
  console.log(`  PASS RATE : ${passCount}/${n} (${((passCount / Math.max(1, n)) * 100).toFixed(2)}%)`);
  console.log(`  GRADES    : A+=${excCount} (${((excCount / n) * 100).toFixed(1)}%) | A=${goodCount} (${((goodCount / n) * 100).toFixed(1)}%) | B=${passOnlyCount} (${((passOnlyCount / n) * 100).toFixed(1)}%) | FAIL=${failCount} (${((failCount / n) * 100).toFixed(1)}%)`);
  console.log(`  METRICS   : corr=${avg('corr')} | gradCorr=${avg('gradCorr')} | MAE=${avg('mae')} | bleed=${avg('bleedPct')}% | smudge=${avg('smudgePct')}%`);
  console.log(`=============================================================`);

  const cats = [...new Set(results.map((r) => r.category))].sort();
  for (const cat of cats) {
    const cr = results.filter((r) => r.category === cat);
    const cp = cr.filter((r) => r.passed).length;
    const cAvg = (k) => (cr.reduce((s, r) => s + r[k], 0) / cr.length).toFixed(4);
    console.log(
      `  ${cat.padEnd(15)} n=${String(cr.length).padStart(2)} | pass=${String(cp).padStart(2)}/${String(cr.length).padEnd(2)} (${((cp / cr.length) * 100).toFixed(1).padStart(5)}%) | corr=${cAvg('corr')} grad=${cAvg('gradCorr')} mae=${cAvg('mae')} bleed=${cAvg('bleedPct')}%`
    );
  }

  const fails = results.filter((r) => !r.passed).sort((a, b) => a.corr - b.corr);
  if (fails.length > 0) {
    console.log(`\n--- FAILED IMAGES (${fails.length}) ---`);
    for (const f of fails) {
      console.log(
        `  ${f.name.padEnd(32)} (${f.preset.padEnd(12)}) corr=${f.corr} grad=${f.gradCorr} mae=${f.mae} bleed=${f.bleedPct}% smudge=${f.smudgePct}% reasons=${f.failReasons.join(',')}`
      );
    }
  }
} else {
  const { decodePng, encodePng, resizeRaster } = await import('./harness/png.ts');
  const { FakeCanvas } = await import('./harness/canvas2d.ts');
  const { reconstructSketchScript, PAPER_BACKGROUND } = await import(
    '../src/lib/strokes/reconstructSketchScript.ts'
  );
  const { SketchCanvasEngine } = await import('../src/lib/canvas/SketchCanvasEngine.ts');

  const { IN_DIR, OUT_DIR, MODE, MAX_SIZE, files } = workerData;
  const paperLum = (0.299 * 251 + 0.587 * 248 + 0.114 * 241) / 255;

  for (const file of files) {
    const name = basename(file, '.png');
    const presetName = MODE === 'matched' ? resolveMatchedPreset(name) : MODE;
    const options = {
      maxProcessingSize: MAX_SIZE,
      minStrokeLength: 4,
      maxStrokeLength: 120,
      speedPreset: 'normal',
      paperGrain: 0.32,
      seed: 12345,
      ...(PRESET_CONFIGS[presetName] || PRESET_CONFIGS.classic),
    };

    const srcRaw = decodePng(readFileSync(join(IN_DIR, file)));
    const resized = resizeRaster(srcRaw, options.maxProcessingSize);

    const t0 = Date.now();
    const res = reconstructSketchScript(
      { width: resized.width, height: resized.height, data: resized.data },
      { width: srcRaw.width, height: srcRaw.height, mimeType: 'image/png' },
      options
    );
    const genMs = Date.now() - t0;
    const { script, target } = res;

    const canvas = new FakeCanvas();
    const engine = new SketchCanvasEngine({
      canvas,
      width: resized.width,
      height: resized.height,
      pixelRatio: 1,
      background: PAPER_BACKGROUND,
    });
    engine.loadScript({
      ...script,
      strokes: script.strokes.map((s, idx) => ({ ...s, order: idx })),
    });
    if (script.strokes.length > 0) engine.drawUntil(script.strokes.length - 1);

    const itemDir = join(OUT_DIR, name);
    mkdirSync(itemDir, { recursive: true });
    writeFileSync(join(itemDir, '00-source.png'), encodePng(resized));
    writeFileSync(join(itemDir, '10-full.png'), canvas.toPng());

    const n = target.darkness.length;
    let mae = 0,
      tSum = 0,
      rSum = 0,
      tSq = 0,
      rSq = 0,
      trSum = 0,
      bleedPixels = 0,
      cleanPaperPixels = 0,
      smudgePixels = 0;

    const renderedArr = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const lum =
        0.299 * canvas.px[i * 4] +
        0.587 * canvas.px[i * 4 + 1] +
        0.114 * canvas.px[i * 4 + 2];
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
        const gt = Math.hypot(
          target.darkness[i + 1] - target.darkness[i - 1],
          target.darkness[i + w] - target.darkness[i - w]
        );
        const gr = Math.hypot(
          renderedArr[i + 1] - renderedArr[i - 1],
          renderedArr[i + w] - renderedArr[i - w]
        );
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
    const corrVal = cov / Math.sqrt(Math.max(1e-10, tVar * rVar));

    const gCov = gTR / gCount - (gTSum / gCount) * (gRSum / gCount);
    const gTVar = gTSq / gCount - (gTSum / gCount) ** 2;
    const gRVar = gRSq / gCount - (gRSum / gCount) ** 2;
    const gradVal = gCov / Math.sqrt(Math.max(1e-10, gTVar * gRVar));

    const maeVal = mae / n;
    const bleedPct = cleanPaperPixels > 0 ? (bleedPixels / cleanPaperPixels) * 100 : 0;
    const smudgePct = (smudgePixels / n) * 100;

    // Strict Production QA Pass/Fail Criteria:
    // Pass requires: corr >= 0.78, gradCorr >= 0.42, MAE <= 0.145, smudgePct <= 2.5%, bleedPct <= 8.5%
    // (For ultra-dark scenes with <2% cleanPaperPixels, bleed is checked with <= 12% since denominator is tiny)
    const cleanRatio = cleanPaperPixels / n;
    const maxBleed = cleanRatio < 0.03 ? 12.0 : 8.0;
    const failReasons = [];
    if (corrVal < 0.78) failReasons.push('low_corr');
    if (gradVal < 0.42) failReasons.push('low_grad');
    if (maeVal > 0.145) failReasons.push('high_mae');
    if (smudgePct > 2.5) failReasons.push('high_smudge');
    if (bleedPct > maxBleed) failReasons.push('high_bleed');

    const passed = failReasons.length === 0;
    let grade = 'FAIL';
    if (passed) {
      if (corrVal >= 0.9 && gradVal >= 0.58 && maeVal <= 0.08 && bleedPct <= 2.5 && smudgePct <= 1.2) {
        grade = 'A+';
      } else if (corrVal >= 0.84 && gradVal >= 0.5 && maeVal <= 0.11) {
        grade = 'A';
      } else {
        grade = 'B';
      }
    }

    const row = {
      name,
      category: resolveCategory(name),
      preset: presetName,
      maxSize: MAX_SIZE,
      genMs,
      strokes: script.strokes.length,
      mae: Number(maeVal.toFixed(4)),
      corr: Number(corrVal.toFixed(4)),
      gradCorr: Number(gradVal.toFixed(4)),
      bleedPct: Number(bleedPct.toFixed(2)),
      smudgePct: Number(smudgePct.toFixed(2)),
      cleanPaperRatio: Number((cleanRatio * 100).toFixed(2)),
      targetMean: Number((tSum / n).toFixed(4)),
      renderedMean: Number((rSum / n).toFixed(4)),
      passed,
      grade,
      failReasons,
    };

    parentPort.postMessage({ type: 'item', row });
  }
}
