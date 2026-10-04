import { createRGBAImage, luminance } from './image';
import type { RGBAImage } from './types';

/**
 * Weighted accumulator indexed by surface coordinate `s` (arc-length pixels, may be negative)
 * that grows in either direction as the bottle is rotated.
 */
export class PanoramaAccumulator {
  readonly height: number;
  private cols = new Map<number, Float32Array>();
  private _min = Infinity;
  private _max = -Infinity;

  constructor(height: number) {
    this.height = height;
  }

  get minS(): number {
    return this._min;
  }
  get maxS(): number {
    return this._max;
  }
  get span(): number {
    return this._max >= this._min ? this._max - this._min + 1 : 0;
  }

  /** Returns the column buffer for `s` (layout: [r, g, b, weight] per row), creating it on demand. */
  column(s: number): Float32Array {
    let c = this.cols.get(s);
    if (!c) {
      c = new Float32Array(this.height * 4);
      this.cols.set(s, c);
      if (s < this._min) this._min = s;
      if (s > this._max) this._max = s;
    }
    return c;
  }

  /** Normalised grayscale of column `s`, sampling every `rowStep`-th row (NaN where empty / missing). */
  columnGray(s: number, rowStep = 1): Float32Array {
    const n = Math.ceil(this.height / rowStep);
    const out = new Float32Array(n).fill(NaN);
    const c = this.cols.get(s);
    if (!c) return out;
    for (let k = 0, y = 0; y < this.height; k++, y += rowStep) {
      const i = y * 4;
      const w = c[i + 3];
      if (w > 1e-6) out[k] = luminance(c[i] / w, c[i + 1] / w, c[i + 2] / w);
    }
    return out;
  }

  /** Dense row-major accumulator covering [minS, maxS]; layout [r, g, b, w] per pixel. */
  toDense(): DenseAccumulator {
    const width = this.span;
    const h = this.height;
    const acc = new Float32Array(width * h * 4);
    for (let x = 0; x < width; x++) {
      const c = this.cols.get(this._min + x);
      if (!c) continue;
      for (let y = 0; y < h; y++) {
        const o = (y * width + x) * 4;
        const i = y * 4;
        acc[o] = c[i];
        acc[o + 1] = c[i + 1];
        acc[o + 2] = c[i + 2];
        acc[o + 3] = c[i + 3];
      }
    }
    return { width, height: h, acc };
  }
}

export interface DenseAccumulator {
  width: number;
  height: number;
  acc: Float32Array;
}

const EPS = 1e-6;

/** Normalised grayscale of an accumulator; pixels without data are NaN. */
export function accumulatorGray(d: DenseAccumulator): Float32Array {
  const out = new Float32Array(d.width * d.height);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    const w = d.acc[j + 3];
    out[i] = w > EPS ? luminance(d.acc[j] / w, d.acc[j + 1] / w, d.acc[j + 2] / w) : NaN;
  }
  return out;
}

export interface PeriodSearchResult {
  period: number;
  score: number;
}

/**
 * Finds the revolution period by matching the first `window` columns of the panorama against
 * columns shifted by candidate periods near `expected` (normalised cross-correlation).
 */
export function findPeriod(
  gray: Float32Array,
  width: number,
  height: number,
  expected: number,
  opts: { searchRange?: number; window?: number } = {},
): PeriodSearchResult | null {
  const range = opts.searchRange ?? 0.15;
  const win = Math.max(8, Math.round(opts.window ?? expected * 0.06));
  const pMin = Math.max(win, Math.floor(expected * (1 - range)));
  const pMax = Math.min(width - win, Math.ceil(expected * (1 + range)));
  if (pMax < pMin) return null;

  const rowStep = height > 300 ? 2 : 1;
  const score = (p: number) => {
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
    for (let y = 0; y < height; y += rowStep) {
      const row = y * width;
      for (let x = 0; x < win; x++) {
        const a = gray[row + x];
        const b = gray[row + x + p];
        if (a !== a || b !== b) continue; // NaN check
        sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; n++;
      }
    }
    if (n < 16) return -1;
    const cov = sab / n - (sa / n) * (sb / n);
    const va = saa / n - (sa / n) ** 2;
    const vb = sbb / n - (sb / n) ** 2;
    return va > EPS && vb > EPS ? cov / Math.sqrt(va * vb) : -1;
  };

  let best: PeriodSearchResult | null = null;
  for (let p = pMin; p <= pMax; p++) {
    const s = score(p);
    if (!best || s > best.score) best = { period: p, score: s };
  }
  return best;
}

