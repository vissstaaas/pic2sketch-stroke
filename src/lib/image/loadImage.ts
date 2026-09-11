import type { UploadImageMeta } from '../../types/image-processing';

const SUPPORTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB safety limit

export interface LoadedImageResult {
  meta: UploadImageMeta;
  image: HTMLImageElement;
}

export async function loadImageFromFile(file: File): Promise<LoadedImageResult> {
  if (!SUPPORTED_TYPES.includes(file.type.toLowerCase())) {
    throw new Error(
      `不支持的文件格式: ${file.type || '未知'}。请上传 PNG、JPEG 或 WebP 格式图片。`
    );
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(`文件大小超过限制 (最大 50MB)`);
  }

  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const meta: UploadImageMeta = {
        fileName: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        width: img.naturalWidth,
        height: img.naturalHeight,
      };
      resolve({ meta, image: img });
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('图片加载失败，文件可能已损坏或格式不受支持。'));
    };

    img.src = objectUrl;
  });
}
