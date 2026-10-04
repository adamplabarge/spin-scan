import { describe, expect, it } from 'vitest';
import { CylinderStitcher } from '../src/core/stitcher';
import { toGray } from '../src/core/image';
import { createSyntheticLabel, renderCylinderFrame, type RenderCylinderOptions } from '../src/testing';
import type { RGBAImage } from '../src/core/types';

const R = 120;
const CIRC = 2 * Math.PI * R;
const H = 240;

function scene(extra: Partial<RenderCylinderOptions> = {}) {
  const label = createSyntheticLabel(Math.round(CIRC), H, 11);
  const opts: RenderCylinderOptions = { frameWidth: 300, frameHeight: H, centerX: 150, radius: R, ...extra };
  return { label, opts };
}

function ncc(a: Float32Array, aw: number, ax: number, b: Float32Array, bw: number, bx: number, w: number, rows: number[]) {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
  for (const y of rows) {
    for (let x = 0; x < w; x++) {
      const va = a[y * aw + ((ax + x) % aw)];
      const vb = b[y * bw + (((bx + x) % bw) + bw) % bw];
      sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb; n++;
    }
  }
  const cov = sab / n - (sa / n) * (sb / n);
  return cov / Math.sqrt((saa / n - (sa / n) ** 2) * (sbb / n - (sb / n) ** 2));
}

/**
 * Similarity between the stitched result and the ground-truth label: find the global cyclic
 * offset, then score 100 px chunks each allowed a small local re-alignment. This tolerates the
 * sub-percent overall scale differences that are expected from accumulated sub-pixel drift.
 */
function labelSimilarity(result: RGBAImage, label: RGBAImage): number {
  const a = toGray(result);
  const b = toGray(label);
  const h = Math.min(a.height, b.height);
  const rows: number[] = [];
  for (let y = 10; y < h - 10; y += 2) rows.push(y);
  const chunk = 100;
  let bestOff = 0, best = -1;
  for (let off = 0; off < b.width; off++) {
    const v = ncc(a.data, a.width, 0, b.data, b.width, off, chunk, rows);
    if (v > best) { best = v; bestOff = off; }
  }
  const scores: number[] = [];
  for (let x = 0; x + chunk <= a.width; x += chunk) {
    const expected = bestOff + Math.round((x * b.width) / a.width);
    let s = -1;
    for (let d = -8; d <= 8; d++) s = Math.max(s, ncc(a.data, a.width, x, b.data, b.width, expected + d, chunk, rows));
    scores.push(s);
  }
  return scores.reduce((p, c) => p + c, 0) / scores.length;
}

function run(stitcher: CylinderStitcher, label: RGBAImage, opts: RenderCylinderOptions, degPerFrame: number, fps = 15, maxFrames = 400) {
  let angle = 0;
  const analyses = [];
  for (let i = 0; i < maxFrames && !stitcher.isComplete; i++) {
    analyses.push(stitcher.addFrame(renderCylinderFrame(label, angle, opts), (i * 1000) / fps));
    angle += (degPerFrame * Math.PI) / 180;
  }
  return analyses;
}

