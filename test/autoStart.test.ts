import { describe, expect, it } from 'vitest';
import { CylinderStitcher } from '../src/core/stitcher';
import { RotationStartDetector } from '../src/core/autoStart';
import { createSyntheticLabel, renderCylinderFrame } from '../src/testing';

describe('RotationStartDetector', () => {
  it('waits while the bottle is still, starts once it turns, and the scan still completes', () => {
    const R = 120;
    const label = createSyntheticLabel(Math.round(2 * Math.PI * R), 240, 5);
    const opts = { frameWidth: 300, frameHeight: 240, centerX: 150, radius: R, noise: 2 };
    const stitcher = new CylinderStitcher();
    const detector = new RotationStartDetector();
    const fps = 12;
    const degPerSec = 30;
    const stillFrames = 40; // ~3.3 s of holding still
    let startedAt = -1;
    let resets = 0;
    let completed = false;

    for (let i = 0; i < stillFrames + 200 && !completed; i++) {
      const t = (i * 1000) / fps;
      const rotSec = Math.max(0, i - stillFrames) / fps;
      const frame = renderCylinderFrame(label, -(rotSec * degPerSec * Math.PI) / 180, opts);
      const a = stitcher.addFrame(frame, t);
      if (startedAt < 0) {
        const d = detector.update(a, t);
        if (d === 'reset') {
          resets++;
          stitcher.reset();
        } else if (d === 'start') startedAt = i;
      } else if (a.phase === 'complete') completed = true;
    }

    expect(resets).toBeGreaterThan(0); // periodic re-calibration while still
    expect(startedAt).toBeGreaterThan(stillFrames);
    expect(startedAt).toBeLessThan(stillFrames + fps * 1.5);
    expect(completed).toBe(true);
    const result = stitcher.finish();
    expect(result.loopClosed).toBe(true);
  });
});
