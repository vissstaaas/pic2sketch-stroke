import { encodePng } from './png';

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

interface Color { r: number; g: number; b: number; a: number }

function parseColor(style: unknown): Color {
  const s = String(style).trim();
  if (s.startsWith('#')) {
    let hex = s.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16) / 255,
        g: parseInt(hex.slice(2, 4), 16) / 255,
        b: parseInt(hex.slice(4, 6), 16) / 255,
        a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
      };
    }
  }
  const match = /^rgba?\(([^)]*)\)$/i.exec(s);
  if (match) {
    const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return {
      r: (parts[0] || 0) / 255,
      g: (parts[1] || 0) / 255,
      b: (parts[2] || 0) / 255,
      a: parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1,
    };
  }
  if (s === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  if (s === 'white') return { r: 1, g: 1, b: 1, a: 1 };
  throw new Error('FakeContext2D: unsupported color "' + s + '"');
}

interface PathPoint { x: number; y: number }
interface SubPath { points: PathPoint[]; closed: boolean }

/** Offscreen-less HTMLCanvasElement stand-in with a CPU rasterizer. */
export class FakeCanvas {
  private _width = 0;
  private _height = 0;
  /** Straight-alpha RGBA floats in 0..1 */
  px: Float32Array = new Float32Array(0);
  style: Record<string, string> = {};
  private context: FakeContext2D | null = null;

  constructor(width = 0, height = 0) {
    this.width = width;
    this.height = height;
  }

  get width(): number { return this._width; }
  set width(value: number) {
    this._width = Math.max(0, Math.floor(value));
    this.px = new Float32Array(this._width * this._height * 4);
  }

  get height(): number { return this._height; }
  set height(value: number) {
    this._height = Math.max(0, Math.floor(value));
    this.px = new Float32Array(this._width * this._height * 4);
  }

  getContext(type: string): FakeContext2D {
    if (type !== '2d') throw new Error('FakeCanvas only supports 2d');
    if (!this.context) this.context = new FakeContext2D(this);
    return this.context;
  }

  toDataURL(): string {
    return 'data:image/png;base64,' + this.toPng().toString('base64');
  }

  toPng(): Buffer {
    const data = new Uint8ClampedArray(this._width * this._height * 4);
    for (let i = 0; i < this.px.length; i++) {
      data[i] = Math.round(Math.min(1, Math.max(0, this.px[i])) * 255);
    }
    return encodePng({ width: this._width, height: this._height, data });
  }
}

interface ContextState {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  globalAlpha: number;
  transform: Matrix;
}

export class FakeContext2D {
  canvas: FakeCanvas;
  fillStyle: unknown = '#000';
  strokeStyle: unknown = '#000';
  lineWidth = 1;
  lineCap = 'butt';
  lineJoin = 'miter';
  globalAlpha = 1;

  private transform: Matrix = [...IDENTITY] as Matrix;
  private stack: ContextState[] = [];
  private subpaths: SubPath[] = [];
  private current: SubPath | null = null;

  constructor(canvas: FakeCanvas) {
    this.canvas = canvas;
  }

  save(): void {
    this.stack.push({
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      lineCap: this.lineCap,
      lineJoin: this.lineJoin,
      globalAlpha: this.globalAlpha,
      transform: [...this.transform] as Matrix,
    });
  }

  restore(): void {
    const state = this.stack.pop();
    if (!state) return;
    this.fillStyle = state.fillStyle;
    this.strokeStyle = state.strokeStyle;
    this.lineWidth = state.lineWidth;
    this.lineCap = state.lineCap;
    this.lineJoin = state.lineJoin;
    this.globalAlpha = state.globalAlpha;
    this.transform = state.transform;
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.transform = [a, b, c, d, e, f];
  }

  scale(sx: number, sy: number): void {
    this.transform = multiply(this.transform, [sx, 0, 0, sy, 0, 0]);
  }

  translate(tx: number, ty: number): void {
    this.transform = multiply(this.transform, [1, 0, 0, 1, tx, ty]);
  }

  // ---- path construction ----
  beginPath(): void {
    this.subpaths = [];
    this.current = null;
  }

