import type { RGBAImage } from '../core/types';

export interface CameraOptions {
  /** Default 'environment' (rear camera). */
  facingMode?: 'environment' | 'user';
  /** Ideal capture width. Default 1920. */
  width?: number;
  /** Ideal capture height. Default 1080. */
  height?: number;
  /** Ideal camera frame rate. Default 30. */
  frameRate?: number;
  /** Specific device id (overrides facingMode). */
  deviceId?: string;
  /** Turn on the torch where supported. Default false (torch often causes glare on glossy labels). */
  torch?: boolean;
}

/** Opens the camera with settings suited to close-up label capture. */
export async function openCamera(options: CameraOptions = {}): Promise<MediaStream> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera access is not available (requires a browser and a secure context: https or localhost)');
  }
  const video: MediaTrackConstraints = {
    width: { ideal: options.width ?? 1920 },
    height: { ideal: options.height ?? 1080 },
    frameRate: { ideal: options.frameRate ?? 30 },
  };
  if (options.deviceId) video.deviceId = { exact: options.deviceId };
  else video.facingMode = { ideal: options.facingMode ?? 'environment' };

  const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  const track = stream.getVideoTracks()[0];
  if (track) await tuneTrack(track, options);
  return stream;
}

/** Best-effort: continuous autofocus and optional torch. Unsupported constraints are ignored. */
async function tuneTrack(track: MediaStreamTrack, options: CameraOptions): Promise<void> {
  const caps = (track.getCapabilities?.() ?? {}) as Record<string, unknown>;
  const advanced: Record<string, unknown>[] = [];
  const focus = caps.focusMode as string[] | undefined;
  if (focus?.includes('continuous')) advanced.push({ focusMode: 'continuous' });
  if (options.torch && caps.torch) advanced.push({ torch: true });
  if (!advanced.length) return;
  try {
    await track.applyConstraints({ advanced } as MediaTrackConstraints);
  } catch {
    // Not fatal: some browsers reject advanced constraints they advertise.
  }
}

export async function setTorch(stream: MediaStream, on: boolean): Promise<boolean> {
  const track = stream.getVideoTracks()[0];
  const caps = (track?.getCapabilities?.() ?? {}) as Record<string, unknown>;
  if (!track || !caps.torch) return false;
  try {
    await track.applyConstraints({ advanced: [{ torch: on }] } as unknown as MediaTrackConstraints);
    return true;
  } catch {
    return false;
  }
}

export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((t) => t.stop());
}

/** Draws an RGBA image into a (new or given) canvas. */
export function imageToCanvas(img: RGBAImage, canvas?: HTMLCanvasElement): HTMLCanvasElement {
  const c = canvas ?? document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas not supported');
  const data = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  ctx.putImageData(data, 0, 0);
  return c;
}

export function imageToBlob(img: RGBAImage, type = 'image/png', quality?: number): Promise<Blob> {
  const c = imageToCanvas(img);
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('Failed to encode image'))), type, quality),
  );
}

export function imageToDataURL(img: RGBAImage, type = 'image/png', quality?: number): string {
  return imageToCanvas(img).toDataURL(type, quality);
}
