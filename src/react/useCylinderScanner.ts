import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { CylinderScanner, type ScanResult, type ScanState, type ScannerOptions } from 'spin-scan';

export interface UseCylinderScannerResult {
  /** Attach to a `<video>` element. */
  videoRef: RefObject<HTMLVideoElement | null>;
  state: ScanState | null;
  result: ScanResult | null;
  error: Error | null;
  startCamera: () => Promise<void>;
  stopCamera: () => void;
  /** Use a recorded clip instead of the camera (call after setting `video.src`). */
  useVideo: () => Promise<void>;
  startScan: () => void;
  /** Wait for the bottle to start turning, then scan (hands-free). */
  arm: () => void;
  stopScan: () => void;
  /** Stop and build the image from what has been captured so far. */
  finish: () => Promise<ScanResult | null>;
  /** Clear the result so another scan can be made. */
  reset: () => void;
  /** Flip the preview (display only). `'auto'` mirrors webcams/front cameras. */
  setMirror: (mirror: boolean | 'auto') => void;
  scanner: CylinderScanner | null;
}

/**
 * React hook around {@link CylinderScanner}. Options are read once on mount.
 * Safe for SSR: nothing touches browser APIs until effects run on the client.
 */
export function useCylinderScanner(options: ScannerOptions = {}): UseCylinderScannerResult {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<CylinderScanner | null>(null);
  const optionsRef = useRef(options);
  const [state, setState] = useState<ScanState | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [, force] = useState(0);

  useEffect(() => {
    const scanner = new CylinderScanner(optionsRef.current);
    scannerRef.current = scanner;
    const offs = [
      scanner.on('state', setState),
      scanner.on('complete', setResult),
      scanner.on('error', setError),
    ];
    setState(scanner.state);
    force((n) => n + 1);
    return () => {
      offs.forEach((off) => off());
      scanner.destroy();
      if (scannerRef.current === scanner) scannerRef.current = null;
    };
  }, []);

  const requireVideo = () => {
    const s = scannerRef.current;
    const v = videoRef.current;
    if (!s || !v) throw new Error('Scanner not mounted yet');
    return { s, v };
  };

  const startCamera = useCallback(async () => {
    setError(null);
    const { s, v } = requireVideo();
    await s.startCamera(v);
  }, []);

  const useVideo = useCallback(async () => {
    setError(null);
    const { s, v } = requireVideo();
    s.stopCamera();
    await s.attachVideo(v);
  }, []);

  const startScan = useCallback(() => {
    setResult(null);
    setError(null);
    scannerRef.current?.startScan();
  }, []);

  const arm = useCallback(() => {
    setResult(null);
    setError(null);
    scannerRef.current?.arm();
  }, []);

  const stopScan = useCallback(() => scannerRef.current?.stopScan(), []);
  const stopCamera = useCallback(() => scannerRef.current?.stopCamera(), []);
  const finish = useCallback(async () => (scannerRef.current ? scannerRef.current.finish() : null), []);
  const reset = useCallback(() => {
    setResult(null);
    scannerRef.current?.stopScan();
  }, []);
  const setMirror = useCallback((mirror: boolean | 'auto') => scannerRef.current?.setMirror(mirror), []);

  return {
    videoRef,
    state,
    result,
    error,
    startCamera,
    stopCamera,
    useVideo,
    startScan,
    arm,
    stopScan,
    finish,
    reset,
    setMirror,
    scanner: scannerRef.current,
  };
}
