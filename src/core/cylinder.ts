import { createGrayImage, createRGBAImage, luminance, median } from './image';
import type { CylinderGeometry, GrayImage, RGBAImage } from './types';

/*
 * Model: orthographic view of a vertical cylinder of radius R whose axis projects to x = centerX.
 * A surface point at angle φ from the camera-facing meridian appears at x = centerX + R·sin(φ)
 * and lies at arc length a = R·φ along the surface. "Unwrapping" resamples the image so that
 * columns are equally spaced in arc length; in that space rotating the bottle becomes a pure
 * horizontal translation, which is what makes frame registration and stitching straightforward.
 */

/** Screen x (continuous coordinates) of a surface point at arc length `arc` from the centre meridian. */
export function arcToScreenX(geom: CylinderGeometry, arc: number): number {
  const t = arc / geom.radius;
  return geom.centerX + geom.radius * Math.sin(t > Math.PI / 2 ? Math.PI / 2 : t < -Math.PI / 2 ? -Math.PI / 2 : t);
}

/** Width (in arc-length pixels) of the unwrapped band spanning ±maxAngle around the centre. */
export function unwrappedWidth(radius: number, maxAngleRad: number): number {
  return 2 * Math.floor(radius * maxAngleRad);
}

/**
 * Unwraps the central ±maxAngle band of the cylinder into a grayscale image, downscaled by `downscale`
 * (box-averaged), for use in motion estimation.
 */
export function unwrapGray(frame: RGBAImage, geom: CylinderGeometry, maxAngleRad: number, downscale = 1): GrayImage {
  const d = Math.max(1, Math.floor(downscale));
  const wu = unwrappedWidth(geom.radius, maxAngleRad);
  const outW = Math.floor(wu / d);
  const outH = Math.floor(frame.height / d);
  const out = createGrayImage(outW, outH);
  const fw = frame.width;
  const src = frame.data;

  // Precompute sample positions for each sub-column.
  const subCols = outW * d;
  const x0s = new Int32Array(subCols);
  const fxs = new Float32Array(subCols);
  for (let u = 0; u < subCols; u++) {
    const x = arcToScreenX(geom, u + 0.5 - wu / 2) - 0.5;
    let x0 = Math.floor(x);
    let fx = x - x0;
    if (x0 < 0) {
      x0 = 0;
      fx = 0;
    } else if (x0 >= fw - 1) {
      x0 = fw - 2;
      fx = 1;
    }
    x0s[u] = x0;
    fxs[u] = fx;
  }

  const rowLum = new Float32Array(subCols);
  const inv = 1 / (d * d);
  for (let oy = 0; oy < outH; oy++) {
    rowLum.fill(0);
    for (let yy = 0; yy < d; yy++) {
      const rowBase = (oy * d + yy) * fw;
      for (let u = 0; u < subCols; u++) {
        const i = (rowBase + x0s[u]) * 4;
        const f = fxs[u];
        const l0 = luminance(src[i], src[i + 1], src[i + 2]);
        const l1 = luminance(src[i + 4], src[i + 5], src[i + 6]);
        rowLum[u] += l0 + (l1 - l0) * f;
      }
    }
    const rowOut = oy * outW;
    for (let ox = 0; ox < outW; ox++) {
      let s = 0;
      for (let k = 0; k < d; k++) s += rowLum[ox * d + k];
      out.data[rowOut + ox] = s * inv;
    }
  }
  return out;
}

/** Unwraps the central ±maxAngle band of the cylinder into a colour image (handy for previews/debugging). */
export function unwrapRGBA(frame: RGBAImage, geom: CylinderGeometry, maxAngleRad: number): RGBAImage {
  const wu = unwrappedWidth(geom.radius, maxAngleRad);
  const out = createRGBAImage(wu, frame.height);
  const fw = frame.width;
  for (let u = 0; u < wu; u++) {
    const x = arcToScreenX(geom, u + 0.5 - wu / 2) - 0.5;
    const x0 = Math.max(0, Math.min(fw - 2, Math.floor(x)));
    const fx = Math.max(0, Math.min(1, x - x0));
    for (let y = 0; y < frame.height; y++) {
      const i = (y * fw + x0) * 4;
      const o = (y * wu + u) * 4;
      for (let c = 0; c < 3; c++) out.data[o + c] = frame.data[i + c] + (frame.data[i + 4 + c] - frame.data[i + c]) * fx;
      out.data[o + 3] = 255;
    }
  }
  return out;
}

