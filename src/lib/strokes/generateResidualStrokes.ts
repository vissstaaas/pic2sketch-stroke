import type { StrokeGenerationOptions } from '../../types/image-processing';
import type { PencilGrade, Stroke, StrokeLayer, StrokePoint } from '../../types/stroke';
import { clamp, clamp01, reflectIndex, smoothstep } from '../../utils/math';
import type { SeededRandom } from '../../utils/random';
import { createRasterScratch, rasterizeStrokeCoverage } from '../canvas/brushMath';
import { gaussianBlur, type SketchTarget } from '../image/buildSketchTarget';

interface AcademicPassConfig {
  spacing: number;
  length: number;
  flowLength: number;
  width: number;
  pitch: number;
  groupLines: number;
  opacity: number;
  maxOpacity: number;
  threshold: number;
  quotaRatio: number;
  layer: StrokeLayer;
  grade: PencilGrade;
  /** Cross-hatch offset (radians) on isotropic planes; attenuated automatically on anisotropic flow! */
  crossRad: number;
  maxBrightJump: number;
  repeats: number;
}

interface TonalCandidate {
  x: number;
  y: number;
  tier: number;
  score: number;
  jitterRad: number;
}

/** Natural right-hand academic pencil hatching slant (~ -39 deg). */
const ERGONOMIC_HATCH_RAD = -0.68;
const ERGONOMIC_UX = Math.cos(ERGONOMIC_HATCH_RAD);
const ERGONOMIC_UY = Math.sin(ERGONOMIC_HATCH_RAD);

/**
 * 5-Pass Capacity-Matched Academic Layered Graphite Planner:
 *
 * 1. Pass 0 (`lightTone` / HB): Broad side-of-lead tonal wash scaled to total integrated darkness
 *    demand so every shadow mass, garment, hair volume, and landscape plane achieves smooth,
 *    gap-free foundation value without quota starvation or half-shaded islands.
 * 2. Passes 1–3 (`midTone` / 2B, `darkTone` / 4B): Multi-scale nematic orientation field blending
 *    ergonomic acute lozenge cross-hatching (on smooth planes) with sleek macro-flow strands
 *    (propagated across wide dark hair, fur, stripes, and folds)—zero worm loops, zero mode cliffs.
 * 3. Pass 4 (`finalAccent` / 6B): Focal-prioritized micro-precision pass ensuring crisp pupils,
 *    iris rings, lash lines, nostrils, lip corners, glasses, and small-scale facial features.
 * 4. Bilateral Light-Boundary + Unblurred Darkness + Contour-Tucking edge stopping:
 *    strokes glide continuously across dark hair sheen while stopping cleanly at skin, sclera,
 *    catchlights, teeth, chin contours, and outer silhouettes.
 */