/**
 * Period search that doesn't trust the radius estimate: every period from `minPeriod` up is
 * scored by the NCC of the *whole* overlap (columns x and x+p for all x), not just a window at
 * the start. Repeated print within one label (Rx labels repeat name, phone and drug) only lines
 * up locally, so it scores poorly over the full overlap. If several turns were captured, the
 * shortest period that scores almost as well as the best is returned.
 */
export function findLoopPeriod(
  gray: Float32Array,
  width: number,
  height: number,
  minPeriod: number,
  minOverlap: number,
): PeriodSearchResult | null {
  const ov = Math.max(16, minOverlap);
  const maxPeriod = width - ov;
  if (maxPeriod < minPeriod) return null;
  const rowStep = Math.max(1, Math.round(height / 64));
  const score = (p: number, colStep: number) => {
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
    for (let y = 0; y < height; y += rowStep) {
      const row = y * width;
      for (let x = 0; x + p < width; x += colStep) {
        const a = gray[row + x];
        const b = gray[row + x + p];
        if (a !== a || b !== b) continue;
        sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; n++;
      }
    }
    if (n < 64) return -1;
    const cov = sab / n - (sa / n) * (sb / n);
    const va = saa / n - (sa / n) ** 2;
    const vb = sbb / n - (sb / n) ** 2;
    return va > EPS && vb > EPS ? cov / Math.sqrt(va * vb) : -1;
  };
  // Coarse pass (every 2nd period, every 2nd column), then refine around good candidates.
  const coarse: PeriodSearchResult[] = [];
  for (let p = minPeriod; p <= maxPeriod; p += 2) coarse.push({ period: p, score: score(p, 2) });
  const refine = (c: PeriodSearchResult) => {
    let best = c;
    for (let p = Math.max(minPeriod, c.period - 2); p <= Math.min(maxPeriod, c.period + 2); p++) {
      const s = score(p, 1);
      if (s > best.score || best === c) best = { period: p, score: s };
    }
    return best;
  };
  let top = coarse[0];
  for (const c of coarse) if (c.score > top.score) top = c;
  const best = refine(top);
  // Prefer a shorter period (one turn) over its multiples when it matches nearly as well.
  for (const k of [3, 2]) {
    const sub = best.period / k;
    if (sub < minPeriod) continue;
    let local: PeriodSearchResult | null = null;
    for (const c of coarse) {
      if (Math.abs(c.period - sub) <= sub * 0.03 && (!local || c.score > local.score)) local = c;
    }
    if (local && local.score >= best.score * 0.9) return refine(local);
  }
  return best;
}

export interface OverlapSearchOptions {
  /** Which end of the panorama the scan started at (the other end is still growing). */
  startAtMin: boolean;
  /** Width of the reference window, in columns. */
  window: number;
  /** Offset of the reference window from the start end, in columns. */
  offset: number;
  /** Smallest period to consider. */
  minPeriod: number;
  /** Row subsampling. Default 1. */
  rowStep?: number;
}

/**
 * Live loop-closure check while scanning: looks for the reference window near the start of the
 * panorama again further along, i.e. detects that the bottle has come round to content that was
 * already captured. Returns the best period (distance in columns) and its NCC score.
 */
export function findOverlap(pano: PanoramaAccumulator, o: OverlapSearchOptions): PeriodSearchResult | null {
  const span = pano.span;
  const pMax = span - o.offset - o.window;
  if (pMax < o.minPeriod || o.window < 4) return null;
  const rowStep = o.rowStep ?? 1;
  const dir = o.startAtMin ? 1 : -1;
  const s0 = o.startAtMin ? pano.minS : pano.maxS;
  const colAt = (d: number) => pano.columnGray(s0 + dir * d, rowStep);

  const ref: Float32Array[] = [];
  for (let x = 0; x < o.window; x++) ref.push(colAt(o.offset + x));
  // Columns at distance offset+minPeriod … offset+pMax+window-1 from the start, computed once.
  const firstD = o.offset + o.minPeriod;
  const cand: Float32Array[] = [];
  for (let d = firstD; d < o.offset + pMax + o.window; d++) cand.push(colAt(d));

  let best: PeriodSearchResult | null = null;
  for (let p = o.minPeriod; p <= pMax; p++) {
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
    for (let x = 0; x < o.window; x++) {
      const a = ref[x];
      const b = cand[p - o.minPeriod + x];
      for (let k = 0; k < a.length; k++) {
        const va = a[k];
        const vb = b[k];
        if (va !== va || vb !== vb) continue;
        sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb; n++;
      }
    }
    if (n < 16) continue;
    const cov = sab / n - (sa / n) * (sb / n);
    const varA = saa / n - (sa / n) ** 2;
    const varB = sbb / n - (sb / n) ** 2;
    const score = varA > EPS && varB > EPS ? cov / Math.sqrt(varA * varB) : -1;
    if (!best || score > best.score) best = { period: p, score };
  }
  return best;
}

