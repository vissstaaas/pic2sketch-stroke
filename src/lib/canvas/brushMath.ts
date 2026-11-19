import type { BrushStyle, PencilGrade, Stroke, StrokeLayer, StrokePoint } from '../../types/stroke';
import { clamp, clamp01 } from '../../utils/math';
import { SeededRandom } from '../../utils/random';

export const MIN_WIDTH_FACTOR = 0.32;
const CAP_SEGMENTS = 5;

interface GraphiteSpec {
  cssColor: string;
  svgHex: string;
  /** Relative darkness against #fbf8f1 warm sketch paper (luminance ~0.98). */
  darknessFactor: number;
}

const GRAPHITE_PALETTE: Record<PencilGrade, GraphiteSpec> = {
  '2H': { cssColor: 'rgba(88, 84, 80, 1)', svgHex: '#585450', darknessFactor: 0.68 },
  HB: { cssColor: 'rgba(58, 55, 51, 1)', svgHex: '#3a3733', darknessFactor: 0.79 },
  '2B': { cssColor: 'rgba(40, 37, 35, 1)', svgHex: '#282523', darknessFactor: 0.85 },
  '4B': { cssColor: 'rgba(25, 23, 22, 1)', svgHex: '#191716', darknessFactor: 0.91 },
  '6B': { cssColor: 'rgba(14, 13, 12, 1)', svgHex: '#0e0d0c', darknessFactor: 0.95 },
};

export interface RasterScratchBuffer {
  stampIds: Int32Array;
  stampCoverage: Float32Array;
  touchedIndices: Int32Array;
  currentStamp: number;
}

export function createRasterScratch(width: number, height: number): RasterScratchBuffer {
  const size = width * height;
  return {
    stampIds: new Int32Array(size),
    stampCoverage: new Float32Array(size),
    touchedIndices: new Int32Array(size),
    currentStamp: 0,
  };
}

export { clamp01 };

export function strokeWidthAt(brushWidth: number, pressure: number): number {
  return brushWidth * (MIN_WIDTH_FACTOR + (1 - MIN_WIDTH_FACTOR) * clamp01(pressure));
}

export function resolvePencilGrade(brush: BrushStyle, layer?: StrokeLayer): PencilGrade {
  if (brush.grade) return brush.grade;
  if (layer === 'structure') return '2H';
  if (layer === 'outline' || layer === 'lightTone') return 'HB';
  if (layer === 'features' || layer === 'midTone') return '2B';
  if (layer === 'darkTone') return '4B';
  if (layer === 'finalAccent') return '6B';
  if (brush.hardness >= 0.82) return '6B';
  if (brush.hardness >= 0.7) return '4B';
  if (brush.hardness >= 0.55) return '2B';
  return 'HB';
}

export function getGraphiteSpec(brush: BrushStyle, layer?: StrokeLayer): GraphiteSpec {
  return GRAPHITE_PALETTE[resolvePencilGrade(brush, layer)];
}

/**
 * Deterministic 2D cold-press sketch paper tooth height field in [0..1].
 * Anchored in canvas coordinates (x, y) so neighboring parallel hatching strokes
 * catch dry graphite on the same paper fiber peaks and skip across micro-valleys.
 */
export function paperTooth2D(x: number, y: number): number {
  const fine = valueNoise2D(x * 0.78, y * 0.78, 1301);
  const medium = valueNoise2D(x * 0.31 + 7.3, y * 0.31 - 5.1, 4919);
  const pore = latticeHash01(Math.floor(x * 1.15), Math.floor(y * 1.15), 8191);
  return clamp01(fine * 0.48 + medium * 0.28 + pore * 0.24);
}

function valueNoise2D(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);

  const n00 = latticeHash01(ix, iy, seed);
  const n10 = latticeHash01(ix + 1, iy, seed);
  const n01 = latticeHash01(ix, iy + 1, seed);
  const n11 = latticeHash01(ix + 1, iy + 1, seed);

  const nx0 = n00 + (n10 - n00) * ux;
  const nx1 = n01 + (n11 - n01) * ux;
  return nx0 + (nx1 - nx0) * uy;
}

function latticeHash01(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function densifyForPaperTooth(points: StrokePoint[], grain: number): StrokePoint[] {
  if (grain <= 0.01 || points.length < 2) return points;

  let totalLen = 0;
  for (let i = 1; i < points.length; i++) {
    totalLen += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  if (totalLen < 3.2) return points;

  const targetStep = clamp(totalLen / 26, 1.5, 3.2);
  const out: StrokePoint[] = [points[0]];

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.min(20, Math.round(segLen / targetStep)));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      out.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        pressure: (a.pressure ?? 0.6) + ((b.pressure ?? 0.6) - (a.pressure ?? 0.6)) * t,
      });
    }
  }
  return out;
}