export function generateResidualStrokes(
  target: SketchTarget,
  options: StrokeGenerationOptions,
  rng: SeededRandom,
  preLaidStrokes?: readonly Stroke[]
): Stroke[] {
  const {
    width,
    height,
    grayscale,
    darkness,
    tone,
    detail,
    foreground,
    tangentX,
    tangentY,
    coherence,
  } = target;

  const size = width * height;
  const achieved = new Float32Array(size);
  const rasterScratch = createRasterScratch(width, height);

  if (preLaidStrokes && preLaidStrokes.length > 0) {
    for (const s of preLaidStrokes) {
      rasterizeStrokeCoverage(
        achieved,
        width,
        height,
        {
          ...s,
          brush: { ...s.brush, opacity: s.brush.opacity * 0.7 },
        },
        rasterScratch
      );
    }
  }

  const scale = clamp(Math.max(width, height) / 768, 0.45, 1.6);
  const stylePreset = options.stylePreset ?? 'classic';
  const tonalShare =
    stylePreset === 'lineart'
      ? 0.42
      : stylePreset === 'architecture'
        ? 0.76
        : stylePreset === 'landscape'
          ? 0.83
          : stylePreset === 'pet'
            ? 0.78
            : stylePreset === 'botanical'
              ? 0.78
              : stylePreset === 'portrait'
                ? 0.78
                : 0.8;
  const budget = Math.max(60, Math.floor(options.targetStrokeCount * tonalShare));
  const density = clamp(options.shadingDensity, 0.2, 1);
  const bgSuppression = clamp01(options.backgroundSuppression);
  const paperGrain = clamp01(options.paperGrain ?? 0.35);

  // Genre-specific brush & flow physics (applied to texture passes 1..4 so Pass 0 foundation never starves)
  const presetLenScale =
    stylePreset === 'landscape' ? 1.15 : stylePreset === 'pet' ? 1.08 : 1.0;
  const presetDetailWidthScale =
    stylePreset === 'pet' ? 0.88 : stylePreset === 'botanical' ? 0.92 : 1.0;
  const presetJitterScale = stylePreset === 'architecture' ? 0.52 : stylePreset === 'pet' ? 0.88 : 1.0;

  const minAllowedLen = Math.max(2.2, options.minStrokeLength * 0.68 * scale);
  const maxAllowedLen = Math.max(minAllowedLen + 6, options.maxStrokeLength * scale);

  // Measure total integrated darkness demand so broad side-of-lead foundation strokes scale
  // proportionally to scene darkness and NEVER starve mid-canvas!
  let demandSum = 0;
  for (let i = 0; i < size; i++) {
    if (bgSuppression > 0.3 && foreground[i] < 0.08 && darkness[i] < 0.12) continue;
    demandSum += darkness[i];
  }
  const meanDemand = demandSum / Math.max(1, size);
  const budgetNorm = clamp(7600 / Math.max(600, budget), 0.75, 2.2);
  const capScale = clamp(Math.sqrt((meanDemand * budgetNorm) / 0.082), 0.96, 2.35);
  const midCapScale = Math.sqrt(capScale);
  const demandOpacityBoost = clamp((meanDemand - 0.14) * 0.34, 0, 0.075);

  const broadTone = gaussianBlur(tone, width, height, Math.max(1.0, 2.2 * scale));
  const midFormTone = gaussianBlur(tone, width, height, Math.max(0.7, 1.1 * scale));

  // Focal salience prioritizes sharp structural features (eyes, brows, lips, hands, petals, facades)
  const localStructure = gaussianBlur(detail, width, height, Math.max(2.2, 6.5 * scale));
  const focalSalience = new Float32Array(size);
  const invHalfW = 2 / Math.max(1, width);
  const invHalfH = 2 / Math.max(1, height);
  for (let y = 0; y < height; y++) {
    const ny = (y * invHalfH - 1) * 0.85;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const nx = (x * invHalfW - 1) * 0.85;
      const centerPrior = clamp(1.06 - 0.22 * (nx * nx + ny * ny), 0.76, 1.06);
      const i = row + x;
      const struct = clamp01(detail[i] * 1.15 + localStructure[i] * 2.3);
      focalSalience[i] = struct * (0.45 + 0.55 * foreground[i]) * centerPrior;
    }
  }

  const macroFlow = computeMultiScaleMacroFlow(grayscale, width, height, scale);

  const passes: AcademicPassConfig[] = [
    // Pass 0: Broad HB side-of-lead tonal foundation (supplies smooth, complete base value everywhere)
    {
      spacing: 10.2 * scale * midCapScale,
      length: clamp(46 * scale * midCapScale, minAllowedLen, maxAllowedLen),
      flowLength: clamp(64 * scale * midCapScale, minAllowedLen, maxAllowedLen),
      width: 5.2 * scale * capScale,
      pitch: 4.0 * scale * midCapScale,
      groupLines: 1,
      opacity: 0.17,
      maxOpacity: 0.36,
      threshold: 0.02,
      quotaRatio: 0.2,
      layer: 'lightTone',
      grade: 'HB',
      crossRad: 0,
      maxBrightJump: 0.13,
      repeats: 3,
    },
    // Pass 1: 2B primary form hatching (establishes rich directional pencil texture)
    {
      spacing: 7.6 * scale * midCapScale,
      length: clamp(31 * scale * Math.min(1.25, midCapScale), minAllowedLen, maxAllowedLen),
      flowLength: clamp(50 * scale * Math.min(1.25, midCapScale), minAllowedLen, maxAllowedLen),
      width: 2.35 * scale * midCapScale,
      pitch: 2.6 * scale * midCapScale,
      groupLines: 2,
      opacity: 0.2,
      maxOpacity: 0.42,
      threshold: 0.026,
      quotaRatio: 0.23,
      layer: 'midTone',
      grade: '2B',
      crossRad: 0.38, // ~ -17 deg acute lozenge cross-hatch on planes; tight weave on hair/stripes
      maxBrightJump: 0.11,
      repeats: 2,
    },
    // Pass 2: 4B acute cross-hatching & sleek hair lock strands
    {
      spacing: 5.6 * scale,
      length: clamp(22 * scale, minAllowedLen, maxAllowedLen),
      flowLength: clamp(42 * scale, minAllowedLen, maxAllowedLen),
      width: 1.38 * scale,
      pitch: 1.9 * scale,
      groupLines: 2,
      opacity: 0.25,
      maxOpacity: 0.48,
      threshold: 0.024,
      quotaRatio: 0.24,
      layer: 'darkTone',
      grade: '4B',
      crossRad: -0.35, // ~ -59 deg steep shadow cross-hatch on planes; counter-weave on strands
      maxBrightJump: 0.095,
      repeats: 2,
    },
    // Pass 3: 4B core shadow & deep hair mass reinforcement
    {
      spacing: 4.2 * scale,
      length: clamp(14.5 * scale, minAllowedLen, maxAllowedLen),
      flowLength: clamp(28 * scale, minAllowedLen, maxAllowedLen),
      width: 1.04 * scale,
      pitch: 1.55 * scale,
      groupLines: 2,
      opacity: 0.3,
      maxOpacity: 0.56,
      threshold: 0.019,
      quotaRatio: 0.18,
      layer: 'darkTone',
      grade: '4B',
      crossRad: 0.1,
      maxBrightJump: 0.085,
      repeats: 2,
    },
    // Pass 4: 6B focal micro-precision (pupils, irises, lash lines, nostrils, lip corners, small faces)
    {
      spacing: 2.9 * scale,
      length: clamp(8.5 * scale, minAllowedLen, maxAllowedLen),
      flowLength: clamp(16 * scale, minAllowedLen, maxAllowedLen),
      width: 0.78 * scale,
      pitch: 1.25 * scale,
      groupLines: 1,
      opacity: 0.36,
      maxOpacity: 0.68,
      threshold: 0.014,
      quotaRatio: 0.15,
      layer: 'finalAccent',
      grade: '6B',
      crossRad: -0.07,
      maxBrightJump: 0.075,
      repeats: 3,
    },
  ];

  const strokes: Stroke[] = [];
  let serial = 0;

  for (let passIndex = 0; passIndex < passes.length; passIndex++) {
    const pass = passes[passIndex];
    const passQuota = Math.max(8, Math.round(budget * pass.quotaRatio));
    const passTarget = passIndex === 0 ? broadTone : passIndex === 1 ? midFormTone : darkness;
    const effectiveThreshold = pass.threshold / Math.pow(density, 0.85);

    const candidates = samplePassCandidates(
      width,
      height,
      grayscale,
      passTarget,
      darkness,
      detail,
      localStructure,
      foreground,
      focalSalience,
      achieved,
      pass,
      passIndex,
      effectiveThreshold,
      bgSuppression,
      rng
    );

    let placedInPass = 0;

    for (const candidate of candidates) {
      if (placedInPass >= passQuota || strokes.length >= budget) break;

      const cx = Math.round(candidate.x);
      const cy = Math.round(candidate.y);
      const idx = cy * width + cx;

      const checkRadius = Math.max(1, Math.min(3, pass.width * 0.65));
      const areaRes = computeLocalResidual(
        passTarget,
        achieved,
        width,
        height,
        candidate.x,
        candidate.y,
        checkRadius
      );
      const pointRes = Math.max(0, passTarget[idx] - achieved[idx]);
      const residual = detail[idx] > 0.15 ? Math.max(areaRes, pointRes * 0.9) : areaRes;
      if (residual < effectiveThreshold) continue;

      const localDetail = detail[idx] ?? 0;
      const fineCoh = coherence[idx] ?? 0;
      const macroCoh = macroFlow.coh[idx] ?? 0;

      // Continuous anisotropy weight [0..1]: 0 = flat isotropic plane, 1 = sleek hair/fur/stripe/fold/ridge
      const isSharpFeature = localDetail > 0.17 && fineCoh > 0.18;
      const rawAniso = isSharpFeature ? 1.0 : smoothstep(0.07, 0.4, macroCoh);
      const aniso = isSharpFeature
        ? 1.0
        : stylePreset === 'pet'
          ? clamp01(rawAniso * 1.32)
          : stylePreset === 'architecture'
            ? clamp01(rawAniso * 0.72)
            : rawAniso;

      let dirX: number;
      let dirY: number;
      if (isSharpFeature) {
        let fx = tangentX[idx];
        let fy = tangentY[idx];
        if (fx * ERGONOMIC_UX + fy * ERGONOMIC_UY < 0) {
          fx = -fx;
          fy = -fy;
        }
        const weave = pass.crossRad * 0.15 + candidate.jitterRad * 0.045;
        const cw = Math.cos(weave);
        const sw = Math.sin(weave);
        dirX = fx * cw - fy * sw;
        dirY = fx * sw + fy * cw;
      } else {
        let mx = macroFlow.tx[idx];
        let my = macroFlow.ty[idx];
        if (mx * ERGONOMIC_UX + my * ERGONOMIC_UY < 0) {
          mx = -mx;
          my = -my;
        }
        let bx = ERGONOMIC_UX * (1 - aniso) + mx * aniso;
        let by = ERGONOMIC_UY * (1 - aniso) + my * aniso;
        const bNorm = Math.hypot(bx, by) || 1;
        bx /= bNorm;
        by /= bNorm;

        const crossAngle =
          pass.crossRad * (1 - 0.84 * aniso) + candidate.jitterRad * (0.032 - 0.014 * aniso);
        const ca = Math.cos(crossAngle);
        const sa = Math.sin(crossAngle);
        dirX = bx * ca - by * sa;
        dirY = bx * sa + by * ca;
      }

      const normX = -dirY;
      const normY = dirX;
      const groupLines = isSharpFeature ? 1 : pass.groupLines;
      const mid = (groupLines - 1) * 0.5;
      const baseLen = (pass.length * (1 - aniso) + pass.flowLength * aniso) * presetLenScale;
      const strokeLen = isSharpFeature
        ? clamp(baseLen * 0.44, minAllowedLen, maxAllowedLen)
        : clamp(baseLen * rng.range(0.86, 1.14), minAllowedLen, maxAllowedLen);

      const localTone = passTarget[idx] ?? 0;
      const confidence = clamp(localTone * 0.62 + localDetail * 0.38, 0.05, 1);
      const priority =
        22 + passIndex * 12 + Math.round(confidence * 8 + Math.min(6, focalSalience[idx] * 6));

      for (let k = 0; k < groupLines; k++) {
        if (placedInPass >= passQuota || strokes.length >= budget) break;

        const lat =
          groupLines > 1
            ? (k - mid) * pass.pitch + rng.range(-0.12, 0.12) * pass.pitch
            : 0;
        const stagger = groupLines > 1 ? rng.range(-0.12, 0.12) * strokeLen : 0;
        const sx = candidate.x + normX * lat + dirX * stagger;
        const sy = candidate.y + normY * lat + dirY * stagger;
        if (sx < 1 || sy < 1 || sx >= width - 2 || sy >= height - 2) continue;

        const sIdx = Math.round(sy) * width + Math.round(sx);
        if (darkness[sIdx] < 0.018) continue;
        const sRes = Math.max(0, passTarget[sIdx] - achieved[sIdx]);
        if (sRes < effectiveThreshold * 0.58) continue;

        // Detect if seed is adjacent to clean paper so wide brushes slim down instead of bleeding
        const rProbe = Math.min(3.2 * scale, Math.max(1.0, pass.width * 0.5));
        const p1 =
          clamp(Math.round(sy + normY * rProbe), 0, height - 1) * width +
          clamp(Math.round(sx + normX * rProbe), 0, width - 1);
        const p2 =
          clamp(Math.round(sy - normY * rProbe), 0, height - 1) * width +
          clamp(Math.round(sx - normX * rProbe), 0, width - 1);
        const p3 =
          clamp(Math.round(sy + dirY * rProbe), 0, height - 1) * width +
          clamp(Math.round(sx + dirX * rProbe), 0, width - 1);
        const p4 =
          clamp(Math.round(sy - dirY * rProbe), 0, height - 1) * width +
          clamp(Math.round(sx - dirX * rProbe), 0, width - 1);
        const nearCleanPaper =
          darkness[p1] < 0.017 ||
          darkness[p2] < 0.017 ||
          darkness[p3] < 0.017 ||
          darkness[p4] < 0.017;
        const boundarySlim = nearCleanPaper ? (passIndex === 0 ? 0.44 : 0.56) : 1.0;
        const guardRadius = nearCleanPaper
          ? Math.min(0.85, pass.width * 0.2)
          : Math.min(3.0, pass.width * 0.44);

        const traced = traceAcademicPencilStroke({
          width,
          height,
          grayscale,
          passTarget,
          darkness,
          detail,
          achieved,
          foreground,
          flowTx: isSharpFeature ? tangentX : macroFlow.tx,
          flowTy: isSharpFeature ? tangentY : macroFlow.ty,
          centerX: sx,
          centerY: sy,
          initDirX: dirX,
          initDirY: dirY,
          aniso,
          isSharpFeature,
          totalLength: nearCleanPaper ? Math.max(minAllowedLen, strokeLen * 0.64) : strokeLen,
          threshold: effectiveThreshold,
          minAcceptedLen:
            isSharpFeature || nearCleanPaper
              ? Math.max(1.8, minAllowedLen * 0.62)
              : Math.max(minAllowedLen, 3.2 * scale),
          maxBrightJump: pass.maxBrightJump,
          guardRadius,
          bgSuppression,
          wristArc: rng.range(-0.007, 0.007),
        });

        if (!traced) continue;
        const { points, meanResidual } = traced;
        if (k % 2 === 1) points.reverse();

        // Slim down broad Pass 0/1 washes automatically near delicate facial features or clean paper borders
        const nearFineFeature = localStructure[sIdx] > 0.12 || localDetail > 0.12;
        const detailSlim = isSharpFeature
          ? clamp(1.02 - localDetail * 0.34, 0.6, 1.0)
          : passIndex === 0 && nearFineFeature
            ? 0.54
            : passIndex === 1 && nearFineFeature
              ? 0.72
              : 1.0;
        const passWidthMult = passIndex === 0 ? 1.0 : presetDetailWidthScale;
        const strokeWidth = Math.max(
          0.55 * scale,
          pass.width *
            passWidthMult *
            Math.min(detailSlim, boundarySlim) *
            rng.range(0.94, 1.06)
        );

        const passBaseOpacity = pass.opacity + demandOpacityBoost;
        const adaptiveBase =
          localTone < 0.12
            ? Math.min(passBaseOpacity * 0.78, meanResidual * 1.42 + 0.024)
            : meanResidual < 0.065
              ? Math.min(passBaseOpacity, meanResidual * 1.85 + 0.042)
              : passBaseOpacity;
        const slimComp = nearCleanPaper ? 1.16 : 1.0;
        const opacity = clamp(
          (adaptiveBase + meanResidual * (localTone < 0.12 ? 0.22 : 0.38)) * slimComp,
          0.038,
          pass.maxOpacity + demandOpacityBoost * 0.85
        );

        const grain =
          passIndex === 0
            ? clamp(0.3 + paperGrain * 0.34, 0.18, 0.62)
            : isSharpFeature
              ? clamp(0.18 + paperGrain * 0.26, 0.12, 0.46)
              : clamp(0.34 + paperGrain * 0.4, 0.24, 0.72);

        const stroke: Stroke = {
          id: `tone-${passIndex}-${++serial}`,
          kind: passIndex >= 1 ? 'crossHatching' : 'hatching',
          layer: pass.layer,
          order: 0,
          points,
          brush: {
            width: strokeWidth,
            opacity,
            hardness: Math.min(0.92, 0.44 + passIndex * 0.11),
            grain,
            jitter: (isSharpFeature ? 0.014 : 0.02) * scale * presetJitterScale,
            grade: pass.grade,
          },
          durationMs: clamp(Math.round(strokeLen * 1.5), 24, 96),
          priority,
          sourceConfidence: confidence,
        };

        strokes.push(stroke);
        rasterizeStrokeCoverage(achieved, width, height, stroke, rasterScratch);
        placedInPass++;
      }
    }
  }

  return strokes;
}

