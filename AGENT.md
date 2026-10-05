# AGENT.md — spin-scan working notes

Context for anyone (human or AI agent) picking up this project: what was built, why it was built that way, where the tuning knobs are, and a log of real-bottle testing. **Update this file whenever behaviour, defaults or findings change.**

## Publishing

Releases are automated on pushes to `main`. Use [Conventional Commits](https://www.conventionalcommits.org/) to say what kind of change you are making:

- `fix: correct scan progress` publishes a patch release.
- `feat: add scan pause support` publishes a minor release.
- `feat!: change the scanner result format` publishes a major release. You can also include a `BREAKING CHANGE:` footer.
- Other commit types, such as `docs:` and `chore:`, do not publish a release.

The workflow runs the `prepublishOnly` checks and build, publishes to npm with provenance, creates a GitHub Release, and updates `CHANGELOG.md` and the package version files. Create an npm granular access token with read/write permission to publish `spin-scan` and enable **Bypass two-factor authentication**, then save it as the `NPM_TOKEN` Actions secret in the GitHub repository settings. Without the bypass option, npm can require an interactive one-time password (`EOTP`), which CI cannot supply. The semantic-release npm plugin configures authentication from `NPM_TOKEN`; no manual token-writing step is needed. Rotate the secret before the token expires. `GITHUB_TOKEN` is supplied by GitHub Actions with the permissions needed to publish releases and report release failures.

If the repository already has a published version but no matching Git tag, add a tag for that version (for example, `v0.1.0`) to its release commit before relying on automated versioning. Without a prior release tag, semantic-release starts at `1.0.0`.

## Goal and ground rules

- Browser library (TypeScript → JS, published to npm as `spin-scan`). It scans a medication-bottle label while the user rotates the bottle and outputs **one flat image**.
- **No OCR in this library.** OCR happens downstream on the output image.
- Must work in a plain HTML page (`demo/`) and in a Next.js app (`spin-scan/react`).
- **Keep automated tests basic.** Real-world validation is done with physical bottles; record the findings below.

## Current status (2026-10-04)

**Working prototype.** On a real Costco Rx bottle (webcam, hand-held), the hands-free flow produces a clean, sharp, single-copy label image that is good enough for the intended use:

> rotate → flat image → **the user clips the medication/prescription region** → OCR on the clip.

So the image doesn't need to be a perfect 360° unwrap. It needs the important block (patient, drug, directions, Rx#) sharp and undistorted, without ghosting.

Known imperfections in the latest real result (accepted for now):
- **The output was narrower than a full turn.** The right side was cut at the phone number. Either the user stopped early or `findLoopPeriod` picked a shorter period; not yet diagnosed (check the demo's result line: `loop closed`, `period` vs `expected`).
- **Slight doubling at a few strip joins** (e.g. "PHARMACY", the bottom small print). This comes from residual tracking drift or uneven speed between strips.
- Bottle cap and orange bottle body appear above and below the label (the row crop uses coverage, not label detection).

Everything from the hands-free auto-start onward (auto-start, start sequence, auto-stop, `findLoopPeriod`, feedback) was **uncommitted** at the time of writing; the last commit is the mirror feature.

## Layout

| Path | Purpose |
|---|---|
| [src/core/stitcher.ts](src/core/stitcher.ts) | `CylinderStitcher`: calibration → tracking → stitching → `finish()` (loop closure, fold, seam, render). **Most defaults live here.** |
| [src/core/phaseCorrelation.ts](src/core/phaseCorrelation.ts) | FFT phase correlation, low-pass weighting, glare masking, sub-pixel refinement |
| [src/core/cylinder.ts](src/core/cylinder.ts) | Arc-length unwrap, silhouette edge detection |
| [src/core/panorama.ts](src/core/panorama.ts) | Accumulator, `findPeriod` / `findLoopPeriod` (loop closure), `findOverlap` (live), fold (narrow seam fade), seam placement, row cropping, gap fill |
| [src/core/autoStart.ts](src/core/autoStart.ts) | `RotationStartDetector`: hands-free start once steady rotation is seen |
| [src/core/speed.ts](src/core/speed.ts) | `SpeedMonitor` (°/s, steadiness, too-slow/too-fast/stalled) |
| [src/core/fft.ts](src/core/fft.ts), [src/core/image.ts](src/core/image.ts), [src/core/types.ts](src/core/types.ts) | FFT, image utilities (gray, sharpness, glare), public types |
| [src/browser/scanner.ts](src/browser/scanner.ts) | `CylinderScanner`: camera/video → frames → stitcher; guide geometry; mirror; hands-free state machine (`waiting` → `countdown` → `scanning` ⇄ `stopping` → `processing` → `complete`); `describeAnalysis` messages |
| [src/browser/feedback.ts](src/browser/feedback.ts) | Beeps (WebAudio) and vibration for countdown ticks, start and done |
| [src/browser/camera.ts](src/browser/camera.ts) | `openCamera`, torch, output helpers |
| [src/react/](src/react/) | `useCylinderScanner` hook, `CylinderScannerView` component (`"use client"`) |
| [src/testing/index.ts](src/testing/index.ts) | Synthetic label + cylinder renderer (`spin-scan/testing`) |
| [demo/](demo/) | Test page: camera, video file, simulated bottle, clip recording, debug JSON panel |
| [scripts/serve.mjs](scripts/serve.mjs) | Static server; `--https` = self-signed cert on LAN for phones |
| [test/](test/) | Basic vitest tests (FFT, unwrap/edges, speed, end-to-end synthetic scans) |

## Commands

```bash
npm test             # vitest (21 tests, ~20 s)
npm run typecheck
npm run build        # tsup → dist/ (ESM + CJS + d.ts)
npm run demo         # http://localhost:5173/demo/
npm run demo:https   # https://<LAN-IP>:5443/demo/ for phone testing (accept the self-signed cert)
npm publish          # prepublishOnly = typecheck + test + build
```

## How the pipeline works (short)

1. **Calibrate** (first 4 frames): detect the bottle silhouette near the on-screen guide to get centreX and radius. If detection fails, fall back to the guide geometry.
2. **Unwrap** the visible band (±50°) into arc-length coordinates, so rotation becomes a horizontal translation.
3. **Track:** phase-correlate each downscaled gray frame against the reference. This gives a sub-pixel shift (x, y) and a confidence.
4. **Analyse:** speed in °/s, steadiness, blur relative to recent frames, glare fraction, luminance, vertical drift, reversal.
5. **Stitch:** splat a feathered centre strip of each sharp frame into the panorama accumulator. Glare pixels are down-weighted.
6. **Stop:** by default (`autoStop`) the user ends the scan by holding the bottle still: still for 3 s → 3 s `'stopping'` countdown → `finish()`. With `autoStop: false`, the stitcher stops by itself using live loop detection: once the span is ≥ 0.7·C, every 3 frames, NCC-match the most textured window near the start of the panorama against the far end (`findOverlap`). Two consistent matches (≥ `overlapMinScore`) give `detectedPeriod`, and the scan completes at span ≥ period × 1.12. Fallback: complete at `maxCoverage` × C.
7. **Finish:** find the period, around `detectedPeriod` when known, otherwise with `findLoopPeriod` (whole-overlap NCC from 0.45·C up, preferring one turn over multiples) (loop closure), cross-fade the overlapping laps, roll the seam to a quiet column, crop poorly covered rows, and fill gaps.

## Decisions and gotchas (don't undo without reason)

- **Markerless.** The label's own print is the tracking texture, so no stickers or markers are needed.
- **Orthographic model, vertical axis only.** Perspective is ignored, and bottles must be upright.
- **Sub-pixel bias fix:** whitened phase correlation locks onto integer shifts. The Gaussian low-pass on the cross-power spectrum (`LOW_PASS_SIGMA = 0.12` in [phaseCorrelation.ts](src/core/phaseCorrelation.ts)) and the upsampled-DFT refinement fix this. Remaining drift is about 0.03 px/frame and loop closure absorbs it.
- **Glare threshold is 250**, not lower. White paper (~245) was being misclassified as glare.
- **TypeScript is pinned to ~5.9.** TypeScript 7 (the native compiler) breaks tsup's dts plugin.
- **React build:** `treeshake: false` and a `banner` keep `"use client"`. React sources import from `'spin-scan'`, which is external at build time and mapped via tsconfig `paths`, so the core isn't bundled twice.
- `useRef(null)` in React 19 types gives `RefObject<T | null>`.
- **Installing/removing packages:** npm's optional-dependency bug can drop rolldown's native binding, which breaks vitest. If that happens, run `rm -rf node_modules package-lock.json && npm install`.
- **Don't run vitest with `--root /`.** It scans the whole filesystem.
- At 15 fps, a 3°/frame synthetic scan is exactly 45°/s, so it trips `too-fast` in tests. This is expected.
- **Auto-start** (`autoStart` option, `scanner.arm()`, status `'waiting'`): frames are tracked while waiting, but the stitcher is reset whenever motion isn't sustained, and at least every 2 s. This discards hand/placement movement and re-measures the geometry. On `'start'`, the frames captured during detection are kept. Not re-armed automatically after a result; call `arm()` (the React view's "Scan again" does this when `autoStart` is set).
- **Start sequence** (status `'countdown'`, `updateStartSequence`): it starts after the rotation detector says `'start'`. First a flashing "turn the bottle back to where the label starts" instruction (`instructionSec` 2, `countdown: null`), then a 3…1 countdown (`countdownSec` 3), then `stitcher.restart()` begins a fresh panorama. Geometry and speed history are kept, so there's no re-calibration. **It is purely time-based and nothing cancels it.** The earlier version went back to `'waiting'` when the bottle stood still for 1.2 s, and that fired exactly when the user had turned back to the start and was holding still (found in a real test on 2026-10-04). End detection can't run during it (`updateAutoStop` only runs in scanning/stopping), and after capture starts it waits for `minCoverage`. With both `instructionSec` and `countdownSec` set to 0, the detection frames are kept and capture continues straight away. "Start now" during waiting or countdown starts capturing immediately. Beeps and vibration come from [feedback.ts](src/browser/feedback.ts) (`sound` option); the audio context is unlocked in `startCamera`/`arm`/`startScan`.
- **The user decides when to stop (default `autoStop`).** The first real test (2026-10-04) took two turns before live overlap detection fired. Holding a bottle and turning it at a constant speed is hard, so the user now ends the scan by holding still: 3 s still (`stillSec`), then a 3 s countdown (status `'stopping'`). Rotation of more than `resumeDeg` (15°, summed so tremor cancels out) cancels it. Nothing happens below `minCoverage` (0.3 of the 2πr estimate). With autoStop, the stitcher runs with `autoComplete: false`, so no live overlap check and no `maxCoverage` stop.
- **Never fold at a guessed period.** In the first real result, folding at 2πr (the radius was off) cross-faded two misaligned laps and ghosted all the text. Now `findLoopPeriod` scores the *whole* overlap (Rx labels print name, phone and drug twice; that only matches locally) from 0.45·C up, so it is robust to large radius errors and prefers p over 2p. If nothing scores ≥ `loopClosureMinScore`, the strip is returned unfolded. `foldAccumulator` keeps the first lap and cross-fades only ~4% of a period at the wrap. Extra laps only fill gaps.
- **Uneven speed is fine.** Each frame's shift is measured, so `unsteady` is still reported but no longer shown to the user, and `speed.minDegPerSec` dropped from 15 to 8.
- **Live overlap auto-stop (only with `autoStop: false`)** is content-based, not 2πr-based. Completion uses the live `findOverlap` match. The reference window is taken from the end of the panorama where the capture started, and that end is inferred from which end the current frame is growing. `coverage` reports span / detectedPeriod once a match is found.
- **Preview mirroring is display-only.** `ScanState.mirrored` tells the UI to flip the `<video>` with CSS. Frames are read from the unflipped video, so tracking and the output are unaffected. `mirror: 'auto'` mirrors when the track reports `facingMode: 'user'` or reports no facingMode (typical of webcams). It doesn't mirror rear cameras, video files or canvas streams. The guide is always horizontally centred, so the overlay isn't flipped. A recorded webcam clip replays unmirrored; use the demo's Mirror selector if needed.

## Tuning knobs (likely to change with real bottles)

All of these can be passed as options to `CylinderScanner`/`CylinderStitcher` without code changes. The location is where the default lives.

| Option | Default | Where | Effect / when to change |
|---|---|---|---|
| `fps` | 12 | [scanner.ts](src/browser/scanner.ts) | Frames processed per second. Lower it if phones lag; raise it if fast turning loses tracking |
| `speed.minDegPerSec` | 8 | [speed.ts](src/core/speed.ts) | Below this speed the user sees "too slow" |
| `speed.maxDegPerSec` | 45 | [speed.ts](src/core/speed.ts) | Above this speed the user sees "too fast". Lower it if real scans are blurry |
| `speed.stallDegPerSec` | 3 | [speed.ts](src/core/speed.ts) | "Stalled" threshold |
| `speed.smoothing` / `window` | 0.35 / 10 | [speed.ts](src/core/speed.ts) | EMA factor and steadiness window |
| `minConfidence` | 0.25 | [stitcher.ts](src/core/stitcher.ts) | Minimum phase-correlation peak to accept a frame. Unrelated content scored 0.15–0.19 on synthetic labels |
| `glareThreshold` | 250 | [stitcher.ts](src/core/stitcher.ts) | Luminance treated as specular glare |
| `glareWarningFraction` | 0.04 | [stitcher.ts](src/core/stitcher.ts) | Glare fraction that triggers the warning |
| `darkThreshold` | 45 | [stitcher.ts](src/core/stitcher.ts) | Mean luminance below this gives `too-dark` |
| `blurRejectRatio` | 0.5 | [stitcher.ts](src/core/stitcher.ts) | Frames below this ratio × the recent median sharpness are not stitched |
| `stripWidthFactor` / `minStripHalfWidth` | 1.5 / 4 | [stitcher.ts](src/core/stitcher.ts) | Strip width per frame (sample redundancy vs. distortion) |
| `maxAngleDeg` | 50 | [stitcher.ts](src/core/stitcher.ts) | Part of the visible surface that gets unwrapped. Lower it if edges look smeared or perspective is strong |
| `completionOverlap` | 0.12 | [stitcher.ts](src/core/stitcher.ts) | Extra rotation past the detected loop before auto-finish |
| `autoStop.stillSec` / `.countdownSec` | 3 / 3 | [scanner.ts](src/browser/scanner.ts) | Time held still before the stop countdown, and its length |
| `autoStop.resumeDeg` | 15 | [scanner.ts](src/browser/scanner.ts) | Rotation that cancels a pending stop. Raise it if hand shake cancels the stop |
| `autoStop.minCoverage` | 0.3 | [scanner.ts](src/browser/scanner.ts) | Pauses before this much of a turn (2πr estimate) don't trigger a stop |
| `overlapMinScore` | 0.6 | [stitcher.ts](src/core/stitcher.ts) | (`autoStop: false` only) NCC needed (twice in a row) to decide the label has come back round. Raise it if scans stop early on repetitive labels; lower it if they run on to `maxCoverage` |
| `maxCoverage` | 1.5 | [stitcher.ts](src/core/stitcher.ts) | Safety stop (turns of 2πr) when no overlap is found |
| `loopClosureMinScore` | 0.5 | [stitcher.ts](src/core/stitcher.ts) | NCC needed to trust the loop-closure period |
| `calibrationFrames` / `autoDetectEdges` / `geometry` | 4 / true / — | [stitcher.ts](src/core/stitcher.ts) | Silhouette detection. Set `geometry` to bypass detection |
| `guide` | portrait 0.6×0.6, landscape 0.3×0.8 | [scanner.ts](src/browser/scanner.ts) | On-screen alignment box |
| `edgeMargin` | 0.15 | [scanner.ts](src/browser/scanner.ts) | Extra width around the guide used for edge detection |
| `maxWorkHeight` | 1080 | [scanner.ts](src/browser/scanner.ts) | Downscale cap for processing (CPU vs. detail) |
| `mirror` | `'auto'` | [scanner.ts](src/browser/scanner.ts) `resolveMirror` | Flips the preview only. Set `true`/`false` if auto-detection guesses wrong on a device |
| `autoStart` | off (demo: on) | [scanner.ts](src/browser/scanner.ts) | Hands-free start. `true` or `{ holdMs, minDegPerSec, recalibrateMs }` |
| `autoStart.holdMs` | 600 | [autoStart.ts](src/core/autoStart.ts) | Steady rotation required before the scan starts. Raise it if hand movement triggers false starts; lower it to lose less of the start |
| `autoStart.minDegPerSec` | 5 | [autoStart.ts](src/core/autoStart.ts) | Speed that counts as "turning" |
| `autoStart.recalibrateMs` | 2000 | [autoStart.ts](src/core/autoStart.ts) | While waiting, how often the bottle geometry is re-measured |
| `autoStart.instructionSec` | 2 | [scanner.ts](src/browser/scanner.ts) | How long "turn the bottle back to where the label starts" is shown |
| `autoStart.countdownSec` | 3 | [scanner.ts](src/browser/scanner.ts) | Countdown after the instruction, before capture starts. Set both to 0 to start immediately (e.g. for recorded clips) |
| `sound` | true | [scanner.ts](src/browser/scanner.ts) / [feedback.ts](src/browser/feedback.ts) | Beep/vibrate on countdown ticks, start, and completion |
| Edge search tolerance | ±30% | [cylinder.ts](src/core/cylinder.ts) | How far the detected radius may differ from the guide |
| Low-pass σ | 0.12 cycles/px | [phaseCorrelation.ts](src/core/phaseCorrelation.ts) | Tracking robustness vs. sub-pixel accuracy (constant, not an option) |
| Row coverage crop | 0.9 | [panorama.ts](src/core/panorama.ts) `validRowRange` | Rows with less coverage are cropped from the output |
| Period search | ≥ 0.45 × C (or 1.5 × visible band), whole overlap; ±2% around a live period | [panorama.ts](src/core/panorama.ts) `findLoopPeriod`, [stitcher.ts](src/core/stitcher.ts) `minLoopPeriod` | Loop-closure search range |
| Seam cross-fade | 4% of period | [panorama.ts](src/core/panorama.ts) `foldAccumulator` | Width of the blend between laps at the wrap |

## Real-bottle testing workflow

1. Run `npm run demo:https` and open the printed LAN URL on the phone.
2. Choose **Open camera**, then **● Record clip**, and do the scan. Download the clip into a local `clips/` folder (keep clips out of git; they may show patient data).
3. Replay with **Scan a video file** while you change options. Same clip, so results are comparable.
4. Watch the debug JSON panel. Useful fields: `confidence`, `speed.degPerSec`, `speed.steadiness`, `quality.relativeSharpness`, `quality.glare`, `warnings`, `geometry`.
5. Record the result in the log below: what failed, what changed, and the outcome.

What to check on each result: is the text sharp, are there doubled or ghosted characters (tracking error), is the seam visible, is the period right (no repeated or missing label section), are the top and bottom cropped correctly, and is glare filled in?

## Real-bottle test log

Add newest entries at the top. Do not include patient names or other PHI.

| Date | Bottle (size, finish, label type) | Device / lighting | Result | Problem observed | Change made | Outcome |
|---|---|---|---|---|---|---|
| _yyyy-mm-dd_ | _e.g. 40 dram amber, glossy paper label_ | _iPhone 14, kitchen light_ | _pass / partial / fail_ | | | |
| 2026-10-04 | Costco Rx label | webcam | **pass (prototype)**: clean, sharp, no ghosting | Output narrower than a full turn (cut at the phone number); slight doubling at a few joins; cap and bottle visible above and below | None yet; accepted because the next step is a user clip area before OCR | See "Where to go next" |
| 2026-10-04 | Costco Rx label | webcam | start unreliable | After auto-start fired and the bottle was turned back to the start and held, the start countdown sometimes cancelled (start and stop detection overlapping) | Start sequence is time-only (2 s instruction + 3 s countdown, no stall reset, no end detection); stop is 3 s still + 3 s countdown; turning cancels the stop and it re-arms when still | Pending re-test |
| 2026-10-04 | Costco Rx label, orange bottle, yellow warning stickers | webcam | partial: readable but ghosted | Had to turn twice before auto-stop fired; second half of the text doubled (~440 px offset); constant speed is hard | Stop is now user-driven (hold still 5 s + 5 s countdown); period found over the whole overlap, never folded at 2πr; narrow seam blend; uneven speed no longer warned | Pending re-test |
| 2026-10-04 | first real bottle | webcam/front camera | difficult | Preview was not mirrored, so turning the bottle looked backwards and was hard to control | Added `mirror` option (auto-mirrors webcams/front cameras), `setMirror()`, `ScanState.mirrored`, demo Mirror selector | Pending re-test |

## Lessons learned (don't backtrack)

These came from real-bottle testing. Each one replaced an approach that looked reasonable on paper but failed in a user's hands.

1. **The user can't press buttons.** One hand holds the bottle and the other turns it. Every step has to be automatic, with audio and visual cues (big countdown numbers and beeps), because the user is watching the bottle, not the screen.
2. **Mirror the preview for webcams and front cameras.** Unmirrored, turning the bottle looks backwards and is very hard to control. This is display-only; frames are never flipped.
3. **People can't turn at a constant speed, and that's fine.** Every frame's shift is measured, so uneven speed doesn't hurt the image. Don't nag about steadiness (the `unsteady` warning is no longer shown). Only *too fast* (blur, lost tracking) really matters.
4. **Don't let the software decide when a turn is done.** Live overlap detection (`findOverlap`) needed two turns on a real bottle, because the radius estimate was off by about 35–45% and repeated print confuses matching. The **user** decides: hold still → countdown → done. Live overlap detection is kept only behind `autoStop: false`.
5. **Start and stop detection must never overlap.** The start sequence is time-based only (instruction → countdown → capture) and nothing cancels it. Stop detection runs only while capturing, and only after `minCoverage`. A "still for 1.2 s → back to waiting" rule in the start countdown fired exactly when the user turned back to the start and held still.
6. **Tell the user to turn back to the start.** After rotation is detected, the bottle is no longer at the label start. A flashing "turn the bottle back to where the label starts" and then 3…1 gives a clean start point.
7. **Never fold at a guessed period (2πr).** If the radius estimate is wrong, folding cross-fades two misaligned laps and ghosts all the text; this was the first real result. Find the period from content (`findLoopPeriod`, whole-overlap NCC, prefer one turn over multiples). If nothing matches, return the unfolded strip.
8. **Don't blend whole laps.** Even with the right period, small drift means two laps never line up exactly. Keep the first lap and cross-fade only about 4% at the wrap; extra laps only fill gaps.
9. **Rx labels repeat themselves.** Name, phone, drug and Rx# can appear twice (main label and the receipt part). Matching a small window finds false periods; score the whole overlap.
10. **The radius estimate is unreliable.** Silhouette detection against a real background, hands on the bottle, and labels that don't fill the guide can all skew it. Treat 2πr as a hint for ranges (minimum period, `minCoverage`), never as the answer.
11. **Test with the user, not the browser automation.** The user runs the demo on real bottles. Agents should run typecheck, tests and build, then tell the user when it's time to test (rule from the user).

## Open questions / suspected adjustments

- Was the latest result narrower than a full turn because the user stopped early, or because `findLoopPeriod` picked a short period? Add the result line (`loopClosed`, `periodPx`, `expectedCircumferencePx`, `coverage`) to the test log next time.
- What causes the small doubling at strip joins: tracking drift, rolling shutter, or a perspective error near the strip edges? Try a smaller `stripWidthFactor` or `maxAngleDeg`, or per-strip local re-alignment.
- Do the default speed limits (8–45°/s) suit real phone exposure times and small print?
- Silhouette detection against busy or bottle-coloured backgrounds: the radius was badly off in real tests. Should the fallback be the guide, or a prompt to the user?
- Labels that don't wrap the full bottle: the strip is returned unfolded (`loopClosed: false`). Is that acceptable for clipping? It probably is.
- Performance on low-end phones (Web Worker/OffscreenCanvas, lower `maxWorkHeight`).
- Auto-exposure or white-balance changes mid-scan may cause banding. Lock them through track constraints.

## Where to go next

**Next feature (the real use case): a clip/crop area on the result.**
- Show the result image with a draggable or resizable rectangle (or several) so the user selects the drug name, directions and Rx block. Output the cropped image(s) to OCR.
- Put it in the library as a reusable piece: a framework-free `cropImage(image, rect)` helper in core, plus a React `<LabelCropper>` component next to `CylinderScannerView` (touch-friendly handles, pinch or zoom on phones). The demo gets a matching plain-JS cropper.
- Keep OCR out of the library. Return `RGBAImage`/canvas/Blob per clip (reuse `imageToCanvas`/`imageToBlob`).
- Possibly auto-propose a crop: the label's own bounding box (rows/columns that differ from the bottle colour) as the default rectangle.

**Clean-up and hardening (in rough priority order):**
1. **Commit** the hands-free work (auto-start, start sequence, auto-stop, `findLoopPeriod`, feedback, docs).
2. **Diagnose the narrow result.** Record a clip, replay it in the demo and look at the result line. If `findLoopPeriod` picks a short period, raise `minLoopPeriod` (currently max(0.45·C, 1.5·band)) or require that the match also covers more of the overlap.
3. **Remove or simplify dead paths.** With `autoStop` on by default, live overlap detection (`findOverlap`, `mostTexturedOffset`, `detectedPeriod`, `overlapMinScore`, `maxCoverage`, `loopDetected`) only runs with `autoStop: false`. Decide whether to keep it as an option or delete it. The same goes for `describeAnalysis` messages that only apply to that mode.
4. **Scanner state machine.** `processFrame`, `updateStartSequence` and `updateAutoStop` grew incrementally. Extract them into a small, testable state machine (pure function of analysis + time → state), which also allows basic tests for start/stop timing.
5. **Crop top and bottom to the label,** not just rows with good coverage (cap and bottle body currently show).
6. **Reduce join doubling:** per-strip local re-alignment against the panorama before splatting, or a narrower strip.
7. **Exposure/focus lock** during the scan where the browser supports it.
8. **Web Worker/OffscreenCanvas** for processing on phones.
9. **Publish** `0.1.0` to npm once the cropper exists and the API settles. Review the exported API surface first (`index.ts` exports a lot of internals).

**Not planned unless needed:** perspective-aware unwrap, lying-down (horizontal-axis) bottles, built-in OCR.

## Change history

- **Unreleased:** package renamed `cylinder-photo` → `spin-scan` (package.json, lock, React imports, tsconfig `paths`, tsup external, docs, demo title). Class names (`CylinderScanner` etc.) intentionally unchanged. The local folder is still `cylinder-photo/`; that's fine.
- **Unreleased:** start sequence reworked: flashing "turn back to the start" instruction (`instructionSec` 2) → 3 s countdown, time-only (stall reset removed). Stop defaults 3 s still + 3 s countdown. Demo: instruction/countdown options, scripted simulation (nudge, turn back, hold, ~1.1 turns, hold).
- **Unreleased:** user-driven stop (`autoStop`: still 5 s → `'stopping'` countdown 5 s → finish; turning cancels), stitcher `autoComplete` option, `findLoopPeriod` (whole-overlap period search, robust to radius error), narrow seam cross-fade in `foldAccumulator`, no fold at a guessed period, `unsteady` no longer shown, `minDegPerSec` 15 → 8. Demo: auto-stop checkbox, still/stop-countdown options; the simulated bottle stops turning after 1.6 turns. 1 test.
- **Unreleased:** 5 s countdown after rotation is detected (`'countdown'` status, `ScanState.countdown`, `autoStart.countdownSec`, beeps/vibration via `sound`, big countdown number in the React view and demo, demo "countdown s" option). Auto-stop by live loop detection (`findOverlap`, `overlapMinScore`, `maxCoverage`, `FrameAnalysis.loopDetected`, `stitcher.restart()`) replaces the fixed 1.12 × 2πr rule. New messages: "Keep turning until you're back where you started" and "Back at the start — almost done". 2 tests.
- **Unreleased:** hands-free auto-start on detected rotation (`autoStart`, `arm()`, `'waiting'` status, `RotationStartDetector`, demo checkbox, React "Start now"/arm support, 1 test). The demo simulation now holds still for 1.5 s before turning.
- **Unreleased:** mirrored preview for webcams/front cameras (`mirror` option, `setMirror()`, `ScanState.mirrored`, React view and demo support). Display-only; output unchanged.
- **v0.1.0:** initial library: core stitcher, browser scanner, React hook/view, demo with simulation/recording, README, 17 basic tests. Simulated scan in the browser: period 901 px vs 908 expected, loop closed, no gaps.
