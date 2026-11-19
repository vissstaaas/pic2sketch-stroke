import type { PencilGrade, Stroke, StrokeLayer, StrokeScript } from '../../types/stroke';

export type PlotterTier = 'fast' | 'standard' | 'fine';
export type PlotterPaperId = 'postcard' | 'A5' | 'A4';
export type PlotterProtocol = 'zaxis' | 'grbl';

export interface PlotterConfig {
  tier: PlotterTier;
  paper: PlotterPaperId;
  protocol: PlotterProtocol;
  /** Pen-down drawing feedrate in mm/min (1200..4800, default 2800) */
  feedRate: number;
  /** Maximum spring-holder Z compression depth in mm (0.6..3.6, default 2.2) */
  maxZDepthMm: number;
  /** Safe pen-up lift height in mm (default 4.0) */
  safeLiftMm: number;
  /** Magnetic clamp paper safety margin in mm (5..24, default 12) */
  marginMm: number;
}

export const DEFAULT_PLOTTER_CONFIG: PlotterConfig = {
  tier: 'standard',
  paper: 'A5',
  protocol: 'zaxis',
  feedRate: 2800,
  maxZDepthMm: 2.2,
  safeLiftMm: 4.0,
  marginMm: 12,
};

export interface PaperSpec {
  id: PlotterPaperId;
  label: string;
  shortLabel: string;
  shortMm: number;
  longMm: number;
}

export const PAPER_SPECS: Record<PlotterPaperId, PaperSpec> = {
  postcard: {
    id: 'postcard',
    label: '明信片 100×150',
    shortLabel: '明信片',
    shortMm: 100,
    longMm: 150,
  },
  A5: {
    id: 'A5',
    label: 'A5 手绘纸 148×210',
    shortLabel: 'A5',
    shortMm: 148,
    longMm: 210,
  },
  A4: {
    id: 'A4',
    label: 'A4 画册纸 210×297',
    shortLabel: 'A4',
    shortMm: 210,
    longMm: 297,
  },
};

export interface TierSpec {
  id: PlotterTier;
  title: string;
  subtitle: string;
  maxSourceStrokes: number;
  zigzagConnectMm: number;
}

export const TIER_SPECS: Record<PlotterTier, TierSpec> = {
  fast: {
    id: 'fast',
    title: '⚡ 极速摆摊',
    subtitle: '85%+轮廓 · 精简排线 · 快速出图',
    maxSourceStrokes: 3800,
    zigzagConnectMm: 2.8,
  },
  standard: {
    id: 'standard',
    title: '⚖️ 标准手绘',
    subtitle: '完整五官轮廓 · 均衡排线质感',
    maxSourceStrokes: 6400,
    zigzagConnectMm: 2.0,
  },
  fine: {
    id: 'fine',
    title: '💎 收藏精绘',
    subtitle: '全量细节 · 细腻铅笔明暗层次',
    maxSourceStrokes: 9500,
    zigzagConnectMm: 1.25,
  },
};

export interface PlotterPointMm {
  x: number;
  y: number;
  pressure: number;
  /** True when entering the next parallel hatch after a short turnaround shift */
  isTurnaround?: boolean;
}

export interface PlotterStrokeMm {
  id: string;
  index: number;
  layer: StrokeLayer;
  grade: PencilGrade;
  brushOpacity: number;
  brushWidthMm: number;
  meanPressure: number;
  points: PlotterPointMm[];
  lengthMm: number;
  airFrom: { x: number; y: number };
  airDistMm: number;
  isMergedZigzag: boolean;
  mergedCount: number;
  airAnimStart: number;
  drawAnimStart: number;
  animEnd: number;
}

export interface PlotterTelemetry {
  drawMm: number;
  travelMm: number;
  penLifts: number;
  originalStrokes: number;
  sampledStrokes: number;
  savedLiftPct: number;
  drawSec: number;
  travelSec: number;
  liftSec: number;
  totalSec: number;
}

export interface PlotterPlan {
  config: PlotterConfig;
  paperLabel: string;
  isLandscape: boolean;
  paperWidthMm: number;
  paperHeightMm: number;
  drawableBoxMm: { x: number; y: number; width: number; height: number };
  strokes: PlotterStrokeMm[];
  totalAnimLen: number;
  telemetry: PlotterTelemetry;
}

