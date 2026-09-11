import type { Stroke, StrokeLayer } from '../../types/stroke';

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

/** Tonal layers are not equally expendable: losing the darks ruins the drawing. */
const TONAL_WEIGHT: Partial<Record<StrokeLayer, number>> = {
  lightTone: 1,
  midTone: 1.2,
  darkTone: 1.6,
  finalAccent: 2.2,
};

/**
 * Sorts and caps strokes in genuine drawing order:
 * structure -> outline -> features -> light -> mid -> dark -> accent.
 *
 * The cap used to simply append tonal strokes in layer order and then
 * `slice` the list, which meant that as soon as the budget ran out every
 * midTone, darkTone and finalAccent stroke was thrown away — the drawing lost
 * its shadows entirely. The budget is now shared out per layer, and each layer
 * is sampled evenly instead of truncated, so the strokes that survive are spread
 * across the whole picture rather than clustered in one corner.
 */
export function orderStrokes(strokes: Stroke[], maxStrokeCount = 8000): Stroke[] {
  const sorted = [...strokes].sort((a, b) => {
    const layerA = LAYER_PRECEDENCE[a.layer] || 99;
    const layerB = LAYER_PRECEDENCE[b.layer] || 99;
    if (layerA !== layerB) return layerA - layerB;
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (b.sourceConfidence !== a.sourceConfidence) return b.sourceConfidence - a.sourceConfidence;
    return a.id.localeCompare(b.id);
  });

  let result = sorted;

  if (sorted.length > maxStrokeCount) {
    const isEssential = (stroke: Stroke) =>
      stroke.layer === 'structure' || stroke.layer === 'outline' || stroke.layer === 'features';

    const essential = sorted.filter(isEssential);
    const essentialBudget = Math.min(essential.length, Math.round(maxStrokeCount * 0.65));
    const keptEssential = evenlySample(essential, essentialBudget);

    let remaining = Math.max(0, maxStrokeCount - keptEssential.length);

    const groups = new Map<StrokeLayer, Stroke[]>();
    for (const layer of TONAL_LAYERS) groups.set(layer, []);
    for (const stroke of sorted) {
      if (isEssential(stroke)) continue;
      const bucket = groups.get(stroke.layer);
      if (bucket) bucket.push(stroke);
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
      let quota = list.length === 0 || weightSum === 0
        ? 0
        : Math.round(remaining * ((list.length * weight) / weightSum));
      quota = Math.min(list.length, quota);
      if (list.length > 0) quota = Math.max(quota, Math.min(list.length, 1));
      quotas.set(layer, quota);
      quotaSum += quota;
    }

    // Rounding can overshoot; take the excess from the largest quota.
    while (quotaSum > remaining) {
      let largestLayer: StrokeLayer | null = null;
      let largestQuota = 0;
      for (const layer of TONAL_LAYERS) {
        const quota = quotas.get(layer) ?? 0;
        if (quota > largestQuota) { largestQuota = quota; largestLayer = layer; }
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

    result = [...keptEssential, ...keptTonal].sort((a, b) => {
      const layerA = LAYER_PRECEDENCE[a.layer] || 99;
      const layerB = LAYER_PRECEDENCE[b.layer] || 99;
      if (layerA !== layerB) return layerA - layerB;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.order - b.order;
    });
  }

  for (let i = 0; i < result.length; i++) result[i].order = i;
  return result;
}

/** Deterministic evenly spread subset: keeps coverage instead of one corner. */
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
