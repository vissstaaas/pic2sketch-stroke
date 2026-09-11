import type { StrokePoint } from '../../types/stroke';
import { pointToSegmentDistance } from '../../utils/math';

/**
 * Ramer-Douglas-Peucker algorithm to simplify a polyline of StrokePoints.
 * Preserves the original pressure and time offsets while significantly reducing point count.
 */
export function simplifyPath(points: StrokePoint[], tolerance = 1.5): StrokePoint[] {
  if (points.length <= 2) {
    return points;
  }

  let maxDist = 0;
  let maxIndex = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const dist = pointToSegmentDistance(
      points[i].x,
      points[i].y,
      first.x,
      first.y,
      last.x,
      last.y
    );
    if (dist > maxDist) {
      maxDist = dist;
      maxIndex = i;
    }
  }

  if (maxDist > tolerance) {
    const left = simplifyPath(points.slice(0, maxIndex + 1), tolerance);
    const right = simplifyPath(points.slice(maxIndex), tolerance);
    return [...left.slice(0, -1), ...right];
  }

  return [first, last];
}
