import { fft2d, isPowerOfTwo } from './fft';
import type { GrayImage } from './types';

export interface Spectrum {
  width: number;
  height: number;
  re: Float64Array;
  im: Float64Array;
}

export interface PhaseCorrelationResult {
  /** Content shift such that `current(x, y) ≈ reference(x - dx, y - dy)`. */
  dx: number;
  dy: number;
  /** Height of the correlation peak (0..1). Pure translation of identical content gives values near 1. */
  peak: number;
  /** Peak-to-sidelobe ratio; a second confidence measure. */
  psr: number;
}

const windowCache = new Map<string, Float64Array>();
const lowPassCache = new Map<string, Float64Array>();

/** Std-dev (cycles/pixel) of the Gaussian weight applied to the whitened cross-power spectrum. */
const LOW_PASS_SIGMA = 0.12;

/**
 * Whitening gives every frequency equal weight, including the highest ones where sensor noise,
 * aliasing and resampling phase errors dominate; those bias sub-pixel estimates towards integers.
 * A Gaussian frequency weight keeps the estimate accurate and the peak smooth.
 */
function lowPassWeights(w: number, h: number): Float64Array {
  const key = `${w}x${h}`;
  let lp = lowPassCache.get(key);
  if (lp) return lp;
  lp = new Float64Array(w * h);
  const k = -1 / (2 * LOW_PASS_SIGMA * LOW_PASS_SIGMA);
  for (let y = 0; y < h; y++) {
    const fy = (y < h / 2 ? y : y - h) / h;
    for (let x = 0; x < w; x++) {
      const fx = (x < w / 2 ? x : x - w) / w;
      lp[y * w + x] = Math.exp(k * (fx * fx + fy * fy));
    }
  }
  lowPassCache.set(key, lp);
  return lp;
}

export function hannWindow(width: number, height: number): Float64Array {
  const key = `${width}x${height}`;
  let win = windowCache.get(key);
  if (win) return win;
  win = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    const wy = 0.5 - 0.5 * Math.cos((2 * Math.PI * (y + 0.5)) / height);
    for (let x = 0; x < width; x++) {
      win[y * width + x] = wy * (0.5 - 0.5 * Math.cos((2 * Math.PI * (x + 0.5)) / width));
    }
  }
  windowCache.set(key, win);
  return win;
}

export interface SpectrumOptions {
  /** Pixels at or above this luminance are treated as glare and neutralised. */
  glareThreshold?: number;
}

/**
 * Computes the windowed spectrum of a centred `blockW` x `blockH` region of `img`.
 * Specular highlights stay fixed in the image while the label moves, so they are replaced with
 * the block mean to keep them from pulling the correlation peak towards zero shift.
 */
export function blockSpectrum(img: GrayImage, blockW: number, blockH: number, opts: SpectrumOptions = {}): Spectrum {
  if (!isPowerOfTwo(blockW) || !isPowerOfTwo(blockH)) throw new Error('Block size must be a power of two');
  if (blockW > img.width || blockH > img.height) throw new Error('Block larger than image');
  const glare = opts.glareThreshold ?? 250;
  const x0 = (img.width - blockW) >> 1;
  const y0 = (img.height - blockH) >> 1;
  const n = blockW * blockH;
  const re = new Float64Array(n);
  const im = new Float64Array(n);

  let sum = 0;
  let count = 0;
  for (let y = 0; y < blockH; y++) {
    const row = (y0 + y) * img.width + x0;
    for (let x = 0; x < blockW; x++) {
      const v = img.data[row + x];
      if (v < glare) {
        sum += v;
        count++;
      }
    }
  }
  const mean = count ? sum / count : 0;
  const win = hannWindow(blockW, blockH);
  for (let y = 0; y < blockH; y++) {
    const row = (y0 + y) * img.width + x0;
    for (let x = 0; x < blockW; x++) {
      const v = img.data[row + x];
      const i = y * blockW + x;
      re[i] = ((v < glare ? v : mean) - mean) * win[i];
    }
  }
  fft2d(re, im, blockW, blockH);
  return { width: blockW, height: blockH, re, im };
}

const UPSAMPLE = 20;

/**
 * Sub-pixel peak refinement by evaluating the inverse DFT of the normalised cross-power spectrum
 * on a fine grid (step 1/UPSAMPLE) within ±1 px of the integer peak (Guizar-Sicairos et al. 2008).
 * Unlike parabolic fitting this has no bias towards integer shifts, which matters because the
 * per-frame shifts are summed over hundreds of frames.
 */
