import type { FrameAnalysis } from './types';

export interface RotationStartOptions {
  /** Continuous rotation needed before the scan starts, in ms. Default 600. */
  holdMs?: number;
  /** Minimum smoothed speed (°/s) that counts as rotating. Default 5. */
  minDegPerSec?: number;
  /**
   * Restart detection (discard everything captured while waiting) at least this often, so the
   * bottle's geometry is re-measured once it has been put in place. Default 2000 ms.
   */
  recalibrateMs?: number;
}

export type RotationStartDecision =
  /** Keep waiting; nothing to do. */
  | 'wait'
  /** Discard what has been captured while waiting (e.g. `stitcher.reset()`), then keep waiting. */
  | 'reset'
  /** Sustained rotation detected: start scanning, keeping what has been captured. */
  | 'start';

/**
 * Decides when to start a scan hands-free: feed it every {@link FrameAnalysis} produced while
 * waiting and it reports `'start'` once the bottle has been turning steadily in one direction
 * for `holdMs`. Hand movement, placing the bottle or a still scene never trigger it.
 */
export class RotationStartDetector {
  private readonly holdMs: number;
  private readonly minDegPerSec: number;
  private readonly recalibrateMs: number;
  private since: number | null = null;
  private sign = 0;
  private sessionStart: number | null = null;

  constructor(options: RotationStartOptions = {}) {
    this.holdMs = options.holdMs ?? 600;
    this.minDegPerSec = options.minDegPerSec ?? 5;
    this.recalibrateMs = options.recalibrateMs ?? 2000;
  }

  reset(): void {
    this.since = null;
    this.sign = 0;
    this.sessionStart = null;
  }

  update(a: FrameAnalysis, timestampMs: number): RotationStartDecision {
    this.sessionStart ??= timestampMs;
    if (a.phase === 'calibrating') return 'wait';

    const deg = a.speed.degPerSec;
    const sign = Math.sign(a.shiftX);
    const rotating =
      a.tracked &&
      Math.abs(deg) >= this.minDegPerSec &&
      sign !== 0 &&
      Math.sign(deg) === sign &&
      !a.warnings.includes('lost-tracking') &&
      !a.warnings.includes('reversed');

    if (rotating && (this.since === null || sign === this.sign)) {
      if (this.since === null) {
        this.since = timestampMs;
        this.sign = sign;
      }
      return timestampMs - this.since >= this.holdMs ? 'start' : 'wait';
    }

    // Not (consistently) rotating. Throw away anything collected while the user was
    // positioning the bottle, and periodically re-measure the geometry.
    const hadMotion = this.since !== null || a.coverage > 0.02;
    const stale = timestampMs - this.sessionStart >= this.recalibrateMs;
    this.since = null;
    this.sign = 0;
    if (hadMotion || stale) {
      this.sessionStart = null;
      return 'reset';
    }
    return 'wait';
  }
}
