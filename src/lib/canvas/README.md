# 石墨笔刷与画板渲染引擎 (`src/lib/canvas`)

本目录实现确定性 HTML5 Canvas 2D 逐笔渲染引擎，并与色调规划器、SVG 导出器共享同一套色带几何与光学浓度模型。

## 核心文件

- `brushMath.ts`：
  - 定义五级铅笔石墨色号（`2H`、`HB`、`2B`、`4B`、`6B`）的色值与纸面相对暗度系数 `darknessFactor`。
  - `buildStrokeRibbonPolygon`：根据笔压曲线 `strokeWidthAt`、正弦干石墨纸纹调制与圆弧端帽构建闭合锥形多边形色带。
  - `rasterizeStrokeCoverage`：基于世代戳稀疏触碰表（`RasterScratchBuffer`）的单次覆盖胶囊体 SDF 光栅化器。保证单条多段笔触内部零自叠加、零每笔堆内存分配，使色调规划器计算的落墨量与 `PencilBrush` 真实渲染结果严格对齐。
- `PencilBrush.ts`：单笔渲染器。支持按 `progress`（`0..1`）亚顶点平滑插值笔尖推进位置，并对整条色带多边形执行单次 `ctx.fill()`。
- `SketchCanvasEngine.ts`：
  - 维护高 DPI 画布缩放与双尺度亚麻素描纸底纹（`#fbf8f1`）。
  - 缓存已完成笔触的 `ImageData` 快照（`baseImageData`），在播放半笔帧时仅恢复底图并绘制当前活动笔触，杜绝透明度逐帧累加。
  - 支持 `setHiddenLayers` 动态图层可见性过滤与 `exportPng` 位图导出。
