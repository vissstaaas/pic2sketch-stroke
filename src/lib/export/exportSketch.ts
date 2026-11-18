import type { StrokeLayer, StrokeScript } from '../../types/stroke';
import { buildStrokeRibbonPolygon, getGraphiteSpec } from '../canvas/brushMath';

export interface SvgExportOptions {
  upToStrokeIndex?: number;
  hiddenLayers?: ReadonlySet<StrokeLayer>;
  includePaperBackground?: boolean;
}

const ORDERED_LAYERS: StrokeLayer[] = [
  'structure',
  'outline',
  'features',
  'lightTone',
  'midTone',
  'darkTone',
  'finalAccent',
];

/**
 * Serializes a `StrokeScript` into a standalone, resolution-independent SVG document
 * using the exact tapered ribbon polygons rendered on the HTML5 canvas.
 */
export function exportScriptToSvg(script: StrokeScript, options?: SvgExportOptions): string {
  const { width, height, background } = script.canvas;
  const maxIdx =
    options?.upToStrokeIndex !== undefined
      ? Math.min(script.strokes.length - 1, options.upToStrokeIndex)
      : script.strokes.length - 1;
  const hidden = options?.hiddenLayers;
  const includePaper = options?.includePaperBackground ?? true;
  const baseSeed = script.generation.seed || 100;

  const layerPaths = new Map<StrokeLayer, string[]>();
  for (const layer of ORDERED_LAYERS) layerPaths.set(layer, []);

  for (let i = 0; i <= maxIdx; i++) {
    const stroke = script.strokes[i];
    if (!stroke || hidden?.has(stroke.layer)) continue;

    const strokeSeed = baseSeed + stroke.order * 37;
    const polygon = buildStrokeRibbonPolygon(stroke.points, stroke.brush, strokeSeed);
    if (polygon.length < 3) continue;

    const spec = getGraphiteSpec(stroke.brush, stroke.layer);
    const opacity = Math.max(0.01, Math.min(1, stroke.brush.opacity)).toFixed(3);

    const coords: string[] = [`M${round2(polygon[0].x)} ${round2(polygon[0].y)}`];
    for (let p = 1; p < polygon.length; p++) {
      coords.push(`L${round2(polygon[p].x)} ${round2(polygon[p].y)}`);
    }
    coords.push('Z');

    layerPaths
      .get(stroke.layer)
      ?.push(`<path d="${coords.join('')}" fill="${spec.svgHex}" fill-opacity="${opacity}"/>`);
  }

  const parts: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    `  <metadata>Pencil Sketch Studio v1.0 | seed=${script.generation.seed} | strokes=${Math.max(0, maxIdx + 1)}</metadata>`,
  ];

  if (includePaper) {
    parts.push(`  <rect width="${width}" height="${height}" fill="${background || '#fbf8f1'}"/>`);
  }

  for (const layer of ORDERED_LAYERS) {
    const paths = layerPaths.get(layer) ?? [];
    if (paths.length === 0) continue;
    parts.push(`  <g id="layer-${layer}">`);
    for (const pathTag of paths) {
      parts.push(`    ${pathTag}`);
    }
    parts.push(`  </g>`);
  }

  parts.push(`</svg>`);
  return parts.join('\n');
}

/**
 * Exports a portable JSON representation of the stroke script without raw diagnostic bitmaps.
 */
export function exportScriptToJson(script: StrokeScript): string {
  const { targetPreview: _omitted, ...portableScript } = script;
  return JSON.stringify(portableScript, null, 2);
}

function round2(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}
