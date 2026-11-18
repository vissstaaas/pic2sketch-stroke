import type { BrushStyle, PencilGrade, Stroke, StrokeLayer, StrokePoint } from '../../types/stroke';
import { clamp01 } from '../../utils/math';
import { SeededRandom } from '../../utils/random';

export const MIN_WIDTH_FACTOR = 0.42;
const CAP_SEGMENTS = 6;

interface GraphiteSpec {
  cssColor: string;
  svgHex: string;
  /** Relative darkness against #fbf8f1 warm sketch paper (luminance ~0.98). */
  darknessFactor: number;
}

const GRAPHITE_PALETTE: Record<PencilGrade, GraphiteSpec> = {
  '2H': { cssColor: 'rgba(84, 81, 78, 1)', svgHex: '#54514e', darknessFactor: 0.68 },
  HB: { cssColor: 'rgba(56, 53, 50, 1)', svgHex: '#383532', darknessFactor: 0.79 },
  '2B': { cssColor: 'rgba(40, 37, 35, 1)', svgHex: '#282523', darknessFactor: 0.85 },
  '4B': { cssColor: 'rgba(26, 24, 23, 1)', svgHex: '#1a1817', darknessFactor: 0.91 },
  '6B': { cssColor: 'rgba(15, 14, 13, 1)', svgHex: '#0f0e0d', darknessFactor: 0.95 },
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
 * Builds a deterministic, variable-width tapered ribbon polygon shared by
 * both Canvas 2D rendering and SVG vector export.
 */
export function buildStrokeRibbonPolygon(
  points: StrokePoint[],
  brush: BrushStyle,
  seed: number
): Array<{ x: number; y: number }> {
  if (points.length === 0) return [];

  const random = new SeededRandom(seed);
  const jitterSpan = brush.jitter * 1.8;
  const jittered: StrokePoint[] = points.map((pt) => ({
    x: pt.x + (random.next() - 0.5) * jitterSpan,
    y: pt.y + (random.next() - 0.5) * jitterSpan,
    pressure: pt.pressure ?? 0.6,
  }));

  const halfWidths = jittered.map((pt) =>
    Math.max(0.22, strokeWidthAt(brush.width, pt.pressure) * 0.5)
  );

  if (brush.grain > 0) {
    let phase = random.range(0, Math.PI * 2);
    for (let i = 0; i < halfWidths.length; i++) {
      phase += 0.62 + random.range(-0.14, 0.14);
      const toothModulation = 1 - brush.grain * 0.32 * (0.5 + 0.5 * Math.sin(phase));
      halfWidths[i] = Math.max(0.18, halfWidths[i] * toothModulation);
    }
  }

  if (jittered.length === 1) {
    const disc: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 14; i++) {
      const angle = (i / 14) * Math.PI * 2;
      disc.push({
        x: jittered[0].x + Math.cos(angle) * halfWidths[0],
        y: jittered[0].y + Math.sin(angle) * halfWidths[0],
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
  const lastIdx = jittered.length - 1;
  appendSemicircleCap(polygon, jittered[lastIdx], tangents[lastIdx], halfWidths[lastIdx], 1);

  for (let i = right.length - 1; i >= 0; i--) {
    polygon.push(right[i]);
  }
  appendSemicircleCap(polygon, jittered[0], tangents[0], halfWidths[0], -1);

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
  const grainWidthAttenuation = 1 - clamp01(brush.grain) * 0.16;
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
    const r = Math.max(0.2, strokeWidthAt(brush.width, pt.pressure) * 0.5 * grainWidthAttenuation);
    const sx0 = Math.max(0, Math.floor(pt.x - r - 1));
    const sx1 = Math.min(width - 1, Math.ceil(pt.x + r + 1));
    const sy0 = Math.max(0, Math.floor(pt.y - r - 1));
    const sy1 = Math.min(height - 1, Math.ceil(pt.y + r + 1));
    for (let y = sy0; y <= sy1; y++) {
      const row = y * width;
      const dy = y + 0.5 - pt.y;
      for (let x = sx0; x <= sx1; x++) {
        const dx = x + 0.5 - pt.x;
        const cov = r + 0.5 - Math.sqrt(dx * dx + dy * dy);
        if (cov > 0) recordPixel(row + x, cov > 1 ? 1 : cov);
      }
    }
  } else {
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const ra = Math.max(0.2, strokeWidthAt(brush.width, a.pressure) * 0.5 * grainWidthAttenuation);
      const rb = Math.max(0.2, strokeWidthAt(brush.width, b.pressure) * 0.5 * grainWidthAttenuation);
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

          const cov = maxCheck - Math.sqrt(distSq);
          recordPixel(row + x, cov > 1 ? 1 : cov);
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
