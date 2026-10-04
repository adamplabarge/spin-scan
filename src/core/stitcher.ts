import { arcToScreenX, detectCylinderEdges, unwrapGray, unwrappedWidth } from './cylinder';
import { floorPowerOfTwo } from './fft';
import { laplacianVariance, luminance, median, toGray } from './image';
import {
  PanoramaAccumulator,
  accumulatorGray,
  findOverlap,
  findLoopPeriod,
  findPeriod,
  findQuietSeam,
  mostTexturedOffset,
  foldAccumulator,
  renderAccumulator,
  rollAccumulator,
  validRowRange,
  type DenseAccumulator,
} from './panorama';
import { blockSpectrum, phaseCorrelate, type Spectrum } from './phaseCorrelation';
import { SpeedMonitor, type SpeedOptions } from './speed';
import type {
  CylinderGeometry,
  FrameAnalysis,
  FrameQuality,
  GrayImage,
  RGBAImage,
  RotationDirection,
  ScanWarning,
  StitcherPhase,
  StitchResult,
} from './types';

export interface StitcherOptions {
  /**
   * Known/expected cylinder geometry in frame pixels. Defaults to a cylinder filling the frame
   * width. When `autoDetectEdges` is on this is used as a search hint.
   */
  geometry?: Partial<CylinderGeometry>;
  /** Detect the bottle silhouette during calibration. Default true. */
  autoDetectEdges?: boolean;
  /** Frames used to calibrate the geometry before tracking starts. Default 4. */
  calibrationFrames?: number;
  /** Half-angle of the band around the facing meridian that is used (degrees). Default 50. */
  maxAngleDeg?: number;
  /** Minimum phase-correlation peak for a frame to count as tracked. Default 0.25. */
  minConfidence?: number;
  /** Luminance at/above which a pixel counts as specular glare (blown-out highlight). Default 250. */
  glareThreshold?: number;
  /** Fraction of glare pixels above which a 'glare' warning is raised. Default 0.04. */
  glareWarningFraction?: number;
  /** Mean luminance below which a 'too-dark' warning is raised. Default 45. */
  darkThreshold?: number;
  /** Frames sharper than this fraction of the recent median are stitched; blurrier ones are skipped. Default 0.5. */
  blurRejectRatio?: number;
  /** Strip half-width as a multiple of the per-frame shift. Default 1.5 (each column gets ~3 samples). */
  stripWidthFactor?: number;
  /** Minimum strip half-width in pixels. Default 4. */
  minStripHalfWidth?: number;
  /**
   * Extra rotation captured after the scan is seen to come back round to the start, for a clean
   * seam. Default 0.12 (≈43°).
   */
  completionOverlap?: number;
  /**
   * While scanning, the start of the label is searched for in newly captured columns. A match
   * with at least this NCC score (seen twice in a row) means a full turn is done. Default 0.6.
   */
  overlapMinScore?: number;
  /**
   * Safety stop: complete after this many estimated circumferences (2πr) even if the overlap
   * with the start was never recognised (e.g. very plain labels). Default 1.5.
   */
  maxCoverage?: number;
  /**
   * Whether the stitcher decides by itself when the scan is complete (live overlap detection,
   * `maxCoverage`). Set false when something else decides when to stop (e.g. the scanner's
   * `autoStop`, which ends the scan once the user stops turning). Default true.
   */
  autoComplete?: boolean;
  /** Rotate the final image so the wrap-around seam lands in a blank area. Default true. */
  autoSeam?: boolean;
  /** Minimum NCC score to accept a loop-closure match. Default 0.5. */
  loopClosureMinScore?: number;
  speed?: SpeedOptions;
}

type ResolvedOptions = Required<Omit<StitcherOptions, 'geometry' | 'speed'>> & Pick<StitcherOptions, 'geometry'>;

interface TrackRef {
  spectrum: Spectrum;
  t: number;
  ty: number;
  timeMs: number;
}