/**
 * Builds a deterministic, needle-tapered dry-graphite ribbon polygon modulated by
 * 2D cold-press paper tooth, shared by both Canvas 2D rendering and SVG vector export.
 */
export function buildStrokeRibbonPolygon(
  points: StrokePoint[],
  brush: BrushStyle,
  seed: number
): Array<{ x: number; y: number }> {
  if (points.length === 0) return [];

  const grain = clamp01(brush.grain);
  const dense = densifyForPaperTooth(points, grain);
  const random = new SeededRandom(seed);
  const jitterSpan = brush.jitter * 1.1;

  const jittered: StrokePoint[] = dense.map((pt, idx) => {
    const endFade =
      dense.length > 2 ? Math.min(1, Math.min(idx, dense.length - 1 - idx) / 2) : 0.4;
    const j = jitterSpan * endFade;
    return {
      x: pt.x + (random.next() - 0.5) * j,
      y: pt.y + (random.next() - 0.5) * j,
      pressure: pt.pressure ?? 0.6,
    };
  });

  const lastIdx = jittered.length - 1;
  const halfWidths = jittered.map((pt, idx) => {
    const p = clamp01(pt.pressure);
    // Preserve full crisp body thickness on contours & mid-strokes while sharpening low-pressure tips (< 0.12) to needle points!
    const tipSharpener = p < 0.12 ? p / 0.12 : 1.0;
    let hw = Math.max(0.035, strokeWidthAt(brush.width, p) * 0.5 * tipSharpener);
    if (grain > 0) {
      const tooth = paperTooth2D(pt.x, pt.y);
      const pressDepth = clamp01(p * 0.6 + brush.hardness * 0.18);
      const valleyCutoff = (1 - pressDepth) * 0.46;
      const contact = clamp01((tooth - valleyCutoff) / Math.max(0.26, 1 - valleyCutoff));
      // Balanced dry paper-tooth modulation: porous valleys + slightly fuller peaks so average tonal weight stays rich!
      const modulation = (1 - grain * 0.58) + grain * 0.84 * contact;
      hw = Math.max(0.03, hw * modulation);
    }
    if (lastIdx >= 2 && (idx === 0 || idx === lastIdx) && p < 0.18) {
      hw = Math.min(hw, 0.14);
    }
    return hw;
  });

  if (jittered.length === 1) {
    const r = Math.max(0.16, halfWidths[0]);
    const disc: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 10; i++) {
      const angle = (i / 10) * Math.PI * 2;
      disc.push({
        x: jittered[0].x + Math.cos(angle) * r,
        y: jittered[0].y + Math.sin(angle) * r,
      });
    }
    return disc;
  }

  const left: Array<{ x: number; y: number }> = [];
  const right: Array<{ x: number; y: number }> = [];
  const tangents: Array<{ x: number; y: number }> = [];

  for (let i = 0; i < jittered.length; i++) {
    const prev = jittered[Math.max(0, i - 1)];
    const next = jittered[Math.min(jittered.length - 1, i + 1)];
    let tx = next.x - prev.x;
    let ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    tangents.push({ x: tx, y: ty });
    const nx = -ty;
    const ny = tx;
    left.push({ x: jittered[i].x + nx * halfWidths[i], y: jittered[i].y + ny * halfWidths[i] });
    right.push({ x: jittered[i].x - nx * halfWidths[i], y: jittered[i].y - ny * halfWidths[i] });
  }

  const polygon: Array<{ x: number; y: number }> = [...left];

  if (halfWidths[lastIdx] < 0.3) {
    const reach = Math.min(0.9, halfWidths[lastIdx] * 2.5);
    polygon.push({
      x: jittered[lastIdx].x + tangents[lastIdx].x * reach,
      y: jittered[lastIdx].y + tangents[lastIdx].y * reach,
    });
  } else {
    appendSemicircleCap(polygon, jittered[lastIdx], tangents[lastIdx], halfWidths[lastIdx], 1);
  }

  for (let i = right.length - 1; i >= 0; i--) {
    polygon.push(right[i]);
  }

  if (halfWidths[0] < 0.3) {
    const reach = Math.min(0.9, halfWidths[0] * 2.5);
    polygon.push({
      x: jittered[0].x - tangents[0].x * reach,
      y: jittered[0].y - tangents[0].y * reach,
    });
  } else {
    appendSemicircleCap(polygon, jittered[0], tangents[0], halfWidths[0], -1);
  }

  return polygon;
}

