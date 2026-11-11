# Live Mac system audio

## Route and controls

Mac system audio → Core Audio capture ring → selected native outputs, and a bounded PCM publisher → local Node relay → iPad Web Audio jitter buffer → iPad speaker.

The Mac's System audio screen discovers current native devices and starts/stops one owned publisher. Only requests from the host machine with a matching local origin can control native devices. A local publisher receives an ephemeral token over loopback; audio ingestion accepts that token only over loopback. LAN browsers receive audio through `/live/audio` and do not get the publisher token or native start permission.

HTTP and both WebSocket routes accept only the advertised local interface IPs or loopback hostnames at the configured port. Browser Origin headers must match that address. This blocks unrelated website origins and DNS-rebinding hostnames from opening the control or audio stream. Use the displayed Local/Network URL when joining.

`/live/status` reports source activity and bounded diagnostics. The source is active only after valid audio packets arrive recently. A connected but silent Mac can stay ready indefinitely; silence is not a connection failure. The publisher sends HTTP headers before calibration/audio and has no arbitrary socket-idle timeout. Broken pipes and owned-process termination still release the audio engine.

The current HCA2 path uses a common future playback deadline, defaulting to 700 ms after capture. The native group reserves the remaining delay after its estimated output path; the iPad schedules the same timestamp using a shared clock. See [Common timeline v1](common-timeline-v1.md) for scheduling, clock mapping and physical limitations. The stream reader uses about 100 ms of capture history. Software timing estimates do not establish acoustic alignment.

Optional native calibration adjusts relative timing only and does not fit new EQ. It is disabled by default. Explicit output delays can be reused within the server session; there is no persistent acoustic calibration database.

The HTTP server disables Node's five-minute total request deadline for the long-running ingest body, while retaining header timeouts and route body-size limits. An independent scaled-down reproduction returned HTTP 408 after 1,019 ms despite continuous writes every 50 ms when the total deadline was 1,000 ms. Source control requests and native exit codes are retained in bounded status metadata to distinguish a requested stop from a transport failure.

## Fresh native setup

This workspace has a working native build. To reproduce it elsewhere, use upstream commit `a1a2f46` and apply the included patch before building:

```bash
git clone https://github.com/alexandrustefan/syncforge.git ../syncforge
git -C ../syncforge checkout a1a2f46
git -C ../syncforge apply ../HomeCinema/native/syncforge-live.patch
npm run native:build
```

These relative paths assume the HomeCinema and syncforge directories are siblings. `SYNCFORGE_DIR` and `SYNCFORGE_BIN` can override the source checkout or executable. The patch retains upstream MIT licensing; the upstream license remains in the source checkout. It adds live export, JSON discovery and the stability fixes described below. Rebuilding the CLI with Command Line Tools is supported; the full upstream XCTest suite and GUI still require full Xcode.

For terminal use:

```bash
npm run native:devices
npm run native:live -- --out 'MAC_UID' --out 'BLUETOOTH_UID' --sync-delay-ms 700 --seconds 7200
```

Keep the server running first. GUI Start/Stop is preferred for ordinary use because the server owns and tracks the process. A terminal-launched session can be stopped with Ctrl-C. Calibration lives in that native session; exiting discards it.

## Buffers and failure behavior

- The native exporter reads an atomic stereo mirror, separate from the renderer's raw sample path. Before/after history guards reject overwritten ranges; atomic stereo pairs avoid a C data race if a worker is preempted during a ring wrap.
- Export chunks are about 20 ms, retain the capture sample rate, and contain stereo Float32 PCM. A blocked exporter skips old history after 350 ms of backlog.
- The relay validates packet framing and finite samples. A slow receiver exceeding 256 KiB of queued writes is disconnected; it can reconnect to fresh audio instead of retaining a growing delay.
- The HCA2 browser groups audio into 100 ms blocks, schedules future common deadlines up to roughly 250 ms ahead, and retains at most 1.2 seconds total. It drops expired frames instead of starting a new arrival-relative timeline. A small playback-rate correction (at most ±0.3%) controls slow clock drift. HCA1 remains a legacy path with a separate startup buffer.
- Sequence gaps, source restarts, format changes, stale source status and socket closure fade out and clear stale buffers. HCA2 rejoins a future deadline after clock acquisition; HCA1 re-buffers. Unavailable data is not looped. Mobile background suspension still interrupts playback; resume requires a local user click when the browser demands it.
- The host browser cannot enable live monitoring on the capture Mac. Playing the captured stream back into that same system source would create feedback.

