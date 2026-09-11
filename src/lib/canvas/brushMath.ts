/**
 * Shared brush maths. The tonal planner and the renderer must agree on how wide
 * a stroke actually lands, otherwise the ink accounting drifts.
 */
export const MIN_WIDTH_FACTOR = 0.45;

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Ribbon half width at a given pen pressure. */
export function strokeWidthAt(brushWidth: number, pressure: number): number {
  return brushWidth * (MIN_WIDTH_FACTOR + (1 - MIN_WIDTH_FACTOR) * clamp01(pressure));
}