const LAYER_ORDER: StrokeLayer[] = [
  'structure',
  'outline',
  'features',
  'lightTone',
  'midTone',
  'darkTone',
  'finalAccent',
];

const ESSENTIAL_LAYERS: StrokeLayer[] = ['outline', 'features', 'finalAccent'];
const TONAL_LAYERS: StrokeLayer[] = ['lightTone', 'midTone', 'darkTone'];
const CONTOUR_LAYERS = new Set<StrokeLayer>(['outline', 'features', 'finalAccent']);

const LAYER_BASE_PRESSURE: Record<StrokeLayer, number> = {
  structure: 0.2,
  outline: 0.66,
  features: 0.78,
  lightTone: 0.34,
  midTone: 0.56,
  darkTone: 0.82,
  finalAccent: 0.96,
};

const LAYER_DEFAULT_GRADE: Record<StrokeLayer, PencilGrade> = {
  structure: '2H',
  outline: 'HB',
  features: '2B',
  lightTone: 'HB',
  midTone: '2B',
  darkTone: '4B',
  finalAccent: '6B',
};

interface InternalMmStroke {
  id: string;
  layer: StrokeLayer;
  grade: PencilGrade;
  brushOpacity: number;
  brushWidthMm: number;
  points: PlotterPointMm[];
  lengthMm: number;
  mergedCount: number;
  dirX: number;
  dirY: number;
}

