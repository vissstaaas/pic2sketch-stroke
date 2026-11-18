import React from 'react';
import { AlertTriangle, CheckCircle2, Compass, Loader2 } from 'lucide-react';
import type { StrokeGenerationState } from '../hooks/useStrokeGeneration';

interface GenerationStatusProps {
  state: StrokeGenerationState;
}

export const GenerationStatus: React.FC<GenerationStatusProps> = ({ state }) => {
  const { status, progress, message, error, script } = state;

  if (status === 'idle') {
    return (
      <div className="status-box idle">
        <Compass size={18} className="status-icon" />
        <div className="status-text">
          <p className="status-title">画架待命</p>
          <p className="status-desc">上传照片或载入内置人像，引擎将实时解算可回放石墨笔触</p>
        </div>
      </div>
    );
  }

  if (status === 'loading' || status === 'generating') {
    const percent = Math.round(progress * 100);
    return (
      <div className="status-box generating">
        <div className="status-header">
          <div className="status-title-row">
            <Loader2 size={16} className="status-spinner spin" />
            <span className="status-title">正在解算素描笔触...</span>
          </div>
          <span className="status-percentage mono-readout">{percent}%</span>
        </div>
        <div className="progress-bar-track">
          <div className="progress-bar-fill" style={{ width: `${percent}%` }} />
        </div>
        <p className="status-msg">{message || '处理中...'}</p>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="status-box error" role="alert">
        <AlertTriangle size={18} className="status-icon error-icon" />
        <div className="status-text">
          <p className="status-title">笔触解算中断</p>
          <p className="status-desc">{error || '发生未知错误，请更换图片或重试'}</p>
        </div>
      </div>
    );
  }

  if (status === 'ready' && script) {
    const { strokes, canvas, generation } = script;
    return (
      <div className="status-box ready">
        <div className="ready-header">
          <CheckCircle2 size={18} className="status-icon success-icon" />
          <div className="ready-title-group">
            <span className="status-title">笔触脚本已就绪</span>
            <span className="status-badge mono-readout">{strokes.length.toLocaleString()} 笔</span>
          </div>
        </div>
        <div className="script-metadata-grid">
          <div className="meta-item">
            <span className="meta-label">画幅规格</span>
            <span className="meta-val mono-readout">
              {canvas.width} × {canvas.height}
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">解算种子</span>
            <span className="meta-val mono-readout">#{generation.seed}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">解算耗时</span>
            <span className="meta-val mono-readout">
              {generation.elapsedMs ? `${generation.elapsedMs} ms` : '—'}
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">分级铅笔</span>
            <span className="meta-val mono-readout">2H · HB · 2B · 4B · 6B</span>
          </div>
        </div>
      </div>
    );
  }

  return null;
};
