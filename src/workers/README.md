# 异步笔触解算 Worker (`src/workers`)

`strokeGenerator.worker.ts` 运行在独立 Web Worker 线程中，隔离高密度图像场滤波与贪心残差规划计算，确保主线程 UI 与画布交互保持 60fps 响应。

## 通信契约

- **输入 (`StrokeWorkerRequest`)**：
  - `generate`：接收由主线程通过 `Transferable`（`imageData.data.buffer`）零拷贝移交的像素缓冲区、`UploadImageMeta` 与 `StrokeGenerationOptions`。
  - `cancel`：标记当前 `requestId` 中断标志，配合 `reconstructSketchScript` 阶段检查点协作退出。
- **输出 (`StrokeWorkerResponse`)**：
  - `progress`：按 `preprocessing -> structure -> contours -> shading -> ordering -> finalizing` 六阶段推送实时进度与状态说明。
  - `complete`：返回完整 `StrokeScript`（含分层统计 `layerMetrics` 与耗时 `elapsedMs`）。
  - `error`：捕获所有未预期异常并封装标准错误码 `GENERATION_FAILED` 回传主线程。
