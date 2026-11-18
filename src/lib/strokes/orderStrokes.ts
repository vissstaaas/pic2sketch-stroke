import type { Stroke, StrokeLayer, StrokeLayerMetrics } from '../../types/stroke';

const LAYER_PRECEDENCE: Record<StrokeLayer, number> = {
  structure: 1,
  outline: 2,
  features: 3,
  lightTone: 4,
  midTone: 5,
  darkTone: 6,
  finalAccent: 7,
};

const TONAL_LAYERS: StrokeLayer[] = ['lightTone', 'midTone', 'darkTone', 'finalAccent'];

const TONAL_WEIGHT: Partial<Record<StrokeLayer, number>> = {
  lightTone: 1.0,
  midTone: 1.25,
  darkTone: 1.65,
  finalAccent: 2.2,
};

function compareStrokePriority(a: Stroke, b: Stroke): number {
  const layerA = LAYER_PRECEDENCE[a.layer] || 99;
  const layerB = LAYER_PRECEDENCE[b.layer] || 99;
  if (layerA !== layerB) return layerA - layerB;
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (b.sourceConfidence !== a.sourceConfidence) return b.sourceConfidence - a.sourceConfidence;
  return a.id.localeCompare(b.id);
}

/**
 * Orders and budgets strokes strictly across the 7 academic drawing layers:
 * structure -> outline -> features -> lightTone -> midTone -> darkTone -> finalAccent.
 *
 * Within equal priority bands of the same layer, applies greedy spatial nearest-neighbor
 * chaining so the virtual hand glides coherently across adjacent regions instead of
 * teleporting erratically across the canvas.
 */
export function orderStrokes(strokes: Stroke[], maxStrokeCount = 8000): Stroke[] {
  if (strokes.length === 0 || maxStrokeCount <= 0) return [];

  const sorted = [...strokes].sort(compareStrokePriority);
  let selected = sorted;

  if (sorted.length > maxStrokeCount) {
    const isEssential = (stroke: Stroke) =>
      stroke.layer === 'structure' || stroke.layer === 'outline' || stroke.layer === 'features';

    const essential = sorted.filter(isEssential);
    const essentialBudget = Math.min(essential.length, Math.round(maxStrokeCount * 0.65));
    const keptEssential = evenlySample(essential, essentialBudget);

    const remaining = Math.max(0, maxStrokeCount - keptEssential.length);

    const groups = new Map<StrokeLayer, Stroke[]>();
    for (const layer of TONAL_LAYERS) groups.set(layer, []);
    for (const stroke of sorted) {
      if (isEssential(stroke)) continue;
      groups.get(stroke.layer)?.push(stroke);
    }

    let weightSum = 0;
    for (const layer of TONAL_LAYERS) {
      const list = groups.get(layer) as Stroke[];
      weightSum += list.length * (TONAL_WEIGHT[layer] ?? 1);
    }

    const quotas = new Map<StrokeLayer, number>();
    let quotaSum = 0;
    for (const layer of TONAL_LAYERS) {
      const list = groups.get(layer) as Stroke[];
      const weight = TONAL_WEIGHT[layer] ?? 1;
      let quota =
        list.length === 0 || weightSum === 0
          ? 0
          : Math.round(remaining * ((list.length * weight) / weightSum));
      quota = Math.min(list.length, quota);
      if (list.length > 0 && remaining > 0) {
        quota = Math.max(quota, Math.min(list.length, 1));
      }
      quotas.set(layer, quota);
      quotaSum += quota;
    }

    while (quotaSum > remaining) {
      let largestLayer: StrokeLayer | null = null;
      let largestQuota = 0;
      for (const layer of TONAL_LAYERS) {
        const q = quotas.get(layer) ?? 0;
        if (q > largestQuota) {
          largestQuota = q;
          largestLayer = layer;
        }
      }
      if (!largestLayer || largestQuota === 0) break;
      quotas.set(largestLayer, largestQuota - 1);
      quotaSum--;
    }

    const keptTonal: Stroke[] = [];
    for (const layer of TONAL_LAYERS) {
      const list = groups.get(layer) as Stroke[];
      keptTonal.push(...evenlySample(list, quotas.get(layer) ?? 0));
    }

    selected = [...keptEssential, ...keptTonal].sort(compareStrokePriority);
  }

  const spatiallyCoherent = chainWithinLayerBands(selected);
  for (let i = 0; i < spatiallyCoherent.length; i++) {
    spatiallyCoherent[i].order = i;
  }
  return spatiallyCoherent;
}

