import { CylinderStitcher, type StitcherOptions } from '../core/stitcher';
import { RotationStartDetector, type RotationStartOptions } from '../core/autoStart';
import type { FrameAnalysis, RGBAImage, ScanWarning, StitchResult } from '../core/types';
import { imageToBlob, imageToCanvas, openCamera, stopStream, type CameraOptions } from './camera';
import { Feedback } from './feedback';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GuideOptions {
  /** Guide width as a fraction of the video width. Default 0.6 (portrait) / 0.3 (landscape). */
  width?: number;
  /** Guide height as a fraction of the video height. Default 0.6 (portrait) / 0.8 (landscape). */
  height?: number;
}

export interface ScannerOptions extends StitcherOptions {
  camera?: CameraOptions;
  /** Frames processed per second. Default 12. */
  fps?: number;
  /**
   * The on-screen guide the user lines the bottle up with. The bottle's silhouette is expected
   * to roughly match the guide's left/right edges; the label area should fill its height.
   */
  guide?: GuideOptions;
  /** Extra width (fraction of guide width, each side) included so the silhouette can be detected. Default 0.15. */
  edgeMargin?: number;
  /** Frames are downscaled so the processed region is at most this tall. Default 1080. */
  maxWorkHeight?: number;
  /**
   * Build the result automatically when the scan completes. With `autoStop` (default) that is when
   * the stop countdown ends; with `autoStop: false` it is when the stitcher sees the label come back
   * round to the start. Default true.
   */
  autoFinish?: boolean;
  /**
   * Hands-free stop: once the user stops turning the bottle for `stillSec`, a `countdownSec`
   * countdown (status `'stopping'`) runs and the scan then finishes. Turning the bottle again at
   * any point cancels it. `false` = let the stitcher decide (live overlap detection). Default true.
   */
  autoStop?: boolean | AutoStopOptions;
  /**
   * Whether the preview should be shown mirrored (like a selfie view). Only affects `ScanState.mirrored`,
   * which the UI uses to flip the displayed video. Captured frames and the result are never mirrored.
   * `'auto'` (default) mirrors user-facing cameras and webcams, not rear cameras or video files.
   */
  mirror?: boolean | 'auto';
  /**
   * Hands-free start: once the camera/video is ready the scanner waits (status `'waiting'`).
   * When it sees the bottle turning, the user is told to turn the bottle back to where the label
   * starts (`instructionSec`, status `'countdown'` with `countdown: null`), then a `countdownSec`
   * countdown runs and capture begins. Nothing during this start sequence can cancel it or stop
   * the scan. Combined with `autoStop`, no buttons are needed. Default false.
   */
  autoStart?: boolean | AutoStartOptions;
  /** Beeps and vibration for countdown, start and completion. Default true. */
  sound?: boolean;
}

export interface AutoStopOptions {
  /** How long the bottle must be still before the stop countdown starts. Default 3. */
  stillSec?: number;
  /** Length of the stop countdown. Default 3. */
  countdownSec?: number;
  /** Rotation (degrees) that counts as "turning again" and cancels the stop. Default 15. */
  resumeDeg?: number;
  /** Don't stop before this much of a turn (radius estimate) is captured. Default 0.3. */
  minCoverage?: number;
}

export interface AutoStartOptions extends RotationStartOptions {
  /**
   * How long (seconds) the "turn the bottle back to the start" instruction is shown after rotation
   * is detected, before the countdown. Default 2.
   */
  instructionSec?: number;
  /**
   * Countdown (seconds) after the instruction, before capture starts. The user holds the bottle at
   * the start position (or starts turning). With both `instructionSec` and `countdownSec` at 0,
   * capture starts immediately and keeps the frames used for detection. Default 3.
   */
  countdownSec?: number;
}

export type ScannerStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  /** Auto-start: waiting for the bottle to turn. */
  | 'waiting'
  /** Auto-start: rotation seen, counting down before capture. */
  | 'countdown'
  | 'scanning'
  /** Auto-stop: the bottle has been still; counting down before the scan finishes. */
  | 'stopping'
  | 'processing'
  | 'complete'
  | 'error';