function appendSemicircleCap(
  polygon: Array<{ x: number; y: number }>,
  center: { x: number; y: number },
  tangent: { x: number; y: number },
  radius: number,
  directionSign: 1 | -1
): void {
  const baseAngle = Math.atan2(tangent.y, tangent.x);
  for (let i = 0; i <= CAP_SEGMENTS; i++) {
    const angle = baseAngle + directionSign * (Math.PI * 0.5 - Math.PI * (i / CAP_SEGMENTS));
    polygon.push({
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    });
  }
}

/**
 * Physically matched single-fill stroke coverage rasterizer using a generation-stamped
 * sparse touch list (zero per-stroke heap allocations, O(stroke_area) work).
 */
export function rasterizeStrokeCoverage(
  achieved: Float32Array,
  width: number,
  height: number,
  stroke: Stroke,
  scratch?: RasterScratchBuffer
): void {
  const { points, brush, layer } = stroke;
  if (points.length === 0) return;

  const spec = getGraphiteSpec(brush, layer);
  const grain = clamp01(brush.grain);
  const grainWidthAttenuation = 1 - grain * 0.36;
  const effectiveOpacity = clamp01(brush.opacity) * spec.darknessFactor;
  if (effectiveOpacity <= 0.001) return;

  const buf = scratch ?? createRasterScratch(width, height);
  const stamp = ++buf.currentStamp;
  const { stampIds, stampCoverage, touchedIndices } = buf;
  let touchedCount = 0;

  const recordPixel = (idx: number, cov: number) => {
    if (stampIds[idx] !== stamp) {
      stampIds[idx] = stamp;
      stampCoverage[idx] = cov;
      touchedIndices[touchedCount++] = idx;
    } else if (cov > stampCoverage[idx]) {
      stampCoverage[idx] = cov;
    }
  };

  if (points.length === 1) {
    const pt = points[0];
    const r = Math.max(0.06, strokeWidthAt(brush.width, pt.pressure) * 0.5 * grainWidthAttenuation);
    const sx0 = Math.max(0, Math.floor(pt.x - r - 1));
    const sx1 = Math.min(width - 1, Math.ceil(pt.x + r + 1));
    const sy0 = Math.max(0, Math.floor(pt.y - r - 1));
    const sy1 = Math.min(height - 1, Math.ceil(pt.y + r + 1));
    for (let y = sy0; y <= sy1; y++) {
      const row = y * width;
      const dy = y + 0.5 - pt.y;
      for (let x = sx0; x <= sx1; x++) {
        const dx = x + 0.5 - pt.x;
        const d = Math.sqrt(dx * dx + dy * dy);
        const cov = Math.min(d + r, 0.5) - Math.max(d - r, -0.5);
        if (cov > 0) recordPixel(row + x, cov);
      }
    }
  } else {
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const ra = Math.max(0.04, strokeWidthAt(brush.width, a.pressure) * 0.5 * grainWidthAttenuation);
      const rb = Math.max(0.04, strokeWidthAt(brush.width, b.pressure) * 0.5 * grainWidthAttenuation);
      const rSeg = ra > rb ? ra : rb;

      const sx0 = Math.max(0, Math.floor((a.x < b.x ? a.x : b.x) - rSeg - 1));
      const sx1 = Math.min(width - 1, Math.ceil((a.x > b.x ? a.x : b.x) + rSeg + 1));
      const sy0 = Math.max(0, Math.floor((a.y < b.y ? a.y : b.y) - rSeg - 1));
      const sy1 = Math.min(height - 1, Math.ceil((a.y > b.y ? a.y : b.y) + rSeg + 1));

      const segDx = b.x - a.x;
      const segDy = b.y - a.y;
      const segLenSq = segDx * segDx + segDy * segDy;
      const invSegLenSq = segLenSq > 1e-8 ? 1 / segLenSq : 0;

      for (let y = sy0; y <= sy1; y++) {
        const py = y + 0.5;
        const row = y * width;
        const relY = py - a.y;
        for (let x = sx0; x <= sx1; x++) {
          const px = x + 0.5;
          const relX = px - a.x;
          let t = (relX * segDx + relY * segDy) * invSegLenSq;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;

          const distX = relX - segDx * t;
          const distY = relY - segDy * t;
          const radiusAtT = ra + (rb - ra) * t;
          const maxCheck = radiusAtT + 0.5;
          const distSq = distX * distX + distY * distY;
          if (distSq >= maxCheck * maxCheck) continue;

          const dist = Math.sqrt(distSq);
          const cov = Math.min(dist + radiusAtT, 0.5) - Math.max(dist - radiusAtT, -0.5);
          if (cov > 0) recordPixel(row + x, cov);
        }
      }
    }
  }

  for (let k = 0; k < touchedCount; k++) {
    const idx = touchedIndices[k];
    const alpha = effectiveOpacity * stampCoverage[idx];
    achieved[idx] = 1 - (1 - achieved[idx]) * (1 - alpha);
  }
}
