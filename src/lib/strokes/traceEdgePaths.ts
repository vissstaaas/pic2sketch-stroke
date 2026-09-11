import type { StrokePoint } from '../../types/stroke';

export interface EdgeTraceOptions {
  highThreshold: number;
  lowThreshold: number;
  /** Lengths are in pixels. */
  minLength: number;
  maxLength: number;
  region?: { minX: number; maxX: number; minY: number; maxY: number };
  /** Soft subject mask; pixels below the gate are ignored. */
  subject?: Float32Array;
  subjectGate?: number;
  /** Pixels already used by earlier passes. Updated in place. */
  claimed?: Uint8Array;
}

export interface EdgeChain {
  points: StrokePoint[];
  length: number;
  /** Mean line response along the chain. */
  strength: number;
}

/**
 * Ridge thinning (non maximum suppression along the local normal).
 * The raw line response is several pixels wide; tracing it directly produces
 * doubled, ragged outlines.
 */
export function thinEdgeMap(
  edgeMap: Float32Array,
  normalX: Float32Array,
  normalY: Float32Array,
  width: number,
  height: number
): Float32Array {
  const thinned = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const index = row + x;
      const value = edgeMap[index];
      if (value <= 0.02) continue;

      const nx = normalX[index];
      const ny = normalY[index];
      const norm = Math.hypot(nx, ny);
      if (norm < 1e-6) { thinned[index] = value; continue; }

      const ax = nx / norm;
      const ay = ny / norm;
      const front = sampleBilinear(edgeMap, width, height, x + ax, y + ay);
      const back = sampleBilinear(edgeMap, width, height, x - ax, y - ay);
      if (value >= front && value >= back) thinned[index] = value;
    }
  }
  return thinned;
}

function sampleBilinear(source: Float32Array, width: number, height: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= width - 1 || y >= height - 1) return 0;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const i00 = y0 * width + x0;
  const top = source[i00] * (1 - tx) + source[i00 + 1] * tx;
  const bottom = source[i00 + width] * (1 - tx) + source[i00 + width + 1] * tx;
  return top * (1 - ty) + bottom * ty;
}

/**
 * Sub-pixel chain follower.
 *
 * Instead of jumping to whichever 8-neighbour is free first (which is what made
 * the old output wander between unrelated edges), this looks ahead in a small
 * fan of directions and keeps the strongest, straightest continuation. The
 * result is a smooth, direction-coherent path.
 */
export function traceEdgePaths(
  thinned: Float32Array,
  normalX: Float32Array,
  normalY: Float32Array,
  width: number,
  height: number,
  options: EdgeTraceOptions
): EdgeChain[] {
  const { highThreshold, lowThreshold, minLength, maxLength } = options;
  const claimed = options.claimed;
  const visited = new Uint8Array(width * height);
  const gate = options.subjectGate ?? 0.5;
  const step = 1.4;
  const turnPenalty = 0.22;

  const minX = options.region ? Math.max(1, options.region.minX) : 1;
  const maxX = options.region ? Math.min(width - 2, options.region.maxX) : width - 2;
  const minY = options.region ? Math.max(1, options.region.minY) : 1;
  const maxY = options.region ? Math.min(height - 2, options.region.maxY) : height - 2;

  const usable = (index: number): boolean => {
    if (thinned[index] < lowThreshold) return false;
    if (options.subject && options.subject[index] < gate) return false;
    return true;
  };

  const walk = (
    startX: number,
    startY: number,
    dirX: number,
    dirY: number
  ): StrokePoint[] => {
    const points: StrokePoint[] = [];
    let x = startX;
    let y = startY;
    let dx = dirX;
    let dy = dirY;
    let travelled = 0;

    const fan = [-0.62, -0.31, 0, 0.31, 0.62];

    while (travelled < maxLength) {
      let bestScore = -Infinity;
      let bestX = 0;
      let bestY = 0;
      let bestDx = 0;
      let bestDy = 0;

      for (const angle of fan) {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const ndx = dx * cos - dy * sin;
        const ndy = dx * sin + dy * cos;
        const nx = x + ndx * step;
        const ny = y + ndy * step;
        if (nx < minX || ny < minY || nx > maxX || ny > maxY) continue;

        const strength = sampleBilinear(thinned, width, height, nx, ny);
        if (strength < lowThreshold) continue;

        const score = strength - Math.abs(angle) * turnPenalty;
        if (score > bestScore) {
          bestScore = score;
          bestX = nx;
          bestY = ny;
          bestDx = ndx;
          bestDy = ndy;
        }
      }

      if (bestScore === -Infinity) break;

      x = bestX;
      y = bestY;
      dx = bestDx;
      dy = bestDy;
      travelled += step;

      const px = Math.round(x);
      const py = Math.round(y);
      if (px < 1 || py < 1 || px >= width - 1 || py >= height - 1) break;
      const index = py * width + px;
      // Stop instead of looping: without this a closed contour gets traced
      // round and round until it hits the length cap, tripling the ink.
      if (visited[index] && travelled > step * 3) break;
      visited[index] = 1;

      const t = Math.min(1, travelled / maxLength);
      points.push({
        x: Math.round(x * 10) / 10,
        y: Math.round(y * 10) / 10,
        pressure: 0.3 + 0.7 * Math.sin(Math.PI * Math.min(0.999, Math.max(0.001, t))),
      });
    }

    return points;
  };

  const chains: EdgeChain[] = [];

  for (let y = minY; y <= maxY; y++) {
    const row = y * width;
    for (let x = minX; x <= maxX; x++) {
      const index = row + x;
      if (visited[index] || claimed?.[index]) continue;
      if (thinned[index] < highThreshold) continue;
      if (!usable(index)) continue;

      // Seed direction: perpendicular to the local ridge normal.
      const nx = normalX[index];
      const ny = normalY[index];
      const norm = Math.hypot(nx, ny) || 1;
      const tangentX = -ny / norm;
      const tangentY = nx / norm;

      visited[index] = 1;
      const forward = walk(x, y, tangentX, tangentY);
      const backward = walk(x, y, -tangentX, -tangentY);

      const points: StrokePoint[] = [
        ...backward.reverse(),
        { x, y, pressure: 0.6 },
        ...forward,
      ];

      let length = 0;
      let strengthSum = 0;
      for (let i = 1; i < points.length; i++) {
        length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
      }
      for (const point of points) {
        strengthSum += sampleBilinear(thinned, width, height, point.x, point.y);
      }

      if (length >= minLength) {
        if (claimed) {
          for (const point of points) {
            const px = Math.round(point.x);
            const py = Math.round(point.y);
            if (px >= 0 && py >= 0 && px < width && py < height) claimed[py * width + px] = 1;
          }
        }
        chains.push({ points, length, strength: strengthSum / Math.max(1, points.length) });
      }
    }
  }

  chains.sort((a, b) => b.length - a.length);
  return chains;
}