function refinePeak(cre: Float64Array, cim: Float64Array, w: number, h: number, px: number, py: number): [number, number] {
  const n = 2 * UPSAMPLE + 1;
  const offs = new Float64Array(n);
  for (let i = 0; i < n; i++) offs[i] = (i - UPSAMPLE) / UPSAMPLE;
  const freq = (k: number, size: number) => (k < size / 2 ? k : k - size);

  // Step 1: A[ky][j] = Σ_kx C[ky][kx] · e^{+i2π kx (px+offs[j]) / w}
  const aRe = new Float64Array(h * n);
  const aIm = new Float64Array(h * n);
  const eRe = new Float64Array(w * n);
  const eIm = new Float64Array(w * n);
  for (let kx = 0; kx < w; kx++) {
    const f = freq(kx, w);
    for (let j = 0; j < n; j++) {
      const ang = (2 * Math.PI * f * (px + offs[j])) / w;
      eRe[kx * n + j] = Math.cos(ang);
      eIm[kx * n + j] = Math.sin(ang);
    }
  }
  for (let ky = 0; ky < h; ky++) {
    for (let kx = 0; kx < w; kx++) {
      const r = cre[ky * w + kx];
      const im = cim[ky * w + kx];
      if (r === 0 && im === 0) continue;
      const eo = kx * n;
      const ao = ky * n;
      for (let j = 0; j < n; j++) {
        const er = eRe[eo + j];
        const ei = eIm[eo + j];
        aRe[ao + j] += r * er - im * ei;
        aIm[ao + j] += r * ei + im * er;
      }
    }
  }
  // Step 2: CC[i][j] = Re Σ_ky A[ky][j] · e^{+i2π ky (py+offs[i]) / h}
  const grid = new Float64Array(n * n);
  let best = -Infinity;
  let bi = UPSAMPLE;
  let bj = UPSAMPLE;
  for (let i = 0; i < n; i++) {
    const row = grid.subarray(i * n, i * n + n);
    for (let ky = 0; ky < h; ky++) {
      const ang = (2 * Math.PI * freq(ky, h) * (py + offs[i])) / h;
      const c = Math.cos(ang);
      const sn = Math.sin(ang);
      const ao = ky * n;
      for (let j = 0; j < n; j++) row[j] += aRe[ao + j] * c - aIm[ao + j] * sn;
    }
    for (let j = 0; j < n; j++) {
      if (row[j] > best) {
        best = row[j];
        bi = i;
        bj = j;
      }
    }
  }
  // The surface is smooth on the fine grid, so a parabola gives the last fraction of a step.
  const para = (a: number, b: number, c: number) => {
    const d = a - 2 * b + c;
    return Math.abs(d) < 1e-12 ? 0 : Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d));
  };
  const g = (i: number, j: number) => grid[i * n + j];
  const fx = bj > 0 && bj < n - 1 ? para(g(bi, bj - 1), best, g(bi, bj + 1)) : 0;
  const fy = bi > 0 && bi < n - 1 ? para(g(bi - 1, bj), best, g(bi + 1, bj)) : 0;
  return [offs[bj] + fx / UPSAMPLE, offs[bi] + fy / UPSAMPLE];
}

/** Phase correlation between two spectra of the same size. */
export function phaseCorrelate(reference: Spectrum, current: Spectrum): PhaseCorrelationResult {
  const { width: w, height: h } = reference;
  if (current.width !== w || current.height !== h) throw new Error('Spectrum sizes differ');
  const n = w * h;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const lp = lowPassWeights(w, h);
  let lpSum = 0;
  for (let i = 0; i < n; i++) lpSum += lp[i];
  const norm = n / lpSum; // keeps a perfect match's peak at ~1
  for (let i = 0; i < n; i++) {
    // current * conj(reference), normalised to unit magnitude
    const ar = current.re[i];
    const ai = current.im[i];
    const br = reference.re[i];
    const bi = -reference.im[i];
    const pr = ar * br - ai * bi;
    const pi = ar * bi + ai * br;
    const mag = Math.hypot(pr, pi);
    if (mag > 1e-9) {
      const f = (lp[i] * norm) / mag;
      re[i] = pr * f;
      im[i] = pi * f;
    }
  }
  const cre = re.slice();
  const cim = im.slice();
  fft2d(re, im, w, h, true);

  let best = -Infinity;
  let bx = 0;
  let by = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = re[y * w + x];
      if (v > best) {
        best = v;
        bx = x;
        by = y;
      }
    }
  }

  const pxSigned = bx > w / 2 ? bx - w : bx;
  const pySigned = by > h / 2 ? by - h : by;
  const [subX, subY] = refinePeak(cre, cim, w, h, pxSigned, pySigned);

  // Peak-to-sidelobe ratio, excluding an 11x11 neighbourhood of the peak.
  let s = 0;
  let s2 = 0;
  let cnt = 0;
  for (let y = 0; y < h; y++) {
    const dyw = Math.min(Math.abs(y - by), h - Math.abs(y - by));
    for (let x = 0; x < w; x++) {
      const dxw = Math.min(Math.abs(x - bx), w - Math.abs(x - bx));
      if (dxw <= 5 && dyw <= 5) continue;
      const v = re[y * w + x];
      s += v;
      s2 += v * v;
      cnt++;
    }
  }
  const mu = cnt ? s / cnt : 0;
  const sd = cnt ? Math.sqrt(Math.max(1e-12, s2 / cnt - mu * mu)) : 1;

  const dx = pxSigned + subX;
  const dy = pySigned + subY;
  return { dx, dy, peak: best, psr: (best - mu) / sd };
}
