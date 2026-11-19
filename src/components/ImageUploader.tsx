import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ImagePlus, Sparkles, Upload } from 'lucide-react';

interface ImageUploaderProps {
  onFileSelect: (file: File) => void;
  disabled?: boolean;
}

const VALID_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const DEMO_SAMPLE_URL = new URL('../../samples/pasted-1-768.png', import.meta.url).href;

export const ImageUploader: React.FC<ImageUploaderProps> = ({
  onFileSelect,
  disabled = false,
}) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [isLoadingSample, setIsLoadingSample] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const validateAndHandle = useCallback(
    (file: File) => {
      setErrorMsg(null);
      if (!VALID_MIME_TYPES.includes(file.type.toLowerCase())) {
        setErrorMsg('仅支持 PNG、JPG、WebP 格式图片');
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        setErrorMsg('文件体积超过 50MB 上限');
        return;
      }
      onFileSelect(file);
    },
    [onFileSelect]
  );

  // Global clipboard paste support (Ctrl+V / Cmd+V anywhere outside inputs)
  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      if (disabled) return;
      const items = event.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const blob = items[i].getAsFile();
          if (blob) {
            event.preventDefault();
            validateAndHandle(blob);
            break;
          }
        }
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [disabled, validateAndHandle]);

  const handleLoadSample = useCallback(async () => {
    if (disabled || isLoadingSample) return;
    setErrorMsg(null);
    setIsLoadingSample(true);
    try {
      const response = await fetch(DEMO_SAMPLE_URL);
      if (!response.ok) throw new Error('无法读取内置示例图');
      const blob = await response.blob();
      const file = new File([blob], 'studio-portrait-sample.png', { type: 'image/png' });
      onFileSelect(file);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '加载示例图失败');
    } finally {
      setIsLoadingSample(false);
    }
  }, [disabled, isLoadingSample, onFileSelect]);

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

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        validateAndHandle(e.target.files[0]);
        e.target.value = '';
      }
    },
    [validateAndHandle]
  );

  return (
    <div className="uploader-container">
      <div
        className={`dropzone ${isDragOver ? 'drag-over' : ''} ${disabled ? 'disabled' : ''}`}
        onDrop={handleDrop}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setIsDragOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setIsDragOver(false);
        }}
        onClick={() => !disabled && fileInputRef.current?.click()}
        role="button"
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
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
            <Upload className="upload-icon" size={22} />
          </div>
          <div className="upload-texts">
            <p className="main-text">拖拽、点击上传或 Ctrl+V 粘贴图片</p>
            <p className="sub-text">PNG / JPG / WebP · 最大 50MB</p>
          </div>
        </div>
      </div>

      <button
        type="button"
        className="sample-trigger-btn"
        disabled={disabled || isLoadingSample}
        onClick={handleLoadSample}
      >
        {isLoadingSample ? <Sparkles size={14} /> : <ImagePlus size={14} />}
        <span>{isLoadingSample ? '正在载入示例肖像...' : '一键载入内置人像示例'}</span>
      </button>

      {errorMsg && (
        <div className="upload-error-banner" role="alert">
          <AlertCircle size={15} />
          <span>{errorMsg}</span>
        </div>
      )}
    </div>
  );
};