function clampVal(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function dist2(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

function polylineLength(pts: readonly PlotterPointMm[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].isTurnaround) continue;
    len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return len;
}

function unitDirection(pts: readonly PlotterPointMm[]): { dx: number; dy: number } {
  if (pts.length < 2) return { dx: 1, dy: 0 };
  const a = pts[0];
  const b = pts[pts.length - 1];
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const mag = Math.hypot(vx, vy);
  if (mag < 1e-4) return { dx: 1, dy: 0 };
  return { dx: vx / mag, dy: vy / mag };
}

function sampleEvenly<T>(items: readonly T[], count: number): T[] {
  if (count <= 0) return [];
  if (items.length <= count) return items.slice();
  const out: T[] = new Array(count);
  const step = items.length / count;
  for (let i = 0; i < count; i++) {
    out[i] = items[Math.min(items.length - 1, Math.floor(i * step))];
  }
  return out;
}

/**
 * Ranks tonal strokes slightly by visual impact (opacity * length) while keeping spatial balance.
 */
function sampleTonalBalanced(list: readonly Stroke[], quota: number): Stroke[] {
  if (quota <= 0) return [];
  if (list.length <= quota) return list.slice();
  return sampleEvenly(list, quota);
}

/**
 * Selects up to `tierSpec.maxSourceStrokes` strokes from visible source strokes while
 * prioritizing essential contours/features (`outline`, `features`, `finalAccent` — 85–100%)
 * and allocating remaining budget across tonal hatching layers proportionally.
 */
function selectTierStrokes(visible: readonly Stroke[], tierSpec: TierSpec): Stroke[] {
  const byLayer: Record<StrokeLayer, Stroke[]> = {
    structure: [],
    outline: [],
    features: [],
    lightTone: [],
    midTone: [],
    darkTone: [],
    finalAccent: [],
  };

  for (let i = 0; i < visible.length; i++) {
    byLayer[visible[i].layer].push(visible[i]);
  }

  const totalVisible = visible.length;
  const budget = tierSpec.maxSourceStrokes;
  if (totalVisible <= budget) {
    return LAYER_ORDER.flatMap((l) => byLayer[l]);
  }

  const quotas: Record<StrokeLayer, number> = {
    structure: 0,
    outline: 0,
    features: 0,
    lightTone: 0,
    midTone: 0,
    darkTone: 0,
    finalAccent: 0,
  };

  // Reserve up to 62% of budget for essential contours & final accents first,
  // preserving 100% of outline & features whenever possible.
  const essentialCap = Math.round(budget * 0.62);
  let remaining = budget;

  const essentialAvail =
    byLayer.outline.length + byLayer.features.length + byLayer.finalAccent.length;

  if (essentialAvail <= essentialCap) {
    for (const l of ESSENTIAL_LAYERS) {
      quotas[l] = byLayer[l].length;
    }
    remaining -= essentialAvail;
  } else {
    // Keep 100% of outline + features up to essentialCap first, then allocate finalAccent
    let remEssential = essentialCap;
    const outlineTake = Math.min(byLayer.outline.length, Math.round(remEssential * 0.45));
    const featuresTake = Math.min(byLayer.features.length, Math.round(remEssential * 0.25));
    quotas.outline = Math.min(byLayer.outline.length, Math.max(outlineTake, Math.min(byLayer.outline.length, Math.round(byLayer.outline.length * 0.85))));
    quotas.features = Math.min(byLayer.features.length, Math.max(featuresTake, Math.min(byLayer.features.length, Math.round(byLayer.features.length * 0.88))));

    // Clamp if over essentialCap
    let usedE = quotas.outline + quotas.features;
    if (usedE > essentialCap) {
      const s = essentialCap / usedE;
      quotas.outline = Math.floor(quotas.outline * s);
      quotas.features = Math.floor(quotas.features * s);
      usedE = quotas.outline + quotas.features;
    }
    quotas.finalAccent = Math.min(byLayer.finalAccent.length, Math.max(0, essentialCap - usedE));
    remaining -= quotas.outline + quotas.features + quotas.finalAccent;
  }

  // Allocate remaining budget across tonal layers proportionally to each layer's count
  const tonalWeights: Record<StrokeLayer, number> = {
    structure: 0,
    outline: 0,
    features: 0,
    lightTone: byLayer.lightTone.length * 0.85,
    midTone: byLayer.midTone.length * 1.0,
    darkTone: byLayer.darkTone.length * 1.15,
    finalAccent: 0,
  };
  const tonalWeightSum =
    tonalWeights.lightTone + tonalWeights.midTone + tonalWeights.darkTone;

  if (tonalWeightSum > 0 && remaining > 0) {
    let usedT = 0;
    for (const l of TONAL_LAYERS) {
      const target = Math.floor((remaining * tonalWeights[l]) / tonalWeightSum);
      quotas[l] = Math.min(byLayer[l].length, target);
      usedT += quotas[l];
    }
    remaining -= usedT;
  }

  // Distribute any left-over quota across any layer (contours first, then tonal)
  const fillOrder: StrokeLayer[] = [
    'outline',
    'features',
    'finalAccent',
    'darkTone',
    'midTone',
    'lightTone',
    'structure',
  ];
  for (const l of fillOrder) {
    if (remaining <= 0) break;
    const surplus = byLayer[l].length - quotas[l];
    if (surplus > 0) {
      const add = Math.min(surplus, remaining);
      quotas[l] += add;
      remaining -= add;
    }
  }

  const selected: Stroke[] = [];
  for (const layer of LAYER_ORDER) {
    const list = byLayer[layer];
    const q = quotas[layer];
    if (q <= 0 || list.length === 0) continue;
    if (list.length <= q) {
      selected.push(...list);
    } else if (CONTOUR_LAYERS.has(layer)) {
      const ranked = list
        .slice()
        .sort(
          (a, b) =>
            b.priority + b.sourceConfidence * 10 - (a.priority + a.sourceConfidence * 10)
        );
      selected.push(...ranked.slice(0, q));
    } else {
      selected.push(...sampleTonalBalanced(list, q));
    }
  }

  return selected;
}

/**
 * Chains strokes within a single layer using 2D nearest-neighbor search over both endpoints.
 */
function orderLayerNearestNeighbor(
  strokes: readonly InternalMmStroke[],
  startX: number,
  startY: number
): { ordered: InternalMmStroke[]; endX: number; endY: number } {
  const n = strokes.length;
  if (n === 0) return { ordered: [], endX: startX, endY: startY };

  const sx = new Float64Array(n);
  const sy = new Float64Array(n);
  const ex = new Float64Array(n);
  const ey = new Float64Array(n);
  const used = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const pts = strokes[i].points;
    sx[i] = pts[0].x;
    sy[i] = pts[0].y;
    ex[i] = pts[pts.length - 1].x;
    ey[i] = pts[pts.length - 1].y;
  }

  const ordered: InternalMmStroke[] = new Array(n);
  let curX = startX;
  let curY = startY;

  for (let step = 0; step < n; step++) {
    let bestIdx = -1;
    let bestDistSq = Infinity;
    let bestReverse = false;

    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const dx1 = sx[i] - curX;
      const dy1 = sy[i] - curY;
      const d1 = dx1 * dx1 + dy1 * dy1;
      if (d1 < bestDistSq) {
        bestDistSq = d1;
        bestIdx = i;
        bestReverse = false;
      }

      const dx2 = ex[i] - curX;
      const dy2 = ey[i] - curY;
      const d2 = dx2 * dx2 + dy2 * dy2;
      if (d2 < bestDistSq) {
        bestDistSq = d2;
        bestIdx = i;
        bestReverse = true;
      }
    }

    used[bestIdx] = 1;
    const picked = strokes[bestIdx];
    if (bestReverse) {
      ordered[step] = {
        ...picked,
        points: picked.points.slice().reverse(),
        dirX: -picked.dirX,
        dirY: -picked.dirY,
      };
      curX = sx[bestIdx];
      curY = sy[bestIdx];
    } else {
      ordered[step] = picked;
      curX = ex[bestIdx];
      curY = ey[bestIdx];
    }
  }

  return { ordered, endX: curX, endY: curY };
}

