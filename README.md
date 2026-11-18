# Atelier Graphite (`pic2sketch-stroke`)

纯前端、零机器学习依赖的**学院派铅笔素描逐笔重构与矢量回放工坊**。系统并非对静态滤镜图片做蒙版擦除或透明度渐显，而是将任意照片解算为数千条具备真实软硬度分级（`2H`–`6B`）、笔压锥度与空间运笔顺序的独立石墨笔触，在 HTML5 Canvas 与分层 SVG 上逐笔绘制成形。

## 核心算法与全球 NPR 方案融合

本项目整合了非真实感绘制（NPR）领域的经典算法体系并针对浏览器端 Web Worker 做了全链路工程化实现：

1. **边缘切向流（Edge Tangent Flow, ETF — Kang et al. 2007）**
   - 基于双尺度结构张量与水平/垂直可分离偶极方向对齐平滑，提取锁定强轮廓边界且顺应发丝、衣褶曲率的连续切向向量场。
2. **流向高斯差分线稿（Flow-based DoG, FDoG）+ 单脊线法向抑制**
   - 沿局部法向评估中心-环绕差分并沿 ETF 流线执行二阶 Runge-Kutta 积分；轮廓提取直接使用 ETF 正交法向进行双线性 NMS 细化，消除二次求导带来的双线空心伪影。
3. **三峰参数化铅笔色调映射（Lu et al. 2012）+ 自适应背景净化**
   - 采用 Laplacian（纸白高光）、Uniform（柔和灰面）、Gaussian（炭黑暗部）三分布混合 CDF 直方图匹配校准明暗层次；通过外框漫水填充识别平坦影棚背景并支持可控留白。
4. **物理一致色带覆盖光栅器与交叉排线残差规划**
   - 规划器（`rasterizeStrokeCoverage`）与渲染器（`PencilBrush`）、矢量导出器（`exportScriptToSvg`）共享同一套胶囊体色带几何与分级石墨光学暗度模型，消除单笔内部重复叠墨导致的色调漂移。
   - 按学院派素描七层规范（`2H 几何起稿 -> HB 主体轮廓 -> 2B 精细特征 -> HB 浅灰铺调 -> 2B 中调交叉排线 -> 4B 暗部排线 -> 6B 重音点睛`）编排，并在同优先级分档内通过贪心最近邻路径串联实现自然手腕运笔轨迹。

## 目录结构

- `src/lib/image/`：滤波算子、ETF 切向流、FDoG 线稿、三峰色调映射与前景估计（详见 [src/lib/image/README.md](./src/lib/image/README.md)）
- `src/lib/strokes/`：起稿、单脊线轮廓、流线交叉排线生成与空间排序（详见 [src/lib/strokes/README.md](./src/lib/strokes/README.md)）
- `src/lib/canvas/`：分级石墨笔刷、色带几何与快照缓存渲染引擎（详见 [src/lib/canvas/README.md](./src/lib/canvas/README.md)）
- `src/lib/playback/`：逐笔回放状态机、单笔步进与跳层控制器（详见 [src/lib/playback/README.md](./src/lib/playback/README.md)）
- `src/lib/export/`：独立分层 SVG 矢量与便携 JSON 导出器（详见 [src/lib/export/README.md](./src/lib/export/README.md)）
- `src/workers/`：零拷贝 `Transferable` Web Worker 异步解算线程（详见 [src/workers/README.md](./src/workers/README.md)）
- `src/components/` & `src/pages/`：Atelier Graphite 工作台 UI 与全局错误边界（详见 [src/components/README.md](./src/components/README.md)）
- `tools/`：纯 TS 离线软件光栅器、量化评测 CLI 与原生测试运行器（详见 [tools/README.md](./tools/README.md)）

## 快速启动与验证

```bash
# 安装依赖
npm install

# 启动本地开发工作台 (http://localhost:5173)
npm run dev

# 运行全量单元测试 (Vitest / 原生无管道运行器)
npm test
npm run test:native

# 生产环境类型检查与构建
npm run build

# 离线生成素描 PNG + 矢量 SVG 并输出 MAE / 相关系数量化报告
npm run sketch:preview -- samples/pasted-1-768.png tools/out-demo
```

## 工作台能力一览

- **输入方式**：点击/拖拽上传、全局 `Ctrl+V` 剪贴板粘贴图片、一键载入内置肖像样本。
- **风格预设与实时重算**：内置 `学院写实`、`细腻肖像`、`纯净速写`、`强烈明暗` 四套预设；支持调节笔触预算、轮廓灵敏度、排线密度、背景净化、纸张颗粒与随机种子锁定。
- **七层解剖检视与快捷键**：支持单独显隐任意图层或点击跳层；支持 `Space`（播放/暂停）、`←/→`（单笔微调，`Shift` 步进 25 笔）、`R`（重绘）。
- **无损多格式导出**：一键导出高清 `PNG`、分层纯矢量 `SVG` 与可复现 `StrokeScript JSON`。