/**
 * Turns a sequence of frames of a rotating upright cylinder into a single flat image.
 *
 * Pipeline per frame:
 *  1. (calibration) locate the cylinder silhouette → centre + radius
 *  2. unwrap the visible band into arc-length coordinates, where rotation is a pure translation
 *  3. phase-correlate against the last tracked frame → sub-pixel shift + confidence
 *  4. update speed / quality metrics and warnings
 *  5. splat a feathered strip around the facing meridian into the panorama (glare is down-weighted
 *     so it gets filled in by neighbouring frames)
 * After ≥ 360° + overlap the end is matched against the start, folded to exactly one revolution
 * and the seam is moved into a quiet area.
 *
 * Has no DOM dependency: frames are plain `{ width, height, data }` RGBA images (e.g. `ImageData`).
 */
export class CylinderStitcher {
  private readonly opts: ResolvedOptions;
  private readonly speed: SpeedMonitor;

  private frameW = 0;
  private frameH = 0;
  private geometry: CylinderGeometry | null = null;
  private calibration: CylinderGeometry[] = [];
  private calibrationSeen = 0;
  private maxAngle = 0;
  private trackScale = 1;
  private blockW = 0;
  private blockH = 0;

  private pano: PanoramaAccumulator | null = null;
  private ref: TrackRef | null = null;
  private lastStitchedT: number | null = null;
  private sharpnessHistory: number[] = [];
  private direction: RotationDirection = 'unknown';
  private lostCount = 0;
  private frameIndex = 0;
  private stitchedCount = 0;
  private _phase: StitcherPhase = 'calibrating';
  private lastAnalysis: FrameAnalysis | null = null;
  /** Revolution width found by the live overlap check (null until the scan has come round). */
  private detectedPeriod: number | null = null;
  private overlapPrev: { period: number; score: number } | null = null;
  private overlapOffset: number | null = null;
  private overlapStartAtMin: boolean | null = null;
  private framesSinceCheck = 0;

  constructor(options: StitcherOptions = {}) {
    this.opts = {
      geometry: options.geometry,
      autoDetectEdges: options.autoDetectEdges ?? true,
      calibrationFrames: options.calibrationFrames ?? 4,
      maxAngleDeg: options.maxAngleDeg ?? 50,
      minConfidence: options.minConfidence ?? 0.25,
      glareThreshold: options.glareThreshold ?? 250,
      glareWarningFraction: options.glareWarningFraction ?? 0.04,
      darkThreshold: options.darkThreshold ?? 45,
      blurRejectRatio: options.blurRejectRatio ?? 0.5,
      stripWidthFactor: options.stripWidthFactor ?? 1.5,
      minStripHalfWidth: options.minStripHalfWidth ?? 4,
      completionOverlap: options.completionOverlap ?? 0.12,
      autoSeam: options.autoSeam ?? true,
      loopClosureMinScore: options.loopClosureMinScore ?? 0.5,
      overlapMinScore: options.overlapMinScore ?? 0.6,
      maxCoverage: options.maxCoverage ?? 1.5,
      autoComplete: options.autoComplete ?? true,
    };
    this.speed = new SpeedMonitor(options.speed);
  }

  get phase(): StitcherPhase {
    return this._phase;
  }

  get isComplete(): boolean {
    return this._phase === 'complete';
  }

  /** Cylinder geometry once calibrated. */
  getGeometry(): CylinderGeometry | null {
    return this.geometry ? { ...this.geometry } : null;
  }

  getLastAnalysis(): FrameAnalysis | null {
    return this.lastAnalysis;
  }

  /** Expected circumference (2πr) in output pixels. */
  get circumference(): number {
    return this.geometry ? 2 * Math.PI * this.geometry.radius : 0;
  }

  /**
   * Fraction of a full revolution captured. Uses the revolution width found by the live overlap
   * check once available, otherwise the circumference estimated from the radius.
   */
  get coverage(): number {
    const c = this.detectedPeriod ?? this.circumference;
    return c > 0 && this.pano ? this.pano.span / c : 0;
  }

  /** True once the scan has been seen to come back round to already-captured content. */
  get loopDetected(): boolean {
    return this.detectedPeriod !== null;
  }

