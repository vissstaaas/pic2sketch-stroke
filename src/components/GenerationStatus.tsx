import React from 'react';
import { CheckCircle2, Loader2, AlertTriangle, Sparkles } from 'lucide-react';
import type { StrokeGenerationState } from '../hooks/useStrokeGeneration';

interface GenerationStatusProps {
  state: StrokeGenerationState;
}

export const GenerationStatus: React.FC<GenerationStatusProps> = ({ state }) => {
  const { status, progress, message, error, script } = state;

  if (status === 'idle') {
    return (
      <div className="status-box idle">
        <Sparkles size={20} className="status-icon" />
        <div className="status-text">
          <p className="status-title">等待图片上传</p>
          <p className="status-desc">上传人物或单主体图片，系统将自动分解生成素描笔触脚本</p>
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
            <Loader2 size={18} className="status-spinner spin" />
            <span className="status-title">正在生成笔触脚本...</span>
          </div>
          <span className="status-percentage">{percent}%</span>
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
      <div className="status-box error">
        <AlertTriangle size={20} className="status-icon error-icon" />
        <div className="status-text">
          <p className="status-title">生成失败</p>
          <p className="status-desc">{error || '发生未知错误，请重试'}</p>
        </div>
      </div>
    );
  }

  if (status === 'ready' && script) {
    const { strokes, canvas, generation } = script;
    return (
      <div className="status-box ready">
        <div className="ready-header">
          <CheckCircle2 size={20} className="status-icon success-icon" />
          <div className="ready-title-group">
            <span className="status-title">笔触脚本已就绪</span>
            <span className="status-badge">{strokes.length} 笔</span>
          </div>
        </div>
        <div className="script-metadata-grid">
          <div className="meta-item">
            <span className="meta-label">画板尺寸</span>
            <span className="meta-val">{canvas.width} × {canvas.height}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">随机种子</span>
            <span className="meta-val">#{generation.seed}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">绘制顺序</span>
            <span className="meta-val">结构 → 轮廓 → 排线 → 强调</span>
          </div>
        </div>
      </div>
    );
  }

  return null;
};
