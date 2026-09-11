import React from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  FastForward,
  Download,
} from 'lucide-react';
import type { PlaybackFrameState } from '../types/stroke';

interface PlaybackControlsProps {
  state: PlaybackFrameState;
  canPlay: boolean;
  canPause: boolean;
  canResume: boolean;
  canReplay: boolean;
  canExport: boolean;
  onPlay: () => void;
  onPause: () => void;
  onResume: () => void;
  onReplay: () => void;
  onSeek: (progress: number) => void;
  onSetSpeed: (speed: number) => void;
  onExport: () => void;
}

const SPEED_OPTIONS = [0.5, 1, 2, 4, 8, 16];

export const PlaybackControls: React.FC<PlaybackControlsProps> = ({
  state,
  canPlay,
  canPause,
  canResume,
  canReplay,
  canExport,
  onPlay,
  onPause,
  onResume,
  onReplay,
  onSeek,
  onSetSpeed,
  onExport,
}) => {
  const { status, currentStrokeIndex, totalStrokes, progress, speed } = state;

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    onSeek(val / 100.0);
  };

  const progressPercent = Math.round(progress * 100);

  return (
    <div className="playback-controls-panel">
      {/* Progress Bar & Counter */}
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
          />
        </div>
        <div className="progress-meta">
          <span className="stroke-counter">
            笔触: {totalStrokes > 0 ? `${currentStrokeIndex + 1} / ${totalStrokes}` : '0 / 0'}
          </span>
          <span className="percent-text">{progressPercent}%</span>
        </div>
      </div>

      {/* Buttons and Speed Controls */}
      <div className="controls-row">
        <div className="button-group playback-buttons">
          {status === 'playing' ? (
            <button
              className="ctrl-btn btn-pause"
              onClick={onPause}
              disabled={!canPause}
              title="暂停"
            >
              <Pause size={18} />
              <span>暂停</span>
            </button>
          ) : status === 'paused' ? (
            <button
              className="ctrl-btn btn-resume"
              onClick={onResume}
              disabled={!canResume}
              title="继续"
            >
              <Play size={18} />
              <span>继续</span>
            </button>
          ) : (
            <button
              className="ctrl-btn btn-play"
              onClick={onPlay}
              disabled={!canPlay}
              title="开始逐笔绘制"
            >
              <Play size={18} />
              <span>播放</span>
            </button>
          )}

          <button
            className="ctrl-btn btn-replay"
            onClick={onReplay}
            disabled={!canReplay}
            title="从头重播"
          >
            <RotateCcw size={18} />
            <span>重播</span>
          </button>
        </div>

        {/* Speed Selector */}
        <div className="speed-group">
          <FastForward size={16} className="speed-icon" />
          <div className="speed-pills">
            {SPEED_OPTIONS.map((spd) => (
              <button
                key={spd}
                className={`speed-pill ${speed === spd ? 'active' : ''}`}
                onClick={() => onSetSpeed(spd)}
                disabled={totalStrokes === 0}
              >
                {spd}x
              </button>
            ))}
          </div>
        </div>

        {/* Export PNG */}
        <div className="export-group">
          <button
            className="ctrl-btn btn-export"
            onClick={onExport}
            disabled={!canExport}
            title="导出当前画布为 PNG 图片"
          >
            <Download size={18} />
            <span>导出 PNG</span>
          </button>
        </div>
      </div>
    </div>
  );
};
