# 离线评测与测试工具链 (`tools`)

本目录提供不依赖浏览器环境的纯 Node.js / TypeScript 离线渲染评测与兼容测试运行器：

- `run-preview.mjs`：命令行离线素描生成与质量量化评测入口。读取 PNG 样本，执行完整的 `reconstructSketchScript` 流水线，输出源图、目标暗度场、细节脊线图、前景掩码、全量渲染 PNG、分层 PNG 及矢量 `13-vector.svg`，并打印相对目标场的 `MAE`、Pearson 相关系数 `correlation` 与平均墨量对比。
  - 环境变量：`SKETCH_MAX_DIM`（默认 `768`）、`SKETCH_SEED`（默认 `12345`）、`SKETCH_PRESET`（`classic | portrait | lineart | dramatic`）。
- `harness/canvas2d.ts`：纯 TypeScript CPU 2D 软件光栅化器（支持 4×4 超采样扫描线多边形填充、矩阵变换与直通 Alpha 合成）。
- `harness/png.ts`：基于 `node:zlib` 的零依赖 PNG 编解码与双线性重采样工具。
- `run-tests.mjs` + `vitest-shim.mjs`：受限环境下的原生 Node 测试执行器，无需派生子进程即可运行全部单元测试。
