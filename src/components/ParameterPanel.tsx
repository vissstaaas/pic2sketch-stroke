import React from 'react';
import { Dices, Lock, RefreshCw, SlidersHorizontal, Unlock } from 'lucide-react';
import type { SketchStylePreset, StrokeGenerationOptions } from '../types/image-processing';

interface ParameterPanelProps {
  options: StrokeGenerationOptions;
  seedLocked: boolean;
  canRegenerate: boolean;
  isBusy: boolean;
  onChange: (patch: Partial<StrokeGenerationOptions>) => void;
  onToggleSeedLock: () => void;
  onRandomizeSeed: () => void;
  onRegenerate: () => void;
}

interface PresetDescriptor {
  id: SketchStylePreset;
  label: string;
  subtitle: string;
  defaults: Partial<StrokeGenerationOptions>;
}

const STYLE_PRESETS: PresetDescriptor[] = [
  {
    id: 'classic',
    label: '学院写实',
    subtitle: '通用均衡 · 静物雕塑',
    defaults: {
      stylePreset: 'classic',
      targetStrokeCount: 9500,
      contourSensitivity: 0.58,
      shadingDensity: 0.66,
      backgroundSuppression: 0.52,
    },
  },
  {
    id: 'portrait',
    label: '细腻人像',
    subtitle: '清透肤质 · 顺滑发丝',
    defaults: {
      stylePreset: 'portrait',
      targetStrokeCount: 10500,
      contourSensitivity: 0.54,
      shadingDensity: 0.62,
      backgroundSuppression: 0.72,
    },
  },
  {
    id: 'pet',
    label: '萌宠毛发',
    subtitle: '蓬松毛流 · 亮眼胡须',
    defaults: {
      stylePreset: 'pet',
      targetStrokeCount: 11000,
      contourSensitivity: 0.6,
      shadingDensity: 0.68,
      backgroundSuppression: 0.64,
    },
  },
  {
    id: 'landscape',
    label: '山水风景',
    subtitle: '云雾留调 · 空气透视',
    defaults: {
      stylePreset: 'landscape',
      targetStrokeCount: 10800,
      contourSensitivity: 0.5,
      shadingDensity: 0.7,
      backgroundSuppression: 0.1,
    },
  },
  {
    id: 'architecture',
    label: '建筑透视',
    subtitle: '锐利直构 · 街景载具',
    defaults: {
      stylePreset: 'architecture',
      targetStrokeCount: 12000,
      contourSensitivity: 0.68,
      shadingDensity: 0.72,
      backgroundSuppression: 0.48,
    },
  },
  {
    id: 'botanical',
    label: '花卉美食',
    subtitle: '柔雅花瓣 · 细腻质感',
    defaults: {
      stylePreset: 'botanical',
      targetStrokeCount: 10500,
      contourSensitivity: 0.6,
      shadingDensity: 0.66,
      backgroundSuppression: 0.65,
    },
  },
  {
    id: 'lineart',
    label: '纯净速写',
    subtitle: '动漫插画 · 极简线稿',
    defaults: {
      stylePreset: 'lineart',
      targetStrokeCount: 4600,
      contourSensitivity: 0.68,
      shadingDensity: 0.34,
      backgroundSuppression: 0.76,
    },
  },
  {
    id: 'dramatic',
    label: '强烈炭笔',
    subtitle: '浓郁体积 · 夜景高反差',
    defaults: {
      stylePreset: 'dramatic',
      targetStrokeCount: 12000,
      contourSensitivity: 0.6,
      shadingDensity: 0.82,
      backgroundSuppression: 0.45,
    },
  },
];

const RESOLUTION_TIERS = [512, 768, 1024];

