import React, { useCallback, useEffect, useState } from 'react';
import { Columns2, Eye, Pencil, ScanSearch } from 'lucide-react';
import { GenerationStatus } from '../components/GenerationStatus';
import { ImageUploader } from '../components/ImageUploader';
import { LayerInspector } from '../components/LayerInspector';
import { ParameterPanel } from '../components/ParameterPanel';
import { PlaybackControls } from '../components/PlaybackControls';
import { SketchCanvas } from '../components/SketchCanvas';
import { TargetSketchPreview } from '../components/TargetSketchPreview';
import { useSketchPlayback } from '../hooks/useSketchPlayback';
import { DEFAULT_OPTIONS, useStrokeGeneration } from '../hooks/useStrokeGeneration';
import type { SketchCanvasEngine } from '../lib/canvas/SketchCanvasEngine';
import { exportScriptToJson, exportScriptToSvg } from '../lib/export/exportSketch';
import type { StrokeGenerationOptions } from '../types/image-processing';
import type { StrokeLayer } from '../types/stroke';

type CanvasViewMode = 'drawing' | 'compare' | 'target' | 'source';

export const SketchMvpPage: React.FC = () => {
  const [engine, setEngine] = useState<SketchCanvasEngine | null>(null);
  const [canvasDimensions, setCanvasDimensions] = useState({ width: 680, height: 680 });
  const [viewMode, setViewMode] = useState<CanvasViewMode>('drawing');
  const [options, setOptions] = useState<StrokeGenerationOptions>(DEFAULT_OPTIONS);
  const [seedLocked, setSeedLocked] = useState(false);
  const [hiddenLayers, setHiddenLayers] = useState<Set<StrokeLayer>>(new Set());
  const [exportFeedback, setExportFeedback] = useState<string | null>(null);

  const {
    state: genState,
    sourcePreviewUrl,
    sourceMeta,
    hasLoadedSource,
    generateFromFile,
    regenerateWithOptions,
    cancel,
    reset,
  } = useStrokeGeneration();

  const {
    state: playbackState,
    play,
    pause,
    resume,
    replay,
    seek,
    stepStrokes,
    seekToLayerEnd,
    setSpeed,
    exportPng,
  } = useSketchPlayback(engine, genState.script || null);

  const handleEngineReady = useCallback((newEngine: SketchCanvasEngine) => {
    setEngine(newEngine);
  }, []);

  const showNotice = useCallback((msg: string) => {
    setExportFeedback(msg);
    window.setTimeout(() => {
      setExportFeedback((prev) => (prev === msg ? null : prev));
    }, 3200);
  }, []);

  // Auto-start authentic stroke-by-stroke drawing once a new script finishes generating
  useEffect(() => {
    if (genState.status === 'ready' && genState.script && engine) {
      const timer = window.setTimeout(() => {
        play();
      }, 60);
      return () => window.clearTimeout(timer);
    }
  }, [genState.status, genState.script, engine, play]);

  const effectiveOptionsForRun = useCallback(
    (base: StrokeGenerationOptions): StrokeGenerationOptions => {
      if (seedLocked && base.seed !== undefined) {
        return base;
      }
      const nextSeed = Math.floor(Math.random() * 1000000);
      return { ...base, seed: nextSeed };
    },
    [seedLocked]
  );

  const handleFileSelect = useCallback(
    async (file: File) => {
      try {
        reset();
        setHiddenLayers(new Set());
        engine?.setHiddenLayers(new Set());
        const runOpts = effectiveOptionsForRun(options);
        const script = await generateFromFile(file, runOpts);
        setOptions((prev) => ({ ...prev, seed: script.generation.seed }));
        setCanvasDimensions({
          width: script.canvas.width,
          height: script.canvas.height,
        });
      } catch (err) {
        console.error('[SketchStudio] Generation failed:', err);
      }
    },
    [effectiveOptionsForRun, engine, generateFromFile, options, reset]
  );

  const handleRegenerate = useCallback(async () => {
    if (!hasLoadedSource) return;
    try {
      setHiddenLayers(new Set());
      engine?.setHiddenLayers(new Set());
      const runOpts = effectiveOptionsForRun(options);
      const script = await regenerateWithOptions(runOpts);
      if (script) {
        setOptions((prev) => ({ ...prev, seed: script.generation.seed }));
        setCanvasDimensions({
          width: script.canvas.width,
          height: script.canvas.height,
        });
      }
    } catch (err) {
      console.error('[SketchStudio] Regeneration failed:', err);
    }
  }, [effectiveOptionsForRun, engine, hasLoadedSource, options, regenerateWithOptions]);

  const handleOptionChange = useCallback((patch: Partial<StrokeGenerationOptions>) => {
    setOptions((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleToggleSeedLock = useCallback(() => {
    setSeedLocked((prev) => {
      const next = !prev;
      if (next && options.seed === undefined) {
        setOptions((o) => ({ ...o, seed: genState.script?.generation.seed ?? 12345 }));
      }
      return next;
    });
  }, [genState.script?.generation.seed, options.seed]);

  const handleRandomizeSeed = useCallback(() => {
    const freshSeed = Math.floor(Math.random() * 1000000);
    setOptions((prev) => ({ ...prev, seed: freshSeed }));
  }, []);

  const handleToggleLayer = useCallback(
    (layer: StrokeLayer) => {
      setHiddenLayers((prev) => {
        const next = new Set(prev);
        if (next.has(layer)) next.delete(layer);
        else next.add(layer);
        engine?.setHiddenLayers(next);
        return next;
      });
    },
    [engine]
  );

  const handleResetVisibility = useCallback(() => {
    const empty = new Set<StrokeLayer>();
    setHiddenLayers(empty);
    engine?.setHiddenLayers(empty);
  }, [engine]);

  // Keyboard shortcuts for studio workflow
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (!genState.script || genState.script.strokes.length === 0) return;

      if (event.code === 'Space') {
        event.preventDefault();
        if (playbackState.status === 'playing') pause();
        else if (playbackState.status === 'paused') resume();
        else play();
      } else if (event.code === 'ArrowLeft') {
        event.preventDefault();
        stepStrokes(event.shiftKey ? -25 : -1);
      } else if (event.code === 'ArrowRight') {
        event.preventDefault();
        stepStrokes(event.shiftKey ? 25 : 1);
      } else if (event.code === 'KeyR' && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        replay();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [genState.script, pause, play, playbackState.status, replay, resume, stepStrokes]);

  const handleExportPng = useCallback(async () => {
    try {
      const dataUrl = exportPng();
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      triggerBlobDownload(blob, `atelier-sketch-${formatTimestamp()}.png`);
      showNotice('已导出高清 PNG 画布');
    } catch (err) {
      showNotice('导出 PNG 失败：' + (err instanceof Error ? err.message : String(err)));
    }
  }, [exportPng, showNotice]);

  const handleExportSvg = useCallback(() => {
    if (!genState.script) return;
    try {
      const upTo =
        playbackState.progress <= 0 && playbackState.currentStrokeProgress <= 0
          ? -1
          : playbackState.currentStrokeIndex;
      const svgContent = exportScriptToSvg(genState.script, {
        upToStrokeIndex: upTo >= 0 ? upTo : genState.script.strokes.length - 1,
        hiddenLayers,
      });
      const blob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
      triggerBlobDownload(blob, `atelier-sketch-${formatTimestamp()}.svg`);
      showNotice('已导出分层矢量 SVG');
    } catch (err) {
      showNotice('导出 SVG 失败：' + (err instanceof Error ? err.message : String(err)));
    }
  }, [
    genState.script,
    hiddenLayers,
    playbackState.currentStrokeIndex,
    playbackState.currentStrokeProgress,
    playbackState.progress,
    showNotice,
  ]);

  const handleExportJson = useCallback(() => {
    if (!genState.script) return;
    try {
      const jsonContent = exportScriptToJson(genState.script);
      const blob = new Blob([jsonContent], { type: 'application/json;charset=utf-8' });
      triggerBlobDownload(blob, `stroke-script-${genState.script.generation.seed}.json`);
      showNotice('已导出可复现笔触 JSON');
    } catch (err) {
      showNotice('导出 JSON 失败：' + (err instanceof Error ? err.message : String(err)));
    }
  }, [genState.script, showNotice]);

  const isBusy = genState.status === 'loading' || genState.status === 'generating';
  const isScriptReady = !!genState.script && genState.script.strokes.length > 0;
  const canPlay = isScriptReady && playbackState.status !== 'playing';
  const canPause = playbackState.status === 'playing';
  const canResume = playbackState.status === 'paused';
  const canReplay = isScriptReady;
  const canExport = !!engine && isScriptReady;

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-brand">
          <div className="logo-mark" aria-hidden="true">
            <Pencil size={18} />
          </div>
          <div className="brand-text">
            <h1>Atelier Graphite</h1>
            <span className="version-tag">ETF · FDoG · 分级铅笔逐笔重构工坊</span>
          </div>
        </div>

        <div className="header-right">
          {exportFeedback && (
            <div className="studio-toast" role="status">
              {exportFeedback}
            </div>
          )}
          <div className="header-spec-chip">
            <span>纯笔触矢量重构 · 零蒙版渐显 · Canvas / SVG 双引擎</span>
          </div>
        </div>
      </header>

      <main className="app-workspace">
        <div className="workspace-canvas-panel">
          <div className="canvas-top-bar">
            <div className="canvas-view-toolbar" role="tablist" aria-label="画架视图切换">
              <button
                className={`view-mode-button ${viewMode === 'drawing' ? 'active' : ''}`}
                onClick={() => setViewMode('drawing')}
                type="button"
              >
                <Pencil size={14} />
                <span>逐笔画架</span>
              </button>
              <button
                className={`view-mode-button ${viewMode === 'compare' ? 'active' : ''}`}
                onClick={() => setViewMode('compare')}
                type="button"
                disabled={!sourcePreviewUrl && !genState.script?.targetPreview}
              >
                <Columns2 size={14} />
                <span>原图并排对照</span>
              </button>
              <button
                className={`view-mode-button ${viewMode === 'source' ? 'active' : ''}`}
                onClick={() => setViewMode('source')}
                type="button"
                disabled={!sourcePreviewUrl}
              >
                <Eye size={14} />
                <span>原图观察</span>
              </button>
              <button
                className={`view-mode-button ${viewMode === 'target' ? 'active' : ''}`}
                onClick={() => setViewMode('target')}
                type="button"
                disabled={!genState.script?.targetPreview}
              >
                <ScanSearch size={14} />
                <span>算法目标场 (诊断)</span>
              </button>
            </div>

            {sourceMeta && (
              <div className="source-Summary-pill mono-readout">
                {sourceMeta.fileName} · {sourceMeta.width}×{sourceMeta.height}
              </div>
            )}
          </div>

          <div className="canvas-container-outer">
            <div className={`comparison-stage mode-${viewMode}`}>
              {viewMode === 'compare' && (
                <section className="comparison-pane reference-pane">
                  <div className="comparison-label">
                    <span>原始照片参照</span>
                    <small>输入源图像</small>
                  </div>
                  <div className="canvas-wrapper">
                    <div className="canvas-easel-frame">
                      {sourcePreviewUrl ? (
                        <img
                          src={sourcePreviewUrl}
                          alt="上传的原始参考图"
                          className="sketch-canvas source-reference-img"
                        />
                      ) : (
                        <TargetSketchPreview preview={genState.script?.targetPreview} />
                      )}
                    </div>
                  </div>
                </section>
              )}

              {viewMode === 'source' && sourcePreviewUrl && (
                <section className="comparison-pane reference-pane">
                  <div className="comparison-label">
                    <span>原始照片参照</span>
                    <small>
                      {sourceMeta ? `${sourceMeta.width} × ${sourceMeta.height} px` : ''}
                    </small>
                  </div>
                  <div className="canvas-wrapper">
                    <div className="canvas-easel-frame">
                      <img
                        src={sourcePreviewUrl}
                        alt="上传的原始参考图"
                        className="sketch-canvas source-reference-img"
                      />
                    </div>
                  </div>
                </section>
              )}

              {viewMode === 'target' && (
                <section className="comparison-pane target-pane">
                  <div className="comparison-label">
                    <span>FDoG + 三峰色调目标场</span>
                    <small>仅供算法残差规划参考，不参与画布绘制</small>
                  </div>
                  <TargetSketchPreview preview={genState.script?.targetPreview} />
                </section>
              )}

              <section
                className={`comparison-pane drawing-pane ${
                  viewMode === 'target' || viewMode === 'source' ? 'is-hidden' : ''
                }`}
              >
                <div className="comparison-label">
                  <span>真实石墨逐笔重构画布</span>
                  <small className="mono-readout">
                    {Math.round(playbackState.progress * 100)}% · 100% 独立笔触生成
                  </small>
                </div>
                <SketchCanvas
                  width={canvasDimensions.width}
                  height={canvasDimensions.height}
                  onEngineReady={handleEngineReady}
                />
              </section>
            </div>
          </div>

          <div className="workspace-controls-bar">
            <PlaybackControls
              state={playbackState}
              canPlay={canPlay}
              canPause={canPause}
              canResume={canResume}
              canReplay={canReplay}
              canExport={canExport}
              hasScript={isScriptReady}
              onPlay={play}
              onPause={pause}
              onResume={resume}
              onReplay={replay}
              onSeek={seek}
              onStep={stepStrokes}
              onSetSpeed={setSpeed}
              onExportPng={handleExportPng}
              onExportSvg={handleExportSvg}
              onExportJson={handleExportJson}
            />
          </div>
        </div>

        <aside className="workspace-sidebar">
          <div className="sidebar-card">
            <div className="card-title-row">
              <h2 className="card-title">画稿源输入</h2>
              {isBusy && (
                <button type="button" className="btn-cancel-generation" onClick={cancel}>
                  中止解算
                </button>
              )}
            </div>
            <ImageUploader onFileSelect={handleFileSelect} disabled={isBusy} />
          </div>

          <div className="sidebar-card">
            <GenerationStatus state={genState} />
          </div>

          <div className="sidebar-card">
            <ParameterPanel
              options={options}
              seedLocked={seedLocked}
              canRegenerate={hasLoadedSource}
              isBusy={isBusy}
              onChange={handleOptionChange}
              onToggleSeedLock={handleToggleSeedLock}
              onRandomizeSeed={handleRandomizeSeed}
              onRegenerate={handleRegenerate}
            />
          </div>

          <div className="sidebar-card">
            <LayerInspector
              metrics={genState.script?.generation.layerMetrics}
              totalStrokes={genState.script?.strokes.length ?? 0}
              activeLayer={playbackState.activeLayer}
              hiddenLayers={hiddenLayers}
              onToggleLayer={handleToggleLayer}
              onJumpToLayer={seekToLayerEnd}
              onResetVisibility={handleResetVisibility}
            />
          </div>
        </aside>
      </main>
    </div>
  );
};

function triggerBlobDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = filename;
  link.href = objectUrl;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
}

function formatTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
