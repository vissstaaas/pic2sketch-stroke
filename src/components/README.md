# 前端工作台组件模块 (`src/components`)

本目录承载 **Atelier Graphite** 数字素描工坊的交互界面组件与异常隔离边界：

- `ErrorBoundary.tsx`：全局 React 错误边界（`GlobalErrorBoundary`），捕获渲染链路异常并提供一键恢复与刷新降级界面。
- `ImageUploader.tsx`：支持拖拽、文件选择、全局 `Ctrl+V` 剪贴板粘贴图片以及一键载入内置肖像示例。
- `ParameterPanel.tsx`：提供四大素描风格预设（学院写实、细腻肖像、纯净速写、强烈明暗）、笔触预算/轮廓灵敏度/排线密度/背景净化/纸纹颗粒滑块、分辨率档位、随机种子锁定及原图缓存重算。
- `LayerInspector.tsx`：七层素描解剖面板，展示各层铅笔标号（`2H`–`6B`）与笔触占比，支持单层显隐切换与点击跳层。
- `PlaybackControls.tsx`：进度时间轴、播放/暂停/重绘、逐笔步进微调、倍速切换及 `PNG / SVG / JSON` 三格式导出栏。
- `SketchCanvas.tsx` / `TargetSketchPreview.tsx` / `GenerationStatus.tsx`：画架容器、算法目标场诊断视图与任务状态卡片。
