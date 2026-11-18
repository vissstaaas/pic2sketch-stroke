import React from 'react';
import { Eye, EyeOff, Layers } from 'lucide-react';
import type { PencilGrade, StrokeLayer, StrokeLayerMetrics } from '../types/stroke';

interface LayerInspectorProps {
  metrics?: StrokeLayerMetrics;
  totalStrokes: number;
  activeLayer?: StrokeLayer;
  hiddenLayers: ReadonlySet<StrokeLayer>;
  onToggleLayer: (layer: StrokeLayer) => void;
  onJumpToLayer: (layer: StrokeLayer) => void;
  onResetVisibility: () => void;
}

interface LayerSpec {
  layer: StrokeLayer;
  grade: PencilGrade;
  title: string;
  desc: string;
  swatch: string;
}

const LAYER_SPECS: LayerSpec[] = [
  {
    layer: 'structure',
    grade: '2H',
    title: '几何起稿',
    desc: '长直线定大比例与外势',
    swatch: '#8f8b84',
  },
  {
    layer: 'outline',
    grade: 'HB',
    title: '主体轮廓',
    desc: 'FDoG 单脊线勾勒清晰边界',
    swatch: '#6b6660',
  },
  {
    layer: 'features',
    grade: '2B',
    title: '精细特征',
    desc: '五官、衣领与高曲率转折',
    swatch: '#4e4944',
  },
  {
    layer: 'lightTone',
    grade: 'HB',
    title: '浅灰铺调',
    desc: '顺流场宽笔触建立柔和灰面',
    swatch: '#c89b62',
  },
  {
    layer: 'midTone',
    grade: '2B',
    title: '中调塑形',
    desc: '+33° 交叉排线塑造立体转折',
    swatch: '#a67946',
  },
  {
    layer: 'darkTone',
    grade: '4B',
    title: '暗部排线',
    desc: '-26° 二次交叉加密明暗交界',
    swatch: '#6e4e2e',
  },
  {
    layer: 'finalAccent',
    grade: '6B',
    title: '重音点睛',
    desc: '浓黑炭精压实瞳孔与深缝',
    swatch: '#2c231c',
  },
];

export const LayerInspector: React.FC<LayerInspectorProps> = ({
  metrics,
  totalStrokes,
  activeLayer,
  hiddenLayers,
  onToggleLayer,
  onJumpToLayer,
  onResetVisibility,
}) => {
  const hasHidden = hiddenLayers.size > 0;

  return (
    <div className="layer-inspector">
      <div className="inspector-header">
        <div className="inspector-title-group">
          <Layers size={14} />
          <span>学院派七层解剖</span>
        </div>
        {hasHidden && (
          <button type="button" className="link-reset-btn" onClick={onResetVisibility}>
            显示全部
          </button>
        )}
      </div>

      <div className="layer-rows">
        {LAYER_SPECS.map((spec) => {
          const count = metrics ? metrics[spec.layer] : 0;
          const share = totalStrokes > 0 ? Math.min(100, (count / totalStrokes) * 100) : 0;
          const isHidden = hiddenLayers.has(spec.layer);
          const isActive = activeLayer === spec.layer;

          return (
            <div
              key={spec.layer}
              className={`layer-row ${isActive ? 'is-active' : ''} ${isHidden ? 'is-muted' : ''}`}
            >
              <button
                type="button"
                className="layer-jump-area"
                disabled={count === 0}
                onClick={() => onJumpToLayer(spec.layer)}
                title={count > 0 ? `点击跳至「${spec.title}」完成处` : spec.desc}
              >
                <span className="grade-badge">{spec.grade}</span>
                <div className="layer-info">
                  <div className="layer-info-top">
                    <span className="layer-name">{spec.title}</span>
                    <span className="mono-readout layer-count">
                      {totalStrokes > 0 ? count : '—'}
                    </span>
                  </div>
                  {totalStrokes > 0 ? (
                    <div className="layer-bar-track">
                      <div
                        className="layer-bar-fill"
                        style={{
                          width: `${Math.max(count > 0 ? 3 : 0, share)}%`,
                          backgroundColor: spec.swatch,
                        }}
                      />
                    </div>
                  ) : (
                    <span className="layer-desc-hint">{spec.desc}</span>
                  )}
                </div>
              </button>

              <button
                type="button"
                className="layer-eye-btn"
                disabled={totalStrokes === 0}
                onClick={() => onToggleLayer(spec.layer)}
                title={isHidden ? `显示${spec.title}层` : `隐藏${spec.title}层`}
                aria-label={isHidden ? `显示${spec.title}层` : `隐藏${spec.title}层`}
              >
                {isHidden ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};