export interface ScanState {
  status: ScannerStatus;
  /** Latest per-frame analysis while scanning. */
  analysis: FrameAnalysis | null;
  /** Human-readable guidance for the user. */
  message: string;
  /** 0..1 progress towards a full revolution. */
  progress: number;
  /** Size of the source video in pixels. */
  videoSize: { width: number; height: number } | null;
  /** Guide rectangle in video pixels (draw it over the video to align the bottle). */
  guide: Rect | null;
  /**
   * Seconds left in the start (`'countdown'`) or stop (`'stopping'`) countdown, else null.
   * While `status === 'countdown'` and this is null, the "turn back to the start" instruction is
   * being shown (see `message`).
   */
  countdown: number | null;
  /** Show the preview flipped horizontally (e.g. CSS `transform: scaleX(-1)` on the video and guide overlay). */
  mirrored: boolean;
  error: string | null;
}

export interface ScanResult extends StitchResult {
  toCanvas(canvas?: HTMLCanvasElement): HTMLCanvasElement;
  toBlob(type?: string, quality?: number): Promise<Blob>;
}

type Events = {
  state: ScanState;
  complete: ScanResult;
  error: Error;
};
type Listener<K extends keyof Events> = (payload: Events[K]) => void;

const WARNING_MESSAGES: [ScanWarning, string][] = [
  ['lost-tracking', 'Lost track — turn back a little and rotate more slowly'],
  ['too-fast', 'Slow down'],
  ['blurry', 'Image is blurry — rotate more slowly and hold the bottle steady'],
  ['too-dark', 'Too dark — move to better light'],
  ['glare', 'Glare detected — tilt the bottle slightly or move away from direct light'],
  ['reversed', 'Keep rotating in the same direction'],
  ['vertical-drift', 'Keep the bottle level — rotate it, don’t move it'],
  ['stalled', 'Slowly rotate the bottle'],
  ['too-slow', 'A little faster'],
];

/**
 * Turns a frame analysis into a single guidance message (most important issue first).
 * `autoStop`: the user ends the scan by holding the bottle still (scanner `autoStop` option).
 */
export function describeAnalysis(a: FrameAnalysis | null, opts: { autoStop?: boolean } = {}): string {
  if (!a) return 'Line the bottle up with the guide';
  if (a.phase === 'calibrating') return 'Hold the bottle inside the guide';
  if (a.phase === 'complete') return 'Full turn captured';
  for (const [w, msg] of WARNING_MESSAGES) if (a.warnings.includes(w)) return msg;
  if (a.loopDetected) return 'Back at the start — almost done, keep turning';
  if (a.coverage >= 0.95) {
    return opts.autoStop
      ? 'Back where you started? Stop turning and hold still to finish'
      : 'Keep turning until you’re back where you started';
  }
  return `Good — keep going (${Math.min(99, Math.round(a.coverage * 100))}%)`;
}

const WAITING_MESSAGE = 'Start turning the bottle — the scan starts automatically';
const INSTRUCTION_MESSAGE = 'Got it! Turn the bottle back to where the label starts';

const STOP_HINT_MESSAGE = 'Hold still to finish — or keep turning';

function stopMessage(n: number): string {
  return `Finishing in ${n}… (turn the bottle to keep scanning)`;
}

function countdownMessage(n: number): string {
  return `Starting in ${n}… then turn the bottle slowly`;
}

/** Default guide for a given video size (in video pixels). */
export function resolveGuide(videoWidth: number, videoHeight: number, guide: GuideOptions = {}): Rect {
  const portrait = videoHeight >= videoWidth;
  const fw = guide.width ?? (portrait ? 0.6 : 0.3);
  const fh = guide.height ?? (portrait ? 0.6 : 0.8);
  const width = Math.round(videoWidth * fw);
  const height = Math.round(videoHeight * fh);
  return { x: Math.round((videoWidth - width) / 2), y: Math.round((videoHeight - height) / 2), width, height };
}

interface VideoFrameMeta {
  mediaTime: number;
}
type RVFCVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: VideoFrameMeta) => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

/**
 * Browser front-end: feeds frames from a `<video>` element (live camera or a recorded clip)
 * into a {@link CylinderStitcher} and reports guidance/progress.
 *
 * ```ts
 * const scanner = new CylinderScanner();
 * scanner.on('state', (s) => (hint.textContent = s.message));
 * scanner.on('complete', async (r) => upload(await r.toBlob()));
 * await scanner.startCamera(videoEl);
 * scanner.startScan();
 * ```
 */
