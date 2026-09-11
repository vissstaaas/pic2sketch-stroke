import React, { useEffect, useRef } from 'react';
import { SketchCanvasEngine } from '../lib/canvas/SketchCanvasEngine';

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

  useEffect(() => {
    if (!canvasRef.current) return;

    if (!engineRef.current) {
      const engine = new SketchCanvasEngine({
        canvas: canvasRef.current,
        width,
        height,
        background: '#fbf9f5',
      });
      engineRef.current = engine;
      onEngineReady(engine);
    } else {
      engineRef.current.resize(width, height);
    }
  }, [width, height, onEngineReady]);

  return (
    <div className="canvas-wrapper">
      <div className="canvas-easel-frame">
        <canvas ref={canvasRef} className="sketch-canvas" />
      </div>
    </div>
  );
};
