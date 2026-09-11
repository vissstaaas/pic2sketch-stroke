import type { StrokePoint } from '../../types/stroke';
import type { PreprocessedImage } from '../../types/image-processing';

export type FlowMap = NonNullable<PreprocessedImage['flowMap']>;

interface FlowVectors {
  cos2: Float32Array;
  sin2: Float32Array;
}

const vectorCache = new WeakMap<FlowMap, FlowVectors>();

function getVectors(flow: FlowMap): FlowVectors {
  const cached = vectorCache.get(flow);
  if (cached) return cached;
  const cos2 = new Float32Array(flow.angle.length);
  const sin2 = new Float32Array(flow.angle.length);
  for (let i = 0; i < flow.angle.length; i++) {
    const double = flow.angle[i] * 2;
    cos2[i] = Math.cos(double);
    sin2[i] = Math.sin(double);
  }
  const vectors = { cos2, sin2 };
  vectorCache.set(flow, vectors);
  return vectors;
}

/**
 * Bilinear tangent direction. Interpolating the doubled angle keeps the field
 * continuous across the +-180 degree wrap that a plain angle average breaks on.
 */
export function sampleFlowAngle(flow: FlowMap, x: number, y: number): number {
  const { width, height, cos2, sin2 } = { ...getVectors(flow), width: flow.width, height: flow.height };
  const fx = Math.max(0, Math.min(width - 1.001, x));
  const fy = Math.max(0, Math.min(height - 1.001, y));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const i00 = y0 * width + x0;
  const i10 = i00 + 1;
  const i01 = i00 + width;
  const i11 = i01 + 1;
  const lerp = (a: number, b: number, c: number, d: number) =>
    (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  const c = lerp(cos2[i00], cos2[i10], cos2[i01], cos2[i11]);
  const s = lerp(sin2[i00], sin2[i10], sin2[i01], sin2[i11]);
  return 0.5 * Math.atan2(s, c);
}

export function sampleCoherence(flow: FlowMap, x: number, y: number): number {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= flow.width || py >= flow.height) return 0;
  return flow.coherence[py * flow.width + px];
}

/** Blend two orientations given as angles, safely across the wrap. */
export function blendAngle(from: number, to: number, weight: number): number {
  const c = Math.cos(from * 2) * (1 - weight) + Math.cos(to * 2) * weight;
  const s = Math.sin(from * 2) * (1 - weight) + Math.sin(to * 2) * weight;
  return 0.5 * Math.atan2(s, c);
}

export interface StreamlineOptions {
  step?: number;
  maxSteps?: number;
  minCoherence?: number;
  /** 0 = snappy direction changes, 1 = very stiff */
  stiffness?: number;
  /** Optional constant rotation applied to the traced direction (cross-hatching). */
  angleOffset?: number;
}

/**
 * Walks the flow field from a seed point and returns a smooth polyline that
 * follows the form (hair strands, cloth folds, the wrap of a cheek).
 */
export function traceStreamline(
  flow: FlowMap,
  seedX: number,
  seedY: number,
  options: StreamlineOptions = {}
): StrokePoint[] {
  const step = options.step ?? 3.5;
  const maxSteps = options.maxSteps ?? 16;
  const minCoherence = options.minCoherence ?? 0;
  const stiffness = options.stiffness ?? 0.55;
  const angleOffset = options.angleOffset ?? 0;

  const points: StrokePoint[] = [];
  let x = seedX;
  let y = seedY;
  let direction = sampleFlowAngle(flow, x, y) + angleOffset;

  for (let i = 0; i < maxSteps; i++) {
    if (x < 1 || y < 1 || x >= flow.width - 2 || y >= flow.height - 2) break;
    if (minCoherence > 0 && i > 1 && sampleCoherence(flow, x, y) < minCoherence) break;

    const t = maxSteps > 1 ? i / (maxSteps - 1) : 0;
    const taper = 0.35 + 0.65 * Math.sin(Math.PI * Math.min(0.999, Math.max(0.001, t)));
    points.push({
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      pressure: Math.max(0.2, Math.min(1, taper)),
    });

    const local = sampleFlowAngle(flow, x, y) + angleOffset;
    direction = blendAngle(direction, local, 1 - stiffness);
    x += Math.cos(direction) * step;
    y += Math.sin(direction) * step;
  }

  return points;
}

/** Rotate a polyline around its midpoint (used for cross-hatching passes). */
export function rotatePolyline(points: StrokePoint[], angle: number): StrokePoint[] {
  if (points.length === 0 || angle === 0) return points;
  let cx = 0;
  let cy = 0;
  for (const p of points) { cx += p.x; cy += p.y; }
  cx /= points.length;
  cy /= points.length;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return points.map((p) => ({
    x: Math.round((cx + (p.x - cx) * cos - (p.y - cy) * sin) * 10) / 10,
    y: Math.round((cy + (p.x - cx) * sin + (p.y - cy) * cos) * 10) / 10,
    pressure: p.pressure,
  }));
}

export function polylineLength(points: StrokePoint[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return length;
}
