# 图像目标场构建模块 (`src/lib/image`)

本目录负责将输入光栅图像（`ImageData`）解算为驱动铅笔素描笔触规划的多维物理场（`SketchTarget`）。全程采用纯 TypeScript 实现，零外部 CV/ML 依赖。

## 模块职责与文件说明

- `filters.ts`：底层滤波与采样算子库。包含镜像反射边界的一维可分离高斯模糊 `gaussianBlur`、LUT 加速保边双边滤波 `bilateralSmooth`、Sobel 梯度算子 `computeSobelGradients`、双线性插值 `sampleBilinear` 与分位数统计 `computePercentile`。
- `edgeTangentFlow.ts`：实现 Kang et al. (NPAR 2007) **边缘切向流（Edge Tangent Flow, ETF）**。基于双尺度结构张量初始化单位切向量与各向异性相干度 `coherence`，通过两轮水平/垂直可分离偶极符号对齐迭代平滑，生成锁死强轮廓边界、顺滑引导长发与衣褶曲率的切向流场。
- `coherentLineDrawing.ts`：实现 **流向高斯差分（Flow-based Difference of Gaussians, FDoG）**。沿局部法向评估中心-环绕一维 DoG，并沿正反双向 ETF 流线执行二阶 Runge-Kutta 积分与软阈值映射，输出干净连贯的结构线响应。
- `pencilToneMapping.ts`：
  - `mapPencilToneField`：借鉴 Lu et al. (NPAR 2012) 自然铅笔素描三峰参数化直方图模型（Laplacian 亮部纸白峰 + Uniform 中间调 + Gaussian 暗部炭黑峰），构建 256 级单调 CDF 查找表，支持 `classic`、`portrait`、`lineart`、`dramatic` 四种艺术预设。
  - `estimateSubjectMask`：基于外框平坦采样拟合逆距离背景色场，结合梯度阻断漫水填充输出前景置信度掩码 `foreground`，供 `backgroundSuppression` 净化影棚灰底。
- `buildSketchTarget.ts`：组装输出统一 `SketchTarget` 数据结构，融合 FDoG 线条、亮部单脊线外缘增强与校准色调场。
- `loadImage.ts` / `resizeImage.ts`：浏览器端文件校验解码与偶数尺寸等比缩放归一化。
