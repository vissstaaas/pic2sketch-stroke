import React, { useCallback, useRef, useState } from 'react';
import { Upload, AlertCircle } from 'lucide-react';

interface ImageUploaderProps {
  onFileSelect: (file: File) => void;
  disabled?: boolean;
}

export const ImageUploader: React.FC<ImageUploaderProps> = ({
  onFileSelect,
  disabled = false,
}) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const validateAndHandle = useCallback(
    (file: File) => {
      setErrorMsg(null);
      const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
      if (!validTypes.includes(file.type.toLowerCase())) {
        setErrorMsg('请上传 JPG、PNG 或 WebP 格式的图片文件');
        return;
      }
      if (file.size > 50 * 1024 * 1024) {
        setErrorMsg('文件过大，请上传 50MB 以内的图片');
        return;
      }
      onFileSelect(file);
    },
    [onFileSelect]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      if (disabled) return;
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        validateAndHandle(e.dataTransfer.files[0]);
      }
    },
    [disabled, validateAndHandle]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        validateAndHandle(e.target.files[0]);
      }
    },
    [validateAndHandle]
  );

  return (
    <div className="uploader-container">
      <div
        className={`dropzone ${isDragOver ? 'drag-over' : ''} ${disabled ? 'disabled' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => !disabled && fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png, image/jpeg, image/webp"
          style={{ display: 'none' }}
          onChange={handleChange}
          disabled={disabled}
        />

        <div className="dropzone-content">
          <div className="icon-wrapper">
            <Upload className="upload-icon" size={28} />
          </div>
          <div className="upload-texts">
            <p className="main-text">点击或拖拽上传人物 / 主体图片</p>
            <p className="sub-text">支持 PNG, JPG, JPEG, WebP（最大 50MB）</p>
          </div>
        </div>
      </div>

      {errorMsg && (
        <div className="upload-error-banner">
          <AlertCircle size={16} />
          <span>{errorMsg}</span>
        </div>
      )}
    </div>
  );
};