  reset(): void {
    this.frameW = this.frameH = 0;
    this.geometry = null;
    this.calibration = [];
    this.calibrationSeen = 0;
    this.sharpnessHistory = [];
    this.speed.reset();
    this.clearPanorama();
    this._phase = 'calibrating';
  }

  /**
   * Starts a fresh panorama but keeps the calibrated geometry and the speed/sharpness history,
   * so tracking continues seamlessly (e.g. at the end of a countdown while the bottle is turning).
   */
  restart(): void {
    this.clearPanorama();
    this._phase = this.geometry ? 'scanning' : 'calibrating';
  }

  private clearPanorama(): void {
    this.pano = null;
    this.ref = null;
    this.lastStitchedT = null;
    this.direction = 'unknown';
    this.lostCount = 0;
    this.frameIndex = 0;
    this.stitchedCount = 0;
    this.lastAnalysis = null;
    this.detectedPeriod = null;
    this.overlapPrev = null;
    this.overlapOffset = null;
    this.overlapStartAtMin = null;
    this.framesSinceCheck = 0;
  }

  /**
   * Adds a frame. All frames must have the same size and show the cylinder at the same place.
   * @param timestampMs capture time; used for speed measurement.
   */
  addFrame(frame: RGBAImage, timestampMs: number): FrameAnalysis {
    if (this.frameW && (frame.width !== this.frameW || frame.height !== this.frameH)) {
      throw new Error(
        `Frame size changed from ${this.frameW}x${this.frameH} to ${frame.width}x${frame.height}; call reset() first`,
      );
    }
    this.frameW = frame.width;
    this.frameH = frame.height;
    const index = this.frameIndex++;

    if (this._phase === 'complete') return this.lastAnalysis ?? this.emptyAnalysis(index);

    if (!this.geometry) {
      this.calibrate(frame);
      if (!this.geometry) {
        return (this.lastAnalysis = this.emptyAnalysis(index));
      }
    }
    const geom = this.geometry;

    const gray = unwrapGray(frame, geom, this.maxAngle, this.trackScale);
    const quality = this.measureQuality(gray);
    const warnings: ScanWarning[] = [];
    if (quality.glareFraction > this.opts.glareWarningFraction) warnings.push('glare');
    if (quality.meanLuminance < this.opts.darkThreshold) warnings.push('too-dark');

    const spectrum = blockSpectrum(gray, this.blockW, this.blockH, { glareThreshold: this.opts.glareThreshold });
    const blurry = quality.relativeSharpness < this.opts.blurRejectRatio;
    if (blurry) warnings.push('blurry');

    let tracked = false;
    let stitched = false;
    let shiftX = 0;
    let shiftY = 0;
    let confidence = 0;

    if (!this.ref) {
      this.ref = { spectrum, t: 0, ty: 0, timeMs: timestampMs };
      this.pano = new PanoramaAccumulator(this.frameH);
      tracked = true;
      confidence = 1;
      if (!blurry) {
        this.stitch(frame, 0, 0, this.opts.minStripHalfWidth);
        stitched = true;
      }
    } else {
      const pc = phaseCorrelate(this.ref.spectrum, spectrum);
      confidence = Math.max(0, pc.peak);
      const maxReliable = this.blockW * 0.4;
      if (pc.peak >= this.opts.minConfidence && Math.abs(pc.dx) <= maxReliable) {
        tracked = true;
        this.lostCount = 0;
        shiftX = pc.dx * this.trackScale;
        shiftY = pc.dy * this.trackScale;
        const t = this.ref.t + shiftX;
        const ty = this.ref.ty + shiftY;
        const dtSec = Math.max(1e-3, (timestampMs - this.ref.timeMs) / 1000);
        const deltaDeg = (shiftX / geom.radius) * (180 / Math.PI);
        const reading = this.speed.update(deltaDeg, dtSec);

        if (Math.abs(pc.dx) > this.blockW * 0.25) warnings.push('too-fast');
        if (Math.abs(shiftY) > Math.max(2, this.frameH * 0.02)) warnings.push('vertical-drift');

        const absSpeed = Math.abs(reading.degPerSec);
        if (absSpeed >= this.speed.options.stallDegPerSec) {
          const dir: RotationDirection = reading.degPerSec > 0 ? 'right' : 'left';
          if (this.direction === 'unknown' && this.coverage > 0.02) this.direction = dir;
          else if (this.direction !== 'unknown' && dir !== this.direction) warnings.push('reversed');
        }

        if (!blurry) {
          const since = this.lastStitchedT === null ? Math.abs(shiftX) : Math.abs(t - this.lastStitchedT);
          const maxHalf = unwrappedWidth(geom.radius, this.maxAngle) / 2 - 2;
          const half = Math.min(maxHalf, Math.max(this.opts.minStripHalfWidth, since * this.opts.stripWidthFactor));
          this.stitch(frame, t, ty, half);
          stitched = true;
        }
        this.ref = { spectrum, t, ty, timeMs: timestampMs };
      } else {
        this.lostCount++;
        warnings.push('lost-tracking');
        if (Math.abs(pc.dx) > maxReliable) warnings.push('too-fast');
      }
    }

    const speed = this.speed.reading();
    if (tracked && this.frameIndex > 2) {
      if (speed.status === 'idle') warnings.push('stalled');
      else if (speed.status === 'too-slow') warnings.push('too-slow');
      else if (speed.status === 'too-fast' && !warnings.includes('too-fast')) warnings.push('too-fast');
      if (speed.status !== 'idle' && speed.steadiness < 0.5) warnings.push('unsteady');
    }

    this.updateCompletion();
    const coverage = this.coverage;

    const analysis: FrameAnalysis = {
      phase: this._phase,
      tracked,
      stitched,
      shiftX,
      shiftY,
      confidence,
      coverage,
      rotationDeg: coverage * 360,
      loopDetected: this.loopDetected,
      direction: this.direction,
      speed,
      quality,
      warnings,
      geometry: { ...geom },
      frameIndex: index,
    };
    this.lastAnalysis = analysis;
    return analysis;
  }

