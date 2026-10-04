import type { GrayImage, RGBAImage } from './types';

export function createRGBAImage(width: number, height: number): RGBAImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function createGrayImage(width: number, height: number): GrayImage {
  return { width, height, data: new Float32Array(width * height) };
}

export function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function toGray(img: RGBAImage, downscale = 1): GrayImage {
  const d = Math.max(1, Math.floor(downscale));
  const w = Math.floor(img.width / d);
  const h = Math.floor(img.height / d);
  const out = createGrayImage(w, h);
  const src = img.data;
  const inv = 1 / (d * d);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let yy = 0; yy < d; yy++) {
        let i = ((y * d + yy) * img.width + x * d) * 4;
        for (let xx = 0; xx < d; xx++, i += 4) sum += luminance(src[i], src[i + 1], src[i + 2]);
      }
      out.data[y * w + x] = sum * inv;
    }
  }
  return out;
}

/** Variance of the 4-neighbour Laplacian: a standard focus / motion-blur measure. */
export function laplacianVariance(img: GrayImage): number {
  const { width: w, height: h, data } = img;
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = data[i - 1] + data[i + 1] + data[i - w] + data[i + w] - 4 * data[i];
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function cropRGBA(img: RGBAImage, x: number, y: number, w: number, h: number): RGBAImage {
  const out = createRGBAImage(w, h);
  for (let row = 0; row < h; row++) {
    const s = ((y + row) * img.width + x) * 4;
    out.data.set(img.data.subarray(s, s + w * 4), row * w * 4);
  }
  return out;
}
