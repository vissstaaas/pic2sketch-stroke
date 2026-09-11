import type { PreprocessedImage, StrokeGenerationOptions } from '../../types/image-processing';
import type { Stroke } from '../../types/stroke';
import type { SeededRandom } from '../../utils/random';

// We simplified the context. It no longer needs ToneAccumulator.
export interface StrokeGenerationContext {
  claimed: Uint8Array;
}

/**
 * AI Lineart version of shading strokes.
 * Since the user explicitly requested a "Pure White/Clean Lineart" style,
 * we almost entirely disable shading, letting the ONNX outlines do the work.
 */
export function generateShadingStrokes(
  _preprocessed: PreprocessedImage,
  _options: StrokeGenerationOptions,
  _rng: SeededRandom,
  _context?: StrokeGenerationContext
): Stroke[] {
  // Return an empty array to completely disable messy shading strokes.
  // The ONNX line art model provides all the necessary semantics!
  return [];
}
