import React, { useEffect, useRef } from 'react';
import type { SketchTargetPreview } from '../types/stroke';

interface TargetSketchPreviewProps {
  preview?: SketchTargetPreview;
}

export const TargetSketchPreview: React.FC<TargetSketchPreviewProps> = ({ preview }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !preview) return;

    canvas.width = preview.width;
    canvas.height = preview.height;
    const context = canvas.getContext('2d');
    if (!context) return;

    const rgba = new Uint8ClampedArray(preview.width * preview.height * 4);
    for (let i = 0; i < preview.pixels.length; i++) {
      const value = preview.pixels[i];
      const offset = i * 4;
      rgba[offset] = value;
      rgba[offset + 1] = value;
      rgba[offset + 2] = value;
      rgba[offset + 3] = 255;
    }
    context.putImageData(new ImageData(rgba, preview.width, preview.height), 0, 0);
  }, [preview]);

  return (
    <div className="canvas-wrapper target-preview-wrapper">
      <div className="canvas-easel-frame">
        {preview ? (
          <canvas
            ref={canvasRef}
            className="sketch-canvas target-preview-canvas"
            aria-label="传统算法生成的完整素描目标图"
          />
        ) : (
          <div className="target-preview-empty">上传图片后显示完整素描目标图</div>
        )}
      </div>
    </div>
  );
};
