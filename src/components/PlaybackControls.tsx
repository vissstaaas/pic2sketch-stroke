import React from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FastForward,
  FileCode2,
  FileJson,
  Pause,
  Play,
  RotateCcw,
} from 'lucide-react';
import type { PlaybackFrameState } from '../types/stroke';

interface PlaybackControlsProps {
  state: PlaybackFrameState;
  canPlay: boolean;
  canPause: boolean;
  canResume: boolean;
  canReplay: boolean;
  canExport: boolean;
  hasScript: boolean;
  onPlay: () => void;
  onPause: () => void;
  onResume: () => void;
  onReplay: () => void;
  onSeek: (progress: number) => void;
  onStep: (delta: number) => void;
  onSetSpeed: (speed: number) => void;
  onExportPng: () => void;
  onExportSvg: () => void;
  onExportJson: () => void;
}

const SPEED_OPTIONS = [0.5, 1, 2, 4, 8, 16];

export const PlaybackControls: React.FC<PlaybackControlsProps> = ({
  state,
  canPlay,
  canPause,
  canResume,
  canReplay,
  canExport,
  hasScript,
  onPlay,
  onPause,
  onResume,
  onReplay,
  onSeek,
  onStep,
  onSetSpeed,
  onExportPng,
  onExportSvg,
  onExportJson,
}) => {
  const { status, currentStrokeIndex, currentStrokeProgress, totalStrokes, progress, speed } =
    state;

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    onSeek(val / 100.0);
  };

  const progressPercent = Math.round(progress * 1000) / 10;
  const displayedStroke =
    totalStrokes === 0
      ? 0
      : progress <= 0 && currentStrokeProgress <= 0
        ? 0
        : Math.min(totalStrokes, currentStrokeIndex + 1);

  return (
    <div className="playback-controls-panel">
      <div className="progress-section">
        <div className="progress-slider-wrapper">
          <input
            type="range"
            min={0}
            max={100}
            step={0.1}
            value={progressPercent}
            onChange={handleSliderChange}
            disabled={totalStrokes === 0}
            className="progress-slider"
            aria-label="笔触绘制进度"
          />
        </div>
        <div className="progress-meta">
          <span className="stroke-counter mono-readout">
            STROKE {displayedStroke.toLocaleString()} / {totalStrokes.toLocaleString()}
          </span>
          <span className="shortcut-hint">Space 播放 · ←/→ 逐笔微调 · R 重播</span>
          <span className="percent-text mono-readout">{Math.round(progress * 100)}%</span>
        </div>
      </div>

      <div className="controls-row">
        <div className="button-group playback-buttons">
          {status === 'playing' ? (
            <button
              type="button"
              className="ctrl-btn btn-pause"
              onClick={onPause}
              disabled={!canPause}
              title="暂停 (Space)"
            >
              <Pause size={16} />
              <span>暂停</span>
            </button>
          ) : status === 'paused' ? (
            <button
              type="button"
              className="ctrl-btn btn-resume"
              onClick={onResume}
              disabled={!canResume}
              title="继续绘制 (Space)"
            >
              <Play size={16} />
              <span>继续</span>
            </button>
          ) : (
            <button
              type="button"
              className="ctrl-btn btn-play"
              onClick={onPlay}
              disabled={!canPlay}
              title="开始逐笔绘制 (Space)"
            >
              <Play size={16} />
              <span>运笔播放</span>
            </button>
          )}

          <div className="step-btn-pair">
            <button
              type="button"
              className="ctrl-btn btn-step"
              disabled={!hasScript || displayedStroke <= 0}
              onClick={() => onStep(-1)}
              title="后退一笔 (←)"
              aria-label="后退一笔"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              className="ctrl-btn btn-step"
              disabled={!hasScript || displayedStroke >= totalStrokes}
              onClick={() => onStep(1)}
              title="前进一笔 (→)"
              aria-label="前进一笔"
            >
              <ChevronRight size={16} />
            </button>
          </div>

          <button
            type="button"
            className="ctrl-btn btn-replay"
            onClick={onReplay}
            disabled={!canReplay}
            title="铺新纸从头重绘 (R)"
          >
            <RotateCcw size={15} />
            <span>重绘</span>
          </button>
        </div>

        <div className="speed-group">
          <FastForward size={15} className="speed-icon" />
          <div className="speed-pills">
            {SPEED_OPTIONS.map((spd) => (
              <button
                key={spd}
                type="button"
                className={`speed-pill ${speed === spd ? 'active' : ''}`}
                onClick={() => onSetSpeed(spd)}
                disabled={totalStrokes === 0}
              >
                {spd}x
              </button>
            ))}
          </div>
        </div>

        <div className="export-group">
          <button
            type="button"
            className="ctrl-btn btn-export"
            onClick={onExportPng}
            disabled={!canExport}
            title="导出当前画布高清位图 (.png)"
          >
            <Download size={15} />
            <span>PNG</span>
          </button>
          <button
            type="button"
            className="ctrl-btn btn-export"
            onClick={onExportSvg}
            disabled={!hasScript}
            title="导出纯矢量分层锥形笔触 (.svg)"
          >
            <FileCode2 size={15} />
            <span>SVG</span>
          </button>
          <button
            type="button"
            className="ctrl-btn btn-export btn-export-subtle"
            onClick={onExportJson}
            disabled={!hasScript}
            title="导出可复现 StrokeScript 笔触数据 (.json)"
          >
            <FileJson size={15} />
            <span>JSON</span>
          </button>
        </div>
      </div>
    </div>
  );
};
