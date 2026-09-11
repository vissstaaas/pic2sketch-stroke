import type { StrokePoint } from '../../types/stroke';

/** Ramer-Douglas-Peucker simplification. */
export function simplifyPoints(points: StrokePoint[], epsilon: number): StrokePoint[] {
  if (points.length < 3) return points;
  const sqEpsilon = epsilon * epsilon;

  const pointLineDistanceSq = (p: StrokePoint, p1: StrokePoint, p2: StrokePoint) => {
    let x = p1.x;
    let y = p1.y;
    let dx = p2.x - x;
    let dy = p2.y - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = p2.x; y = p2.y; } else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = p.x - x;
    dy = p.y - y;
    return dx * dx + dy * dy;
  };

  const step = (first: number, last: number, tolerance: number, out: StrokePoint[]) => {
    let maxSqDist = tolerance;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const sqDist = pointLineDistanceSq(points[i], points[first], points[last]);
      if (sqDist > maxSqDist) { index = i; maxSqDist = sqDist; }
    }
    if (maxSqDist > tolerance && index > -1) {
      if (index - first > 1) step(first, index, tolerance, out);
      out.push(points[index]);
      if (last - index > 1) step(index, last, tolerance, out);
    }
  };

  const simplified: StrokePoint[] = [points[0]];
  step(0, points.length - 1, sqEpsilon, simplified);
  simplified.push(points[points.length - 1]);
  return simplified;
}

/** Catmull-Rom resample so rendered strokes are smooth rather than polygonal. */
export function resamplePoints(points: StrokePoint[], spacing: number): StrokePoint[] {
  if (points.length < 2) return points;
  const result: StrokePoint[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const steps = Math.max(1, Math.min(24, Math.round(segLen / spacing)));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      const pressure = 0.5 * ((2 * p1.pressure) + (-p0.pressure + p2.pressure) * t + (2 * p0.pressure - 5 * p1.pressure + 4 * p2.pressure - p3.pressure) * t2 + (-p0.pressure + 3 * p1.pressure - 3 * p2.pressure + p3.pressure) * t3);
      result.push({
        x: Math.round(x * 10) / 10,
        y: Math.round(y * 10) / 10,
        pressure: Math.max(0.15, Math.min(1, pressure)),
      });
    }
  }
  result.push(points[points.length - 1]);
  return result;
}

export function pathLength(points: StrokePoint[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return length;
}

/** Taper pressure at both ends so strokes start and lift off the paper. */
export function taperEnds(points: StrokePoint[], taperCount: number): void {
  const count = Math.max(1, Math.min(taperCount, Math.floor(points.length / 3)));
  for (let i = 0; i < points.length; i++) {
    let taper = 1;
    if (i < count) taper = (i + 1) / count;
    else if (i > points.length - 1 - count) taper = (points.length - i) / count;
    points[i].pressure = Math.max(0.15, points[i].pressure * taper);
  }
}