/**
 * Merges consecutive nearest-neighbor strokes within a layer into continuous zigzag polylines
 * only when:
 *  - gap <= 0.55 mm (direct virtually touching continuation), OR
 *  - tonal layer gap <= connectThresholdMm AND parallel stroke direction |cos(theta)| >= 0.75
 *    (marks turnaround entry vertex with isTurnaround=true so preview & plotters avoid bridge scratches).
 */
function mergeContinuousZigzags(
  ordered: readonly InternalMmStroke[],
  connectThresholdMm: number,
  allowTurnaroundBridges: boolean
): InternalMmStroke[] {
  if (ordered.length === 0) return [];
  const merged: InternalMmStroke[] = [];
  const MAX_CONTINUOUS_LEN_MM = 90;
  const DIRECT_TOUCH_MM = 0.55;

  let cur: InternalMmStroke = {
    ...ordered[0],
    points: ordered[0].points.map((p) => ({ ...p })),
  };
  let lastDirX = cur.dirX;
  let lastDirY = cur.dirY;

  for (let i = 1; i < ordered.length; i++) {
    const next = ordered[i];
    const curEnd = cur.points[cur.points.length - 1];
    const nextStart = next.points[0];
    const gap = dist2(curEnd.x, curEnd.y, nextStart.x, nextStart.y);

    const canAcceptLen = cur.lengthMm + gap + next.lengthMm <= MAX_CONTINUOUS_LEN_MM;
    const withinDirectTouch = gap <= DIRECT_TOUCH_MM;
    const absCos = Math.abs(lastDirX * next.dirX + lastDirY * next.dirY);
    const compatibleStyle =
      Math.abs(cur.brushOpacity - next.brushOpacity) <= 0.16 &&
      cur.grade === next.grade;

    const withinParallelZigzag =
      allowTurnaroundBridges &&
      compatibleStyle &&
      gap <= connectThresholdMm &&
      absCos >= 0.75;

    if (canAcceptLen && (withinDirectTouch || withinParallelZigzag)) {
      const nextPts = next.points.map((p, idx) =>
        idx === 0 && !withinDirectTouch ? { ...p, isTurnaround: true } : { ...p }
      );
      cur.points.push(...nextPts);
      cur.lengthMm += (withinDirectTouch ? gap : 0) + next.lengthMm;
      cur.mergedCount += next.mergedCount;
      cur.brushOpacity = (cur.brushOpacity + next.brushOpacity) * 0.5;
      cur.brushWidthMm = (cur.brushWidthMm + next.brushWidthMm) * 0.5;
      lastDirX = next.dirX;
      lastDirY = next.dirY;
    } else {
      merged.push(cur);
      cur = {
        ...next,
        points: next.points.map((p) => ({ ...p })),
      };
      lastDirX = next.dirX;
      lastDirY = next.dirY;
    }
  }

  merged.push(cur);
  return merged;
}