  /** Builds the flat image. Can be called before completion to get a partial result. */
  finish(): StitchResult {
    if (!this.pano || !this.geometry || this.pano.span === 0) {
      throw new Error('No frames have been stitched yet');
    }
    const geom = this.geometry;
    const expected = 2 * Math.PI * geom.radius;
    const live = this.detectedPeriod;
    // Prefer the revolution width measured while scanning over the radius-based estimate.
    const center = live ?? expected;
    let dense: DenseAccumulator = this.pano.toDense();
    const coverage = dense.width / center;
    let loopClosed = false;
    let period = dense.width;

    const minPeriod = this.minLoopPeriod(expected);
    if (live !== null ? dense.width > live * 0.98 : dense.width > minPeriod * 1.1) {
      const gray = accumulatorGray(dense);
      const match =
        live !== null
          ? findPeriod(gray, dense.width, dense.height, live, { searchRange: 0.02 })
          : findLoopPeriod(gray, dense.width, dense.height, minPeriod, Math.round(expected * 0.06));
      if (match && match.score >= this.opts.loopClosureMinScore) {
        loopClosed = true;
        period = match.period;
      } else if (live !== null && dense.width > live) {
        loopClosed = true;
        period = live;
      }
      // No reliable period: leave the strip unfolded. Folding at a guessed period ghosts the text.
      if (period < dense.width) dense = foldAccumulator(dense, period);
    }

    const cyclic = period < this.pano.span;
    if (cyclic && this.opts.autoSeam) {
      const seam = findQuietSeam(accumulatorGray(dense), dense.width, dense.height);
      dense = rollAccumulator(dense, seam);
    }

    const rows = validRowRange(dense);
    const { image, filledGapColumns } = renderAccumulator(dense, rows, cyclic);
    return {
      image,
      loopClosed,
      periodPx: period,
      expectedCircumferencePx: expected,
      coverage: Math.min(coverage, 1 + this.opts.completionOverlap),
      filledGapColumns,
      framesProcessed: this.frameIndex,
      framesStitched: this.stitchedCount,
      geometry: { ...geom },
    };
  }