export class CylinderScanner {
  private readonly opts: ScannerOptions;
  private video: RVFCVideo | null = null;
  private stream: MediaStream | null = null;
  private ownsStream = false;
  private stitcher: CylinderStitcher | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private region: Rect | null = null;
  private workSize = { width: 0, height: 0 };
  private loopHandle: number | null = null;
  private loopIsRVFC = false;
  private lastProcessed = -Infinity;
  private busy = false;
  private listeners: { [K in keyof Events]: Set<Listener<K>> } = {
    state: new Set(),
    complete: new Set(),
    error: new Set(),
  };
  private _state: ScanState = {
    status: 'idle',
    analysis: null,
    message: describeAnalysis(null),
    progress: 0,
    videoSize: null,
    guide: null,
    mirrored: false,
    countdown: null,
    error: null,
  };
  private _result: ScanResult | null = null;
  private detector: RotationStartDetector | null = null;
  /** Start sequence: end of the instruction phase and of the countdown (frame time, ms). */
  private instructionEnd = 0;
  private countdownEnd = 0;
  /** Auto-stop: when the bottle became still, and rotation (degrees) since then. */
  private stillSince: number | null = null;
  private stillDeg = 0;
  private readonly feedback: Feedback;
  private mirrorSetting: boolean | 'auto';

  constructor(options: ScannerOptions = {}) {
    this.opts = options;
    this.mirrorSetting = options.mirror ?? 'auto';
    this.feedback = new Feedback(options.sound ?? true);
  }

  /** Changes how the preview is mirrored (display only; does not affect the scan). */
  setMirror(mirror: boolean | 'auto'): void {
    this.mirrorSetting = mirror;
    this.setState({ mirrored: this.resolveMirror() });
  }

  private resolveMirror(): boolean {
    if (this.mirrorSetting !== 'auto') return this.mirrorSetting;
    const src = this.video?.srcObject;
    const track = typeof MediaStream !== 'undefined' && src instanceof MediaStream ? src.getVideoTracks()[0] : undefined;
    // No live track means a video file, which is never mirrored. Canvas capture streams aren't cameras either.
    if (!track || 'canvas' in track) return false;
    const facing = track.getSettings?.().facingMode;
    if (facing) return facing === 'user';
    // Webcams usually don't report facingMode, and they face the user.
    return true;
  }

  get state(): ScanState {
    return this._state;
  }

  get result(): ScanResult | null {
    return this._result;
  }

  get mediaStream(): MediaStream | null {
    return this.stream;
  }

  on<K extends keyof Events>(event: K, listener: Listener<K>): () => void {
    this.listeners[event].add(listener);
    return () => this.off(event, listener);
  }

  off<K extends keyof Events>(event: K, listener: Listener<K>): void {
    this.listeners[event].delete(listener);
  }

  /** Opens the camera and plays it into `video`. */
  async startCamera(video: HTMLVideoElement, camera: CameraOptions = this.opts.camera ?? {}): Promise<void> {
    this.feedback.unlock();
    this.setState({ status: 'starting', error: null });
    try {
      this.stopCamera();
      const stream = await openCamera(camera);
      this.stream = stream;
      this.ownsStream = true;
      video.muted = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.srcObject = stream;
      await this.attachVideo(video);
      await video.play().catch(() => undefined);
    } catch (err) {
      this.fail(err);
      throw err;
    }
  }

  /** Uses an existing video element (e.g. a recorded clip or your own stream). */
  async attachVideo(video: HTMLVideoElement): Promise<void> {
    if (this.video && this.video !== video) this.video.removeEventListener('ended', this.onEnded);
    this.video = video as RVFCVideo;
    video.addEventListener('ended', this.onEnded);
    if (video.readyState < 1) {
      await new Promise<void>((resolve, reject) => {
        const ok = () => {
          cleanup();
          resolve();
        };
        const bad = () => {
          cleanup();
          reject(new Error('Video failed to load'));
        };
        const cleanup = () => {
          video.removeEventListener('loadedmetadata', ok);
          video.removeEventListener('error', bad);
        };
        video.addEventListener('loadedmetadata', ok);
        video.addEventListener('error', bad);
      });
    }
    const videoSize = { width: video.videoWidth, height: video.videoHeight };
    const active = this.isActive();
    this.setState({
      status: active ? this._state.status : 'ready',
      videoSize,
      guide: resolveGuide(videoSize.width, videoSize.height, this.opts.guide),
      mirrored: this.resolveMirror(),
    });
    if (!active && this.opts.autoStart) this.arm();
  }