/**
 * Builds an optimized physical robotic arm / pen plotter toolpath from a generated StrokeScript.
 */
export function buildPlotterPlan(
  script: StrokeScript,
  config: PlotterConfig,
  hiddenLayers?: ReadonlySet<StrokeLayer>
): PlotterPlan {
  const safeMarginMm = clampVal(config.marginMm, 5, 24);
  const safeFeedRate = clampVal(config.feedRate, 800, 6000);
  const safeMaxZ = clampVal(config.maxZDepthMm, 0.4, 4.5);
  const safeLiftMm = clampVal(config.safeLiftMm, 1.5, 12);

  const normalizedConfig: PlotterConfig = {
    ...config,
    marginMm: safeMarginMm,
    feedRate: safeFeedRate,
    maxZDepthMm: safeMaxZ,
    safeLiftMm,
  };

  const spec = PAPER_SPECS[config.paper];
  const tierSpec = TIER_SPECS[config.tier];

  const srcW = Math.max(1, script.canvas.width || script.sourceImage.processedWidth || 640);
  const srcH = Math.max(1, script.canvas.height || script.sourceImage.processedHeight || 640);
  const isLandscape = srcW > srcH * 1.05;

  const paperWidthMm = isLandscape ? spec.longMm : spec.shortMm;
  const paperHeightMm = isLandscape ? spec.shortMm : spec.longMm;

  const innerW = Math.max(20, paperWidthMm - safeMarginMm * 2);
  const innerH = Math.max(20, paperHeightMm - safeMarginMm * 2);
  const scale = Math.min(innerW / srcW, innerH / srcH);

  const drawBoxW = srcW * scale;
  const drawBoxH = srcH * scale;
  const offsetX = (paperWidthMm - drawBoxW) * 0.5;
  const offsetY = (paperHeightMm - drawBoxH) * 0.5;

  const userVisible = script.strokes.filter(
    (s) => s.points.length >= 2 && !(hiddenLayers && hiddenLayers.has(s.layer))
  );
  const nonStructure = userVisible.filter((s) => s.layer !== 'structure');
  // Exclude faint 2H construction scaffolding by default unless it is the only visible layer
  const visibleStrokes = nonStructure.length > 0 ? nonStructure : userVisible;

  const selected = selectTierStrokes(visibleStrokes, tierSpec);

  const bucketByLayer: Record<StrokeLayer, InternalMmStroke[]> = {
    structure: [],
    outline: [],
    features: [],
    lightTone: [],
    midTone: [],
    darkTone: [],
    finalAccent: [],
  };

  const clampPad = Math.max(2, safeMarginMm * 0.35);

  for (let i = 0; i < selected.length; i++) {
    const s = selected[i];
    const baseLayerP = LAYER_BASE_PRESSURE[s.layer] ?? 0.55;
    const opacityBoost = clampVal(s.brush.opacity, 0.05, 1.0);
    const pts: PlotterPointMm[] = [];

    for (let k = 0; k < s.points.length; k++) {
      const p = s.points[k];
      const mx = clampVal(offsetX + p.x * scale, clampPad, paperWidthMm - clampPad);
      const my = clampVal(offsetY + p.y * scale, clampPad, paperHeightMm - clampPad);
      const ptPressure = clampVal(
        baseLayerP * 0.65 + clampVal(p.pressure, 0.1, 1.0) * Math.max(0.25, opacityBoost) * 0.42,
        0.12,
        1.0
      );

      if (pts.length > 0) {
        const prev = pts[pts.length - 1];
        if (Math.hypot(mx - prev.x, my - prev.y) < 0.08 && k < s.points.length - 1) {
          continue;
        }
      }
      pts.push({
        x: Math.round(mx * 100) / 100,
        y: Math.round(my * 100) / 100,
        pressure: Math.round(ptPressure * 1000) / 1000,
      });
    }

    if (pts.length < 2) continue;
    const lenMm = polylineLength(pts);
    if (lenMm < 0.15) continue;

    const dir = unitDirection(pts);
    bucketByLayer[s.layer].push({
      id: s.id,
      layer: s.layer,
      grade: s.brush.grade ?? LAYER_DEFAULT_GRADE[s.layer],
      brushOpacity: opacityBoost,
      brushWidthMm: clampVal(s.brush.width * scale, 0.18, 1.2),
      points: pts,
      lengthMm: lenMm,
      mergedCount: 1,
      dirX: dir.dx,
      dirY: dir.dy,
    });
  }

  let curPenX = 0;
  let curPenY = 0;
  const combinedInternal: InternalMmStroke[] = [];

  for (const layer of LAYER_ORDER) {
    const rawLayerList = bucketByLayer[layer];
    if (rawLayerList.length === 0) continue;

    const { ordered, endX, endY } = orderLayerNearestNeighbor(rawLayerList, curPenX, curPenY);
    curPenX = endX;
    curPenY = endY;

    const isContour = CONTOUR_LAYERS.has(layer);
    const mergedLayer = mergeContinuousZigzags(
      ordered,
      isContour ? 0.55 : tierSpec.zigzagConnectMm,
      !isContour
    );
    combinedInternal.push(...mergedLayer);
  }

  // Finalize timeline offsets and telemetry
  const finalStrokes: PlotterStrokeMm[] = new Array(combinedInternal.length);
  let penX = 0;
  let penY = 0;
  let animCursor = 0;
  let drawMm = 0;
  let travelMm = 0;

  for (let i = 0; i < combinedInternal.length; i++) {
    const s = combinedInternal[i];
    const startPt = s.points[0];
    const endPt = s.points[s.points.length - 1];
    const airFrom = { x: penX, y: penY };
    const airDistMm = dist2(penX, penY, startPt.x, startPt.y);

    const exactLen = Math.max(0.15, polylineLength(s.points));
    let pSum = 0;
    for (let k = 0; k < s.points.length; k++) {
      pSum += s.points[k].pressure;
    }
    const meanPressure = pSum / s.points.length;

    const airAnimStart = animCursor;
    const drawAnimStart = airAnimStart + airDistMm * 0.25;
    const animEnd = drawAnimStart + exactLen;
    animCursor = animEnd;

    finalStrokes[i] = {
      id: s.id,
      index: i,
      layer: s.layer,
      grade: s.grade,
      brushOpacity: s.brushOpacity,
      brushWidthMm: s.brushWidthMm,
      meanPressure,
      points: s.points,
      lengthMm: exactLen,
      airFrom,
      airDistMm,
      isMergedZigzag: s.mergedCount > 1,
      mergedCount: s.mergedCount,
      airAnimStart,
      drawAnimStart,
      animEnd,
    };

    drawMm += exactLen;
    travelMm += airDistMm;
    penX = endPt.x;
    penY = endPt.y;
  }

  const returnHomeMm = dist2(penX, penY, 0, 0);
  travelMm += returnHomeMm;

  const originalStrokes = visibleStrokes.length;
  const sampledStrokes = selected.length;
  const penLifts = finalStrokes.length;
  const savedLiftPct =
    originalStrokes > 0
      ? clampVal(Math.round(((originalStrokes - penLifts) / originalStrokes) * 100), 0, 99)
      : 0;

  const drawSpeedMmPerSec = safeFeedRate / 60;
  const rapidSpeedMmPerSec = Math.max(drawSpeedMmPerSec * 1.65, 3600 / 60);
  const liftCycleSec = config.protocol === 'zaxis' ? 0.12 : 0.16;

  const drawSec = (drawMm / drawSpeedMmPerSec) * 1.12;
  const travelSec = (travelMm / rapidSpeedMmPerSec) * 1.15;
  const liftSec = penLifts * liftCycleSec;
  const totalSec = Math.max(1, Math.round(drawSec + travelSec + liftSec));

  return {
    config: normalizedConfig,
    paperLabel: `${spec.shortLabel} ${isLandscape ? '横版' : '竖版'}`,
    isLandscape,
    paperWidthMm,
    paperHeightMm,
    drawableBoxMm: {
      x: Math.round(offsetX * 100) / 100,
      y: Math.round(offsetY * 100) / 100,
      width: Math.round(drawBoxW * 100) / 100,
      height: Math.round(drawBoxH * 100) / 100,
    },
    strokes: finalStrokes,
    totalAnimLen: Math.max(1, animCursor),
    telemetry: {
      drawMm,
      travelMm,
      penLifts,
      originalStrokes,
      sampledStrokes,
      savedLiftPct,
      drawSec,
      travelSec,
      liftSec,
      totalSec,
    },
  };
}

