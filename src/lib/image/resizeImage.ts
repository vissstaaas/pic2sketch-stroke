export interface ResizedImageResult {
  imageData: ImageData;
  processedWidth: number;
  processedHeight: number;
  aspectRatio: number;
}

/**
 * Normalizes input image into an optimal drawing canvas resolution (~768px).
 * Both oversized images (e.g. 4K) and undersized images (e.g. 200px thumbnails)
 * are normalized to ~768px so pencil strokes, line widths, and hair strands
 * have consistent, high-fidelity artistic resolution.
 */
export function resizeImageToProcessingSize(
  image: HTMLImageElement | ImageBitmap,
  targetDimension = 768
): ResizedImageResult {
  const origWidth = 'naturalWidth' in image ? image.naturalWidth : image.width;
  const origHeight = 'naturalHeight' in image ? image.naturalHeight : image.height;

  const maxOrig = Math.max(origWidth, origHeight);
  // Scale so the largest dimension equals targetDimension (default 768px)
  const scale = targetDimension / Math.max(1, maxOrig);

  let width = Math.round(origWidth * scale);
  let height = Math.round(origHeight * scale);

  // Keep even dimensions and minimum bound
  width = Math.max(256, width + (width % 2));
  height = Math.max(256, height + (height % 2));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('无法创建 2D 画布上下文');
  }

  // Draw scaled image with high quality
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, width, height);

  const imageData = ctx.getImageData(0, 0, width, height);

  return {
    imageData,
    processedWidth: width,
    processedHeight: height,
    aspectRatio: origWidth / origHeight,
  };
}
