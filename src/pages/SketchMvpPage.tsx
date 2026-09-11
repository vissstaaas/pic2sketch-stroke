import React, { useCallback, useState } from 'react';
import { Columns2, Image as ImageIcon, Info, Pencil } from 'lucide-react';
import { ImageUploader } from '../components/ImageUploader';
import { SketchCanvas } from '../components/SketchCanvas';
import { PlaybackControls } from '../components/PlaybackControls';
import { GenerationStatus } from '../components/GenerationStatus';
import { TargetSketchPreview } from '../components/TargetSketchPreview';
import { useStrokeGeneration } from '../hooks/useStrokeGeneration';
import { useSketchPlayback } from '../hooks/useSketchPlayback';
import type { SketchCanvasEngine } from '../lib/canvas/SketchCanvasEngine';
import type { UploadImageMeta } from '../types/image-processing';

type CanvasViewMode = 'drawing' | 'target' | 'compare';

export const SketchMvpPage: React.FC = () => {
  const [engine, setEngine] = useState<SketchCanvasEngine | null>(null);
  const [canvasDimensions, setCanvasDimensions] = useState({ width: 680, height: 680 });
  const [uploadedMeta, setUploadedMeta] = useState<UploadImageMeta | null>(null);
  const [viewMode, setViewMode] = useState<CanvasViewMode>('drawing');

  const { state: genState, generateFromFile, cancel, reset } = useStrokeGeneration();
  const {
    state: playbackState,
    play,
    pause,
    resume,
    replay,
    seek,
    setSpeed,
    exportPng,
  } = useSketchPlayback(engine, genState.script || null);

  const handleEngineReady = useCallback((newEngine: SketchCanvasEngine) => {
    setEngine(newEngine);
  }, []);

  const handleFileSelect = useCallback(
    async (file: File) => {
      try {
        reset();
        setViewMode('drawing');
        const script = await generateFromFile(file);
        setUploadedMeta({
          fileName: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          width: script.sourceImage.width,
          height: script.sourceImage.height,
        });
        setCanvasDimensions({
          width: script.canvas.width,
          height: script.canvas.height,
        });
        if (script.targetPreview) setViewMode('compare');
      } catch (err) {
        console.error('Stroke generation failed:', err);
      }
    },
    [generateFromFile, reset]
  );

  const handleExport = useCallback(async () => {
    try {
      const dataUrl = exportPng();
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      link.download = `pencil-sketch-${timestamp}.png`;
      link.href = objectUrl;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (err) {
      console.error('Export PNG failed:', err);
      alert('导出 PNG 失败：' + (err instanceof Error ? err.message : String(err)));
    }
  }, [exportPng]);

  const isScriptReady = !!genState.script && genState.script.strokes.length > 0;
  const canPlay = isScriptReady && playbackState.status !== 'playing';
  const canPause = playbackState.status === 'playing';
  const canResume = playbackState.status === 'paused';
  const canReplay = isScriptReady;
  const canExport = !!engine;

  return (
    <div className="app-container">
      {/* Top Navigation Bar */}
      <header className="app-header">
        <div className="header-brand">
          <div className="logo-icon">
            <Pencil size={22} />
          </div>
          <div className="brand-text">
            <h1>Pencil Sketch Studio</h1>
            <span className="version-tag">MVP · 逐笔绘制引擎</span>
          </div>
        </div>
        <div className="header-tips">
          <Info size={15} />
          <span>传统图像处理 · 真实笔触重建 · 无蒙版渐显</span>
        </div>
      </header>

      {/* Main Workspace */}
      <main className="app-workspace">
        {/* Left / Center: Drawing Board Viewport */}
        <div className="workspace-canvas-panel">
          <div className="canvas-view-toolbar" aria-label="画布显示模式">
            <button
              className={`view-mode-button ${viewMode === 'drawing' ? 'active' : ''}`}
              onClick={() => setViewMode('drawing')}
              type="button"
            >
              <Pencil size={15} />
              逐笔画布
            </button>
            <button
              className={`view-mode-button ${viewMode === 'target' ? 'active' : ''}`}
              onClick={() => setViewMode('target')}
              type="button"
              disabled={!genState.script?.targetPreview}
            >
              <ImageIcon size={15} />
              生成目标图
            </button>
            <button
              className={`view-mode-button ${viewMode === 'compare' ? 'active' : ''}`}
              onClick={() => setViewMode('compare')}
              type="button"
              disabled={!genState.script?.targetPreview}
            >
              <Columns2 size={15} />
              并排对比
            </button>
          </div>
          <div className="canvas-container-outer">
            <div className={`comparison-stage mode-${viewMode}`}>
              <section className={`comparison-pane target-pane ${viewMode === 'drawing' ? 'is-hidden' : ''}`}>
                <div className="comparison-label">
                  <span>生成目标图</span>
                  <small>传统算法生成，未拆成笔触</small>
                </div>
                <TargetSketchPreview preview={genState.script?.targetPreview} />
              </section>
              <section className={`comparison-pane drawing-pane ${viewMode === 'target' ? 'is-hidden' : ''}`}>
                <div className="comparison-label">
                  <span>逐笔绘制结果</span>
                  <small>{Math.round(playbackState.progress * 100)}% · 仅由笔触组成</small>
                </div>
                <SketchCanvas
                  width={canvasDimensions.width}
                  height={canvasDimensions.height}
                  onEngineReady={handleEngineReady}
                />
              </section>
            </div>
          </div>

          {/* Bottom Floating Playback Controls Bar */}
          <div className="workspace-controls-bar">
            <PlaybackControls
              state={playbackState}
              canPlay={canPlay}
              canPause={canPause}
              canResume={canResume}
              canReplay={canReplay}
              canExport={canExport}
              onPlay={play}
              onPause={pause}
              onResume={resume}
              onReplay={replay}
              onSeek={seek}
              onSetSpeed={setSpeed}
              onExport={handleExport}
            />
          </div>
        </div>

        {/* Right: Sidebar with Upload and Generation Inspector */}
        <aside className="workspace-sidebar">
          <div className="sidebar-card">
            <h2 className="card-title">图片输入</h2>
            <ImageUploader
              onFileSelect={handleFileSelect}
              disabled={genState.status === 'generating'}
            />
          </div>

          <div className="sidebar-card">
            <div className="card-title-row">
              <h2 className="card-title">笔触生成状态</h2>
              {genState.status === 'generating' && (
                <button className="btn-cancel-generation" onClick={cancel}>
                  取消
                </button>
              )}
            </div>
            <GenerationStatus state={genState} />
          </div>

          {uploadedMeta && (
            <div className="sidebar-card">
              <h2 className="card-title">原图参数</h2>
              <div className="meta-list">
                <div className="meta-row">
                  <span className="k">文件名</span>
                  <span className="v" title={uploadedMeta.fileName}>{uploadedMeta.fileName}</span>
                </div>
                <div className="meta-row">
                  <span className="k">分辨率</span>
                  <span className="v">{uploadedMeta.width} × {uploadedMeta.height} px</span>
                </div>
                <div className="meta-row">
                  <span className="k">文件大小</span>
                  <span className="v">{(uploadedMeta.sizeBytes / 1024).toFixed(1)} KB</span>
                </div>
              </div>
            </div>
          )}

          <div className="sidebar-card tips-card">
            <h2 className="card-title">素描绘制层次规范</h2>
            <ol className="drawing-layers-list">
              <li><span className="layer-dot layer-1" /> <strong>生成目标</strong>：灰度、反相、模糊与颜色减淡</li>
              <li><span className="layer-dot layer-2" /> <strong>主体轮廓</strong>：保护外缘、五官与衣褶细节</li>
              <li><span className="layer-dot layer-3" /> <strong>浅层调子</strong>：用宽笔触建立整体明暗关系</li>
              <li><span className="layer-dot layer-4" /> <strong>残差补笔</strong>：逐层填补目标图与画布的差异</li>
              <li><span className="layer-dot layer-5" /> <strong>重音强调</strong>：用细笔压深瞳孔、发丝与深影</li>
            </ol>
          </div>
        </aside>
      </main>
    </div>
  );
};
