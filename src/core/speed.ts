import type { SpeedReading, SpeedStatus } from './types';

export interface SpeedOptions {
  /**
   * Below this the user is told to rotate faster. Default 8°/s (~45 s per turn). Slow turning
   * only costs time: every frame's shift is measured, so the speed does not need to be constant.
   */
  minDegPerSec?: number;
  /**
   * Above this the user is told to slow down. Default 45°/s (~8 s per turn).
   * The real limit is motion blur: blur in px ≈ ω·r·exposure, so small text on a large-radius
   * bottle in dim light needs a slower rotation.
   */
  maxDegPerSec?: number;
  /** Below this the bottle is considered not rotating. Default 3°/s. */
  stallDegPerSec?: number;
  /** EMA factor for the reported speed (0..1, higher = more responsive). Default 0.35. */
  smoothing?: number;
  /** Number of recent samples used for the steadiness metric. Default 10. */
  window?: number;
}

/** Tracks angular speed from per-frame rotation increments and classifies it for user guidance. */
export class SpeedMonitor {
  private readonly opts: Required<SpeedOptions>;
  private ema: number | null = null;
  private history: number[] = [];

  constructor(options: SpeedOptions = {}) {
    this.opts = {
      minDegPerSec: options.minDegPerSec ?? 8,
      maxDegPerSec: options.maxDegPerSec ?? 45,
      stallDegPerSec: options.stallDegPerSec ?? 3,
      smoothing: options.smoothing ?? 0.35,
      window: options.window ?? 10,
    };
  }

  get options(): Readonly<Required<SpeedOptions>> {
    return this.opts;
  }

  reset(): void {
    this.ema = null;
    this.history = [];
  }

  /** @param deltaDeg rotation since the previous sample, @param dtSec elapsed time. */
  update(deltaDeg: number, dtSec: number): SpeedReading {
    if (dtSec > 0 && Number.isFinite(deltaDeg)) {
      const inst = deltaDeg / dtSec;
      this.ema = this.ema === null ? inst : this.ema + this.opts.smoothing * (inst - this.ema);
      this.history.push(inst);
      if (this.history.length > this.opts.window) this.history.shift();
    }
    return this.reading();
  }

  reading(): SpeedReading {
    const v = this.ema ?? 0;
    return { degPerSec: v, status: this.classify(Math.abs(v)), steadiness: this.steadiness() };
  }

  classify(absDegPerSec: number): SpeedStatus {
    const o = this.opts;
    if (absDegPerSec < o.stallDegPerSec) return 'idle';
    if (absDegPerSec < o.minDegPerSec) return 'too-slow';
    if (absDegPerSec > o.maxDegPerSec) return 'too-fast';
    return 'good';
  }

  /** 1 − coefficient of variation of |speed| over the recent window, clamped to 0..1. */
  private steadiness(): number {
    const h = this.history.map(Math.abs);
    if (h.length < 3) return 1;
    const mean = h.reduce((a, b) => a + b, 0) / h.length;
    if (mean < this.opts.stallDegPerSec) return 1;
    const sd = Math.sqrt(h.reduce((a, b) => a + (b - mean) ** 2, 0) / h.length);
    return Math.max(0, Math.min(1, 1 - sd / mean));
  }
}
