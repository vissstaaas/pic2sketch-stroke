export class FpsTracker {
  private lastTime = performance.now();
  private frames = 0;
  private currentFps = 60;

  update(): number {
    this.frames++;
    const now = performance.now();
    const elapsed = now - this.lastTime;
    if (elapsed >= 1000) {
      this.currentFps = Math.round((this.frames * 1000) / elapsed);
      this.frames = 0;
      this.lastTime = now;
    }
    return this.currentFps;
  }

  getFps(): number {
    return this.currentFps;
  }
}

export function measureExecutionTime<T>(_label: string, fn: () => T): { result: T; durationMs: number } {
  const start = performance.now();
  const result = fn();
  const durationMs = performance.now() - start;
  return { result, durationMs };
}
