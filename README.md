# Pencil Sketch Stroke Reconstruction

This is an isolated copy of the original MVP. The original project remains at:

`C:\Users\sxbdg\Documents\ChatGPT\1`

This copy implements a non-AI two-stage pipeline:

1. Build a hidden pencil-sketch target with grayscale, inversion, Gaussian blur, color dodge, and restrained shadow mass.
2. Reconstruct that target on a blank Canvas with replayable graphite strokes, from broad tone to fine residual detail.
3. Add a limited contour pass for coherent silhouettes, facial features, hair, and clothing folds.

The target bitmap is never shown or exported as the result. The visible Canvas and exported PNG are composed from real stroke commands.

## Run

```powershell
pnpm install
pnpm dev
```

Open the Vite URL, upload a PNG/JPG/WebP image, and use the playback controls.

## Verify

```powershell
pnpm test
pnpm build
pnpm sketch:preview -- samples/pasted-1-768.png tools/out-portrait
```

The preview command writes the source image, hidden target, detail map, tonal strokes, detail strokes, and final reconstruction into the selected output directory.

## Core Files

- `src/lib/image/buildSketchTarget.ts`: traditional pencil target conversion.
- `src/lib/strokes/generateResidualStrokes.ts`: coarse-to-fine residual reconstruction.
- `src/lib/strokes/generateDetailContours.ts`: restrained feature and silhouette vectorization.
- `src/workers/strokeGenerator.worker.ts`: generation pipeline orchestration.
- `src/lib/canvas/SketchCanvasEngine.ts`: incremental playback and frame snapshots.
