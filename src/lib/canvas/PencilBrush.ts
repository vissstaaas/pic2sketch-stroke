import type { BrushStyle, Stroke, StrokePoint } from '../../types/stroke';
import { buildStrokeRibbonPolygon, getGraphiteSpec } from './brushMath';

export interface PencilBrushRenderContext {
  ctx: CanvasRenderingContext2D;
  stroke: Stroke;
  points: StrokePoint[];
  brush: BrushStyle;
  seed: number;
  progress: number;
}

export class PencilBrush {
  render(context: PencilBrushRenderContext): void {
    const { ctx, stroke, points, brush, seed, progress } = context;
    if (points.length === 0 || progress <= 0) return;

    const clampedProgress = Math.max(0.02, Math.min(1, progress));
    const activePoints = sliceStrokeAtProgress(points, clampedProgress);
    if (activePoints.length === 0) return;

    const ribbon = buildStrokeRibbonPolygon(activePoints, brush, seed);
    if (ribbon.length < 3) return;

    const graphite = getGraphiteSpec(brush, stroke.layer);

    ctx.save();
    ctx.globalAlpha = Math.max(0.01, Math.min(1, brush.opacity));
    ctx.fillStyle = graphite.cssColor;
    ctx.beginPath();
    ctx.moveTo(ribbon[0].x, ribbon[0].y);
    for (let i = 1; i < ribbon.length; i++) {
      ctx.lineTo(ribbon[i].x, ribbon[i].y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

/**
 * Interpolates the partial tip position along the polyline so slow-motion
 * playback glides smoothly instead of snapping vertex-to-vertex.
 */
function sliceStrokeAtProgress(points: StrokePoint[], progress: number): StrokePoint[] {
  if (progress >= 0.999 || points.length <= 1) return points;

  const exactIndex = progress * (points.length - 1);
  const wholeIndex = Math.floor(exactIndex);
  const fraction = exactIndex - wholeIndex;

  const subset = points.slice(0, wholeIndex + 1);
  if (fraction > 0.01 && wholeIndex + 1 < points.length) {
    const a = points[wholeIndex];
    const b = points[wholeIndex + 1];
    subset.push({
      x: a.x + (b.x - a.x) * fraction,
      y: a.y + (b.y - a.y) * fraction,
      pressure: (a.pressure + (b.pressure - a.pressure) * fraction) * 0.85,
    });
  }
  return subset;
}
