# Native audio hardware check — 2026-11-10

This is a short hardware experiment, not a long-session or multiple-Bluetooth qualification.

- Mac: Apple Silicon, macOS 26.3, Swift 6.2.1 Command Line Tools.
- Engine: SyncForge upstream commit `a1a2f46`, MIT.
- Outputs: MacBook Pro Speakers and STOCKWELL II over Bluetooth.
- Microphone: built-in MacBook Pro microphone. Device UIDs are intentionally omitted.

## Direct engine results

The release core and `sfctl` executable compiled locally. The XCTest suite could not compile because the installed Command Line Tools lack XCTest; full Xcode was not installed. The SwiftUI app was not built.

A 15-second system-audio run started both outputs and captured non-silent audio. The listener confirmed both outputs played, with audible echo. The Bluetooth renderer recorded 178 startup underruns; the engine increased base latency from 45 to 65 ms. The underrun counter then stayed unchanged for the rest of that run. CPU reported 2.65% of one core and RSS 15.1 MB for this short run; these are not long-session guarantees.

Calibration used a -24 dBFS starting sweep and the built-in microphone, followed by 20 seconds of system-audio playback:

| Measurement | Result |
| --- | --- |
| Mac measured arrival, including microphone path | 46.53 ms |
| Bluetooth measured arrival, including microphone path | 365.60 ms |
| Mac additional compensation | 319.1 ms |
| Estimated difference before calibration | 249.9 ms |
| Verification arrival, Mac | 428.05 ms after capture |
| Verification arrival, Bluetooth | 430.60 ms after capture |
| Estimated remaining difference | 2.55 ms |
| Verification repeatability | 1.91 ms |

The listener reported that echo was clearly reduced and the outputs sounded nearly coincident. These acoustic estimates come from SyncForge's own estimator at one microphone position, not independent measurement equipment. The calibration also applied upstream automatic tone correction. Bluetooth's five initial measurements ranged from 362.53 to 364.03 ms; verification refined its latency. Drift can continue after calibration.

The calibrated hold recorded non-silent capture/output levels and an unchanged Bluetooth underrun count of 184. Renderer servo errors describe software clock lock, not acoustic arrival accuracy. Both processes ended normally and released their audio capture.

## Home Cinema integration boundary

`scripts/native-audio.mjs` is an optional local launcher for the external engine. It builds the CLI, lists devices, forwards selected outputs, and keeps the calibrated engine alive for a bounded session. It forwards termination to the CLI's cleanup handler. It does not expose native device control to LAN HTTP clients.

The audio route is Home Cinema browser → Mac system audio → SyncForge → selected Mac-connected outputs. The Mac group shares one browser stem. Calibration does not measure phone/tablet arrival times, and this first direct-engine check does not establish browser-to-native-to-LAN acoustic alignment.

## Adapter and browser check

`npm run native:build` succeeded using the installed Command Line Tools. A temporary executable stub checked argument preservation (including UIDs with spaces/colons), calibration defaults and explicit overrides, missing output/binary errors, and forwarding SIGTERM as SIGINT so the CLI can clean up. Home Cinema's production Vite build and `git diff --check` passed.

A second real calibration launched through `npm run native:calibrate` with a 90-second hold:

| Measurement | Result |
| --- | --- |
| Mac additional compensation | 330.4 ms |
| Bluetooth measured arrival, including microphone path | 376.84 ms |
| Bluetooth confidence | Low (spread 8.22 ms) |
| Estimated difference before calibration | 257.0 ms |
| Estimated remaining difference on verification | 6.71 ms |
| Verification repeatability | 2.51 ms |

The Bluetooth repeated measurements moved from 366.77 to 374.98 ms before verification refined the estimate. This second result is evidence of changing latency and measurement uncertainty; the first 2.55 ms residual must not be treated as a durable guarantee. The Bluetooth underrun count was 177 by the start of the calibrated hold.

The Home Cinema server was started, a generated 16-second low-level WAV was loaded, the browser speaker was enabled, and playback was started using the visible UI during the native hold. The UI reported Web Audio running and a playing track; native logs showed non-silent capture and both renderers active. Other system audio was also present, so those levels alone cannot identify the browser signal or establish acoustic alignment. No phone/tablet participated in this check.

## Next experiments

- Compare the Home Cinema browser's Mac speaker group against one LAN player using a known track.
- Repeat calibration after moving the microphone to the listening position and after Bluetooth reconnect.
- Add a second Bluetooth output and measure whether concurrent playback is supported and stable.
- Run a 30-minute session and record glitches, underruns, CPU and repeated acoustic arrival estimates.
- If multiple wireless outputs drift independently, evaluate a new calibration/tracking design; upstream Live Sync does not cover that configuration.

## iPad playback troubleshooting

An iPad joined the LAN player and reported Ready/unlocked. The listener initially heard its local Speaker test but no track playback, including a generated 90-second test melody. Ready alone did not establish that music had started.

After refreshing with live diagnostic reporting, the iPad was using HTML audio fallback with a suspended Web Audio context. During a remote play command its media element remained paused and its playback time did not advance. Following a local button interaction, the listener confirmed sustained melody. Live diagnostics then showed HTML audio still selected, `mediaPaused: false`, and media time advancing. This establishes successful fallback playback; it does not establish Web Audio recovery, nor calibrated acoustic synchronization with the Mac/Bluetooth group.

Client changes stop rescheduling the final 20 ms after a local track ends and display Ended. Five timing boundary tests cover end detection, late joins, countdown offsets, unknown duration and restart. Live per-player diagnostics report aggregate buffer metadata and engine/source/gain state, never audio samples.