  moveTo(x: number, y: number): void {
    const p = this.apply(x, y);
    this.current = { points: [p], closed: false };
    this.subpaths.push(this.current);
  }

  lineTo(x: number, y: number): void {
    if (!this.current) this.moveTo(x, y);
    else this.current.points.push(this.apply(x, y));
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    if (!this.current) this.moveTo(cpx, cpy);
    const start = this.current.points[this.current.points.length - 1];
    const control = this.apply(cpx, cpy);
    const end = this.apply(x, y);
    const approx = Math.hypot(control.x - start.x, control.y - start.y) + Math.hypot(end.x - control.x, end.y - control.y);
    const steps = Math.max(2, Math.min(48, Math.ceil(approx / 0.4)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const mt = 1 - t;
      this.current.points.push({
        x: mt * mt * start.x + 2 * mt * t * control.x + t * t * end.x,
        y: mt * mt * start.y + 2 * mt * t * control.y + t * t * end.y,
      });
    }
  }

  arc(cx: number, cy: number, r: number, _start: number, _end: number): void {
    const steps = Math.max(12, Math.min(64, Math.ceil(r * 2)));
    const points: PathPoint[] = [];
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      points.push(this.apply(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
    }
    this.current = { points, closed: true };
    this.subpaths.push(this.current);
  }

  closePath(): void {
    if (this.current) this.current.closed = true;
  }

  // ---- painting ----
  fillRect(x: number, y: number, w: number, h: number): void {
    const color = parseColor(this.fillStyle);
    const p0 = this.apply(x, y);
    const p1 = this.apply(x + w, y + h);
    const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x)));
    const maxX = Math.min(this.canvas.width - 1, Math.ceil(Math.max(p0.x, p1.x)) - 1);
    const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y)));
    const maxY = Math.min(this.canvas.height - 1, Math.ceil(Math.max(p0.y, p1.y)) - 1);
    for (let py = minY; py <= maxY; py++) {
      for (let pxi = minX; pxi <= maxX; pxi++) {
        const x0 = Math.max(p0.x, p1.x === p0.x ? p0.x : Math.min(p0.x, p1.x));
        const x1 = Math.max(p0.x, p1.x);
        const cov = Math.min(x1, pxi + 1) - Math.max(x0, pxi);
        if (cov > 0) this.composite(pxi, py, color, Math.min(1, Math.max(0, cov)));
      }
    }
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    const minX = Math.max(0, Math.floor(x));
    const maxX = Math.min(this.canvas.width - 1, Math.ceil(x + w) - 1);
    const minY = Math.max(0, Math.floor(y));
    const maxY = Math.min(this.canvas.height - 1, Math.ceil(y + h) - 1);
    for (let py = minY; py <= maxY; py++) {
      for (let pxi = minX; pxi <= maxX; pxi++) {
        const i = (py * this.canvas.width + pxi) * 4;
        this.canvas.px[i] = 0; this.canvas.px[i + 1] = 0; this.canvas.px[i + 2] = 0; this.canvas.px[i + 3] = 0;
      }
    }
  }

  stroke(): void {
    const color = parseColor(this.strokeStyle);
    const halfWidth = Math.max(0.05, (this.lineWidth * this.scaleFactor()) / 2);
    for (const path of this.subpaths) {
      const points = path.points;
      for (let i = 0; i < points.length - 1; i++) {
        this.strokeSegment(points[i], points[i + 1], halfWidth, color);
      }
      if (path.closed && points.length > 2) {
        this.strokeSegment(points[points.length - 1], points[0], halfWidth, color);
      }
    }
  }

  fill(): void {
    const color = parseColor(this.fillStyle);
    for (const path of this.subpaths) {
      if (path.points.length < 3) continue;
      this.fillPolygon(path.points, color);
    }
  }

  getImageData(x: number, y: number, w: number, h: number): ImageData {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const sx = x + col;
        const sy = y + row;
        const dst = (row * w + col) * 4;
        if (sx < 0 || sy < 0 || sx >= this.canvas.width || sy >= this.canvas.height) continue;
        const src = (sy * this.canvas.width + sx) * 4;
        data[dst] = this.canvas.px[src] * 255;
        data[dst + 1] = this.canvas.px[src + 1] * 255;
        data[dst + 2] = this.canvas.px[src + 2] * 255;
        data[dst + 3] = this.canvas.px[src + 3] * 255;
      }
    }
    return { data, width: w, height: h } as unknown as ImageData;
  }

  putImageData(image: ImageData, x: number, y: number): void {
    const { width: w, height: h, data } = image;
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const sx = x + col;
        const sy = y + row;
        if (sx < 0 || sy < 0 || sx >= this.canvas.width || sy >= this.canvas.height) continue;
        const src = (row * w + col) * 4;
        const dst = (sy * this.canvas.width + sx) * 4;
        this.canvas.px[dst] = data[src] / 255;
        this.canvas.px[dst + 1] = data[src + 1] / 255;
        this.canvas.px[dst + 2] = data[src + 2] / 255;
        this.canvas.px[dst + 3] = data[src + 3] / 255;
      }
    }
  }

  // ---- internals ----
  private apply(x: number, y: number): PathPoint {
    const m = this.transform;
    return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
  }

  private scaleFactor(): number {
    const m = this.transform;
    return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
  }

  private composite(x: number, y: number, color: Color, coverage: number): void {
    if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) return;
    const alpha = color.a * coverage * this.globalAlpha;
    if (alpha <= 0.0002) return;
    const px = this.canvas.px;
    const i = (y * this.canvas.width + x) * 4;
    const dstA = px[i + 3];
    const outA = alpha + dstA * (1 - alpha);
    if (outA <= 0) { px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = 0; return; }
    const w = dstA * (1 - alpha);
    px[i] = (color.r * alpha + px[i] * w) / outA;
    px[i + 1] = (color.g * alpha + px[i + 1] * w) / outA;
    px[i + 2] = (color.b * alpha + px[i + 2] * w) / outA;
    px[i + 3] = outA;
  }

  private strokeSegment(a: PathPoint, b: PathPoint, halfWidth: number, color: Color): void {
    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x) - halfWidth - 1));
    const maxX = Math.min(this.canvas.width - 1, Math.ceil(Math.max(a.x, b.x) + halfWidth + 1));
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y) - halfWidth - 1));
    const maxY = Math.min(this.canvas.height - 1, Math.ceil(Math.max(a.y, b.y) + halfWidth + 1));
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        let t = lenSq > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / lenSq : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(px - (a.x + dx * t), py - (a.y + dy * t));
        const coverage = halfWidth + 0.5 - d;
        if (coverage > 0) this.composite(x, y, color, coverage > 1 ? 1 : coverage);
      }
    }
  }

  private fillPolygon(points: PathPoint[], color: Color): void {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const x0 = Math.max(0, Math.floor(minX));
    const x1 = Math.min(this.canvas.width - 1, Math.ceil(maxX));
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(this.canvas.height - 1, Math.ceil(maxY));
    if (x1 < x0 || y1 < y0) return;

    const w = x1 - x0 + 1;
    const cover = new Float32Array(w * (y1 - y0 + 1));
    const SUB = 4;

    for (let y = y0; y <= y1; y++) {
      for (let s = 0; s < SUB; s++) {
        const sy = y + (s + 0.5) / SUB;
        const xs: number[] = [];
        for (let i = 0; i < points.length; i++) {
          const a = points[i];
          const b = points[(i + 1) % points.length];
          if ((a.y <= sy && b.y > sy) || (b.y <= sy && a.y > sy)) {
            xs.push(a.x + ((sy - a.y) / (b.y - a.y)) * (b.x - a.x));
          }
        }
        xs.sort((p, q) => p - q);
        for (let i = 0; i + 1 < xs.length; i += 2) {
          const spanStart = xs[i];
          const spanEnd = xs[i + 1];
          for (let x = Math.max(x0, Math.floor(spanStart)); x <= Math.min(x1, Math.ceil(spanEnd) - 1); x++) {
            const overlap = Math.min(spanEnd, x + 1) - Math.max(spanStart, x);
            if (overlap > 0) cover[(y - y0) * w + (x - x0)] += overlap / SUB;
          }
        }
      }
    }

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const c = cover[(y - y0) * w + (x - x0)];
        if (c > 0) this.composite(x, y, color, c > 1 ? 1 : c);
      }
    }
  }
}
