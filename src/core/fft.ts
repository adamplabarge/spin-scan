const bitRevCache = new Map<number, Uint32Array>();
const twiddleCache = new Map<number, { cos: Float64Array; sin: Float64Array }>();

export function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

export function floorPowerOfTwo(n: number): number {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

function bitReverse(n: number): Uint32Array {
  let rev = bitRevCache.get(n);
  if (rev) return rev;
  rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0, v = i; b < bits; b++, v >>= 1) r = (r << 1) | (v & 1);
    rev[i] = r;
  }
  bitRevCache.set(n, rev);
  return rev;
}

function twiddles(n: number) {
  let t = twiddleCache.get(n);
  if (t) return t;
  const half = n >> 1;
  t = { cos: new Float64Array(half), sin: new Float64Array(half) };
  for (let i = 0; i < half; i++) {
    t.cos[i] = Math.cos((2 * Math.PI * i) / n);
    t.sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  twiddleCache.set(n, t);
  return t;
}

/** In-place iterative radix-2 FFT on `n` complex values read with the given offset/stride. */
function fftStrided(
  re: Float64Array,
  im: Float64Array,
  n: number,
  offset: number,
  stride: number,
  inverse: boolean,
  bufRe: Float64Array,
  bufIm: Float64Array,
): void {
  const rev = bitReverse(n);
  for (let i = 0; i < n; i++) {
    const j = offset + rev[i] * stride;
    bufRe[i] = re[j];
    bufIm[i] = im[j];
  }
  const { cos, sin } = twiddles(n);
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sign * sin[k * step];
        const a = start + k;
        const b = a + half;
        const tr = bufRe[b] * wr - bufIm[b] * wi;
        const ti = bufRe[b] * wi + bufIm[b] * wr;
        bufRe[b] = bufRe[a] - tr;
        bufIm[b] = bufIm[a] - ti;
        bufRe[a] += tr;
        bufIm[a] += ti;
      }
    }
  }
  const scale = inverse ? 1 / n : 1;
  for (let i = 0; i < n; i++) {
    const j = offset + i * stride;
    re[j] = bufRe[i] * scale;
    im[j] = bufIm[i] * scale;
  }
}

export function fft1d(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (!isPowerOfTwo(n)) throw new Error(`FFT size must be a power of two, got ${n}`);
  fftStrided(re, im, n, 0, 1, inverse, new Float64Array(n), new Float64Array(n));
}

/** In-place 2D FFT of a row-major `width` x `height` complex array. Both sizes must be powers of two. */
export function fft2d(re: Float64Array, im: Float64Array, width: number, height: number, inverse = false): void {
  if (!isPowerOfTwo(width) || !isPowerOfTwo(height)) {
    throw new Error(`FFT sizes must be powers of two, got ${width}x${height}`);
  }
  const n = Math.max(width, height);
  const bufRe = new Float64Array(n);
  const bufIm = new Float64Array(n);
  for (let y = 0; y < height; y++) fftStrided(re, im, width, y * width, 1, inverse, bufRe, bufIm);
  for (let x = 0; x < width; x++) fftStrided(re, im, height, x, width, inverse, bufRe, bufIm);
}