describe('CylinderStitcher', () => {
  it('reconstructs a full label from a rotating bottle', () => {
    const { label, opts } = scene();
    const s = new CylinderStitcher({ geometry: { centerX: 150, radius: 125 } });
    const analyses = run(s, label, opts, 3);
    expect(s.isComplete).toBe(true);
    const g = s.getGeometry()!;
    expect(Math.abs(g.radius - R)).toBeLessThan(2);

    const res = s.finish();
    expect(res.loopClosed).toBe(true);
    expect(Math.abs(res.periodPx - CIRC) / CIRC).toBeLessThan(0.02);
    expect(res.image.width).toBe(res.periodPx);
    expect(res.image.height).toBeGreaterThan(H * 0.9);
    expect(res.filledGapColumns).toBe(0);

    const tracked = analyses.filter((a) => a.phase !== 'calibrating');
    expect(tracked.every((a) => a.tracked)).toBe(true);
    const speeds = tracked.slice(5).map((a) => a.speed.degPerSec);
    // Content moves left when angle increases → negative speed; 3°/frame @15fps = 45°/s
    expect(Math.abs(speeds[speeds.length - 1] + 45)).toBeLessThan(3);

    expect(labelSimilarity(res.image, label)).toBeGreaterThan(0.9);
  });

  it('works in the opposite direction with glare and noise', () => {
    const { label, opts } = scene({ glareAt: 0.15, noise: 6 });
    const s = new CylinderStitcher({ geometry: { centerX: 150, radius: 125 } });
    run(s, label, opts, -2.5);
    expect(s.isComplete).toBe(true);
    expect(s.getLastAnalysis()!.direction).toBe('right');
    const res = s.finish();
    expect(res.loopClosed).toBe(true);
    expect(Math.abs(res.periodPx - CIRC) / CIRC).toBeLessThan(0.02);
    expect(labelSimilarity(res.image, label)).toBeGreaterThan(0.8);
  });

  it('stops when it comes back round to the start, even with a wrong radius estimate', () => {
    const { label, opts } = scene();
    // Edge detection off and radius 15% too large: 2πr would overshoot by ~15%.
    const s = new CylinderStitcher({ geometry: { centerX: 150, radius: R * 1.15 }, autoDetectEdges: false });
    const analyses = run(s, label, opts, 3);
    expect(s.isComplete).toBe(true);
    expect(s.loopDetected).toBe(true);
    expect(analyses[analyses.length - 1].loopDetected).toBe(true);
    const res = s.finish();
    expect(res.loopClosed).toBe(true);
    // The true turn (measured in the mis-scaled unwrap) is detected, not the 2πr guess.
    const rotatedDeg = analyses.length * 3;
    expect(rotatedDeg).toBeLessThan(360 * 1.25);
    expect(Math.abs(res.periodPx - res.expectedCircumferencePx) / res.expectedCircumferencePx).toBeGreaterThan(0.05);
  });

  it('restart() starts a fresh panorama mid-rotation (end of countdown)', () => {
    const { label, opts } = scene();
    const s = new CylinderStitcher({ geometry: { centerX: 150, radius: 125 } });
    let angle = 0;
    let i = 0;
    const step = (3 * Math.PI) / 180;
    // "Countdown": 5 s of turning that must not count towards the scan.
    for (; i < 75; i++, angle += step) s.addFrame(renderCylinderFrame(label, angle, opts), (i * 1000) / 15);
    s.restart();
    expect(s.getGeometry()).not.toBeNull();
    let frames = 0;
    for (; i < 500 && !s.isComplete; i++, frames++, angle += step) {
      const a = s.addFrame(renderCylinderFrame(label, angle, opts), (i * 1000) / 15);
      if (frames === 0) expect(a.coverage).toBeLessThan(0.1);
    }
    expect(s.isComplete).toBe(true);
    // A full turn after the restart, not counting the countdown's rotation.
    expect(frames * 3).toBeGreaterThan(360);
    const res = s.finish();
    expect(res.loopClosed).toBe(true);
    expect(labelSimilarity(res.image, label)).toBeGreaterThan(0.85);
  });

  it('finds one turn when the user decides when to stop, even after two turns at uneven speed', () => {
    const { label, opts } = scene();
    const scan = (radius: number) => {
      const s = new CylinderStitcher({ geometry: { centerX: 150, radius }, autoDetectEdges: false, autoComplete: false });
      let angle = 0;
      for (let i = 0; angle < 4 * Math.PI; i++) {
        s.addFrame(renderCylinderFrame(label, angle, opts), (i * 1000) / 15);
        angle += ((1 + 2.5 * (0.5 + 0.5 * Math.sin(i / 7))) * Math.PI) / 180;
      }
      expect(s.isComplete).toBe(false);
      return s.finish();
    };
    // Two turns are folded into one without ghosting.
    const good = scan(R);
    expect(good.loopClosed).toBe(true);
    expect(Math.abs(good.periodPx - CIRC) / CIRC).toBeLessThan(0.02);
    expect(labelSimilarity(good.image, label)).toBeGreaterThan(0.85);
    // Radius 45% too large: still one turn, not two, and not the 2πr guess.
    const off = scan(R * 1.45);
    expect(off.loopClosed).toBe(true);
    expect(Math.abs(off.periodPx - good.periodPx) / good.periodPx).toBeLessThan(0.05);
  }, 30000);

  it('flags rotation speed', () => {
    const { label, opts } = scene();
    const slow = new CylinderStitcher({ geometry: { centerX: 150, radius: 125 } });
    const a = run(slow, label, opts, 0.5, 15, 30);
    expect(a[a.length - 1].speed.status).toBe('too-slow');
    expect(a[a.length - 1].warnings).toContain('too-slow');

    const fast = new CylinderStitcher({ geometry: { centerX: 150, radius: 125 } });
    const b = run(fast, label, opts, 6, 15, 30);
    expect(b[b.length - 1].speed.status).toBe('too-fast');
  });

  it('returns a partial result when stopped early', () => {
    const { label, opts } = scene();
    const s = new CylinderStitcher({ geometry: { centerX: 150, radius: 125 } });
    run(s, label, opts, 3, 15, 40);
    expect(s.isComplete).toBe(false);
    const res = s.finish();
    expect(res.loopClosed).toBe(false);
    expect(res.coverage).toBeGreaterThan(0.2);
    expect(res.coverage).toBeLessThan(1);
    expect(res.image.width).toBeGreaterThan(100);
  });
});
