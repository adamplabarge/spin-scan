/** Short audio/vibration cues so the user can keep their eyes on the bottle. Best-effort; never throws. */
export class Feedback {
  private ctx: AudioContext | null = null;

  constructor(private readonly enabled: boolean) {}

  /** Create/resume the audio context. Call from a user gesture (e.g. a click) so browsers allow sound. */
  unlock(): void {
    if (!this.enabled || typeof window === 'undefined') return;
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx ??= new Ctor();
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
    } catch {
      this.ctx = null;
    }
  }

  /** Countdown tick. */
  tick(): void {
    this.tone(660, 0.08);
    this.vibrate(30);
  }

  /** Capture started. */
  go(): void {
    this.tone(990, 0.25);
    this.vibrate(120);
  }

  /** Scan complete. */
  done(): void {
    this.tone(880, 0.12);
    this.tone(1320, 0.18, 0.16);
    this.vibrate([80, 60, 80]);
  }

  dispose(): void {
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }

  private tone(freq: number, seconds: number, delay = 0): void {
    if (!this.enabled) return;
    this.unlock();
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    try {
      const t0 = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + seconds);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + seconds + 0.02);
    } catch {
      // Audio is optional.
    }
  }

  private vibrate(pattern: number | number[]): void {
    if (!this.enabled || typeof navigator === 'undefined' || !navigator.vibrate) return;
    try {
      navigator.vibrate(pattern);
    } catch {
      // Vibration is optional.
    }
  }
}