/**
 * Computes physical Z depth (negative = pressed into paper) for a normalized pressure [0..1].
 */
export function computeZDepthMm(pressure: number, maxZDepthMm: number): number {
  const minTouch = Math.min(0.35, maxZDepthMm * 0.4);
  const depth = minTouch + clampVal(pressure, 0, 1) * Math.max(0.1, maxZDepthMm - minTouch);
  return -Math.round(depth * 100) / 100;
}

/**
 * Formats a duration in seconds into readable Chinese minutes/seconds text.
 */
export function formatDurationChinese(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  if (sec < 60) return `${sec}秒`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}分 ${String(s).padStart(2, '0')}秒`;
}

/**
 * Exports the PlotterPlan to machine-ready G-code supporting both Z-axis spring-holder pressure
 * (G1 X Y Z) and GRBL servo pen plotters (M3/M5). Feathers Z on zigzag turnaround shifts.
 */
export function exportPlotterGcode(plan: PlotterPlan): string {
  const { config, paperWidthMm, paperHeightMm, strokes, telemetry } = plan;
  const rapidFeed = Math.round(Math.max(config.feedRate * 1.6, 3600));
  const lines: string[] = [
    '; =========================================================',
    '; Atelier Graphite - Robotic Arm & Pen Plotter G-code',
    `; Paper     : ${plan.paperLabel} (${paperWidthMm} x ${paperHeightMm} mm, margin ${config.marginMm} mm)`,
    `; Tier      : ${config.tier} | Original: ${telemetry.originalStrokes} -> Physical Lifts: ${telemetry.penLifts} (Saved ${telemetry.savedLiftPct}%)`,
    `; Telemetry : Draw ${(telemetry.drawMm / 1000).toFixed(2)}m | Travel ${(telemetry.travelMm / 1000).toFixed(2)}m | Est ${formatDurationChinese(telemetry.totalSec)}`,
    `; Protocol  : ${config.protocol === 'zaxis' ? `3D Z-Axis Spring Pressure (Max Z-${config.maxZDepthMm.toFixed(2)}mm)` : 'GRBL Pen Plotter Servo (M3/M5)'}`,
    '; =========================================================',
    'G21 ; Millimeter units',
    'G90 ; Absolute positioning',
  ];

  if (config.protocol === 'zaxis') {
    lines.push(`G0 Z${config.safeLiftMm.toFixed(2)} F${rapidFeed} ; Safe initial lift`);
  } else {
    lines.push('M5 ; Initial pen up');
    lines.push('G4 P0.10');
  }
  lines.push(`G0 X0.00 Y0.00 F${rapidFeed}`);

  let currentLayer: StrokeLayer | null = null;
  for (let i = 0; i < strokes.length; i++) {
    const stroke = strokes[i];
    if (stroke.layer !== currentLayer) {
      currentLayer = stroke.layer;
      lines.push(`; --- Layer: ${stroke.layer} (${stroke.grade}) ---`);
    }

    const startPt = stroke.points[0];
    lines.push(`G0 X${startPt.x.toFixed(2)} Y${startPt.y.toFixed(2)} F${rapidFeed}`);

    if (config.protocol === 'zaxis') {
      const firstZ = computeZDepthMm(startPt.pressure, config.maxZDepthMm);
      lines.push(
        `G1 Z${firstZ.toFixed(2)} F${Math.round(config.feedRate * 0.45)} ; ${stroke.grade} pen down`
      );
      for (let k = 1; k < stroke.points.length; k++) {
        const pt = stroke.points[k];
        const z = computeZDepthMm(pt.pressure, config.maxZDepthMm);
        if (pt.isTurnaround) {
          lines.push(`G1 Z-0.18 F${rapidFeed} ; Feather Z for zigzag turnaround`);
          lines.push(`G1 X${pt.x.toFixed(2)} Y${pt.y.toFixed(2)} Z-0.18 F${rapidFeed}`);
          lines.push(`G1 Z${z.toFixed(2)} F${config.feedRate}`);
        } else {
          lines.push(
            `G1 X${pt.x.toFixed(2)} Y${pt.y.toFixed(2)} Z${z.toFixed(2)}${k === 1 ? ` F${config.feedRate}` : ''}`
          );
        }
      }
      lines.push(`G0 Z${config.safeLiftMm.toFixed(2)} ; Pen up`);
    } else {
      const pwm = Math.round(120 + stroke.meanPressure * 135);
      lines.push(`M3 S${pwm} ; ${stroke.grade} servo down`);
      lines.push('G4 P0.08');
      for (let k = 1; k < stroke.points.length; k++) {
        const pt = stroke.points[k];
        if (pt.isTurnaround) {
          lines.push('M5 ; Turnaround micro-lift');
          lines.push(`G0 X${pt.x.toFixed(2)} Y${pt.y.toFixed(2)} F${rapidFeed}`);
          lines.push(`M3 S${pwm}`);
          lines.push('G4 P0.04');
        } else {
          lines.push(
            `G1 X${pt.x.toFixed(2)} Y${pt.y.toFixed(2)}${k === 1 ? ` F${config.feedRate}` : ''}`
          );
        }
      }
      lines.push('M5 ; Servo up');
      lines.push('G4 P0.06');
    }
  }

  lines.push('; --- Finish & Home ---');
  if (config.protocol === 'zaxis') {
    lines.push(`G0 Z${(config.safeLiftMm + 4).toFixed(2)} F${rapidFeed}`);
  } else {
    lines.push('M5');
  }
  lines.push(`G0 X0.00 Y0.00 F${rapidFeed}`);
  lines.push('M2');

  return lines.join('\n');
}

/**
 * Exports pure single-centerline SVG polylines in real millimeter units for pen plotters
 * (Inkscape/AxiDraw/DobotStudio), splitting on turnaround hops to avoid double-lines or bridges.
 */
export function exportPlotterCenterlineSvg(plan: PlotterPlan): string {
  const { paperWidthMm, paperHeightMm, strokes, config, telemetry } = plan;

  const grouped = new Map<StrokeLayer, PlotterStrokeMm[]>();
  for (const l of LAYER_ORDER) grouped.set(l, []);
  for (const s of strokes) {
    grouped.get(s.layer)?.push(s);
  }

  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${paperWidthMm}mm" height="${paperHeightMm}mm" viewBox="0 0 ${paperWidthMm} ${paperHeightMm}">`,
    `  <!-- Atelier Graphite Single-Centerline Plotter SVG (${plan.paperLabel}, tier=${config.tier}, lifts=${telemetry.penLifts}, saved=${telemetry.savedLiftPct}%) -->`,
    `  <rect x="0" y="0" width="${paperWidthMm}" height="${paperHeightMm}" fill="#fbf8f1" />`,
  ];

  for (const layer of LAYER_ORDER) {
    const list = grouped.get(layer) ?? [];
    if (list.length === 0) continue;
    parts.push(`  <g id="layer-${layer}" fill="none" stroke-linecap="round" stroke-linejoin="round">`);
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const opacity = clampVal(s.brushOpacity * 1.15, 0.08, 0.96).toFixed(2);
      const sw = clampVal(s.brushWidthMm, 0.22, 0.85).toFixed(2);

      // Split into contiguous sub-polylines at turnaround hops so SVG never draws connector wires
      let seg: PlotterPointMm[] = [];
      const flushSeg = () => {
        if (seg.length >= 2) {
          const ptStr = seg.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
          parts.push(
            `    <polyline points="${ptStr}" stroke="#201e1c" stroke-opacity="${opacity}" stroke-width="${sw}" />`
          );
        }
        seg = [];
      };

      for (let k = 0; k < s.points.length; k++) {
        const pt = s.points[k];
        if (pt.isTurnaround) {
          flushSeg();
        }
        seg.push(pt);
      }
      flushSeg();
    }
    parts.push('  </g>');
  }

  parts.push('</svg>');
  return parts.join('\n');
}
