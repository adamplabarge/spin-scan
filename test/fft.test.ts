import { describe, expect, it } from 'vitest';
import { fft1d, fft2d } from '../src/core/fft';
import { blockSpectrum, phaseCorrelate } from '../src/core/phaseCorrelation';
import { createSyntheticLabel } from '../src/testing';
import { toGray } from '../src/core/image';
import type { GrayImage } from '../src/core/types';

describe('fft', () => {
  it('round-trips 1D and 2D data', () => {
    const re = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i) + i * 0.1);
    const im = new Float64Array(64);
    const orig = re.slice();
    fft1d(re, im);
    fft1d(re, im, true);
    re.forEach((v, i) => expect(v).toBeCloseTo(orig[i], 9));

    const re2 = Float64Array.from({ length: 32 * 16 }, (_, i) => (i * 7919) % 13);
    const im2 = new Float64Array(re2.length);
    const orig2 = re2.slice();
    fft2d(re2, im2, 32, 16);
    fft2d(re2, im2, 32, 16, true);
    re2.forEach((v, i) => expect(v).toBeCloseTo(orig2[i], 9));
  });

  it('matches a naive DFT', () => {
    const n = 16;
    const re = Float64Array.from({ length: n }, (_, i) => Math.cos(i * 0.7) * (i % 3));
    const im = new Float64Array(n);
    const expected = Array.from({ length: n }, (_, k) => {
      let sr = 0, si = 0;
      for (let t = 0; t < n; t++) {
        sr += re[t] * Math.cos((-2 * Math.PI * k * t) / n);
        si += re[t] * Math.sin((-2 * Math.PI * k * t) / n);
      }
      return [sr, si];
    });
    fft1d(re, im);
    expected.forEach(([r, i], k) => {
      expect(re[k]).toBeCloseTo(r, 9);
      expect(im[k]).toBeCloseTo(i, 9);
    });
  });
});

function shiftedCrop(src: GrayImage, x0: number, y0: number, w: number, h: number): GrayImage {
  // Sub-pixel shift via bilinear interpolation.
  const out = { width: w, height: h, data: new Float32Array(w * h) };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x + x0, sy = y + y0;
      const ix = Math.floor(sx), iy = Math.floor(sy);
      const fx = sx - ix, fy = sy - iy;
      const g = (a: number, b: number) => src.data[b * src.width + a];
      out.data[y * w + x] =
        g(ix, iy) * (1 - fx) * (1 - fy) + g(ix + 1, iy) * fx * (1 - fy) + g(ix, iy + 1) * (1 - fx) * fy + g(ix + 1, iy + 1) * fx * fy;
    }
  }
  return out;
}

describe('phaseCorrelate', () => {
  const base = toGray(createSyntheticLabel(400, 300, 3));
  const cases: [number, number][] = [[0, 0], [12, 0], [-20, 3], [7.5, -2], [-33.25, 1.5]];
  it.each(cases)('recovers content shift (%f, %f)', (dx, dy) => {
    const ref = shiftedCrop(base, 100, 60, 128, 128);
    // Content moved by +dx means current(x) = ref(x - dx) -> sample source at x - dx.
    const cur = shiftedCrop(base, 100 - dx, 60 - dy, 128, 128);
    const r = phaseCorrelate(blockSpectrum(ref, 128, 128), blockSpectrum(cur, 128, 128));
    expect(r.dx).toBeCloseTo(dx, 0);
    expect(Math.abs(r.dx - dx)).toBeLessThan(0.35);
    expect(Math.abs(r.dy - dy)).toBeLessThan(0.35);
    expect(r.peak).toBeGreaterThan(0.4);
  });

  it('reports low confidence for unrelated content', () => {
    const a = shiftedCrop(toGray(createSyntheticLabel(300, 300, 1)), 10, 10, 128, 128);
    const b = shiftedCrop(toGray(createSyntheticLabel(300, 300, 99)), 10, 10, 128, 128);
    const r = phaseCorrelate(blockSpectrum(a, 128, 128), blockSpectrum(b, 128, 128));
    expect(r.peak).toBeLessThan(0.25);
  });
});
