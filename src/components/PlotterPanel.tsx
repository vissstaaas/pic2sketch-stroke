import React, { useMemo, useState } from 'react';
import { Bot, Check, Code2, Copy, Download, FileCode2, Play, X } from 'lucide-react';
import {
  exportPlotterCenterlineSvg,
  exportPlotterGcode,
  formatDurationChinese,
  PAPER_SPECS,
  TIER_SPECS,
  type PlotterConfig,
  type PlotterPaperId,
  type PlotterPlan,
  type PlotterTier,
} from '../lib/plotter/buildPlotterPlan';

interface PlotterPanelProps {
  config: PlotterConfig;
  plan: PlotterPlan | null;
  isPlotterViewActive: boolean;
  onChangeConfig: (partial: Partial<PlotterConfig>) => void;
  onActivatePlotterView: () => void;
  onExportGcode: () => void;
  onExportCenterlineSvg: () => void;
  onOpenCodePreview: (tab: 'gcode' | 'svg') => void;
  disabled?: boolean;
}

const TIER_ORDER: PlotterTier[] = ['fast', 'standard', 'fine'];
const PAPER_ORDER: PlotterPaperId[] = ['postcard', 'A5', 'A4'];

export const PlotterPanel: React.FC<PlotterPanelProps> = ({
  config,
  plan,
  isPlotterViewActive,
  onChangeConfig,
  onActivatePlotterView,
  onExportGcode,
  onExportCenterlineSvg,
  onOpenCodePreview,
  disabled = false,
}) => {
  const hasPlan = !!plan && plan.strokes.length > 0 && !disabled;

  return (
    <div className="plotter-panel">
      <div className="plotter-panel-header">
        <div className="plotter-panel-title-wrap">
          <Bot size={15} className="plotter-icon-accent" />
          <h2 className="card-title">机械臂 & 写字机真机工坊</h2>
        </div>
        <button
          type="button"
          className={`plotter-view-pill ${isPlotterViewActive ? 'active' : ''}`}
          onClick={onActivatePlotterView}
          disabled={!hasPlan}
          title="在左侧画架切换为物理毫米走刀仿真视图"
        >
          <Play size={11} />
          <span>{isPlotterViewActive ? '走刀视图中' : '真机仿真'}</span>
        </button>
      </div>

      {plan && (
        <div className="plotter-summary-banner">
          <span>
            预计真机耗时 <strong>{formatDurationChinese(plan.telemetry.totalSec)}</strong>
          </span>
          <span className="mono-readout">
            {plan.telemetry.penLifts.toLocaleString()} 次抬笔 (-{plan.telemetry.savedLiftPct}%)
          </span>
        </div>
      )}

      <div className="plotter-section">
        <span className="control-label">1. 商业出图档位 (耗时 vs 细腻度)</span>
        <div className="plotter-tier-grid">
          {TIER_ORDER.map((tierId) => {
            const spec = TIER_SPECS[tierId];
            const isSelected = config.tier === tierId;
            return (
              <button
                key={tierId}
                type="button"
                className={`plotter-tier-card ${isSelected ? 'active' : ''}`}
                onClick={() => onChangeConfig({ tier: tierId })}
                disabled={!hasPlan}
              >
                <span className="tier-card-title">{spec.title}</span>
                <span className="tier-card-sub">{spec.subtitle}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="plotter-section">
        <span className="control-label">2. 物理画纸幅面 (自动横竖自适应)</span>
        <div className="plotter-seg-row cols-3">
          {PAPER_ORDER.map((paperId) => {
            const spec = PAPER_SPECS[paperId];
            return (
              <button
                key={paperId}
                type="button"
                className={`plotter-seg-btn ${config.paper === paperId ? 'active' : ''}`}
                onClick={() => onChangeConfig({ paper: paperId })}
                disabled={!hasPlan}
              >
                {spec.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="plotter-section">
        <span className="control-label">3. 硬件控制器协议</span>
        <div className="plotter-seg-row cols-2">
          <button
            type="button"
            className={`plotter-seg-btn ${config.protocol === 'zaxis' ? 'active' : ''}`}
            onClick={() => onChangeConfig({ protocol: 'zaxis' })}
            disabled={!hasPlan}
          >
            机械臂 Z轴压感 (G1 Z)
          </button>
          <button
            type="button"
            className={`plotter-seg-btn ${config.protocol === 'grbl' ? 'active' : ''}`}
            onClick={() => onChangeConfig({ protocol: 'grbl' })}
            disabled={!hasPlan}
          >
            GRBL 写字机舵机 (M3/M5)
          </button>
        </div>
      </div>

      <div className="plotter-sliders">
        <label className="slider-item">
          <div className="slider-head">
            <span>落笔走刀速度 (Feedrate)</span>
            <span className="mono-readout">{config.feedRate} mm/min</span>
          </div>
          <input
            type="range"
            min={1200}
            max={4800}
            step={100}
            value={config.feedRate}
            disabled={!hasPlan}
            onChange={(e) => onChangeConfig({ feedRate: Number(e.target.value) })}
          />
        </label>

        {config.protocol === 'zaxis' && (
          <label className="slider-item">
            <div className="slider-head">
              <span>弹簧笔夹最大下压深度 (Max Z)</span>
              <span className="mono-readout">-{config.maxZDepthMm.toFixed(1)} mm</span>
            </div>
            <input
              type="range"
              min={0.6}
              max={3.6}
              step={0.1}
              value={config.maxZDepthMm}
              disabled={!hasPlan}
              onChange={(e) => onChangeConfig({ maxZDepthMm: Number(e.target.value) })}
            />
          </label>
        )}

        <label className="slider-item">
          <div className="slider-head">
            <span>四边磁吸压纸安全边距</span>
            <span className="mono-readout">{config.marginMm} mm</span>
          </div>
          <input
            type="range"
            min={5}
            max={24}
            step={1}
            value={config.marginMm}
            disabled={!hasPlan}
            onChange={(e) => onChangeConfig({ marginMm: Number(e.target.value) })}
          />
        </label>
      </div>

      <div className="plotter-export-stack">
        <button
          type="button"
          className="plotter-btn-primary"
          onClick={onExportGcode}
          disabled={!hasPlan}
        >
          <Download size={14} />
          <span>导出真机轨迹 (.gcode)</span>
        </button>

        <button
          type="button"
          className="plotter-btn-secondary"
          onClick={onExportCenterlineSvg}
          disabled={!hasPlan}
        >
          <FileCode2 size={14} />
          <span>导出写字机单线中心线 (.svg)</span>
        </button>

        <button
          type="button"
          className="plotter-btn-ghost"
          onClick={() => onOpenCodePreview('gcode')}
          disabled={!hasPlan}
        >
          <Code2 size={13} />
          <span>在线预览 G-code / 单线 SVG 指令源码</span>
        </button>
      </div>
    </div>
  );
};

interface PlotterCodeModalProps {
  plan: PlotterPlan;
  initialTab: 'gcode' | 'svg';
  onClose: () => void;
  onDownloadGcode: () => void;
  onDownloadSvg: () => void;
}

const MAX_PREVIEW_LINES = 420;

export const PlotterCodeModal: React.FC<PlotterCodeModalProps> = ({
  plan,
  initialTab,
  onClose,
  onDownloadGcode,
  onDownloadSvg,
}) => {
  const [activeTab, setActiveTab] = useState<'gcode' | 'svg'>(initialTab);
  const [copied, setCopied] = useState(false);

  const fullCode = useMemo(() => {
    return activeTab === 'gcode'
      ? exportPlotterGcode(plan)
      : exportPlotterCenterlineSvg(plan);
  }, [activeTab, plan]);

  const { previewText, totalLines, truncated, sizeKb } = useMemo(() => {
    const lines = fullCode.split('\n');
    const isTrunc = lines.length > MAX_PREVIEW_LINES;
    const sliced = isTrunc
      ? lines.slice(0, MAX_PREVIEW_LINES).join('\n') +
        `\n\n; ... (已省略剩余 ${lines.length - MAX_PREVIEW_LINES} 行，点击上方「复制全部」或「下载文件」获取完整代码)`
      : fullCode;
    return {
      previewText: sliced,
      totalLines: lines.length,
      truncated: isTrunc,
      sizeKb: (fullCode.length / 1024).toFixed(1),
    };
  }, [fullCode]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(fullCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="plotter-modal-backdrop" role="dialog" aria-modal="true">
      <div className="plotter-modal-card">
        <div className="plotter-modal-header">
          <div className="plotter-modal-tabs">
            <button
              type="button"
              className={`plotter-modal-tab ${activeTab === 'gcode' ? 'active' : ''}`}
              onClick={() => setActiveTab('gcode')}
            >
              真机轨迹 (.gcode)
            </button>
            <button
              type="button"
              className={`plotter-modal-tab ${activeTab === 'svg' ? 'active' : ''}`}
              onClick={() => setActiveTab('svg')}
            >
              单线中心线 (.svg)
            </button>
            <span className="plotter-modal-meta mono-readout">
              {totalLines.toLocaleString()} 行 · {sizeKb} KB{truncated ? ' (预览前 420 行)' : ''}
            </span>
          </div>

          <div className="plotter-modal-actions">
            <button type="button" className="plotter-modal-btn" onClick={handleCopy}>
              {copied ? <Check size={13} /> : <Copy size={13} />}
              <span>{copied ? '已复制全文' : '复制全部'}</span>
            </button>
            <button
              type="button"
              className="plotter-modal-btn primary"
              onClick={activeTab === 'gcode' ? onDownloadGcode : onDownloadSvg}
            >
              <Download size={13} />
              <span>下载 {activeTab === 'gcode' ? '.gcode' : '.svg'}</span>
            </button>
            <button
              type="button"
              className="plotter-modal-close"
              onClick={onClose}
              aria-label="关闭源码预览"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <pre className="plotter-modal-code mono-readout">{previewText}</pre>
      </div>
    </div>
  );
};
