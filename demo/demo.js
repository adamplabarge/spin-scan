import { CylinderScanner, setTorch } from '../dist/index.js';
import { createSyntheticLabel, renderCylinderFrame } from '../dist/testing.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const overlay = $('overlay');
let scanner = null;
let simHandle = null;
let recorder = null;
let torchOn = false;
let lastResult = null;

function numberOpt(id) {
  const v = parseFloat($(id).value);
  return Number.isFinite(v) ? v : undefined;
}

function mirrorOpt() {
  const v = $('optMirror').value;
  return v === 'auto' ? 'auto' : v === 'on';
}

function buildScanner() {
  scanner?.destroy();
  stopSim();
  scanner = new CylinderScanner({
    fps: numberOpt('optFps'),
    guide: { width: numberOpt('optGw'), height: numberOpt('optGh') },
    speed: { minDegPerSec: numberOpt('optMin'), maxDegPerSec: numberOpt('optMax') },
    mirror: mirrorOpt(),
    autoStart: $('optAuto').checked && { instructionSec: numberOpt('optInstr') ?? 2, countdownSec: numberOpt('optCountdown') ?? 3 },
    autoStop: $('optAutoStop').checked && { stillSec: numberOpt('optStill') ?? 3, countdownSec: numberOpt('optStopCountdown') ?? 3 },
  });
  scanner.on('state', render);
  scanner.on('complete', showResult);
  scanner.on('error', (e) => console.error(e));
  return scanner;
}

function render(s) {
  $('message').textContent = s.message;
  // Display only: the guide is centred, so the overlay doesn't need flipping.
  video.style.transform = s.mirrored ? 'scaleX(-1)' : '';
  const a = s.analysis;
  const capturing = s.status === 'scanning' || s.status === 'stopping';
  $('sub').textContent = capturing && a ? `${Math.abs(a.speed.degPerSec).toFixed(0)}°/s · ${Math.round(s.progress * 100)}%` : s.status;
  const pending = s.status === 'waiting' || s.status === 'countdown';
  $('btnStart').disabled = !['ready', 'waiting', 'countdown', 'complete', 'error'].includes(s.status);
  $('btnStart').textContent = s.status === 'complete' ? 'Scan again' : pending ? 'Start now' : 'Start scan';
  $('instruction').classList.toggle('show', s.status === 'countdown' && s.countdown == null);
  $('countdown').textContent = (s.status === 'countdown' || s.status === 'stopping') && s.countdown != null ? String(s.countdown) : '';
  $('btnFinish').disabled = !capturing;
  drawOverlay(s);
  if (a) {
    $('debug').textContent = JSON.stringify(
      {
        status: s.status,
        phase: a.phase,
        frame: a.frameIndex,
        tracked: a.tracked,
        stitched: a.stitched,
        shiftX: +a.shiftX.toFixed(2),
        shiftY: +a.shiftY.toFixed(2),
        confidence: +a.confidence.toFixed(3),
        coverage: +a.coverage.toFixed(3),
        loopDetected: a.loopDetected,
        countdown: s.countdown,
        direction: a.direction,
        speed: { degPerSec: +a.speed.degPerSec.toFixed(1), status: a.speed.status, steadiness: +a.speed.steadiness.toFixed(2) },
        quality: {
          relativeSharpness: +a.quality.relativeSharpness.toFixed(2),
          glare: +a.quality.glareFraction.toFixed(3),
          luminance: +a.quality.meanLuminance.toFixed(0),
        },
        warnings: a.warnings,
        geometry: a.geometry && { centerX: +a.geometry.centerX.toFixed(1), radius: +a.geometry.radius.toFixed(1) },
        video: s.videoSize,
      },
      null,
      1,
    );
  }
}

const SPEED_COLORS = { good: '#22c55e', 'too-slow': '#eab308', 'too-fast': '#ef4444', idle: '#94a3b8' };

