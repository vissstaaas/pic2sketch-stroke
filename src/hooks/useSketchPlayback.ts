import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlaybackFrameState, StrokeScript } from '../types/stroke';
import type { SketchCanvasEngine } from '../lib/canvas/SketchCanvasEngine';
import { PlaybackController } from '../lib/playback/PlaybackController';

const INITIAL_STATE: PlaybackFrameState = {
  status: 'idle',
  currentStrokeIndex: 0,
  currentStrokeProgress: 0,
  totalStrokes: 0,
  progress: 0,
  speed: 1.0,
};

export function useSketchPlayback(
  engine: SketchCanvasEngine | null,
  script: StrokeScript | null
) {
  const [playbackState, setPlaybackState] = useState<PlaybackFrameState>(INITIAL_STATE);
  const controllerRef = useRef<PlaybackController | null>(null);

  // Initialize or reload controller when engine or script changes
  useEffect(() => {
    if (!engine) {
      controllerRef.current?.dispose();
      controllerRef.current = null;
      setPlaybackState(INITIAL_STATE);
      return;
    }

    if (!controllerRef.current) {
      controllerRef.current = new PlaybackController({
        engine,
        initialSpeed: playbackState.speed,
        onStateChange: (newState) => {
          setPlaybackState(newState);
        },
      });
    }

    if (script) {
      controllerRef.current.load(script);
    } else {
      setPlaybackState(INITIAL_STATE);
    }

    return () => {
      controllerRef.current?.dispose();
      controllerRef.current = null;
    };
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

  const setSpeed = useCallback((speed: number) => {
    controllerRef.current?.setSpeed(speed);
  }, []);

  const exportPng = useCallback((): string => {
    if (!engine) {
      throw new Error('画板尚未就绪，无法导出图片');
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
    setSpeed,
    exportPng,
  };
}
