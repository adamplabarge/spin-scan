import { describe, expect, it } from 'vitest';
import { detectCylinderEdges, unwrapGray } from '../src/core/cylinder';
import { toGray } from '../src/core/image';
import { SpeedMonitor } from '../src/core/speed';
import { createSyntheticLabel, renderCylinderFrame } from '../src/testing';

describe('detectCylinderEdges', () => {
  it('finds the silhouette of a synthetic bottle', () => {
    const r = 140;
    const label = createSyntheticLabel(Math.round(2 * Math.PI * r), 360, 5);
    const frame = renderCylinderFrame(label, 0.3, { frameWidth: 400, frameHeight: 360, centerX: 207, radius: r });
    const g = detectCylinderEdges(toGray(frame), { hint: { centerX: 200, radius: 150 } });
    expect(g).not.toBeNull();
    expect(Math.abs(g!.centerX - 207)).toBeLessThan(1.5);
    expect(Math.abs(g!.radius - r)).toBeLessThan(2);
  });

  it('returns null when there is no bottle', () => {
    const label = createSyntheticLabel(400, 300, 2);
    expect(detectCylinderEdges(toGray(label), { hint: { centerX: 200, radius: 150 } })).toBeNull();
  });
});

describe('unwrapGray', () => {
  it('turns rotation into a horizontal translation', () => {
    const r = 150;
    const label = createSyntheticLabel(Math.round(2 * Math.PI * r), 300, 8);
    const opts = { frameWidth: 360, frameHeight: 300, centerX: 180, radius: r, shading: false };
    const geom = { centerX: 180, radius: r };
    const a = unwrapGray(renderCylinderFrame(label, 0, opts), geom, 0.8);
    const shiftPx = 10;
    const b = unwrapGray(renderCylinderFrame(label, shiftPx / r, opts), geom, 0.8);
    // b(u) should equal a(u + shift)
    let err = 0, n = 0;
    for (let y = 0; y < a.height; y++) {
      for (let u = 20; u < a.width - 40; u++) {
        err += Math.abs(b.data[y * a.width + u] - a.data[y * a.width + u + shiftPx]);
        n++;
      }
    }
    expect(err / n).toBeLessThan(6);
  });
});

describe('SpeedMonitor', () => {
  it('classifies speeds', () => {
    const m = new SpeedMonitor({ minDegPerSec: 15, maxDegPerSec: 45, smoothing: 1 });
    expect(m.update(0.1, 0.1).status).toBe('idle');
    expect(m.update(1, 0.1).status).toBe('too-slow');
    expect(m.update(3, 0.1).status).toBe('good');
    expect(m.update(-3, 0.1).degPerSec).toBeCloseTo(-30);
    expect(m.update(6, 0.1).status).toBe('too-fast');
  });

  it('measures steadiness', () => {
    const steady = new SpeedMonitor();
    for (let i = 0; i < 10; i++) steady.update(3, 0.1);
    expect(steady.reading().steadiness).toBeGreaterThan(0.95);
    const jerky = new SpeedMonitor();
    for (let i = 0; i < 10; i++) jerky.update(i % 2 ? 6 : 0.5, 0.1);
    expect(jerky.reading().steadiness).toBeLessThan(0.5);
  });
});