  /**
   * Decides whether the scan is complete: once the newest columns are recognised as the start of
   * the label (the bottle has come round), capture a little more overlap and stop. Falls back to
   * a radius-based limit if the overlap is never recognised.
   */
  private updateCompletion(): void {
    const pano = this.pano;
    const c = this.circumference;
    if (!pano || !this.ref || c <= 0 || !this.opts.autoComplete) return;
    const span = pano.span;
    if (this.detectedPeriod === null && span >= c * 0.7 && ++this.framesSinceCheck >= 3) {
      this.framesSinceCheck = 0;
      this.checkOverlap(pano, c);
    }
    if (this.detectedPeriod !== null) {
      if (span >= this.detectedPeriod * (1 + this.opts.completionOverlap)) this._phase = 'complete';
    } else if (span >= c * this.opts.maxCoverage) {
      this._phase = 'complete';
    }
  }

  /**
   * Shortest revolution accepted when finding the period at the end. The radius estimate can be
   * badly off on real bottles (silhouette not found, hand in the way), so this is deliberately far
   * below 2πr. It only needs to exceed what a single frame shows.
   */
  private minLoopPeriod(c: number): number {
    const band = this.geometry ? unwrappedWidth(this.geometry.radius, this.maxAngle) : 0;
    return Math.floor(Math.max(c * 0.45, band * 1.5));
  }

  private checkOverlap(pano: PanoramaAccumulator, c: number): void {
    const window = Math.max(8, Math.round(c * 0.06));
    const rowStep = Math.max(1, Math.round(this.frameH / 96));
    if (this.overlapStartAtMin === null || this.overlapOffset === null) {
      // The frame centre sits at s = -t; the panorama is growing at the end nearest to it.
      const cur = -this.ref!.t;
      this.overlapStartAtMin = Math.abs(pano.maxS - cur) <= Math.abs(cur - pano.minS);
      const searchWidth = Math.min(pano.span, Math.max(window, Math.round(c * 0.12)));
      this.overlapOffset = mostTexturedOffset(pano, this.overlapStartAtMin, window, searchWidth, rowStep);
    }
    const m = findOverlap(pano, {
      startAtMin: this.overlapStartAtMin,
      window,
      offset: this.overlapOffset,
      minPeriod: Math.floor(c * 0.7),
      rowStep,
    });
    if (m && m.score >= this.opts.overlapMinScore) {
      // Require the same period twice in a row so a single chance match can't end the scan.
      if (this.overlapPrev && Math.abs(this.overlapPrev.period - m.period) <= 2) this.detectedPeriod = m.period;
      this.overlapPrev = m;
    } else {
      this.overlapPrev = null;
    }
  }

  private calibrate(frame: RGBAImage): void {
    const hint: CylinderGeometry = {
      centerX: this.opts.geometry?.centerX ?? frame.width / 2,
      radius: this.opts.geometry?.radius ?? frame.width / 2,
    };
    if (!this.opts.autoDetectEdges) {
      this.lockGeometry(hint);
      return;
    }
    const d = frame.width > 800 ? 2 : 1;
    const detected = detectCylinderEdges(toGray(frame, d), {
      hint: { centerX: hint.centerX / d, radius: hint.radius / d },
    });
    if (detected) this.calibration.push({ centerX: detected.centerX * d, radius: detected.radius * d });
    this.calibrationSeen++;
    if (this.calibrationSeen >= this.opts.calibrationFrames) {
      const n = this.calibration.length;
      // Use detection only if it was consistent in most calibration frames.
      this.lockGeometry(
        n >= Math.ceil(this.opts.calibrationFrames / 2)
          ? {
              centerX: median(this.calibration.map((g) => g.centerX)),
              radius: median(this.calibration.map((g) => g.radius)),
            }
          : hint,
      );
    }
  }

