# 素描笔触生成与空间编排模块 (`src/lib/strokes`)

本目录将 `SketchTarget` 多维图像场分解为可逐笔回放、具有真实铅笔软硬度分级与方向流向的离散笔触序列（`Stroke[]`）。

## 核心流水线

1. **几何起稿层 (`generateConstructionStrokes.ts`)**
   - 提取低频高置信结构边界，通过大容差 RDP 折线简化与两端轻压出锋延伸，生成 `structure` 层 `2H` 浅硬铅起稿辅助线。
2. **单脊线轮廓与特征层 (`generateDetailContours.ts` + `traceEdgePaths.ts`)**
   - 直接使用 ETF 垂直法向 `(-tangentY, tangentX)` 执行双线性非极大值抑制（`thinEdgeMap`），消除对边缘图二次求导导致的双线空心伪影。
   - 通过 5 射线扇形亚像素滞后追踪、Catmull-Rom 样条重采样与曲率自适应分类，生成 `outline`（`HB`）、`features`（`2B`）与深暗缝隙 `finalAccent`（`6B`）笔触。
3. **流线交叉排线残差重构 (`generateResidualStrokes.ts`)**
   - 预先将起稿与轮廓笔触计入墨量账本，避免轮廓线被重复涂脏。
   - 执行 5 轮由粗到细（`HB -> 2B -> 4B -> 4B -> 6B`）贪心残差消除：强相干区（如发丝）紧贴 ETF 流线弯曲追踪；弱方向过渡区（如面颊、颈部、衣面）施加学院派交叉排线偏角（`+33°` / `-26°`），每落一笔调用 `rasterizeStrokeCoverage` 同步更新画纸暗度。
4. **分层预算与手腕空间巡游排序 (`orderStrokes.ts`)**
   - 严格遵循 `structure -> outline -> features -> lightTone -> midTone -> darkTone -> finalAccent` 七层作画次序。
   - 超预算时保护最多 65% 结构轮廓层，其余按色调层权重分层均匀抽样。
   - 在同层同优先级分档内执行贪心最近邻笔触串联，使回放运笔轨迹连续自然。
5. **统一编排入口 (`reconstructSketchScript.ts`)**
   - 纯函数领域服务，统一供 Web Worker 与 Node CLI 预览工具调用。