function drawOverlay(s) {
  const size = s.videoSize;
  const g = s.guide;
  if (!size || !g) {
    overlay.innerHTML = '';
    return;
  }
  const color = ['scanning', 'stopping', 'countdown'].includes(s.status) ? SPEED_COLORS[s.analysis?.speed.status ?? 'idle'] : '#fff';
  const sw = Math.max(3, size.width / 200);
  const by = g.y + g.height + size.height * 0.02;
  const bh = size.height * 0.012;
  overlay.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`);
  overlay.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  overlay.innerHTML = `
    <rect x="${g.x}" y="${g.y}" width="${g.width}" height="${g.height}" rx="${g.width * 0.08}" fill="none" stroke="${color}" stroke-width="${sw}"/>
    <line x1="${g.x + g.width / 2}" x2="${g.x + g.width / 2}" y1="${g.y}" y2="${g.y + g.height}" stroke="${color}" stroke-opacity="0.5" stroke-dasharray="12 12" stroke-width="${sw / 2}"/>
    <rect x="${g.x}" y="${by}" width="${g.width}" height="${bh}" fill="rgba(255,255,255,.25)"/>
    <rect x="${g.x}" y="${by}" width="${g.width * Math.min(1, s.progress)}" height="${bh}" fill="#22c55e"/>`;
}

function showResult(r) {
  lastResult = r;
  $('result').style.display = 'grid';
  r.toCanvas($('resultCanvas'));
  $('resultInfo').textContent =
    `${r.image.width}×${r.image.height}px · loop ${r.loopClosed ? 'closed' : 'NOT closed'} · period ${r.periodPx}px ` +
    `(expected ${r.expectedCircumferencePx.toFixed(0)}) · coverage ${(r.coverage * 100).toFixed(0)}% · ` +
    `frames ${r.framesStitched}/${r.framesProcessed} · gaps ${r.filledGapColumns}`;
  console.log('result', r);
}

function resetVideo() {
  video.pause();
  video.removeAttribute('src');
  video.srcObject = null;
  video.load();
}

$('btnCamera').onclick = async () => {
  const s = buildScanner();
  resetVideo();
  try {
    await s.startCamera(video);
    $('btnTorch').disabled = false;
    $('btnRecord').disabled = false;
  } catch (e) {
    $('message').textContent = `Camera error: ${e.message}`;
  }
};

$('fileInput').onchange = async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  const s = buildScanner();
  resetVideo();
  $('btnTorch').disabled = true;
  $('btnRecord').disabled = true;
  video.src = URL.createObjectURL(file);
  await s.attachVideo(video);
  video.playbackRate = numberOpt('optRate') ?? 1;
  video.currentTime = 0;
  // With auto-start the scanner is already waiting for rotation; otherwise start right away.
  if (s.state.status !== 'waiting') s.startScan();
  await video.play();
  ev.target.value = '';
};

$('btnSim').onclick = async () => {
  const s = buildScanner();
  resetVideo();
  $('btnTorch').disabled = true;
  $('btnRecord').disabled = true;
  const W = 480, H = 640, R = 144;
  const label = createSyntheticLabel(Math.round(2 * Math.PI * R), Math.round(H * 0.6), 4);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const start = performance.now();
  const draw = (now) => {
    const deg = numberOpt('optSimSpeed') ?? 30;
    const angle = simAngle((now - start) / 1000, deg);
    const frame = renderCylinderFrame(label, angle, { frameWidth: W, frameHeight: H, centerX: W / 2, radius: R, glareAt: 0.25, noise: 3, samples: 2 });
    ctx.putImageData(new ImageData(frame.data, W, H), 0, 0);
    simHandle = requestAnimationFrame(draw);
  };
  draw(start);
  video.srcObject = canvas.captureStream(30);
  await video.play();
  await s.attachVideo(video);
};

/**
 * Scripted user for the simulation (degrees → radians): hold still, turn a little (auto-start
 * detects it), turn back to the start and hold during the instruction + countdown, turn ~1.1
 * turns, then hold still so auto-stop runs.
 */
function simAngle(sec, degPerSec) {
  const nudge = 1.5 * degPerSec;
  let deg;
  if (sec < 1.5) deg = 0;
  else if (sec < 3) deg = (sec - 1.5) * degPerSec;
  else if (sec < 4.5) deg = nudge - (sec - 3) * degPerSec;
  else if (sec < 8) deg = 0;
  else deg = Math.min((sec - 8) * degPerSec, 400);
  return (deg * Math.PI) / 180;
}

function stopSim() {
  if (simHandle !== null) cancelAnimationFrame(simHandle);
  simHandle = null;
}

$('btnStart').onclick = () => {
  $('result').style.display = 'none';
  if (video.src && !video.srcObject) {
    video.currentTime = 0;
    video.play();
  }
  if (!scanner) return;
  const pending = ['waiting', 'countdown'].includes(scanner.state.status);
  if (!pending && $('optAuto').checked) scanner.arm();
  else scanner.startScan();
};
$('btnFinish').onclick = () => scanner?.finish();

$('optAuto').onchange = () => {
  if (!scanner) return;
  const st = scanner.state.status;
  if ($('optAuto').checked && (st === 'ready' || st === 'complete')) scanner.arm();
  else if (!$('optAuto').checked && (st === 'waiting' || st === 'countdown')) scanner.stopScan();
};
$('optMirror').onchange = () => scanner?.setMirror(mirrorOpt());

$('btnTorch').onclick = async () => {
  if (!scanner?.mediaStream) return;
  torchOn = !torchOn;
  const ok = await setTorch(scanner.mediaStream, torchOn);
  if (!ok) $('message').textContent = 'Torch not supported on this device/browser';
};

$('btnRecord').onclick = () => {
  if (recorder) {
    recorder.stop();
    return;
  }
  const stream = scanner?.mediaStream;
  if (!stream) return;
  const mime = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
  const chunks = [];
  recorder = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 10_000_000 });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: recorder.mimeType });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `bottle-${Date.now()}.${recorder.mimeType.includes('mp4') ? 'mp4' : 'webm'}`;
    a.textContent = `Download clip (${(blob.size / 1e6).toFixed(1)} MB)`;
    $('recInfo').replaceChildren(a);
    recorder = null;
    $('btnRecord').textContent = '● Record clip';
  };
  recorder.start(500);
  $('btnRecord').textContent = '■ Stop recording';
  $('recInfo').textContent = 'Recording…';
};

$('btnDownload').onclick = async () => {
  if (!lastResult) return;
  const blob = await lastResult.toBlob('image/png');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `label-${Date.now()}.png`;
  a.click();
};