interface TraceStrokeArgs {
  width: number;
  height: number;
  grayscale: Float32Array;
  passTarget: Float32Array;
  darkness: Float32Array;
  detail: Float32Array;
  achieved: Float32Array;
  foreground: Float32Array;
  flowTx: Float32Array;
  flowTy: Float32Array;
  centerX: number;
  centerY: number;
  initDirX: number;
  initDirY: number;
  aniso: number;
  isSharpFeature: boolean;
  totalLength: number;
  threshold: number;
  minAcceptedLen: number;
  maxBrightJump: number;
  guardRadius: number;
  bgSuppression: number;
  wristArc: number;
}

function traceAcademicPencilStroke(
  a: TraceStrokeArgs
): { points: StrokePoint[]; meanResidual: number } | null {
  const {
    width,
    height,
    grayscale,
    passTarget,
    darkness,
    detail,
    achieved,
    foreground,
    flowTx,
    flowTy,
    centerX,
    centerY,
    initDirX,
    initDirY,
    aniso,
    isSharpFeature,
    totalLength,
    threshold,
    minAcceptedLen,
    maxBrightJump,
    guardRadius,
    bgSuppression,
    wristArc,
  } = a;

  const cx = clamp(Math.round(centerX), 0, width - 1);
  const cy = clamp(Math.round(centerY), 0, height - 1);
  const cIdx = cy * width + cx;

  const darkFloor = Math.max(0.018, threshold * 0.52);
  if (darkness[cIdx] < darkFloor || passTarget[cIdx] < darkFloor * 0.85) {
    return null;
  }
  if (bgSuppression > 0.3 && foreground[cIdx] < 0.08 && passTarget[cIdx] < 0.12) {
    return null;
  }

  const seedGray = grayscale[cIdx];
  const seedDetail = detail[cIdx];
  const stepPx = clamp(totalLength / 16, 1.15, 3.0);
  const halfSteps = clamp(Math.round((totalLength * 0.5) / stepPx), 2, 15);

  const maxStepTurn = isSharpFeature ? 0.065 : 0.008 + 0.038 * aniso;
  const maxTotalTurn = isSharpFeature ? 0.38 : 0.05 + 0.24 * aniso;
  const flowFollow = isSharpFeature ? 0.65 : aniso * 0.56;

  type PtSample = { x: number; y: number; res: number; tgt: number };

  const march = (sign: 1 | -1): PtSample[] => {
    const ray: PtSample[] = [];
    let x = centerX;
    let y = centerY;
    let dx = initDirX * sign;
    let dy = initDirY * sign;
    let cumulativeTurn = 0;
    let lockedTurnSign = 0;

    for (let s = 1; s <= halfSteps; s++) {
      if (flowFollow > 0.04) {
        const idx =
          clamp(Math.round(y), 0, height - 1) * width + clamp(Math.round(x), 0, width - 1);
        let fx = flowTx[idx];
        let fy = flowTy[idx];
        if (fx * dx + fy * dy < 0) {
          fx = -fx;
          fy = -fy;
        }
        const cross = dx * fy - dy * fx;
        const dot = clamp(dx * fx + dy * fy, -1, 1);
        let desiredTurn = Math.atan2(cross, dot) * flowFollow;

        if (!isSharpFeature) {
          if (lockedTurnSign === 0 && Math.abs(desiredTurn) > 0.004) {
            lockedTurnSign = desiredTurn > 0 ? 1 : -1;
          } else if (lockedTurnSign !== 0 && desiredTurn * lockedTurnSign < 0) {
            desiredTurn = 0;
          }
        }

        desiredTurn = clamp(desiredTurn, -maxStepTurn, maxStepTurn);
        if (Math.abs(cumulativeTurn + desiredTurn) > maxTotalTurn) {
          desiredTurn =
            clamp(maxTotalTurn - Math.abs(cumulativeTurn), 0, maxStepTurn) *
            Math.sign(desiredTurn);
        }
        cumulativeTurn += desiredTurn;

        const ct = Math.cos(desiredTurn);
        const st = Math.sin(desiredTurn);
        const ndx = dx * ct - dy * st;
        const ndy = dx * st + dy * ct;
        const norm = Math.hypot(ndx, ndy) || 1;
        dx = ndx / norm;
        dy = ndy / norm;
      } else if (Math.abs(wristArc) > 1e-4) {
        const ct = Math.cos(wristArc * sign);
        const st = Math.sin(wristArc * sign);
        const ndx = dx * ct - dy * st;
        const ndy = dx * st + dy * ct;
        dx = ndx;
        dy = ndy;
      }

      x += dx * stepPx;
      y += dy * stepPx;
      if (x < 0.5 || y < 0.5 || x > width - 1.5 || y > height - 1.5) break;

      const pIdx = Math.round(y) * width + Math.round(x);
      if (bgSuppression > 0.3 && foreground[pIdx] < 0.08 && passTarget[pIdx] < 0.12) {
        break;
      }

      // 1. Unblurred paper-white silhouette guard + lateral/forward brush-radius guard
      if (darkness[pIdx] < Math.max(0.018, darkFloor * 0.78) || passTarget[pIdx] < darkFloor * 0.75) {
        break;
      }
      if (guardRadius >= 0.8) {
        const lx1 = clamp(Math.round(x - dy * guardRadius), 0, width - 1);
        const ly1 = clamp(Math.round(y + dx * guardRadius), 0, height - 1);
        const lx2 = clamp(Math.round(x + dy * guardRadius), 0, width - 1);
        const ly2 = clamp(Math.round(y - dx * guardRadius), 0, height - 1);
        const fx1 = clamp(Math.round(x + dx * guardRadius), 0, width - 1);
        const fy1 = clamp(Math.round(y + dy * guardRadius), 0, height - 1);
        if (
          darkness[ly1 * width + lx1] < 0.017 ||
          darkness[ly2 * width + lx2] < 0.017 ||
          darkness[fy1 * width + fx1] < 0.017
        ) {
          break;
        }
      }

      // 2. Bilateral light-plane guard: allow dark hair sheen continuity (gray < 0.34),
      //    but stop immediately when entering skin, sclera, catchlights, or teeth!
      const gHere = grayscale[pIdx];
      const lumDiff = gHere - seedGray;
      if (
        (lumDiff > maxBrightJump && gHere > Math.max(0.33, seedGray + maxBrightJump)) ||
        (gHere > 0.68 && seedGray < 0.48) ||
        lumDiff < -0.24
      ) {
        break;
      }

      // 3. Crisp contour tucking: exterior/planar strokes stop cleanly at bright/skin facial features
      //    and true luminance boundaries, while gliding smoothly inside dark architectural/foliage shadow masses!
      if (
        !isSharpFeature &&
        seedDetail < 0.11 &&
        detail[pIdx] > 0.19 &&
        (gHere > 0.4 || Math.abs(lumDiff) > 0.11)
      ) {
        break;
      }

      const tgt = passTarget[pIdx];
      const res = Math.max(0, tgt - achieved[pIdx]);
      ray.push({ x, y, res, tgt });
    }

    return ray;
  };

  const back = march(-1).reverse();
  const fwd = march(1);
  const cTgt = passTarget[cIdx];
  const cRes = Math.max(0, cTgt - achieved[cIdx]);
  const samples: PtSample[] = [...back, { x: centerX, y: centerY, res: cRes, tgt: cTgt }, ...fwd];
  if (samples.length < 2) return null;

  let start = 0;
  let end = samples.length - 1;
  const seedPos = back.length;
  while (start < seedPos && samples[start].res < threshold * 0.24) start++;
  while (end > seedPos && samples[end].res < threshold * 0.24) end--;
  const active = samples.slice(start, end + 1);
  if (active.length < 2) return null;

  let pathLen = 0;
  let resSum = 0;
  for (let i = 0; i < active.length; i++) {
    resSum += active[i].res;
    if (i > 0) {
      pathLen += Math.hypot(active[i].x - active[i - 1].x, active[i].y - active[i - 1].y);
    }
  }
  if (pathLen < minAcceptedLen) return null;

  const meanResidual = resSum / active.length;
  if (meanResidual < threshold * 0.38) return null;

  const span = active.length - 1;
  const stride = Math.max(1, Math.floor(span / 8));
  const out: StrokePoint[] = [];

  for (let i = 0; i <= span; i += stride) {
    const u = i / span;
    const fusiform = Math.pow(Math.sin(Math.PI * clamp(u, 0.015, 0.985)), 0.56);
    const need = clamp01(active[i].res / Math.max(0.03, active[i].tgt));
    const pressure = clamp(
      0.06 + fusiform * (0.4 + need * 0.34 + active[i].res * 0.32),
      0.06,
      1
    );
    out.push({
      x: Math.round(active[i].x * 10) / 10,
      y: Math.round(active[i].y * 10) / 10,
      pressure,
    });
  }

  const lastSample = active[span];
  if (span % stride !== 0) {
    out.push({
      x: Math.round(lastSample.x * 10) / 10,
      y: Math.round(lastSample.y * 10) / 10,
      pressure: 0.05,
    });
  } else if (out.length > 0) {
    out[out.length - 1].pressure = 0.05;
  }
  if (out.length > 0) out[0].pressure = 0.05;

  return out.length >= 2 ? { points: out, meanResidual } : null;
}

