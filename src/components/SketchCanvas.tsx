import React, { useEffect, useRef } from 'react';
import { SketchCanvasEngine } from '../lib/canvas/SketchCanvasEngine';
import { PAPER_BACKGROUND } from '../lib/strokes/reconstructSketchScript';

interface SketchCanvasProps {
  width: number;
  height: number;
  onEngineReady: (engine: SketchCanvasEngine) => void;
}

export const SketchCanvas: React.FC<SketchCanvasProps> = ({
  width,
  height,
  onEngineReady,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<SketchCanvasEngine | null>(null);
  const initialSizeRef = useRef({ width, height });

  useEffect(() => {
    if (!canvasRef.current) return;

    const engine = new SketchCanvasEngine({
      canvas: canvasRef.current,
      width: initialSizeRef.current.width,
      height: initialSizeRef.current.height,
      background: PAPER_BACKGROUND,
    });
    engineRef.current = engine;
    onEngineReady(engine);

    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, [onEngineReady]);

  useEffect(() => {
    engineRef.current?.resize(width, height);
  }, [width, height]);

  return (
    <div className="canvas-wrapper">
      <div className="canvas-easel-frame">
        <canvas ref={canvasRef} className="sketch-canvas" aria-label="铅笔素描逐笔绘制画布" />
      </div>
    </div>
  );
};