  /** Guide rectangle for the current video, in video pixels. */
  getGuide(): Rect | null {
    return this._state.guide;
  }

  /** Begins (or restarts) capturing immediately. */
  startScan(): void {
    this.begin('scanning');
  }

  /**
   * Waits for the user to start turning the bottle, then starts scanning by itself (status
   * `'waiting'` until then). Called automatically when the `autoStart` option is set; call it
   * again for the next hands-free scan.
   */
  arm(): void {
    this.begin('waiting');
  }

  private isActive(): boolean {
    const st = this._state.status;
    return st === 'scanning' || st === 'waiting' || st === 'countdown' || st === 'stopping';
  }

  private autoStopOptions(): Required<AutoStopOptions> | null {
    const o = this.opts.autoStop ?? true;
    if (o === false) return null;
    const v = o === true ? {} : o;
    return {
      stillSec: v.stillSec ?? 3,
      countdownSec: v.countdownSec ?? 3,
      resumeDeg: v.resumeDeg ?? 15,
      minCoverage: v.minCoverage ?? 0.3,
    };
  }

  private autoStartOptions(): AutoStartOptions {
    return typeof this.opts.autoStart === 'object' ? this.opts.autoStart : {};
  }

  private begin(status: 'scanning' | 'waiting'): void {
    if (!this.video) throw new Error('No video attached; call startCamera() or attachVideo() first');
    this.feedback.unlock();
    this.stopLoop();
    this._result = null;
    this.stitcher = null;
    this.region = null;
    this.lastProcessed = -Infinity;
    this.detector = status === 'waiting' ? new RotationStartDetector(this.autoStartOptions()) : null;
    this.stillSince = null;
    this.setState({
      status,
      analysis: null,
      progress: 0,
      countdown: null,
      error: null,
      message: status === 'waiting' ? WAITING_MESSAGE : describeAnalysis(null),
    });
    this.scheduleNext();
  }

  /** Stops capturing (or waiting) without building a result. */
  stopScan(): void {
    this.stopLoop();
    this.detector = null;
    if (this.isActive()) this.setState({ status: 'ready', countdown: null });
  }

  /**
   * Stops capturing and builds the image from what has been captured so far
   * (a partial label if less than a full turn was recorded).
   */
  async finish(): Promise<ScanResult> {
    this.stopLoop();
    const stitcher = this.stitcher;
    if (!stitcher) throw new Error('Nothing has been scanned yet');
    this.setState({ status: 'processing', message: 'Building image…' });
    // Let the UI paint the "processing" state before the synchronous work.
    await new Promise((r) => setTimeout(r, 0));
    try {
      const raw = stitcher.finish();
      const result: ScanResult = {
        ...raw,
        toCanvas: (canvas?: HTMLCanvasElement) => imageToCanvas(raw.image, canvas),
        toBlob: (type?: string, quality?: number) => imageToBlob(raw.image, type, quality),
      };
      this._result = result;
      this.setState({
        status: 'complete',
        progress: Math.min(1, raw.coverage),
        message: raw.loopClosed ? 'Done' : `Done (partial: ${Math.round(Math.min(1, raw.coverage) * 100)}% of the label)`,
      });
      this.feedback.done();
      this.emit('complete', result);
      return result;
    } catch (err) {
      this.fail(err);
      throw err;
    }
  }

  stopCamera(): void {
    this.stopLoop();
    if (this.ownsStream) stopStream(this.stream);
    if (this.video && this.ownsStream) this.video.srcObject = null;
    this.stream = null;
    this.ownsStream = false;
  }

  /** Releases the camera, listeners and buffers. */
  destroy(): void {
    this.stopCamera();
    this.feedback.dispose();
    this.video?.removeEventListener('ended', this.onEnded);
    this.video = null;
    this.stitcher = null;
    this.canvas = null;
    this.ctx = null;
    (Object.keys(this.listeners) as (keyof Events)[]).forEach((k) => this.listeners[k].clear());
  }

  private onEnded = () => {
    if (this._state.status === 'waiting' || this._state.status === 'countdown') this.stopScan();
    else if ((this._state.status === 'scanning' || this._state.status === 'stopping') && this.stitcher && this.stitcher.coverage > 0) {
      void this.finish().catch(() => undefined);
    }
  };