/**
 * Multi-scale structure tensor (medium 6.5px + wide 18.5px) so silhouette orientation
 * propagates cleanly across wide uniform jet-black hair masses, garments, and tree trunks!
 */
function computeMultiScaleMacroFlow(
  grayscale: Float32Array,
  width: number,
  height: number,
  scale: number
): { tx: Float32Array; ty: Float32Array; coh: Float32Array } {
  const size = width * height;
  const smooth = gaussianBlur(grayscale, width, height, Math.max(1.0, 1.8 * scale));
  const jxx = new Float32Array(size);
  const jxy = new Float32Array(size);
  const jyy = new Float32Array(size);

  for (let y = 0; y < height; y++) {
    const yPrev = reflectIndex(y - 1, height) * width;
    const yCurr = y * width;
    const yNext = reflectIndex(y + 1, height) * width;
    for (let x = 0; x < width; x++) {
      const xPrev = reflectIndex(x - 1, width);
      const xNext = reflectIndex(x + 1, width);
      const gx = (smooth[yCurr + xNext] - smooth[yCurr + xPrev]) * 0.5;
      const gy = (smooth[yNext + x] - smooth[yPrev + x]) * 0.5;
      const idx = yCurr + x;
      jxx[idx] = gx * gx;
      jxy[idx] = gx * gy;
      jyy[idx] = gy * gy;
    }
  }

  const medSigma = Math.max(2.2, 6.5 * scale);
  const wideSigma = Math.max(6.0, 18.5 * scale);
  const mxx = gaussianBlur(jxx, width, height, medSigma);
  const mxy = gaussianBlur(jxy, width, height, medSigma);
  const myy = gaussianBlur(jyy, width, height, medSigma);

  const wxx = gaussianBlur(jxx, width, height, wideSigma);
  const wxy = gaussianBlur(jxy, width, height, wideSigma);
  const wyy = gaussianBlur(jyy, width, height, wideSigma);

  const tx = new Float32Array(size);
  const ty = new Float32Array(size);
  const coh = new Float32Array(size);

  for (let i = 0; i < size; i++) {
    // Only blend wide-range orientation inside deep dark masses (e.g. uniform black hair/cloth)
    // so distant hair/jawline contours never hijack smooth planar hatching on cheeks, noses, or necks!
    const darkInteriorGate = 1 - smoothstep(0.18, 0.36, smooth[i]);
    const wideWeight = 1.45 * darkInteriorGate;
    const sxx = mxx[i] + wxx[i] * wideWeight;
    const sxy = mxy[i] + wxy[i] * wideWeight;
    const syy = myy[i] + wyy[i] * wideWeight;
    const trace = sxx + syy;
    const diff = sxx - syy;
    const aniso = Math.hypot(diff, 2 * sxy);
    const reg = 3.2e-5 + (1 - darkInteriorGate) * 2.1e-4;
    coh[i] = clamp01(aniso / (trace + reg));
    const a =
      coh[i] > 0.02 ? 0.5 * Math.atan2(2 * sxy, diff) + Math.PI * 0.5 : ERGONOMIC_HATCH_RAD;
    tx[i] = Math.cos(a);
    ty[i] = Math.sin(a);
  }

  return { tx, ty, coh };
}

