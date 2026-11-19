import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Code2, Crosshair, GitCommitHorizontal, Pause, Play, RotateCcw, Route } from 'lucide-react';
import {
  computeZDepthMm,
  formatDurationChinese,
  type PlotterPlan,
  type PlotterStrokeMm,
} from '../lib/plotter/buildPlotterPlan';
import type { PencilGrade, StrokeLayer } from '../types/stroke';

interface PlotterStageProps {
  plan: PlotterPlan;
  onOpenCodePreview: (tab: 'gcode' | 'svg') => void;
}

interface PenReadoutState {
  xMm: number;
  yMm: number;
  isDown: boolean;
  isHome: boolean;
  zMm: number;
  pressure: number;
  strokeIndex: number;
  grade: PencilGrade;
  layer: StrokeLayer;
  gcodeLine: string;
}

const LAYER_LABELS: Record<StrokeLayer, string> = {
  structure: '几何起稿',
  outline: '主体轮廓',
  features: '精细特征',
  lightTone: '浅灰铺调',
  midTone: '中调排线',
  darkTone: '暗部排线',
  finalAccent: '重音点睛',
};

const GRADE_RGB: Record<PencilGrade, string> = {
  '2H': '88, 84, 80',
  HB: '58, 55, 51',
  '2B': '40, 37, 35',
  '4B': '25, 23, 22',
  '6B': '14, 13, 12',
};

const RULER_PAD_PX = 26;
const SIM_DURATION_SEC = 10;

