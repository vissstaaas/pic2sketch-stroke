import type { PreprocessedImage, StrokeGenerationOptions } from '../../types/image-processing';
import type { Stroke } from '../../types/stroke';
import type { SeededRandom } from '../../utils/random';
import type { StrokeGenerationContext } from './generateShadingStrokes';

export function generateHairFlowStrokes(
  _preprocessed: PreprocessedImage,
  _options: StrokeGenerationOptions,
  _rng: SeededRandom,
  _context?: StrokeGenerationContext
): Stroke[] {
  // With ONNX AI lineart, hair lines are already perfectly extracted as contours.
  // We don't need synthetic mathematical hair flow anymore.
  return [];
}