export const ParameterPanel: React.FC<ParameterPanelProps> = ({
  options,
  seedLocked,
  canRegenerate,
  isBusy,
  onChange,
  onToggleSeedLock,
  onRandomizeSeed,
  onRegenerate,
}) => {
  const activePreset = options.stylePreset ?? 'classic';

  return (
    <div className="param-panel">
      <div className="param-section">
        <div className="param-section-label">
          <SlidersHorizontal size={13} />
          <span>题材与风格预设</span>
        </div>
        <div className="preset-grid">
          {STYLE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              disabled={isBusy}
              className={`preset-card ${activePreset === preset.id ? 'active' : ''}`}
              onClick={() => onChange(preset.defaults)}
            >
              <span className="preset-name">{preset.label}</span>
              <span className="preset-sub">{preset.subtitle}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="slider-group">
        <div className="slider-item">
          <div className="slider-head">
            <label htmlFor="stroke-budget">笔触数量预算</label>
            <span className="mono-readout">{options.targetStrokeCount.toLocaleString()} 笔</span>
          </div>
          <input
            id="stroke-budget"
            type="range"
            min={1500}
            max={16000}
            step={500}
            disabled={isBusy}
            value={options.targetStrokeCount}
            onChange={(e) => onChange({ targetStrokeCount: Number(e.target.value) })}
          />
        </div>

        <div className="slider-item">
          <div className="slider-head">
            <label htmlFor="contour-sens">FDoG 轮廓灵敏度</label>
            <span className="mono-readout">{Math.round(options.contourSensitivity * 100)}%</span>
          </div>
          <input
            id="contour-sens"
            type="range"
            min={0.15}
            max={0.95}
            step={0.01}
            disabled={isBusy}
            value={options.contourSensitivity}
            onChange={(e) => onChange({ contourSensitivity: Number(e.target.value) })}
          />
        </div>

        <div className="slider-item">
          <div className="slider-head">
            <label htmlFor="shading-density">交叉排线密度</label>
            <span className="mono-readout">{Math.round(options.shadingDensity * 100)}%</span>
          </div>
          <input
            id="shading-density"
            type="range"
            min={0.2}
            max={1.0}
            step={0.02}
            disabled={isBusy}
            value={options.shadingDensity}
            onChange={(e) => onChange({ shadingDensity: Number(e.target.value) })}
          />
        </div>

        <div className="slider-item">
          <div className="slider-head">
            <label htmlFor="bg-suppress">背景净化留白</label>
            <span className="mono-readout">{Math.round(options.backgroundSuppression * 100)}%</span>
          </div>
          <input
            id="bg-suppress"
            type="range"
            min={0}
            max={1}
            step={0.05}
            disabled={isBusy}
            value={options.backgroundSuppression}
            onChange={(e) => onChange({ backgroundSuppression: Number(e.target.value) })}
          />
        </div>

        <div className="slider-item">
          <div className="slider-head">
            <label htmlFor="paper-grain">纸张肌理颗粒</label>
            <span className="mono-readout">{Math.round((options.paperGrain ?? 0.32) * 100)}%</span>
          </div>
          <input
            id="paper-grain"
            type="range"
            min={0}
            max={0.85}
            step={0.05}
            disabled={isBusy}
            value={options.paperGrain ?? 0.32}
            onChange={(e) => onChange({ paperGrain: Number(e.target.value) })}
          />
        </div>
      </div>

      <div className="param-inline-row">
        <span className="inline-label">采样精度</span>
        <div className="segmented-pills">
          {RESOLUTION_TIERS.map((dim) => (
            <button
              key={dim}
              type="button"
              disabled={isBusy}
              className={`seg-pill ${options.maxProcessingSize === dim ? 'active' : ''}`}
              onClick={() => onChange({ maxProcessingSize: dim })}
            >
              {dim}px
            </button>
          ))}
        </div>
      </div>

      <div className="param-inline-row">
        <span className="inline-label">随机种子</span>
        <div className="seed-control-box">
          <span className="mono-readout seed-val">
            #{options.seed !== undefined ? options.seed : 'AUTO'}
          </span>
          <button
            type="button"
            className={`icon-mini-btn ${seedLocked ? 'locked' : ''}`}
            onClick={onToggleSeedLock}
            disabled={isBusy}
            title={seedLocked ? '已锁定种子（参数微调可严格对照）' : '点击锁定当前随机种子'}
          >
            {seedLocked ? <Lock size={13} /> : <Unlock size={13} />}
          </button>
          <button
            type="button"
            className="icon-mini-btn"
            onClick={onRandomizeSeed}
            disabled={isBusy}
            title="换一组新随机种子"
          >
            <Dices size={13} />
          </button>
        </div>
      </div>

      <button
        type="button"
        className="regenerate-btn"
        disabled={!canRegenerate || isBusy}
        onClick={onRegenerate}
      >
        <RefreshCw size={15} className={isBusy ? 'spin' : ''} />
        <span>{canRegenerate ? '按当前参数重新生成笔触' : '上传图片后可随时调参重算'}</span>
      </button>
    </div>
  );
};