export const PlotterStage: React.FC<PlotterStageProps> = ({ plan, onOpenCodePreview }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [showAirTravel, setShowAirTravel] = useState(true);
  const [showNodes, setShowNodes] = useState(false);
  const [showCrosshair, setShowCrosshair] = useState(true);
  const [stageSize, setStageSize] = useState({ width: 660, height: 540 });

  // Dedicated Plotter Simulation state: defaults to 1.0 (full completed artwork)
  const [simProgress, setSimProgress] = useState(1);
  const [isSimPlaying, setIsSimPlaying] = useState(false);

  // Reset to 100% completed view whenever a new plan (image / preset / tier / paper) loads
  useEffect(() => {
    setIsSimPlaying(false);
    setSimProgress(1);
  }, [plan]);

  // Smooth ~10s robotic arm simulation loop when playing
  useEffect(() => {
    if (!isSimPlaying) return;
    let rafId = 0;
    let lastTs = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(0.08, Math.max(0.001, (now - lastTs) / 1000));
      lastTs = now;
      let finished = false;
      setSimProgress((prev) => {
        const next = prev + dt / SIM_DURATION_SEC;
        if (next >= 1) {
          finished = true;
          return 1;
        }
        return next;
      });
      if (finished) {
        setIsSimPlaying(false);
      } else {
        rafId = requestAnimationFrame(tick);
      }
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isSimPlaying]);

  const handleTogglePlay = () => {
    if (isSimPlaying) {
      setIsSimPlaying(false);
    } else {
      if (simProgress >= 0.999) {
        setSimProgress(0);
      }
      setIsSimPlaying(true);
    }
  };

  const handleReplay = () => {
    setSimProgress(0);
    setIsSimPlaying(true);
  };

  // Observe responsive container width
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const updateSize = () => {
      const w = Math.max(320, Math.floor(el.clientWidth));
      const targetH = Math.max(420, Math.min(580, Math.round(window.innerHeight * 0.6)));
      setStageSize({ width: w, height: targetH });
    };

    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Compute live pen readout synced with simProgress
  const penState = useMemo<PenReadoutState>(() => {
    const { strokes, totalAnimLen, config } = plan;
    if (strokes.length === 0) {
      return {
        xMm: 0,
        yMm: 0,
        isDown: false,
        isHome: true,
        zMm: config.safeLiftMm,
        pressure: 0,
        strokeIndex: 0,
        grade: 'HB',
        layer: 'outline',
        gcodeLine: 'G0 X0.00 Y0.00 ; Empty path',
      };
    }

    if (simProgress >= 0.999) {
      const last = strokes[strokes.length - 1];
      return {
        xMm: 0,
        yMm: 0,
        isDown: false,
        isHome: true,
        zMm: config.safeLiftMm,
        pressure: 0,
        strokeIndex: strokes.length,
        grade: last.grade,
        layer: last.layer,
        gcodeLine:
          config.protocol === 'zaxis'
            ? `G0 Z${config.safeLiftMm.toFixed(2)} -> G0 X0.00 Y0.00 ; 走刀完成回机械原点`
            : 'M5 -> G0 X0.00 Y0.00 ; 写字机抬笔回原点',
      };
    }

    const targetPos = Math.max(0, Math.min(1, simProgress)) * totalAnimLen;

    let lo = 0;
    let hi = strokes.length - 1;
    let activeIdx = strokes.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (strokes[mid].animEnd >= targetPos) {
        activeIdx = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }

    const st = strokes[activeIdx];
    if (targetPos < st.drawAnimStart) {
      const airSpan = Math.max(0.001, st.drawAnimStart - st.airAnimStart);
      const t = Math.max(0, Math.min(1, (targetPos - st.airAnimStart) / airSpan));
      const xMm = st.airFrom.x + (st.points[0].x - st.airFrom.x) * t;
      const yMm = st.airFrom.y + (st.points[0].y - st.airFrom.y) * t;
      const zMm = config.safeLiftMm;
      return {
        xMm,
        yMm,
        isDown: false,
        isHome: false,
        zMm,
        pressure: 0,
        strokeIndex: st.index + 1,
        grade: st.grade,
        layer: st.layer,
        gcodeLine:
          config.protocol === 'zaxis'
            ? `G0 X${xMm.toFixed(2)} Y${yMm.toFixed(2)} Z+${zMm.toFixed(2)} F${Math.round(config.feedRate * 1.6)}`
            : `M5 ; G0 X${xMm.toFixed(2)} Y${yMm.toFixed(2)} (快速空移)`,
      };
    }

    const drawSpan = Math.max(0.001, st.animEnd - st.drawAnimStart);
    const ratio = Math.max(0, Math.min(1, (targetPos - st.drawAnimStart) / drawSpan));
    const sampled = sampleStrokeAtLength(st, ratio * st.lengthMm);
    const zMm =
      config.protocol === 'zaxis'
        ? computeZDepthMm(sampled.pressure, config.maxZDepthMm)
        : -0.5;
    const pwm = Math.round(120 + sampled.pressure * 135);

    return {
      xMm: sampled.x,
      yMm: sampled.y,
      isDown: true,
      isHome: false,
      zMm,
      pressure: sampled.pressure,
      strokeIndex: st.index + 1,
      grade: st.grade,
      layer: st.layer,
      gcodeLine:
        config.protocol === 'zaxis'
          ? `G1 X${sampled.x.toFixed(2)} Y${sampled.y.toFixed(2)} Z${zMm.toFixed(2)} F${config.feedRate}`
          : `M3 S${pwm} ; G1 X${sampled.x.toFixed(2)} Y${sampled.y.toFixed(2)} F${config.feedRate}`,
    };
  }, [plan, simProgress]);

  // Draw millimeter paper canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = stageSize.width;
    const ch = stageSize.height;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Stage background
    ctx.fillStyle = '#151412';
    ctx.fillRect(0, 0, cw, ch);

    const availW = cw - RULER_PAD_PX - 22;
    const availH = ch - RULER_PAD_PX - 18;
    const mmScale = Math.min(availW / plan.paperWidthMm, availH / plan.paperHeightMm);

    const paperPxW = plan.paperWidthMm * mmScale;
    const paperPxH = plan.paperHeightMm * mmScale;
    const paperOriginX = RULER_PAD_PX + (availW - paperPxW) * 0.5;
    const paperOriginY = RULER_PAD_PX + (availH - paperPxH) * 0.5;

    // 1. Physical Millimeter Rulers
    drawMillimeterRulers(
      ctx,
      cw,
      ch,
      paperOriginX,
      paperOriginY,
      plan.paperWidthMm,
      plan.paperHeightMm,
      mmScale
    );

    // 2. Physical Ivory Paper Sheet
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = '#fbf8f1';
    ctx.fillRect(paperOriginX, paperOriginY, paperPxW, paperPxH);
    ctx.restore();

    ctx.strokeStyle = 'rgba(0,0,0,0.16)';
    ctx.lineWidth = 1;
    ctx.strokeRect(paperOriginX, paperOriginY, paperPxW, paperPxH);

    // 3. Magnetic Clamp Safety Margin Box
    const marginPx = plan.config.marginMm * mmScale;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(200, 155, 98, 0.45)';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      paperOriginX + marginPx,
      paperOriginY + marginPx,
      paperPxW - marginPx * 2,
      paperPxH - marginPx * 2
    );
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(155, 110, 57, 0.62)';
    ctx.font = '10px "JetBrains Mono", Consolas, monospace';
    ctx.fillText(
      `SAFE CLAMP MARGIN ${plan.config.marginMm}mm`,
      paperOriginX + marginPx + 6,
      paperOriginY + marginPx + 13
    );
    ctx.restore();

    const toPxX = (mmX: number) => paperOriginX + mmX * mmScale;
    const toPxY = (mmY: number) => paperOriginY + mmY * mmScale;

    const targetPos = Math.max(0, Math.min(1, simProgress)) * plan.totalAnimLen;
    const strokes = plan.strokes;

    // 4. Subtle G0 Air Travel Red Dashed Overlay
    if (showAirTravel && strokes.length > 0) {
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 0.75;
      ctx.strokeStyle = 'rgba(214, 90, 71, 0.13)';
      ctx.beginPath();

      const recentStartIdx = Math.max(0, penState.strokeIndex - 22);
      for (let i = 0; i < strokes.length; i++) {
        const s = strokes[i];
        if (s.airAnimStart > targetPos) break;
        if (i >= recentStartIdx && !penState.isHome) continue;
        const fx = toPxX(s.airFrom.x);
        const fy = toPxY(s.airFrom.y);
        ctx.moveTo(fx, fy);
        ctx.lineTo(toPxX(s.points[0].x), toPxY(s.points[0].y));
      }
      ctx.stroke();

      // Highlight the most recent active G0 travel hops while simulating
      if (!penState.isHome) {
        ctx.strokeStyle = 'rgba(214, 90, 71, 0.48)';
        ctx.lineWidth = 0.95;
        ctx.beginPath();
        for (let i = recentStartIdx; i < strokes.length; i++) {
          const s = strokes[i];
          if (s.airAnimStart > targetPos) break;
          const fx = toPxX(s.airFrom.x);
          const fy = toPxY(s.airFrom.y);
          if (targetPos >= s.drawAnimStart) {
            ctx.moveTo(fx, fy);
            ctx.lineTo(toPxX(s.points[0].x), toPxY(s.points[0].y));
          } else {
            const span = Math.max(0.001, s.drawAnimStart - s.airAnimStart);
            const t = Math.max(0, Math.min(1, (targetPos - s.airAnimStart) / span));
            ctx.moveTo(fx, fy);
            ctx.lineTo(
              fx + (toPxX(s.points[0].x) - fx) * t,
              fy + (toPxY(s.points[0].y) - fy) * t
            );
          }
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    // 5. Authentic Graphite Single-Line Strokes (true opacity, grade tone, width, and turnaround lifts)
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let i = 0; i < strokes.length; i++) {
      const s = strokes[i];
      if (targetPos < s.drawAnimStart) break;

      const rgb = GRADE_RGB[s.grade] ?? '40, 37, 35';
      const alpha = Math.min(0.95, Math.max(0.055, s.brushOpacity * 1.15));
      ctx.strokeStyle = `rgba(${rgb}, ${alpha.toFixed(3)})`;
      ctx.lineWidth = Math.max(0.45, Math.min(2.6, s.brushWidthMm * mmScale * 0.92));

      ctx.beginPath();
      const p0 = s.points[0];
      ctx.moveTo(toPxX(p0.x), toPxY(p0.y));

      if (targetPos >= s.animEnd) {
        for (let k = 1; k < s.points.length; k++) {
          const pt = s.points[k];
          if (pt.isTurnaround) {
            ctx.moveTo(toPxX(pt.x), toPxY(pt.y));
          } else {
            ctx.lineTo(toPxX(pt.x), toPxY(pt.y));
          }
        }
      } else {
        const span = Math.max(0.001, s.animEnd - s.drawAnimStart);
        const targetDist = ((targetPos - s.drawAnimStart) / span) * s.lengthMm;
        let acc = 0;
        for (let k = 1; k < s.points.length; k++) {
          const a = s.points[k - 1];
          const b = s.points[k];
          if (b.isTurnaround) {
            ctx.moveTo(toPxX(b.x), toPxY(b.y));
            continue;
          }
          const seg = Math.hypot(b.x - a.x, b.y - a.y);
          if (acc + seg <= targetDist) {
            ctx.lineTo(toPxX(b.x), toPxY(b.y));
            acc += seg;
          } else {
            const frac = seg > 0 ? Math.max(0, (targetDist - acc) / seg) : 0;
            const ix = a.x + (b.x - a.x) * frac;
            const iy = a.y + (b.y - a.y) * frac;
            ctx.lineTo(toPxX(ix), toPxY(iy));
            break;
          }
        }
      }
      ctx.stroke();

      // Optional subtle entry/zigzag turnaround vertex dots
      if (showNodes) {
        ctx.fillStyle = s.isMergedZigzag
          ? 'rgba(77, 154, 106, 0.52)'
          : 'rgba(200, 155, 98, 0.48)';
        ctx.fillRect(toPxX(p0.x) - 0.8, toPxY(p0.y) - 0.8, 1.6, 1.6);
      }
    }
    ctx.restore();

    // 6. Robotic Pen-Holder Crosshair (parks cleanly at Home (0,0) when finished)
    if (showCrosshair && strokes.length > 0) {
      const px = toPxX(penState.xMm);
      const py = toPxY(penState.yMm);

      ctx.save();
      ctx.strokeStyle = penState.isDown ? '#d65a47' : '#c89b62';
      ctx.lineWidth = 1.25;

      ctx.beginPath();
      ctx.moveTo(px - 10, py);
      ctx.lineTo(px + 10, py);
      ctx.moveTo(px, py - 10);
      ctx.lineTo(px, py + 10);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(px, py, penState.isDown ? 5.5 : 7, 0, Math.PI * 2);
      ctx.fillStyle = penState.isDown ? 'rgba(214, 90, 71, 0.22)' : 'rgba(200, 155, 98, 0.2)';
      ctx.fill();
      ctx.stroke();

      const tagText = penState.isHome
        ? `HOME X0.0 Y0.0 Z+${penState.zMm.toFixed(1)}mm`
        : penState.isDown
          ? `${penState.grade} Z${penState.zMm.toFixed(2)}mm`
          : `G0 抬笔 Z+${penState.zMm.toFixed(1)}mm`;
      ctx.font = 'bold 10px "JetBrains Mono", Consolas, monospace';
      const tw = ctx.measureText(tagText).width + 10;
      const labelX = px + 12 + tw > cw - 8 ? px - tw - 12 : px + 12;
      const labelY = penState.isHome
        ? py + 10
        : py - 24 < RULER_PAD_PX
          ? py + 10
          : py - 22;

      ctx.fillStyle = 'rgba(20, 18, 16, 0.9)';
      ctx.strokeStyle = penState.isDown ? '#d65a47' : '#c89b62';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(labelX, labelY, tw, 17, 4);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#f3efe6';
      ctx.fillText(tagText, labelX + 5, labelY + 12);
      ctx.restore();
    }
  }, [penState, plan, showAirTravel, showCrosshair, showNodes, simProgress, stageSize]);

  const { telemetry } = plan;
  const totalDistMeters = (telemetry.drawMm / 1000).toFixed(2);
  const travelDistMeters = (telemetry.travelMm / 1000).toFixed(2);
  const effRatio = Math.round(
    (telemetry.drawMm / Math.max(1, telemetry.drawMm + telemetry.travelMm)) * 100
  );
  const pressurePct = Math.round(penState.pressure * 100);
  const simPct = Math.round(simProgress * 100);

  return (
    <div className="plotter-stage-container">
      <div className="plotter-subtoolbar">
        <div className="plotter-spec-pills">
          <span className="plotter-spec-badge">
            {plan.paperLabel} · {plan.paperWidthMm} × {plan.paperHeightMm} mm
          </span>
          <span className="plotter-compression-badge">
            单线中心线矢量化 · 已省去 {telemetry.savedLiftPct}% 抬笔
          </span>
        </div>

        <div className="plotter-sim-controls">
          <button
            type="button"
            className={`plotter-sim-btn ${isSimPlaying ? 'playing' : ''}`}
            onClick={handleTogglePlay}
          >
            {isSimPlaying ? <Pause size={12} /> : <Play size={12} />}
            <span>{isSimPlaying ? '暂停走刀' : simProgress >= 0.999 ? '播放走刀仿真' : '继续仿真'}</span>
          </button>
          <button
            type="button"
            className="plotter-sim-icon-btn"
            onClick={handleReplay}
            title="从 0% 重新演练机械臂走刀"
          >
            <RotateCcw size={12} />
          </button>
          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round(simProgress * 1000)}
            onChange={(e) => {
              setIsSimPlaying(false);
              setSimProgress(Number(e.target.value) / 1000);
            }}
            className="plotter-sim-slider"
            aria-label="走刀仿真进度"
          />
          <span className="plotter-sim-pct mono-readout">{simPct}%</span>
        </div>

        <div className="plotter-overlay-toggles">
          <button
            type="button"
            className={`plotter-toggle-chip ${showAirTravel ? 'active' : ''}`}
            onClick={() => setShowAirTravel((v) => !v)}
            title="显示或隐藏机器空移（不落笔）轨迹"
          >
            <Route size={12} />
            <span>空程红线 (G0)</span>
          </button>
          <button
            type="button"
            className={`plotter-toggle-chip ${showNodes ? 'active' : ''}`}
            onClick={() => setShowNodes((v) => !v)}
            title="绿色为连笔往复折点，金色为起落笔点"
          >
            <GitCommitHorizontal size={12} />
            <span>连笔折点</span>
          </button>
          <button
            type="button"
            className={`plotter-toggle-chip ${showCrosshair ? 'active' : ''}`}
            onClick={() => setShowCrosshair((v) => !v)}
            title="显示机械臂实时笔头准星与 Z 轴深度"
          >
            <Crosshair size={12} />
            <span>笔头准星</span>
          </button>
        </div>
      </div>

      <div className="plotter-canvas-box" ref={containerRef}>
        <canvas ref={canvasRef} className="plotter-canvas" />
      </div>

      <div className="plotter-telemetry-grid">
        <div className="plotter-tele-card">
          <div className="tele-label">⏱️ 预计真机耗时</div>
          <div className="tele-val accent">{formatDurationChinese(telemetry.totalSec)}</div>
          <div className="tele-sub">
            落笔 {formatDurationChinese(telemetry.drawSec)} · 空移 {Math.round(telemetry.travelSec)}s
          </div>
        </div>

        <div className="plotter-tele-card">
          <div className="tele-label">↕️ 抬落笔次数 (Lifts)</div>
          <div className="tele-val">
            {telemetry.penLifts.toLocaleString()} 次
            <span className="tele-pill-good">-{telemetry.savedLiftPct}%</span>
          </div>
          <div className="tele-sub">
            原画稿 {telemetry.originalStrokes.toLocaleString()} 笔 → 连笔融合
          </div>
        </div>

        <div className="plotter-tele-card">
          <div className="tele-label">📏 物理笔芯行程</div>
          <div className="tele-val">{totalDistMeters} m</div>
          <div className="tele-sub">
            空移 {travelDistMeters} m · 落笔占比 {effRatio}%
          </div>
        </div>

        <div className="plotter-tele-card">
          <div className="tele-label">⏬ 实时 Z 轴压感</div>
          <div className="tele-val mono-readout">
            Z {penState.zMm >= 0 ? '+' : ''}
            {penState.zMm.toFixed(2)} mm
          </div>
          <div className="tele-pressure-bar">
            <div className="tele-pressure-fill" style={{ width: `${pressurePct}%` }} />
          </div>
          <div className="tele-sub">
            {penState.isHome
              ? '全稿完成 · 笔头已回机械原点 (0,0)'
              : penState.isDown
                ? `[${penState.grade}] ${LAYER_LABELS[penState.layer]} · 压感 ${pressurePct}%`
                : 'G0 安全抬笔快速移动中'}
          </div>
        </div>
      </div>

      <div className="plotter-gcode-ticker">
        <span className="ticker-badge">LIVE G-CODE</span>
        <span className="ticker-cmd mono-readout">{penState.gcodeLine}</span>
        <span className="ticker-count mono-readout">
          Stroke {penState.strokeIndex} / {plan.strokes.length}
        </span>
        <button
          type="button"
          className="ticker-preview-btn"
          onClick={() => onOpenCodePreview('gcode')}
        >
          <Code2 size={13} />
          <span>查看源码</span>
        </button>
      </div>
    </div>
  );
};

