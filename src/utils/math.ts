export interface Point2D {
  x: number;
  y: number;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function clampIndex(index: number, length: number): number {
  return index < 0 ? 0 : index >= length ? length - 1 : index;
}

/**
 * Mirror-reflects out-of-range coordinates back into [0, length - 1]
 * to prevent dark border halos during large-kernel convolutions.
 */
export function reflectIndex(index: number, length: number): number {
  if (length <= 1) return 0;
  let reflected = index;
  while (reflected < 0 || reflected >= length) {
    if (reflected < 0) reflected = -reflected;
    if (reflected >= length) reflected = 2 * length - 2 - reflected;
  }
  return reflected;
}

export function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / Math.max(1e-6, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function distance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

export function distanceSq(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return dx * dx + dy * dy;
}

export function pointToSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const segmentLengthSq = distanceSq(ax, ay, bx, by);
  if (segmentLengthSq === 0) return distance(px, py, ax, ay);
  const projection = clamp(
    ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / segmentLengthSq,
    0,
    1
  );
  return distance(px, py, ax + projection * (bx - ax), ay + projection * (by - ay));
}

export function pointToSegmentProjection(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): { distance: number; t: number } {
  const segmentLengthSq = distanceSq(ax, ay, bx, by);
  if (segmentLengthSq <= 1e-8) {
    return { distance: distance(px, py, ax, ay), t: 0 };
  }
  const t = clamp(((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / segmentLengthSq, 0, 1);
  return {
    distance: distance(px, py, ax + t * (bx - ax), ay + t * (by - ay)),
    t,
  };
}

export function catmullRom(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number
): number {
  const v0 = (p2 - p0) * 0.5;
  const v1 = (p3 - p1) * 0.5;
  const t2 = t * t;
  const t3 = t * t2;
  return (
    (2 * p1 - 2 * p2 + v0 + v1) * t3 +
    (-3 * p1 + 3 * p2 - 2 * v0 - v1) * t2 +
    v0 * t +
    p1
  );
}
