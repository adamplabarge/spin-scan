import { createRGBAImage } from '../core/image';
import type { RGBAImage } from '../core/types';

/** Small deterministic PRNG so synthetic scenes are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generates a label-like texture: light paper with lines of dark "words" and a few coloured blocks. */
export function createSyntheticLabel(width: number, height: number, seed = 1): RGBAImage {
  const rnd = mulberry32(seed);
  const img = createRGBAImage(width, height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = 228 + rnd() * 10;
    d[i] = n;
    d[i + 1] = n;
    d[i + 2] = n - 6;
    d[i + 3] = 255;
  }
  const fill = (x0: number, y0: number, w: number, h: number, r: number, g: number, b: number) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) {
      for (let x = x0; x < x0 + w; x++) {
        const xi = ((x % width) + width) % width;
        const i = (y * width + xi) * 4;
        d[i] = r;
        d[i + 1] = g;
        d[i + 2] = b;
      }
    }
  };
  // Coloured header blocks.
  for (let k = 0; k < 3; k++) {
    fill(Math.floor(rnd() * width), Math.floor(height * 0.04), Math.floor(width * (0.08 + rnd() * 0.1)),
      Math.floor(height * 0.1), 40 + rnd() * 80, 60 + rnd() * 100, 140 + rnd() * 100);
  }
  // Lines of "text".
  const lineH = Math.max(4, Math.round(height * 0.035));
  for (let y = Math.floor(height * 0.2); y + lineH < height * 0.95; y += Math.round(lineH * 1.8)) {
    let x = Math.floor(rnd() * width * 0.05);
    const end = width - Math.floor(rnd() * width * 0.15);
    while (x < end) {
      const wordW = Math.max(3, Math.round(lineH * (0.8 + rnd() * 3)));
      // Letters inside a word: thin vertical bars of varied height.
      for (let cx = x; cx < Math.min(x + wordW, end); cx += Math.max(2, Math.round(lineH * 0.45))) {
        const lh = Math.round(lineH * (0.6 + rnd() * 0.4));
        fill(cx, y + (lineH - lh), Math.max(1, Math.round(lineH * 0.25)), lh, 25, 25, 30);
      }
      x += wordW + Math.max(3, Math.round(lineH * 0.7));
    }
  }
  return img;
}

export interface RenderCylinderOptions {
  frameWidth: number;
  frameHeight: number;
  centerX: number;
  radius: number;
  /** Background colour behind the bottle. Default dark grey. */
  background?: [number, number, number];
  /** Lambertian-style darkening towards the silhouette. Default true. */
  shading?: boolean;
  /** A fixed vertical specular highlight at this screen offset (fraction of radius, -1..1). */
  glareAt?: number;
  /** Additive Gaussian-ish noise amplitude. Default 0. */
  noise?: number;
  seed?: number;
  /** Horizontal sub-samples per pixel (area integration, like a real sensor). Default 4. */
  samples?: number;
}

/**
 * Renders an orthographic view of a vertical cylinder wrapped with `label` (label width = full
 * circumference), rotated by `angleRad`. Increasing the angle moves the label content to the left.
 */
export function renderCylinderFrame(label: RGBAImage, angleRad: number, opts: RenderCylinderOptions): RGBAImage {
  const { frameWidth: fw, frameHeight: fh, centerX: cx, radius: r } = opts;
  const bg = opts.background ?? [50, 52, 58];
  const shading = opts.shading ?? true;
  const rnd = opts.noise ? mulberry32(opts.seed ?? 7) : null;
  const img = createRGBAImage(fw, fh);
  const circ = 2 * Math.PI * r;
  const lw = label.width;
  const lh = label.height;
  const ss = Math.max(1, Math.floor(opts.samples ?? 4));
  const acc = new Float32Array(fh * 3);
  for (let x = 0; x < fw; x++) {
    acc.fill(0);
    let insideCount = 0;
    for (let k = 0; k < ss; k++) {
      const xr = (x + (k + 0.5) / ss - cx) / r;
      if (Math.abs(xr) >= 1) {
        for (let y = 0; y < fh; y++) {
          acc[y * 3] += bg[0];
          acc[y * 3 + 1] += bg[1];
          acc[y * 3 + 2] += bg[2];
        }
        continue;
      }
      insideCount++;
      const phi = Math.asin(xr);
      const s = (phi + angleRad) * r;
      let tx = ((s / circ) * lw) % lw;
      if (tx < 0) tx += lw;
      tx -= 0.5;
      const tx0 = Math.floor(tx);
      const fx = tx - tx0;
      const ia = ((tx0 % lw) + lw) % lw;
      const ib = (ia + 1) % lw;
      const shade = shading ? 0.55 + 0.45 * Math.cos(phi) : 1;
      const glare = opts.glareAt !== undefined ? Math.exp(-(((xr - opts.glareAt) / 0.06) ** 2)) : 0;
      for (let y = 0; y < fh; y++) {
        const ly = Math.min(lh - 1, Math.floor((y / fh) * lh));
        const a = (ly * lw + ia) * 4;
        const b = (ly * lw + ib) * 4;
        for (let c = 0; c < 3; c++) {
          const v = (label.data[a + c] * (1 - fx) + label.data[b + c] * fx) * shade;
          acc[y * 3 + c] += v + (255 - v) * glare;
        }
      }
    }
    for (let y = 0; y < fh; y++) {
      const o = (y * fw + x) * 4;
      for (let c = 0; c < 3; c++) {
        let v = acc[y * 3 + c] / ss;
        if (rnd && insideCount > 0) v += (rnd() + rnd() - 1) * opts.noise!;
        img.data[o + c] = v;
      }
      img.data[o + 3] = 255;
    }
  }
  return img;
}
