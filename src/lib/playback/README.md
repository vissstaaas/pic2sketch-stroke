# 逐笔回放控制模块 (`src/lib/playback`)

`PlaybackController.ts` 负责管理 `StrokeScript` 在 `SketchCanvasEngine` 上的时间轴状态机与帧循环调度。

## 核心能力

- **状态流转**：`idle -> ready -> playing <-> paused -> completed` 及异常捕获态 `error`（触发 `onError` 回调并记录 `errorMessage`）。
- **自适应帧推进**：基于总笔触数自适应计算基准每秒笔触速率（约 68 秒完成整幅 1x 作品），支持 `0.1x ~ 32x` 倍速无级调节，兼容浏览器 `requestAnimationFrame` 与无头环境定时器回退。
- **精准定位与微调**：
  - `seek(progress)`：支持 `0..1` 任意进度拖拽（`0` 精准归零至空白画纸）。
  - `stepStrokes(delta)`：支持正反向精确逐笔或批量步进微调。
  - `seekToLayerEnd(layer)`：一键跳转至指定素描图层绘制完成时刻。
