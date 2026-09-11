import type { BrushStyle, Stroke, StrokePoint } from '../../types/stroke';
import { SeededRandom } from '../../utils/random';
import { strokeWidthAt } from './brushMath';

export interface PencilBrushRenderContext {
  ctx: CanvasRenderingContext2D;
  stroke: Stroke;
  points: StrokePoint[];
  brush: BrushStyle;
  seed: number;
  progress: number; // 0.0 to 1.0
}

const GRAPHITE = 'rgba(38, 34, 32, 1)';
const CAP_SEGMENTS = 6;

/**
 * Graphite brush.
 *
 * The previous implementation stroked every segment separately with its own
 * alpha, which double-darkened every joint (visible beading along each line) and
 * made the final darkness impossible to predict. This one builds a single
 * variable-width ribbon polygon and fills it once with the stroke opacity, so
 * the ink a stroke lays down is exactly what the tonal planner accounted for.
 */
export class PencilBrush {
  render(context: PencilBrushRenderContext): void {
    const { ctx, points, brush, seed, progress } = context;
    if (points.length === 0) return;

    const activeLength = Math.max(1, Math.floor(points.length * Math.max(0.02, Math.min(1, progress))));
    const activePoints = points.slice(0, activeLength);
    if (activePoints.length === 0) return;

    const random = new SeededRandom(seed);
    const jitter = brush.jitter * 2.0;
    const jittered: StrokePoint[] = activePoints.map((point) => ({
      x: point.x + (random.next() - 0.5) * jitter,
      y: point.y + (random.next() - 0.5) * jitter,
      pressure: point.pressure ?? 0.6,
    }));

    const ribbon = buildRibbon(jittered, brush.width, brush.grain, random);
    if (ribbon.length < 3) return;

    ctx.save();
    ctx.globalAlpha = Math.max(0.01, Math.min(1, brush.opacity));
    ctx.fillStyle = GRAPHITE;
    ctx.beginPath();
    ctx.moveTo(ribbon[0].x, ribbon[0].y);
    for (let i = 1; i < ribbon.length; i++) ctx.lineTo(ribbon[i].x, ribbon[i].y);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

/**
 * Builds the outline of a tapered ribbon around the path: down one side, round
 * the end cap, back up the other side, round the start cap.
 */
function buildRibbon(
  points: StrokePoint[],
  brushWidth: number,
  grain: number,
  random: SeededRandom
): { x: number; y: number }[] {
  const halfWidths: number[] = points.map((point) =>
    Math.max(0.25, strokeWidthAt(brushWidth, point.pressure) / 2)
  );

  // Dry-graphite modulation: real pencil lines are not perfectly even.
  if (grain > 0) {
    let phase = random.range(0, Math.PI * 2);
    for (let i = 0; i < halfWidths.length; i++) {
      phase += 0.6 + random.range(-0.15, 0.15);
      const modulation = 1 - grain * 0.35 * (0.5 + 0.5 * Math.sin(phase));
      halfWidths[i] = Math.max(0.2, halfWidths[i] * modulation);
    }
  }

  if (points.length === 1) {
    const circle: { x: number; y: number }[] = [];
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2;
      circle.push({
        x: points[0].x + Math.cos(angle) * halfWidths[0],
        y: points[0].y + Math.sin(angle) * halfWidths[0],
      });
    }
    return circle;
  }

  const left: { x: number; y: number }[] = [];
  const right: { x: number; y: number }[] = [];
  const tangents: { x: number; y: number }[] = [];

  for (let i = 0; i < points.length; i++) {
    const previous = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    let tx = next.x - previous.x;
    let ty = next.y - previous.y;
    const length = Math.hypot(tx, ty) || 1;
    tx /= length;
    ty /= length;
    tangents.push({ x: tx, y: ty });
    const nx = -ty;
    const ny = tx;
    left.push({ x: points[i].x + nx * halfWidths[i], y: points[i].y + ny * halfWidths[i] });
    right.push({ x: points[i].x - nx * halfWidths[i], y: points[i].y - ny * halfWidths[i] });
  }

  const polygon: { x: number; y: number }[] = [];
  polygon.push(...left);

  // End cap: sweep from the left edge, round the tip, to the right edge.
  const endIndex = points.length - 1;
  appendCap(polygon, points[endIndex], tangents[endIndex], halfWidths[endIndex], 1);

  for (let i = right.length - 1; i >= 0; i--) polygon.push(right[i]);

  // Start cap: sweep from the right edge, round the back, to the left edge.
  appendCap(polygon, points[0], tangents[0], halfWidths[0], -1);

  return polygon;
}

function appendCap(
  polygon: { x: number; y: number }[],
  center: { x: number; y: number },
  tangent: { x: number; y: number },
  radius: number,
  sign: 1 | -1
): void {
  const baseAngle = Math.atan2(tangent.y, tangent.x);
  for (let i = 0; i <= CAP_SEGMENTS; i++) {
    const angle = baseAngle + sign * (Math.PI * 0.5 - Math.PI * (i / CAP_SEGMENTS));
    polygon.push({
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    });
  }
}
