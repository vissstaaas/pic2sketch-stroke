# 多格式笔触导出模块 (`src/lib/export`)

`exportSketch.ts` 提供无损矢量与结构化脚本导出能力：

- `exportScriptToSvg(script, options?)`：复用 `brushMath.ts` 中的 `buildStrokeRibbonPolygon` 与铅笔色号规范，按 `layer-structure` 至 `layer-finalAccent` 分组输出独立 `.svg` 矢量文件，支持按当前回放进度截断与隐藏图层过滤，可直接用于大幅面印刷、Figma/Illustrator 编辑或绘图仪后处理。
- `exportScriptToJson(script)`：剥离诊断预览位图后序列化标准 `StrokeScript v1.0` JSON，便于归档与跨端确定性复现。