function sampleStrokeAtLength(
  stroke: PlotterStrokeMm,
  targetDistMm: number
): { x: number; y: number; pressure: number } {
  const pts = stroke.points;
  if (pts.length === 0) return { x: 0, y: 0, pressure: 0.5 };
  if (targetDistMm <= 0) return pts[0];

  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (b.isTurnaround) continue;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (acc + seg >= targetDistMm && seg > 0) {
      const t = (targetDistMm - acc) / seg;
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        pressure: a.pressure + (b.pressure - a.pressure) * t,
      };
    }
    acc += seg;
  }
  return pts[pts.length - 1];
}

function drawMillimeterRulers(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  originX: number,
  originY: number,
  paperW: number,
  paperH: number,
  mmScale: number
): void {
  ctx.save();
  ctx.fillStyle = '#1b1a17';
  ctx.fillRect(0, 0, cw, RULER_PAD_PX);
  ctx.fillRect(0, 0, RULER_PAD_PX, ch);

  ctx.fillStyle = '#9c9384';
  ctx.strokeStyle = 'rgba(156, 147, 132, 0.38)';
  ctx.lineWidth = 1;
  ctx.font = '9px "JetBrains Mono", Consolas, monospace';

  const stepX = paperW >= 250 ? 25 : 20;
  for (let mm = 0; mm <= paperW; mm += 10) {
    const x = originX + mm * mmScale;
    const isMajor = mm % stepX === 0 || mm === 0;
    ctx.beginPath();
    ctx.moveTo(x, RULER_PAD_PX);
    ctx.lineTo(x, RULER_PAD_PX - (isMajor ? 8 : 4));
    ctx.stroke();
    if (isMajor) {
      ctx.fillText(String(mm), x + 2, 13);
    }
  }

  const stepY = paperH >= 250 ? 25 : 20;
  for (let mm = 0; mm <= paperH; mm += 10) {
    const y = originY + mm * mmScale;
    const isMajor = mm % stepY === 0 || mm === 0;
    ctx.beginPath();
    ctx.moveTo(RULER_PAD_PX, y);
    ctx.lineTo(RULER_PAD_PX - (isMajor ? 8 : 4), y);
    ctx.stroke();
    if (isMajor) {
      ctx.fillText(String(mm), 3, y + 3);
    }
  }

  ctx.fillStyle = '#c89b62';
  ctx.fillText('mm', 4, 13);
  ctx.restore();
}