function samplePassCandidates(
  width: number,
  height: number,
  grayscale: Float32Array,
  passTarget: Float32Array,
  darkness: Float32Array,
  detail: Float32Array,
  localStructure: Float32Array,
  foreground: Float32Array,
  focalSalience: Float32Array,
  achieved: Float32Array,
  pass: AcademicPassConfig,
  passIndex: number,
  effectiveThreshold: number,
  bgSuppression: number,
  rng: SeededRandom
): TonalCandidate[] {
  const candidates: TonalCandidate[] = [];
  const spacing = Math.max(2.2, pass.spacing);

  for (let repeat = 0; repeat < pass.repeats; repeat++) {
    const offsetX = ((repeat + 0.29) / pass.repeats) * spacing;
    const offsetY = (((repeat * 0.618034) % 1) + 0.17) * spacing;

    for (let y = offsetY; y < height - 1; y += spacing) {
      for (let x = offsetX; x < width - 1; x += spacing) {
        const px = clamp(x + rng.range(-spacing * 0.32, spacing * 0.32), 1, width - 2);
        const py = clamp(y + rng.range(-spacing * 0.32, spacing * 0.32), 1, height - 2);
        const idx = Math.round(py) * width + Math.round(px);

        if (bgSuppression > 0.3 && (foreground[idx] ?? 1) < 0.08 && passTarget[idx] < 0.12) {
          continue;
        }
        if (darkness[idx] < Math.max(0.018, effectiveThreshold * 0.52)) continue;

        // Keep bright highlights (nose bridge, forehead, cheek highlights) clean luminous paper!
        if (
          passIndex >= 1 &&
          grayscale[idx] > 0.71 &&
          detail[idx] < 0.08 &&
          darkness[idx] < 0.046
        ) {
          continue;
        }

        const residual = Math.max(0, passTarget[idx] - achieved[idx]);
        if (residual < effectiveThreshold * 0.62) continue;

        // Pass 0 distributes base wash evenly across all shaded planes; later passes focus sharply on features!
        const fgWeight = passIndex === 0 ? 0.84 + 0.16 * (foreground[idx] ?? 1) : 0.62 + 0.38 * (foreground[idx] ?? 1);
        const focalBoost =
          passIndex === 0
            ? 0.92 + 0.18 * focalSalience[idx]
            : passIndex >= 3
              ? 0.7 + 1.3 * focalSalience[idx]
              : 0.75 + 0.8 * focalSalience[idx];
        const score = residual * fgWeight * focalBoost + detail[idx] * 0.08 + rng.next() * 0.005;

        candidates.push({
          x: px,
          y: py,
          tier: passIndex <= 2 ? repeat : 0,
          score,
          jitterRad: rng.range(-1, 1),
        });
      }
    }
  }

  if (passIndex >= 2) {
    const featStep = Math.max(1.8, spacing * 0.44);
    for (let y = 2; y < height - 2; y += featStep) {
      const row = Math.round(y) * width;
      for (let x = 2; x < width - 2; x += featStep) {
        const idx = row + Math.round(x);
        if (darkness[idx] < 0.018) continue;
        const isDarkFocal = darkness[idx] > 0.48 && localStructure[idx] > 0.055;
        if (detail[idx] < 0.13 && !isDarkFocal) continue;
        if (bgSuppression > 0.3 && (foreground[idx] ?? 1) < 0.12 && passTarget[idx] < 0.16) {
          continue;
        }
        const residual = Math.max(0, passTarget[idx] - achieved[idx]);
        if (residual < effectiveThreshold * 0.64) continue;

        candidates.push({
          x: clamp(x + rng.range(-0.6, 0.6), 1, width - 2),
          y: clamp(y + rng.range(-0.6, 0.6), 1, height - 2),
          tier: 0,
          score:
            residual * (1.32 + focalSalience[idx] * 1.05) +
            detail[idx] * 0.24 +
            (isDarkFocal ? 0.12 : 0) +
            rng.next() * 0.004,
          jitterRad: rng.range(-1, 1),
        });
      }
    }
  }

  candidates.sort((a, b) => a.tier - b.tier || b.score - a.score);
  return candidates;
}

function computeLocalResidual(
  target: Float32Array,
  achieved: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number
): number {
  const r = Math.max(1, Math.round(radius));
  const cx = Math.round(x);
  const cy = Math.round(y);
  let sum = 0;
  let weightSum = 0;

  for (let dy = -r; dy <= r; dy++) {
    const py = cy + dy;
    if (py < 0 || py >= height) continue;
    const row = py * width;
    for (let dx = -r; dx <= r; dx++) {
      const px = cx + dx;
      if (px < 0 || px >= width) continue;
      const weight = 1 / (1 + dx * dx + dy * dy);
      sum += Math.max(0, target[row + px] - achieved[row + px]) * weight;
      weightSum += weight;
    }
  }
  return sum / Math.max(1e-6, weightSum);
}
