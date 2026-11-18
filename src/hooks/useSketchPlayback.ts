import { useCallback, useEffect, useRef, useState } from 'react';
import type { SketchCanvasEngine } from '../lib/canvas/SketchCanvasEngine';
import { PlaybackController } from '../lib/playback/PlaybackController';
import type { PlaybackFrameState, StrokeLayer, StrokeScript } from '../types/stroke';

const INITIAL_STATE: PlaybackFrameState = {
  status: 'idle',
  currentStrokeIndex: 0,
  currentStrokeProgress: 0,
  totalStrokes: 0,
  progress: 0,
  speed: 1.0,
};

const PRESET_SPEED_MAP: Record<'slow' | 'normal' | 'fast', number> = {
  slow: 0.5,
  normal: 1.0,
  fast: 4.0,
};

export function useSketchPlayback(
  engine: SketchCanvasEngine | null,
  script: StrokeScript | null
) {
  const [playbackState, setPlaybackState] = useState<PlaybackFrameState>(INITIAL_STATE);
  const controllerRef = useRef<PlaybackController | null>(null);
  const speedRef = useRef<number>(1.0);

  useEffect(() => {
    if (!engine) {
      controllerRef.current?.dispose();
      controllerRef.current = null;
      setPlaybackState(INITIAL_STATE);
      return;
    }

    const controller = new PlaybackController({
      engine,
      initialSpeed: speedRef.current,
      onStateChange: (nextState) => {
        speedRef.current = nextState.speed;
        setPlaybackState(nextState);
      },
      onError: (err) => {
        console.error('[PlaybackController] Rendering failure:', err);
      },
    });
    controllerRef.current = controller;

    return () => {
      controller.dispose();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
  }, [engine]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;

    if (script) {
      const preset = script.generation.options.speedPreset;
      if (preset && PRESET_SPEED_MAP[preset]) {
        controller.setSpeed(PRESET_SPEED_MAP[preset]);
      }
      controller.load(script);
    } else {
      setPlaybackState((prev) => ({ ...INITIAL_STATE, speed: prev.speed }));
    }
  }, [engine, script]);

  const play = useCallback(() => {
    controllerRef.current?.play();
  }, []);

  const pause = useCallback(() => {
    controllerRef.current?.pause();
  }, []);

  const resume = useCallback(() => {
    controllerRef.current?.resume();
  }, []);

  const replay = useCallback(() => {
    controllerRef.current?.replay();
  }, []);

  const seek = useCallback((progress: number) => {
    controllerRef.current?.seek(progress);
  }, []);

  const stepStrokes = useCallback((delta: number) => {
    controllerRef.current?.stepStrokes(delta);
  }, []);

  const seekToLayerEnd = useCallback((layer: StrokeLayer) => {
    controllerRef.current?.seekToLayerEnd(layer);
  }, []);

  const setSpeed = useCallback((speed: number) => {
    speedRef.current = speed;
    controllerRef.current?.setSpeed(speed);
  }, []);

  const exportPng = useCallback((): string => {
    if (!engine) {
      throw new Error('画板尚未就绪，无法导出 PNG');
    }
    return engine.exportPng();
  }, [engine]);

  return {
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
  };
}