/** Offset (from the start end) of the most textured `window`-wide stretch within the first `searchWidth` columns. */
export function mostTexturedOffset(
  pano: PanoramaAccumulator,
  startAtMin: boolean,
  window: number,
  searchWidth: number,
  rowStep = 1,
): number {
  const dir = startAtMin ? 1 : -1;
  const s0 = startAtMin ? pano.minS : pano.maxS;
  const cols: Float32Array[] = [];
  for (let d = 0; d < searchWidth; d++) cols.push(pano.columnGray(s0 + dir * d, rowStep));
  // Texture = mean squared horizontal gradient.
  const energy = new Float64Array(searchWidth);
  for (let d = 1; d < searchWidth; d++) {
    let e = 0;
    for (let k = 0; k < cols[d].length; k++) {
      const g = cols[d][k] - cols[d - 1][k];
      if (g === g) e += g * g;
    }
    energy[d] = e;
  }
  let bestOff = 0;
  let bestE = -1;
  for (let off = 0; off + window <= searchWidth; off += 2) {
    let e = 0;
    for (let x = 0; x < window; x++) e += energy[off + x];
    if (e > bestE) {
      bestE = e;
      bestOff = off;
    }
  }
  return bestOff;
}

/**
 * Folds an accumulator that covers more than one revolution into exactly `period` columns.
 * The first lap is kept; the next lap is cross-faded in over a narrow band at the wrap-around
 * so the seam is invisible, and fills gaps in the first lap.
 */
export function foldAccumulator(d: DenseAccumulator, period: number): DenseAccumulator {
  const { width, height, acc } = d;
  const out = new Float32Array(period * height * 4);
  const overlap = Math.max(0, width - period);
  // Cross-fade only a narrow band at the wrap-around. Blending whole laps ghosts the text,
  // because small tracking drift means the laps never line up exactly.
  const fade = Math.min(overlap, Math.max(8, Math.round(period * 0.04)));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < period; x++) {
      const o = (y * period + x) * 4;
      const a = (y * width + x) * 4;
      if (x < fade) {
        const b = (y * width + x + period) * 4;
        const t = (x + 0.5) / fade;
        const wa = acc[a + 3];
        const wb = acc[b + 3];
        // Each lap is normalised first, then cross-faded (falling back to whichever lap has data).
        let ta = wa > EPS ? t : 0;
        let tb = wb > EPS ? 1 - t : 0;
        const tsum = ta + tb;
        if (tsum <= 0) continue;
        ta /= tsum;
        tb /= tsum;
        for (let c = 0; c < 3; c++) {
          out[o + c] = (wa > EPS ? (acc[a + c] / wa) * ta : 0) + (wb > EPS ? (acc[b + c] / wb) * tb : 0);
        }
        out[o + 3] = 1;
      } else if (acc[a + 3] <= EPS && x < overlap) {
        // Gap in the first lap: take the next lap.
        const b = (y * width + x + period) * 4;
        out[o] = acc[b];
        out[o + 1] = acc[b + 1];
        out[o + 2] = acc[b + 2];
        out[o + 3] = acc[b + 3];
      } else {
        out[o] = acc[a];
        out[o + 1] = acc[a + 1];
        out[o + 2] = acc[a + 2];
        out[o + 3] = acc[a + 3];
      }
    }
  }
  return { width: period, height, acc: out };
}

/** Rotates a cyclic accumulator so that column `offset` becomes column 0. */
export function rollAccumulator(d: DenseAccumulator, offset: number): DenseAccumulator {
  const { width, height, acc } = d;
  const k = ((offset % width) + width) % width;
  if (k === 0) return d;
  const out = new Float32Array(acc.length);
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    out.set(acc.subarray(row + k * 4, row + width * 4), row);
    out.set(acc.subarray(row, row + k * 4), row + (width - k) * 4);
  }
  return { width, height, acc: out };
}

