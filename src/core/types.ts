/** RGBA image, structurally compatible with the DOM `ImageData`. */
export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Single-channel float image (luminance 0..255). */
export interface GrayImage {
  width: number;
  height: number;
  data: Float32Array;
}

/**
 * Where the cylinder sits inside a frame, in frame pixels.
 * The cylinder axis is assumed to be vertical (bottle held upright).
 */
export interface CylinderGeometry {
  /** X coordinate of the cylinder axis (continuous pixel coordinates, 0 = left edge of the frame). */
  centerX: number;
  /** Radius of the cylinder silhouette in pixels. */
  radius: number;
}

export type SpeedStatus = 'idle' | 'too-slow' | 'good' | 'too-fast';

export type RotationDirection = 'left' | 'right' | 'unknown';

export type ScanWarning =
  | 'too-fast'
  | 'too-slow'
  | 'stalled'
  | 'reversed'
  | 'lost-tracking'
  | 'blurry'
  | 'glare'
  | 'too-dark'
  | 'unsteady'
  | 'vertical-drift';

export type StitcherPhase = 'calibrating' | 'scanning' | 'complete';

export interface SpeedReading {
  /** Smoothed angular speed in degrees per second (signed: positive = label moves right). */
  degPerSec: number;
  status: SpeedStatus;
  /** 0..1, 1 = perfectly constant speed over the recent window. */
  steadiness: number;
}

export interface FrameQuality {
  /** Variance of the Laplacian; higher = sharper. */
  sharpness: number;
  /** Sharpness relative to the recent median (1 = typical). */
  relativeSharpness: number;
  /** Fraction (0..1) of pixels that are blown out (specular glare). */
  glareFraction: number;
  /** Mean luminance 0..255. */
  meanLuminance: number;
}

export interface FrameAnalysis {
  phase: StitcherPhase;
  /** Whether this frame was successfully registered against the previous one. */
  tracked: boolean;
  /** Whether pixels from this frame were added to the panorama. */
  stitched: boolean;
  /** Horizontal label motion since the last tracked frame, in unwrapped (arc-length) pixels. */
  shiftX: number;
  /** Vertical motion since the last tracked frame, in pixels. */
  shiftY: number;
  /** Registration confidence 0..1 (phase-correlation peak height). */
  confidence: number;
  /** Fraction of the circumference covered so far (>= 1 means a full turn). */
  coverage: number;
  /** Total rotation so far in degrees (absolute). */
  rotationDeg: number;
  /** True once the scan has come back round to already-captured label content. */
  loopDetected: boolean;
  direction: RotationDirection;
  speed: SpeedReading;
  quality: FrameQuality;
  warnings: ScanWarning[];
  geometry: CylinderGeometry | null;
  frameIndex: number;
}

export interface StitchResult {
  /** The flattened label. */
  image: RGBAImage;
  /** True when the end of the scan was matched against the start (a clean 360° wrap). */
  loopClosed: boolean;
  /** Width of one full revolution in output pixels. */
  periodPx: number;
  /** Circumference predicted from the measured radius (2πr). */
  expectedCircumferencePx: number;
  /** Fraction of a full revolution that was captured. */
  coverage: number;
  /** Number of output columns that had no data and were interpolated. */
  filledGapColumns: number;
  framesProcessed: number;
  framesStitched: number;
  geometry: CylinderGeometry;
}