  private lockGeometry(g: CylinderGeometry): void {
    const radius = Math.max(8, Math.min(g.radius, this.frameW));
    this.geometry = { centerX: g.centerX, radius };
    // Never sample beyond the frame edges.
    const maxByFrame = Math.min(g.centerX, this.frameW - g.centerX) / radius;
    const maxAngleByFrame = maxByFrame >= 1 ? Math.PI / 2 : Math.asin(Math.max(0.1, maxByFrame));
    this.maxAngle = Math.min((this.opts.maxAngleDeg * Math.PI) / 180, maxAngleByFrame * 0.98);

    const wu = unwrappedWidth(radius, this.maxAngle);
    this.trackScale = Math.max(1, Math.floor(Math.min(wu, this.frameH) / 128));
    const tw = Math.floor(wu / this.trackScale);
    const th = Math.floor(this.frameH / this.trackScale);
    this.blockW = Math.min(256, floorPowerOfTwo(tw));
    this.blockH = Math.min(256, floorPowerOfTwo(th));
    if (this.blockW < 16 || this.blockH < 16) {
      throw new Error(`Cylinder too small to track (unwrapped band ${wu}x${this.frameH}px)`);
    }
    this._phase = 'scanning';
  }

  private measureQuality(gray: GrayImage): FrameQuality {
    const sharpness = laplacianVariance(gray);
    this.sharpnessHistory.push(sharpness);
    if (this.sharpnessHistory.length > 15) this.sharpnessHistory.shift();
    const ref = median(this.sharpnessHistory);
    let glare = 0;
    let sum = 0;
    const thr = this.opts.glareThreshold;
    for (let i = 0; i < gray.data.length; i++) {
      const v = gray.data[i];
      sum += v;
      if (v >= thr) glare++;
    }
    return {
      sharpness,
      relativeSharpness: ref > 0 ? sharpness / ref : 1,
      glareFraction: gray.data.length ? glare / gray.data.length : 0,
      meanLuminance: gray.data.length ? sum / gray.data.length : 0,
    };
  }

  /**
   * Splats the strip |arc| <= half around the facing meridian into the panorama.
   * Surface coordinate s = arc − t, so frame content at arc = s + t lands at column s.
   */
  private stitch(frame: RGBAImage, t: number, ty: number, half: number): void {
    const pano = this.pano!;
    const geom = this.geometry!;
    const fw = frame.width;
    const h = frame.height;
    const src = frame.data;
    const glareThr = this.opts.glareThreshold;
    const rowShift = Math.round(ty);
    const sStart = Math.ceil(-half - t);
    const sEnd = Math.floor(half - t);
    for (let s = sStart; s <= sEnd; s++) {
      const arc = s + t;
      const feather = 1 - Math.abs(arc) / (half + 1);
      if (feather <= 0) continue;
      const x = arcToScreenX(geom, arc) - 0.5;
      const x0 = Math.max(0, Math.min(fw - 2, Math.floor(x)));
      const fx = Math.max(0, Math.min(1, x - x0));
      const col = pano.column(s);
      for (let y = 0; y < h; y++) {
        const py = y - rowShift;
        if (py < 0 || py >= h) continue;
        const i = (y * fw + x0) * 4;
        const r = src[i] + (src[i + 4] - src[i]) * fx;
        const g = src[i + 1] + (src[i + 5] - src[i + 1]) * fx;
        const b = src[i + 2] + (src[i + 6] - src[i + 2]) * fx;
        const w = luminance(r, g, b) >= glareThr ? feather * 0.02 : feather;
        const o = py * 4;
        col[o] += r * w;
        col[o + 1] += g * w;
        col[o + 2] += b * w;
        col[o + 3] += w;
      }
    }
    this.lastStitchedT = t;
    this.stitchedCount++;
  }

  private emptyAnalysis(index: number): FrameAnalysis {
    return {
      phase: this._phase,
      tracked: false,
      stitched: false,
      shiftX: 0,
      shiftY: 0,
      confidence: 0,
      coverage: this.coverage,
      rotationDeg: this.coverage * 360,
      loopDetected: this.loopDetected,
      direction: this.direction,
      speed: this.speed.reading(),
      quality: { sharpness: 0, relativeSharpness: 1, glareFraction: 0, meanLuminance: 0 },
      warnings: [],
      geometry: this.getGeometry(),
      frameIndex: index,
    };
  }
}
