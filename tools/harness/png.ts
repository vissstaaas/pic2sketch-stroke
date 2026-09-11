import { deflateSync, inflateSync } from 'node:zlib';

export interface RasterImage {
  width: number;
  height: number;
  /** Straight-alpha RGBA, 0-255 */
  data: Uint8ClampedArray;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Minimal non-interlaced PNG decoder (8/16-bit gray, RGB, palette, gray+A, RGBA). */
export function decodePng(buffer: Buffer): RasterImage {
  if (!buffer.subarray(0, 8).equals(PNG_SIG)) throw new Error('Not a PNG file');

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let interlace = 0;
  let palette: Buffer | null = null;
  const idat: Buffer[] = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const chunk = buffer.subarray(start, start + length);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
      interlace = chunk[12];
    } else if (type === 'PLTE') {
      palette = Buffer.from(chunk);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(chunk));
    } else if (type === 'IEND') {
      break;
    }
    offset = start + length + 4;
  }

  if (interlace !== 0) throw new Error('Interlaced PNG is not supported');
  if (bitDepth !== 8 && bitDepth !== 16) throw new Error('Unsupported bit depth ' + bitDepth);

  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
  const bytesPerSample = bitDepth / 8;
  const bpp = channels * bytesPerSample;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(height * stride);

  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const value = raw[pos++];
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let result: number;
      switch (filter) {
        case 0: result = value; break;
        case 1: result = value + a; break;
        case 2: result = value + b; break;
        case 3: result = value + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          result = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error('Unknown PNG filter ' + filter);
      }
      row[x] = result & 0xff;
    }
  }

  const data = new Uint8ClampedArray(width * height * 4);
  const sampleAt = (base: number) => (bitDepth === 8 ? out[base] : out[base]);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = y * stride + x * bpp;
      const dst = (y * width + x) * 4;
      let r = 0, g = 0, b = 0, a = 255;
      if (colorType === 0) {
        r = g = b = sampleAt(src);
      } else if (colorType === 2) {
        r = sampleAt(src); g = sampleAt(src + bytesPerSample); b = sampleAt(src + 2 * bytesPerSample);
      } else if (colorType === 3) {
        const idx = out[src] * 3;
        r = palette ? palette[idx] : 0;
        g = palette ? palette[idx + 1] : 0;
        b = palette ? palette[idx + 2] : 0;
      } else if (colorType === 4) {
        r = g = b = sampleAt(src);
        a = sampleAt(src + bytesPerSample);
      } else {
        r = sampleAt(src); g = sampleAt(src + bytesPerSample); b = sampleAt(src + 2 * bytesPerSample);
        a = sampleAt(src + 3 * bytesPerSample);
      }
      data[dst] = r; data[dst + 1] = g; data[dst + 2] = b; data[dst + 3] = a;
    }
  }

  return { width, height, data };
}

/** Minimal truecolor+alpha PNG encoder. */
export function encodePng(image: RasterImage): Buffer {
  const { width, height, data } = image;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < stride; x++) {
      raw[y * (stride + 1) + 1 + x] = data[y * stride + x];
    }
  }

  const chunks: Buffer[] = [PNG_SIG];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  chunks.push(makeChunk('IHDR', ihdr));
  chunks.push(makeChunk('IDAT', deflateSync(raw, { level: 6 })));
  chunks.push(makeChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type: string, payload: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, payload])), 0);
  return Buffer.concat([length, typeBuffer, payload, crc]);
}

/** Box-filter resize for straight-alpha RGBA buffers. */
export function resizeRaster(image: RasterImage, maxDimension: number): RasterImage {
  const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  if (width === image.width && height === image.height) return image;

  const data = new Uint8ClampedArray(width * height * 4);
  const xRatio = image.width / width;
  const yRatio = image.height / height;

  for (let y = 0; y < height; y++) {
    const sy0 = Math.floor(y * yRatio);
    const sy1 = Math.min(image.height, Math.max(sy0 + 1, Math.ceil((y + 1) * yRatio)));
    for (let x = 0; x < width; x++) {
      const sx0 = Math.floor(x * xRatio);
      const sx1 = Math.min(image.width, Math.max(sx0 + 1, Math.ceil((x + 1) * xRatio)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * image.width + sx) * 4;
          r += image.data[i]; g += image.data[i + 1]; b += image.data[i + 2]; a += image.data[i + 3];
          n++;
        }
      }
      const o = (y * width + x) * 4;
      data[o] = r / n; data[o + 1] = g / n; data[o + 2] = b / n; data[o + 3] = a / n;
    }
  }
  return { width, height, data };
}
