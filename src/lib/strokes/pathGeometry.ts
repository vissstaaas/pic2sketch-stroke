import type { StrokePoint } from '../../types/stroke';
import { catmullRom, clamp, distance, pointToSegmentDistance } from '../../utils/math';

/** Ramer-Douglas-Peucker polyline simplification. */
export function simplifyPoints(points: StrokePoint[], epsilon: number): StrokePoint[] {
  if (points.length < 3) return points.slice();

  const step = (first: number, last: number, tolerance: number, out: StrokePoint[]) => {
    let maxDist = tolerance;
    let splitIndex = -1;
    const pFirst = points[first];
    const pLast = points[last];

    for (let i = first + 1; i < last; i++) {
      const d = pointToSegmentDistance(
        points[i].x,
        points[i].y,
        pFirst.x,
        pFirst.y,
        pLast.x,
        pLast.y
      );
      if (d > maxDist) {
        splitIndex = i;
        maxDist = d;
      }
    }

    if (splitIndex > -1) {
      if (splitIndex - first > 1) step(first, splitIndex, tolerance, out);
      out.push(points[splitIndex]);
      if (last - splitIndex > 1) step(splitIndex, last, tolerance, out);
    }
  };

  const simplified: StrokePoint[] = [points[0]];
  step(0, points.length - 1, epsilon, simplified);
  simplified.push(points[points.length - 1]);
  return simplified;
}

/** Smooth Catmull-Rom spline resampling with preserved endpoint pressures. */
export function resamplePoints(points: StrokePoint[], spacing: number): StrokePoint[] {
  if (points.length < 2) return points.slice();
  const safeSpacing = Math.max(0.6, spacing);
  const result: StrokePoint[] = [];

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const segLen = distance(p1.x, p1.y, p2.x, p2.y);
    const steps = clamp(Math.round(segLen / safeSpacing), 1, 28);

    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      result.push({
        x: Math.round(catmullRom(p0.x, p1.x, p2.x, p3.x, t) * 10) / 10,
        y: Math.round(catmullRom(p0.y, p1.y, p2.y, p3.y, t) * 10) / 10,
        pressure: clamp(catmullRom(p0.pressure, p1.pressure, p2.pressure, p3.pressure, t), 0.14, 1),
      });
    }
  }
  const last = points[points.length - 1];
  result.push({
    x: Math.round(last.x * 10) / 10,
    y: Math.round(last.y * 10) / 10,
    pressure: clamp(last.pressure, 0.14, 1),
  });
  return result;
}

export function pathLength(points: StrokePoint[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += distance(points[i].x, points[i - 1].x, points[i].y, points[i - 1].y);
  }
  return length;
}

/** Measures mean absolute turning angle (radians) to identify intricate facial/detail features. */
export function meanCurvature(points: StrokePoint[]): number {
  if (points.length < 3) return 0;
  let angleSum = 0;
  let count = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const a1 = Math.atan2(points[i].y - points[i - 1].y, points[i].x - points[i - 1].x);
    const a2 = Math.atan2(points[i + 1].y - points[i].y, points[i + 1].x - points[i].x);
    let diff = Math.abs(a2 - a1);
    if (diff > Math.PI) diff = Math.PI * 2 - diff;
    angleSum += diff;
    count++;
  }
  return count > 0 ? angleSum / count : 0;
}

export function taperEnds(points: StrokePoint[], taperCount: number): void {
  if (points.length < 2) return;
  const count = Math.max(1, Math.min(taperCount, Math.floor(points.length / 3)));
  for (let i = 0; i < points.length; i++) {
    let taper = 1;
    if (i < count) taper = (i + 1) / (count + 0.4);
    else if (i > points.length - 1 - count) taper = (points.length - i) / (count + 0.4);
    points[i].pressure = clamp(points[i].pressure * taper, 0.14, 1);
  }
}