  private scheduleNext(): void {
    const v = this.video;
    if (!v) return;
    if (v.requestVideoFrameCallback) {
      this.loopIsRVFC = true;
      this.loopHandle = v.requestVideoFrameCallback((now, meta) => this.tick(now, meta));
    } else {
      this.loopIsRVFC = false;
      this.loopHandle = requestAnimationFrame((now) => this.tick(now));
    }
  }

  private stopLoop(): void {
    if (this.loopHandle === null) return;
    if (this.loopIsRVFC) this.video?.cancelVideoFrameCallback?.(this.loopHandle);
    else cancelAnimationFrame(this.loopHandle);
    this.loopHandle = null;
  }

  private tick(now: number, meta?: VideoFrameMeta): void {
    this.loopHandle = null;
    if (!this.isActive()) return;
    this.scheduleNext();
    const v = this.video;
    if (!v || this.busy || v.readyState < 2 || !v.videoWidth) return;
    // For recorded clips use media time so speeds are correct even if playback stutters.
    const t = !v.srcObject && meta ? meta.mediaTime * 1000 : now;
    const interval = 1000 / (this.opts.fps ?? 12);
    if (t - this.lastProcessed < interval * 0.9 && t >= this.lastProcessed) return;
    this.lastProcessed = t;
    this.busy = true;
    try {
      this.processFrame(v, t);
    } catch (err) {
      this.fail(err);
    } finally {
      this.busy = false;
    }
  }

  private processFrame(v: HTMLVideoElement, t: number): void {
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    const size = this._state.videoSize;
    if (!size || size.width !== vw || size.height !== vh) {
      // Device rotated or stream changed: restart with the new geometry.
      this.setState({ videoSize: { width: vw, height: vh }, guide: resolveGuide(vw, vh, this.opts.guide) });
      this.stitcher = null;
      this.region = null;
      this.detector?.reset();
    }
    if (!this.stitcher || !this.region) this.setupStitcher(vw, vh);
    const frame = this.grab(v);
    const analysis = this.stitcher!.addFrame(frame, t);
    if (this._state.status === 'waiting' && this.detector) {
      const decision = this.detector.update(analysis, t);
      if (decision === 'reset') this.stitcher!.reset();
      if (decision !== 'start') {
        this.setState({ analysis, progress: 0, message: WAITING_MESSAGE });
        return;
      }
      this.detector = null;
      const so = this.autoStartOptions();
      const instr = Math.max(0, so.instructionSec ?? 2);
      const sec = Math.max(0, so.countdownSec ?? 3);
      if (instr + sec > 0) {
        this.instructionEnd = t + instr * 1000;
        this.countdownEnd = this.instructionEnd + sec * 1000;
        this.feedback.tick();
        this.updateStartSequence(analysis, t);
        return;
      }
      // No start sequence: keep what was captured during detection and carry on scanning.
      this.feedback.go();
      this.setState({ status: 'scanning', countdown: null });
    } else if (this._state.status === 'countdown') {
      this.updateStartSequence(analysis, t);
      return;
    }
    if (this.updateAutoStop(analysis, t)) return;
    this.setState({ analysis, progress: Math.min(1, analysis.coverage), message: describeAnalysis(analysis, { autoStop: this.autoStopOptions() !== null }) });
    if (analysis.phase === 'complete' && (this.opts.autoFinish ?? true)) {
      void this.finish().catch(() => undefined);
    }
  }

  /**
   * Start sequence: instruction ("turn back to the start") → countdown → capture. Runs on time
   * alone; the bottle may move or stand still, and nothing cancels it (only `stopScan()`).
   * Frames are still tracked so geometry stays calibrated; the panorama is restarted at the end.
   */
  private updateStartSequence(analysis: FrameAnalysis, t: number): void {
    if (t < this.instructionEnd) {
      this.setState({ status: 'countdown', countdown: null, analysis, progress: 0, message: INSTRUCTION_MESSAGE });
      return;
    }
    const left = Math.ceil((this.countdownEnd - t) / 1000);
    if (left > 0) {
      if (left !== this._state.countdown) this.feedback.tick();
      this.setState({ status: 'countdown', countdown: left, analysis, progress: 0, message: countdownMessage(left) });
      return;
    }
    this.stitcher!.restart();
    this.stillSince = null;
    this.feedback.go();
    this.setState({ status: 'scanning', countdown: null, analysis, progress: 0, message: 'Go — turn the bottle slowly' });
  }