export function computeLayerMetrics(strokes: readonly Stroke[]): StrokeLayerMetrics {
  const metrics: StrokeLayerMetrics = {
    structure: 0,
    outline: 0,
    features: 0,
    lightTone: 0,
    midTone: 0,
    darkTone: 0,
    finalAccent: 0,
  };
  for (const stroke of strokes) {
    metrics[stroke.layer] = (metrics[stroke.layer] ?? 0) + 1;
  }
  return metrics;
}

/**
 * Groups consecutive strokes sharing the same `(layer, coarsePriorityBand)` and
 * orders each band via greedy nearest-neighbor continuation so playback moves
 * smoothly across local neighborhoods.
 */
function chainWithinLayerBands(sorted: Stroke[]): Stroke[] {
  if (sorted.length <= 2) return sorted.slice();

  const output: Stroke[] = [];
  let cursor = 0;
  let lastEndX = sorted[0].points[0]?.x ?? 0;
  let lastEndY = sorted[0].points[0]?.y ?? 0;

  while (cursor < sorted.length) {
    const anchor = sorted[cursor];
    const anchorBand = Math.floor(anchor.priority / 14);
    let bandEnd = cursor + 1;

    while (
      bandEnd < sorted.length &&
      sorted[bandEnd].layer === anchor.layer &&
      Math.floor(sorted[bandEnd].priority / 14) === anchorBand &&
      bandEnd - cursor < 900
    ) {
      bandEnd++;
    }

    const count = bandEnd - cursor;
    if (count <= 2) {
      for (let i = cursor; i < bandEnd; i++) {
        const s = sorted[i];
        output.push(s);
        const endPt = s.points[s.points.length - 1];
        if (endPt) {
          lastEndX = endPt.x;
          lastEndY = endPt.y;
        }
      }
    } else {
      const pool = sorted.slice(cursor, bandEnd);
      const used = new Uint8Array(pool.length);

      for (let step = 0; step < pool.length; step++) {
        let bestIdx = -1;
        let bestDistSq = Infinity;

        for (let i = 0; i < pool.length; i++) {
          if (used[i]) continue;
          const startPt = pool[i].points[0];
          const dx = startPt.x - lastEndX;
          const dy = startPt.y - lastEndY;
          // Mild index penalty preserves high-priority sub-ranking when distances are comparable
          const cost = dx * dx + dy * dy + i * 2.5;
          if (cost < bestDistSq) {
            bestDistSq = cost;
            bestIdx = i;
          }
        }

        if (bestIdx < 0) break;
        used[bestIdx] = 1;
        const chosen = pool[bestIdx];
        output.push(chosen);
        const endPt = chosen.points[chosen.points.length - 1];
        if (endPt) {
          lastEndX = endPt.x;
          lastEndY = endPt.y;
        }
      }
    }

    cursor = bandEnd;
  }

  return output;
}

function evenlySample<T>(list: T[], count: number): T[] {
  if (count <= 0) return [];
  if (count >= list.length) return list.slice();
  if (count === 1) return [list[Math.floor(list.length / 2)]];
  const out: T[] = [];
  for (let i = 0; i < count; i++) {
    out.push(list[Math.round((i * (list.length - 1)) / (count - 1))]);
  }
  return out;
}
