import type { StrokePoint } from '../../types/stroke';
import { sampleBilinear } from '../image/filters';

export interface EdgeTraceOptions {
  highThreshold: number;
  lowThreshold: number;
  minLength: number;
  maxLength: number;
  region?: { minX: number; maxX: number; minY: number; maxY: number };
  subject?: Float32Array;
  subjectGate?: number;
  claimed?: Uint8Array;
}

export interface EdgeChain {
  points: StrokePoint[];
  length: number;
  strength: number;
}

/**
 * Non-maximum suppression along the local gradient normal so wide edge responses
 * collapse to single-pixel ridges prior to sub-pixel polyline tracing.
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
      if (value <= 0.015) continue;

      const nx = normalX[index];
      const ny = normalY[index];
      const norm = Math.hypot(nx, ny);
      if (norm < 1e-6) {
        thinned[index] = value;
        continue;
      }

      const ax = nx / norm;
      const ay = ny / norm;
      const front = sampleBilinear(edgeMap, width, height, x + ax, y + ay);
      const back = sampleBilinear(edgeMap, width, height, x - ax, y - ay);
      if (value >= front && value >= back) {
        thinned[index] = value;
      }
    }
  }
  return thinned;
}

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
  const gate = options.subjectGate ?? 0.35;
  const step = 1.35;
  const turnPenalty = 0.2;

  const minX = options.region ? Math.max(1, options.region.minX) : 1;
  const maxX = options.region ? Math.min(width - 2, options.region.maxX) : width - 2;
  const minY = options.region ? Math.max(1, options.region.minY) : 1;
  const maxY = options.region ? Math.min(height - 2, options.region.maxY) : height - 2;

  const usable = (index: number): boolean => {
    if (thinned[index] < lowThreshold) return false;
    if (options.subject && options.subject[index] < gate) return false;
    return true;
  };

  const fanCos = [Math.cos(-0.58), Math.cos(-0.29), 1, Math.cos(0.29), Math.cos(0.58)];
  const fanSin = [Math.sin(-0.58), Math.sin(-0.29), 0, Math.sin(0.29), Math.sin(0.58)];
  const fanPenalty = [0.58 * turnPenalty, 0.29 * turnPenalty, 0, 0.29 * turnPenalty, 0.58 * turnPenalty];

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

    while (travelled < maxLength) {
      let bestScore = -Infinity;
      let bestX = 0;
      let bestY = 0;
      let bestDx = 0;
      let bestDy = 0;

      for (let f = 0; f < 5; f++) {
        const cos = fanCos[f];
        const sin = fanSin[f];
        const ndx = dx * cos - dy * sin;
        const ndy = dx * sin + dy * cos;
        const nx = x + ndx * step;
        const ny = y + ndy * step;
        if (nx < minX || ny < minY || nx > maxX || ny > maxY) continue;

        const strength = sampleBilinear(thinned, width, height, nx, ny);
        if (strength < lowThreshold) continue;

        const score = strength - fanPenalty[f];
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
      if (visited[index] && travelled > step * 3) break;
      visited[index] = 1;

      const localStrength = sampleBilinear(thinned, width, height, x, y);
      const arcPhase = Math.min(0.999, Math.max(0.001, travelled / maxLength));
      points.push({
        x: Math.round(x * 10) / 10,
        y: Math.round(y * 10) / 10,
        pressure: Math.min(1, 0.28 + 0.52 * Math.sin(Math.PI * arcPhase) + localStrength * 0.25),
      });
    }

    return points;
  };

  // Seed strongest ridges first so primary contours claim clean, unbroken paths.
  const seeds: Array<{ index: number; x: number; y: number; val: number }> = [];
  for (let y = minY; y <= maxY; y++) {
    const row = y * width;
    for (let x = minX; x <= maxX; x++) {
      const index = row + x;
      if (claimed?.[index]) continue;
      const val = thinned[index];
      if (val >= highThreshold && usable(index)) {
        seeds.push({ index, x, y, val });
      }
    }
  }
  seeds.sort((a, b) => b.val - a.val);

  const chains: EdgeChain[] = [];

  for (const seed of seeds) {
    const { index, x, y } = seed;
    if (visited[index] || claimed?.[index]) continue;

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
      { x, y, pressure: Math.min(1, 0.45 + seed.val * 0.4) },
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

    if (length >= minLength && points.length >= 2) {
      if (claimed) {
        for (const point of points) {
          const px = Math.round(point.x);
          const py = Math.round(point.y);
          if (px >= 0 && py >= 0 && px < width && py < height) {
            claimed[py * width + px] = 1;
          }
        }
      }
      chains.push({
        points,
        length,
        strength: strengthSum / Math.max(1, points.length),
      });
    }
  }

  chains.sort((a, b) => b.length - a.length);
  return chains;
}