/**
 * Picks the column with the least image detail (smoothed horizontal gradient energy) — typically
 * blank label area — so the wrap-around seam doesn't cut through text.
 */
export function findQuietSeam(gray: Float32Array, width: number, height: number): number {
  const energy = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const a = gray[row + x];
      const b = gray[row + ((x + 1) % width)];
      if (a === a && b === b) energy[x] += Math.abs(b - a);
    }
  }
  const half = Math.max(2, Math.round(width * 0.01));
  let best = 0;
  let bestE = Infinity;
  for (let x = 0; x < width; x++) {
    let e = 0;
    for (let k = -half; k <= half; k++) e += energy[(x + k + width) % width];
    if (e < bestE) {
      bestE = e;
      best = x;
    }
  }
  return best;
}

/** Returns [top, bottom) rows where at least `minFraction` of pixels have data. */
export function validRowRange(d: DenseAccumulator, minFraction = 0.9): [number, number] {
  const { width, height, acc } = d;
  const ok = (y: number) => {
    let c = 0;
    for (let x = 0; x < width; x++) if (acc[(y * width + x) * 4 + 3] > EPS) c++;
    return c >= width * minFraction;
  };
  let top = 0;
  while (top < height && !ok(top)) top++;
  let bottom = height;
  while (bottom > top && !ok(bottom - 1)) bottom--;
  return [top, bottom];
}

/**
 * Normalises the accumulator into an RGBA image. Missing pixels are linearly interpolated along
 * each row (cyclically when `cyclic`). Returns the number of fully empty columns that were filled.
 */
export function renderAccumulator(
  d: DenseAccumulator,
  rows: [number, number] = [0, d.height],
  cyclic = false,
): { image: RGBAImage; filledGapColumns: number } {
  const { width, acc } = d;
  const [top, bottom] = rows;
  const h = Math.max(0, bottom - top);
  const img = createRGBAImage(width, h);
  let emptyCols = 0;
  for (let x = 0; x < width; x++) {
    let any = false;
    for (let y = top; y < bottom && !any; y++) any = acc[(y * width + x) * 4 + 3] > EPS;
    if (!any) emptyCols++;
  }

  const rowRGB = new Float32Array(width * 3);
  const valid = new Uint8Array(width);
  for (let y = 0; y < h; y++) {
    const src = (y + top) * width;
    let nValid = 0;
    for (let x = 0; x < width; x++) {
      const i = (src + x) * 4;
      const w = acc[i + 3];
      valid[x] = w > EPS ? 1 : 0;
      if (valid[x]) {
        nValid++;
        rowRGB[x * 3] = acc[i] / w;
        rowRGB[x * 3 + 1] = acc[i + 1] / w;
        rowRGB[x * 3 + 2] = acc[i + 2] / w;
      }
    }
    if (nValid > 0 && nValid < width) fillRow(rowRGB, valid, width, cyclic);
    const out = y * width * 4;
    for (let x = 0; x < width; x++) {
      img.data[out + x * 4] = rowRGB[x * 3];
      img.data[out + x * 4 + 1] = rowRGB[x * 3 + 1];
      img.data[out + x * 4 + 2] = rowRGB[x * 3 + 2];
      img.data[out + x * 4 + 3] = 255;
    }
  }
  return { image: img, filledGapColumns: emptyCols };
}

function fillRow(rgb: Float32Array, valid: Uint8Array, width: number, cyclic: boolean): void {
  const idx: number[] = [];
  for (let x = 0; x < width; x++) if (valid[x]) idx.push(x);
  const lerpSpan = (a: number, b: number) => {
    const ai = (a % width) * 3;
    const bi = (b % width) * 3;
    for (let x = a + 1; x < b; x++) {
      const t = (x - a) / (b - a);
      const xi = (x % width) * 3;
      for (let c = 0; c < 3; c++) rgb[xi + c] = rgb[ai + c] * (1 - t) + rgb[bi + c] * t;
    }
  };
  for (let k = 0; k + 1 < idx.length; k++) if (idx[k + 1] - idx[k] > 1) lerpSpan(idx[k], idx[k + 1]);
  const first = idx[0];
  const last = idx[idx.length - 1];
  if (cyclic) {
    lerpSpan(last, first + width);
  } else {
    for (let x = 0; x < first; x++) for (let c = 0; c < 3; c++) rgb[x * 3 + c] = rgb[first * 3 + c];
    for (let x = last + 1; x < width; x++) for (let c = 0; c < 3; c++) rgb[x * 3 + c] = rgb[last * 3 + c];
  }
}
