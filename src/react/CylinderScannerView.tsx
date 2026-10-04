import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import type { ScanResult, ScanState, ScannerOptions } from 'spin-scan';
import { useCylinderScanner } from './useCylinderScanner';

export interface CylinderScannerViewProps {
  options?: ScannerOptions;
  /** Open the camera on mount. Default true. */
  autoStartCamera?: boolean;
  /**
   * Start scanning as soon as the camera is ready. Default false (user presses Start).
   * For hands-free use prefer `options.autoStart`, which waits until the bottle is turning.
   */
  autoStartScan?: boolean;
  onComplete?: (result: ScanResult) => void;
  onStateChange?: (state: ScanState) => void;
  onError?: (error: Error) => void;
  /** Show the built-in Start / Finish buttons. Default true. */
  showControls?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Rendered over the video (e.g. your own controls). */
  children?: ReactNode;
}

const SPEED_COLORS: Record<string, string> = {
  good: '#22c55e',
  'too-slow': '#eab308',
  'too-fast': '#ef4444',
  idle: '#94a3b8',
};

/** Camera view with an alignment guide, progress, speed indicator and guidance text. */
export function CylinderScannerView(props: CylinderScannerViewProps) {
  const {
    options,
    autoStartCamera = true,
    autoStartScan = false,
    onComplete,
    onStateChange,
    onError,
    showControls = true,
    className,
    style,
    children,
  } = props;
  const s = useCylinderScanner(options);
  const callbacks = useRef({ onComplete, onStateChange, onError });
  callbacks.current = { onComplete, onStateChange, onError };

  useEffect(() => {
    if (!autoStartCamera) return;
    s.startCamera()
      .then(() => autoStartScan && s.startScan())
      .catch(() => undefined);
    return () => s.stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStartCamera, s.scanner]);

  useEffect(() => {
    if (s.state) callbacks.current.onStateChange?.(s.state);
  }, [s.state]);
  useEffect(() => {
    if (s.result) callbacks.current.onComplete?.(s.result);
  }, [s.result]);
  useEffect(() => {
    if (s.error) callbacks.current.onError?.(s.error);
  }, [s.error]);

  const st = s.state;
  const size = st?.videoSize;
  const guide = st?.guide;
  const speed = st?.analysis?.speed;
  const progress = st?.progress ?? 0;
  const capturing = st?.status === 'scanning' || st?.status === 'stopping';
  const scanning = capturing || st?.status === 'countdown';
  const pending = st?.status === 'waiting' || st?.status === 'countdown';
  const autoStart = !!options?.autoStart;
  const stroke = scanning ? SPEED_COLORS[speed?.status ?? 'idle'] : '#ffffff';
  // The guide is horizontally centred, so only the video needs flipping when mirrored.
  const flip: CSSProperties | undefined = st?.mirrored ? { transform: 'scaleX(-1)' } : undefined;

  return (
    <div
      className={className}
      style={{ position: 'relative', background: '#000', overflow: 'hidden', width: '100%', ...style }}
    >
      <video
        ref={s.videoRef}
        muted
        playsInline
        autoPlay
        style={{ display: 'block', width: '100%', height: '100%', objectFit: 'contain', ...flip }}
      />
      {size && guide && (
        <svg
          viewBox={`0 0 ${size.width} ${size.height}`}
          preserveAspectRatio="xMidYMid meet"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
        >
          <defs>
            <mask id="cp-guide-mask">
              <rect width={size.width} height={size.height} fill="white" />
              <rect x={guide.x} y={guide.y} width={guide.width} height={guide.height} rx={guide.width * 0.08} fill="black" />
            </mask>
          </defs>
          <rect width={size.width} height={size.height} fill="rgba(0,0,0,0.45)" mask="url(#cp-guide-mask)" />
          <rect
            x={guide.x}
            y={guide.y}
            width={guide.width}
            height={guide.height}
            rx={guide.width * 0.08}
            fill="none"
            stroke={stroke}
            strokeWidth={Math.max(3, size.width / 200)}
          />
          {/* Centre line: the strip that gets stitched. */}
          <line
            x1={guide.x + guide.width / 2}
            x2={guide.x + guide.width / 2}
            y1={guide.y}
            y2={guide.y + guide.height}
            stroke={stroke}
            strokeOpacity={0.5}
            strokeDasharray="12 12"
            strokeWidth={Math.max(2, size.width / 400)}
          />
          {/* Progress bar under the guide. */}
          <rect
            x={guide.x}
            y={guide.y + guide.height + size.height * 0.02}
            width={guide.width}
            height={size.height * 0.012}
            fill="rgba(255,255,255,0.25)"
            rx={size.height * 0.006}
          />
          <rect
            x={guide.x}
            y={guide.y + guide.height + size.height * 0.02}
            width={guide.width * Math.min(1, progress)}
            height={size.height * 0.012}
            fill="#22c55e"
            rx={size.height * 0.006}
          />
        </svg>
      )}
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          right: 12,
          textAlign: 'center',
          color: '#fff',
          font: '600 16px/1.3 system-ui, sans-serif',
          textShadow: '0 1px 3px rgba(0,0,0,0.8)',
        }}
      >
        {st?.message}
        {capturing && speed && (
          <div style={{ fontWeight: 400, fontSize: 13, opacity: 0.85 }}>
            {Math.abs(speed.degPerSec).toFixed(0)}°/s · {Math.round(progress * 100)}%
          </div>
        )}
      </div>
      {st?.status === 'countdown' && st.countdown == null && (
        <div
          aria-live="assertive"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            textAlign: 'center',
            color: '#fde047',
            font: '700 clamp(22px, 6vw, 40px)/1.2 system-ui, sans-serif',
            textShadow: '0 2px 10px rgba(0,0,0,0.9)',
            pointerEvents: 'none',
            animation: 'cp-flash 0.8s ease-in-out infinite alternate',
          }}
        >
          <style>{'@keyframes cp-flash { from { opacity: 1 } to { opacity: 0.25 } }'}</style>
          ↺ Turn the bottle back to where the label starts
        </div>
      )}
      {(st?.status === 'countdown' || st?.status === 'stopping') && st.countdown != null && (
        <div
          aria-live="assertive"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            font: '700 min(30vw, 160px)/1 system-ui, sans-serif',
            textShadow: '0 2px 12px rgba(0,0,0,0.8)',
            pointerEvents: 'none',
          }}
        >
          {st.countdown}
        </div>
      )}
      {showControls && (
        <div style={{ position: 'absolute', bottom: 12, left: 0, right: 0, display: 'flex', gap: 8, justifyContent: 'center' }}>
          {capturing ? (
            <button type="button" onClick={() => void s.finish()} style={buttonStyle}>
              Finish
            </button>
          ) : (
            <button
              type="button"
              disabled={!st || st.status === 'idle' || st.status === 'starting' || st.status === 'processing'}
              onClick={() => (!pending && autoStart ? s.arm() : s.startScan())}
              style={buttonStyle}
            >
              {st?.status === 'complete' ? 'Scan again' : pending ? 'Start now' : 'Start'}
            </button>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

const buttonStyle: CSSProperties = {
  padding: '10px 22px',
  borderRadius: 999,
  border: 'none',
  background: '#fff',
  color: '#111',
  font: '600 15px system-ui, sans-serif',
  cursor: 'pointer',
};