  /**
   * Hands-free stop: still for `stillSec` → `'stopping'` countdown → finish. Any real rotation
   * (more than `resumeDeg` in total, so hand tremor doesn't count) cancels it.
   * Returns true when it has set the state for this frame.
   */
  private updateAutoStop(analysis: FrameAnalysis, t: number): boolean {
    const o = this.autoStopOptions();
    if (!o) return false;
    const st = this._state.status;
    const still = !analysis.tracked || analysis.speed.status === 'idle';
    if (this.stillSince === null) {
      if (!still || analysis.coverage < o.minCoverage) return false;
      this.stillSince = t;
      this.stillDeg = 0;
    } else if (analysis.tracked && analysis.geometry) {
      this.stillDeg += (analysis.shiftX / analysis.geometry.radius) * (180 / Math.PI);
    }
    if (Math.abs(this.stillDeg) > o.resumeDeg) {
      this.stillSince = null;
      if (st === 'stopping') this.setState({ status: 'scanning', countdown: null });
      return false;
    }
    const progress = Math.min(1, analysis.coverage);
    const elapsed = (t - this.stillSince) / 1000;
    if (elapsed < o.stillSec) {
      // Only hint once the bottle has clearly stopped, not during a brief pause.
      if (elapsed < Math.min(1, o.stillSec / 2)) return false;
      this.setState({ analysis, progress, message: STOP_HINT_MESSAGE });
      return true;
    }
    const left = Math.ceil(o.stillSec + o.countdownSec - elapsed);
    if (left > 0) {
      if (st !== 'stopping' || left !== this._state.countdown) this.feedback.tick();
      this.setState({ status: 'stopping', countdown: left, analysis, progress, message: stopMessage(left) });
      return true;
    }
    this.stillSince = null;
    this.setState({ countdown: null });
    if (this.opts.autoFinish ?? true) void this.finish().catch(() => undefined);
    else this.setState({ status: 'ready', message: 'Scan stopped' });
    return true;
  }

  private setupStitcher(vw: number, vh: number): void {
    const guide = this._state.guide ?? resolveGuide(vw, vh, this.opts.guide);
    const margin = Math.round(guide.width * (this.opts.edgeMargin ?? 0.15));
    const x0 = Math.max(0, guide.x - margin);
    const x1 = Math.min(vw, guide.x + guide.width + margin);
    this.region = { x: x0, y: guide.y, width: x1 - x0, height: guide.height };
    const scale = Math.min(1, (this.opts.maxWorkHeight ?? 1080) / this.region.height);
    this.workSize = {
      width: Math.max(16, Math.round(this.region.width * scale)),
      height: Math.max(16, Math.round(this.region.height * scale)),
    };
    if (!this.canvas) this.canvas = document.createElement('canvas');
    this.canvas.width = this.workSize.width;
    this.canvas.height = this.workSize.height;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!this.ctx) throw new Error('2D canvas not supported');

    const { camera: _c, fps: _f, guide: _g, edgeMargin: _e, maxWorkHeight: _m, autoFinish: _a, mirror: _mi, autoStart: _as, sound: _so, autoStop: _ast, ...stitcherOpts } = this.opts;
    this.stitcher = new CylinderStitcher({
      // With auto-stop the user decides when the turn is done; the stitcher must not stop early.
      autoComplete: this.autoStopOptions() === null,
      ...stitcherOpts,
      geometry: {
        centerX: (guide.x + guide.width / 2 - x0) * scale,
        radius: (guide.width / 2) * scale,
        ...stitcherOpts.geometry,
      },
    });
  }

  private grab(v: HTMLVideoElement): RGBAImage {
    const r = this.region!;
    const { width, height } = this.workSize;
    this.ctx!.drawImage(v, r.x, r.y, r.width, r.height, 0, 0, width, height);
    return this.ctx!.getImageData(0, 0, width, height);
  }

  private fail(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    this.stopLoop();
    this.setState({ status: 'error', error: error.message, message: error.message });
    this.emit('error', error);
  }

  private setState(patch: Partial<ScanState>): void {
    this._state = { ...this._state, ...patch };
    this.emit('state', this._state);
  }

  private emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    this.listeners[event].forEach((l) => {
      try {
        l(payload);
      } catch (e) {
        console.error(e);
      }
    });
  }
}