export interface EdgeDetectionOptions {
  /** Expected geometry; the search is restricted to ±tolerance around its edges. */
  hint?: CylinderGeometry;
  /** Relative tolerance on the hint radius (default 0.3). */
  tolerance?: number;
  /** Minimum fraction of rows that must show an edge at the silhouette column (default 0.45). */
  minEdgeFraction?: number;
}

/**
 * Finds the left/right silhouette of an upright cylinder in a grayscale frame.
 * Silhouette edges are vertical and span (almost) the full height, whereas label text edges
 * are short, so each column is scored by the fraction of rows that contain a strong horizontal gradient.
 */
export function detectCylinderEdges(gray: GrayImage, opts: EdgeDetectionOptions = {}): CylinderGeometry | null {
  const { width: w, height: h, data } = gray;
  if (w < 16 || h < 8) return null;
  const tol = opts.tolerance ?? 0.3;
  const minFrac = opts.minEdgeFraction ?? 0.45;

  const grads = new Float32Array(w * h);
  const sample: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 1; x < w - 1; x++) {
      const g = Math.abs(data[y * w + x + 1] - data[y * w + x - 1]);
      grads[y * w + x] = g;
      if ((x + y * 7) % 13 === 0) sample.push(g);
    }
  }
  const thr = Math.max(8, 3 * median(sample));

  const profile = new Float32Array(w);
  for (let x = 1; x < w - 1; x++) {
    let c = 0;
    for (let y = 0; y < h; y++) {
      if (grads[y * w + x] > thr) c++;
    }
    profile[x] = c / h;
  }
  // Silhouette edges may be blurred over a couple of columns; take a local max over ±1 column.
  const smooth = new Float32Array(w);
  for (let x = 1; x < w - 1; x++) smooth[x] = Math.max(profile[x - 1], profile[x], profile[x + 1]);

  let lLo = 1;
  let lHi = Math.floor(w * 0.45);
  let rLo = Math.ceil(w * 0.55);
  let rHi = w - 2;
  if (opts.hint) {
    const { centerX: cx, radius: r } = opts.hint;
    lLo = Math.max(1, Math.floor(cx - r * (1 + tol)));
    lHi = Math.min(w - 2, Math.ceil(cx - r * (1 - tol)));
    rLo = Math.max(1, Math.floor(cx + r * (1 - tol)));
    rHi = Math.min(w - 2, Math.ceil(cx + r * (1 + tol)));
  }
  const argmax = (lo: number, hi: number) => {
    let best = -1;
    let bi = -1;
    for (let x = lo; x <= hi; x++) {
      if (smooth[x] > best) {
        best = smooth[x];
        bi = x;
      }
    }
    return { x: bi, v: best };
  };
  const left = argmax(lLo, lHi);
  const right = argmax(rLo, rHi);
  if (left.x < 0 || right.x < 0 || left.v < minFrac || right.v < minFrac || right.x - left.x < w * 0.2) return null;

  // Refine to the exact column with the strongest profile in the ±1 neighbourhood.
  const refine = (x: number) => {
    let bx = x;
    for (let k = x - 1; k <= x + 1; k++) if (profile[k] > profile[bx]) bx = k;
    return bx;
  };
  // A central-difference gradient at column x straddles the boundary between x-1|x and x|x+1,
  // so the silhouette boundary sits at x + 0.5 (continuous coordinates).
  const l = refine(left.x) + 0.5;
  const r = refine(right.x) + 0.5;
  return { centerX: (l + r) / 2, radius: (r - l) / 2 };
}
