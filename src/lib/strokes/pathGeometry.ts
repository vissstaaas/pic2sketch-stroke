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

/**
 * Nudges contour/construction points ~0.6px toward the dark side of a silhouette or specular
 * boundary whenever a clean-paper pixel (darkness < 0.018) is within the brush's 1px halo,
 * and trims endpoints that drift onto clean paper.
 */
export function tuckPointsOffCleanPaper(
  points: StrokePoint[],
  darkness: Float32Array,
  width: number,
  height: number,
  nudgePx = 0.62
): StrokePoint[] {
  if (points.length < 2) return points;

  const adjusted: StrokePoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const cx = clamp(Math.round(pt.x), 1, width - 2);
    const cy = clamp(Math.round(pt.y), 1, height - 2);
    const cIdx = cy * width + cx;

    const minNeighborDark = Math.min(
      darkness[cIdx],
      darkness[cIdx - 1],
      darkness[cIdx + 1],
      darkness[cIdx - width],
      darkness[cIdx + width]
    );

    if (minNeighborDark >= 0.018) {
      adjusted.push(pt);
      continue;
    }

    // Search 3x3 neighborhood for the safest dark side of the edge
    let bestScore = -1;
    let bestDx = 0;
    let bestDy = 0;
    let maxDark = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = clamp(cy + dy, 1, height - 2);
      const row = ny * width;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = clamp(cx + dx, 1, width - 2);
        const idx = row + nx;
        const dHere = darkness[idx];
        if (dHere > maxDark) maxDark = dHere;
        const dMin4 = Math.min(
          dHere,
          darkness[idx - 1],
          darkness[idx + 1],
          darkness[idx - width],
          darkness[idx + width]
        );
        const score = dHere + dMin4 * 1.6;
        if (score > bestScore) {
          bestScore = score;
          bestDx = dx;
          bestDy = dy;
        }
      }
    }

    if (maxDark < 0.02) {
      continue;
    }

    const norm = Math.hypot(bestDx, bestDy);
    const nx = norm > 0 ? clamp(pt.x + (bestDx / norm) * nudgePx, 1, width - 2) : pt.x;
    const ny = norm > 0 ? clamp(pt.y + (bestDy / norm) * nudgePx, 1, height - 2) : pt.y;
    adjusted.push({
      x: Math.round(nx * 10) / 10,
      y: Math.round(ny * 10) / 10,
      pressure: darkness[cIdx] < 0.018 ? Math.min(pt.pressure, 0.28) : pt.pressure,
    });
  }

  return adjusted;
}