## Noise investigation — 2026-11-10

The listener reported intermittent continuous noise across devices without isolating one output. Analysis of the old native session found all observed post-start underrun increments during adjacent -60 dB capture readings: Mac +12,358, Bluetooth +5,707. This does not demonstrate audible Bluetooth jitter during program playback.

Concrete problems addressed:

1. The file player previously restarted the last 20 ms after a track ended. It now stops locally and displays Ended without stopping longer stems elsewhere.
2. Invalid capture samples or poisoned filter state could propagate NaN/Inf indefinitely. Capture/output sanitization and filter-state recovery now bound this failure.
3. A native starvation edge jumped abruptly to zero. It now fades to silence over 5 ms and still counts underruns.
4. Silent capture gaps no longer keep increasing the automatic base buffer. Counters remain visible.
5. The new live publisher initially treated 60 seconds without PCM as a failed connection. Hardware integration exposed this while the Mac was silent; the idle timeout was removed and initial headers are flushed immediately.

Standalone before/after C regressions:

| Case | Upstream | Patched |
| --- | --- | --- |
| Invalid output after injected NaN/Inf capture | 98,756 samples | 0 |
| Invalid output after malformed filter/recovery | 71,680 samples | 0 |
| Starvation sample step, ~0.5 amplitude | 0.499986 | 0.002083 |
| Normal output SNR, 48 kHz | 83.83 dB | 83.83 dB |
| Normal output SNR, 44.1 kHz | 87.16 dB | 87.16 dB |
| 60-second mixed-rate/drift SNR | 87.16 dB | 87.16 dB |

The simulations and sanitizers reproduce those failure mechanisms. They do not establish the cause of every noise heard in the room or qualify every Bluetooth device.

## Checks

With Node 22+ for the WebSocket integration tests:

```bash
node --test lib/*.test.mjs src/*.test.js scripts/*.test.mjs
npm run build
../syncforge/scripts/test-live-export.sh
../syncforge/scripts/test-stream-timeline.sh
../syncforge/scripts/check-rt-stability.sh
../syncforge/scripts/check-rt-stability.sh --sanitize
```

Checks cover packet fragmentation, invalid data, publication authentication, source teardown, slow receivers, idle publication, argument/device validation, process cleanup, jitter/clock drift, bounded queues and local end-of-track behavior. Native checks also cover history wrapping, atomic stereo consistency and sanitizers. Real iPad playback, actual speaker alignment and long-session noise must be assessed separately from these tests.

## Hardware integration observations

The updated source stayed connected for more than 80 seconds with silent program audio, without the former idle timeout. A generated melody was then played by macOS `afplay`, outside the Home Cinema file player. The relay received stereo PCM at 48 kHz. A separate network receiver observed 300 consecutive packets (6 seconds), peak amplitude 0.1163 and zero sequence gaps; no sound samples were saved. Native output diagnostics showed zero underruns/resyncs during the sampled silent and audible interval with the new 120 ms base buffer.

The iPad joined live mode and reported a running Web Audio context. At a later inspection the native capture process had stopped and the receiver correctly cleared its queue. This transport check is distinct from a listener confirming sustained iPad audio or the absence of room noise; those require a live source while the iPad receiver remains enabled.

After the long-request lifetime fix, a Bluetooth-only reference run kept the source active while the iPad reported a running live PCM source, gain 1, approximately 542 ms queued audio and zero receiver underruns. Those counters establish active scheduling on the iPad, not independent acoustic alignment or a full long-session qualification.

The listener still initially heard silence with this running graph. Turning off iPad Silent Mode restored audible live system audio. This reproduces WebKit's documented difference between ambient Web Audio and media playback sessions ([WebKit issue 237322](https://bugs.webkit.org/show_bug.cgi?id=237322)). The frontend now requests `navigator.audioSession.type = "playback"` when that API is available, inside an explicit local enable action. Unsupported browsers retain a Silent Mode/volume hint; a running context alone is not proof of audible output.
