# Phase 1 Reference Design: Reliable Browser Playout

## Purpose

Phase 1 turns the current prototype into a measurable and recoverable browser
playout system. It intentionally excludes AI separation, live PCM streaming,
room reconstruction, Bluetooth endpoints, and video sync.

The target is not to reproduce Dante or Snapcast precision. The target is to
apply their reliability principles in an unmanaged Wi-Fi and browser runtime:

- disciplined clocks;
- timestamped playout;
- explicit readiness and deadlines;
- endpoint capability reporting;
- stale-state rejection;
- observable correction and degradation;
- acoustic measurements kept separate from software estimates.

## Sources reviewed

### Snapcast native client

Reviewed from the `develop` branch downloaded on 2026-07-10:

- `client/time_provider.cpp`
- `client/controller.cpp`
- `client/stream.cpp`
- `client/double_buffer.hpp`
- `doc/binary_protocol.md`
- `doc/configuration.md`

Repository: <https://github.com/snapcast/snapcast>

Important implementation observations:

1. The client performs 50 rapid clock samples after connecting, then samples
   continuously at a fixed interval.
2. Clock offset is kept in a bounded rolling buffer and selected by median to
   resist network jitter.
3. Audio chunks carry a server timestamp. A chunk is due at its timestamp plus
   the configured playout buffer, minus endpoint-specific latency.
4. The native client includes the estimated time from the output buffer to the
   DAC when deciding which sample should be audible.
5. It keeps multiple error windows. Small persistent errors trigger gentle
   sample-rate correction, capped around 500 ppm in the reviewed path. Large
   errors trigger a hard synchronization path that inserts silence or skips
   stale samples.
6. Underflow handling is backend-specific. For example, the PulseAudio backend
   can increase its buffer after repeated underflows.

### Snapweb browser client

Reviewed from the `develop` branch downloaded on 2026-07-10:

- `src/snapstream.ts`

Repository: <https://github.com/snapcast/snapweb>

Important implementation observations:

1. It samples time once per second and keeps the median of up to 100 offset
   samples.
2. When available, it uses `AudioContext.getOutputTimestamp().contextTime`;
   otherwise it falls back to `AudioContext.currentTime`.
3. It estimates output latency as `baseLatency + outputLatency` when exposed by
   the browser.
4. It schedules a chain of Web Audio buffers ahead of time rather than relying
   on main-thread timers at the audible deadline.
5. Its default browser chunk duration is approximately 80 ms, with the next
   buffers scheduled from a monotonically increasing AudioContext play time.
6. Browser output timing remains less observable than native audio backends;
   endpoint-specific calibration is still required.

### License boundary

Snapcast and Snapweb are GPL-3.0. This project will use an independent
implementation based on publicly documented algorithms and behavioral ideas.
No Snapcast or Snapweb source will be copied into this repository.

## Adopt, adapt, exclude

| Reference behavior | Decision | Phase 1 treatment |
| --- | --- | --- |
| Continuous time sampling | Adopt | Fast calibration on join, then periodic samples |
| Rolling robust statistics | Adopt and improve | Keep RTT and offset; filter high-RTT samples before median |
| Monotonic time base | Adopt | Node and browser monotonic-derived timestamps |
| Timestamped audio chunks | Adapt | Preloaded asset plus timestamped timeline command |
| Server playout buffer | Adapt | Readiness-derived scheduling lead, not a PCM jitter buffer |
| Endpoint latency setting | Adopt | Separate reported, manual, and measured offsets |
| Native DAC latency query | Exclude | Not available in a portable browser |
| Sample insertion/removal | Defer | Phase 1 uses bounded rate correction and safe rejoin |
| Continuous PCM/codec stream | Exclude | Assets are fetched over HTTP and decoded before arming |
| Snapcast control protocol | Exclude | Use a session/epoch protocol designed for this product |
| Raw median of all offsets | Improve | Prefer the lowest-RTT subset and report confidence |

## Time model

The system exposes three distinct synchronization layers.

### 1. Clock synchronization

Maps server monotonic time to browser monotonic time.

Each exchange captures:

```text
t0 client send
t1 server receive
t2 server send
t3 client receive
```

```text
rtt = (t3 - t0) - (t2 - t1)
offset = ((t1 - t0) + (t2 - t3)) / 2
```

The client stores at least:

```text
sample sequence
t0, t1, t2, t3
rtt
offset
accepted/rejected
rejection reason
```

Initial estimator policy:

1. collect 12 fast samples after the WebSocket opens;
2. keep the most recent 30 valid samples;
3. reject non-finite and impossible samples;
4. select the lowest-RTT quartile, with a minimum of 4 samples;
5. use the median offset of that subset;
6. report RTT median, RTT spread, offset spread, sample age, and confidence;
7. sample every 2 seconds while idle and every 1 second while armed or playing.

This is deliberately not advertised as PTP. It is an application-layer clock
estimate under an assumed approximately symmetric path.

### 2. Playout synchronization

Maps a server timeline deadline to Web Audio time.

The client maintains:

```text
server time <-> performance time
performance time <-> AudioContext time
AudioContext scheduled start <-> estimated playhead
```

Where supported, `getOutputTimestamp()` is sampled to improve the mapping.
`baseLatency` and `outputLatency` are recorded as estimates, never presented as
verified acoustic delay.

### 3. Acoustic synchronization

Measures relative arrival time at a fixed listening position with a reference
microphone. It is a separate calibration product surface and metric namespace.
It must never be inferred solely from clock or AudioContext telemetry.

## Session and epoch protocol

Every state-changing message contains:

```json
{
  "protocolVersion": 1,
  "sessionId": "room-123",
  "playbackEpoch": 7,
  "sequence": 1042,
  "commandId": "unique-id",
  "serverTime": 18400.125
}
```

Rules:

- a different session is rejected;
- an older epoch is rejected and counted;
- a newer epoch invalidates old scheduling and local playback state;
- a non-increasing sequence in the same epoch is idempotently ignored;
- reconnecting clients fetch authoritative session state before arming;
- play, seek, track replacement, and invalidating recovery create a new epoch.

### Endpoint states

```text
DISCOVERED
  -> JOINED
  -> CALIBRATING
  -> PRELOADING
  -> READY
  -> ARMED
  -> PLAYING
  -> DEGRADED
  -> REJOINING
```

### Preloaded playout flow

```text
PLAY_REQUEST
  -> new playback epoch
  -> PRELOAD(epoch, manifest, position)
  -> READY(epoch, asset hash, duration, audio health)
  -> ARM(epoch, effective server time, position)
  -> ARMED(epoch, scheduled AudioContext time)
  -> local scheduled playback
```

`ARM` is the commit point. There is no last-moment network message at the
audible deadline.

## Asset manifest

```json
{
  "manifestId": "sha256:...",
  "assets": [
    {
      "id": "main",
      "url": "/audio?layer=...",
      "version": 123,
      "size": 1234567,
      "duration": 180.25,
      "contentHash": "sha256:..."
    }
  ]
}
```

Phase 1 may initially use the existing layer version as cache identity while
content hashing is added. A client cannot report READY until fetch, decode, and
manifest validation have completed.

## Drift policy

The system records before it corrects. Thresholds remain experimental and
configurable.

```text
small, persistent error
  -> bounded playback-rate correction

medium error
  -> faster but still bounded convergence with telemetry

large error or unhealthy AudioContext
  -> DEGRADED, fade out, re-arm at a safe boundary, fade in
```

Required metrics:

- estimated drift ppm;
- current and maximum playhead error;
- correction rate and duration;
- correction duty cycle;
- hard rejoin count;
- missed scheduling deadline count.

Phase 1 must not claim that a corrected software playhead is acoustically
aligned. Continuous high-quality resampling belongs in a later AudioWorklet.

## Endpoint health and capability

An endpoint is not READY merely because its WebSocket is connected.

Minimum health inputs:

- user gesture has unlocked audio;
- `AudioContext.state === "running"`;
- the audio clock is advancing;
- the required manifest is decoded;
- the page is visible;
- heartbeat and clock samples are recent;
- the clock estimate has sufficient confidence;
- the scheduling deadline has not been missed.

Initial roles:

```text
FOREGROUND_CAPABLE
AMBIENCE_CAPABLE
CONTROL_ONLY
```

Bluetooth or otherwise unbounded output paths are not assigned timing-critical
content in Phase 1.

## Telemetry contract

Metrics are separated by layer.

### Network

- RTT median and spread;
- accepted/rejected clock samples;
- clock offset and confidence;
- heartbeat age;
- reconnect count.

### Protocol

- session, epoch, sequence;
- endpoint state;
- stale and duplicate messages rejected;
- READY-to-ARM lead;
- missed deadlines.

### Audio engine

- AudioContext state and sample rate;
- base/output latency estimates;
- scheduled AudioContext start;
- estimated playhead error;
- drift ppm;
- rate correction duty cycle;
- hard rejoin count.

### Acoustic

- measured relative arrival offset;
- calibration timestamp and confidence;
- fixed listening position identifier;
- foreground eligibility.

## Phase 1 acceptance tests

1. Three browser endpoints preload and arm the same asset.
2. Duplicate sequences and old epochs do not alter playback.
3. A slow endpoint does not cause a false all-ready state.
4. A backgrounded or suspended endpoint becomes degraded.
5. Remaining endpoints keep playing when one disconnects.
6. A reconnecting endpoint reconciles the current epoch and does not resume old
   playback.
7. Rapid seek commands leave only the latest epoch audible.
8. A 30-minute run produces clock, playhead, correction, and recovery logs.
9. Software estimates and acoustic measurements are displayed separately.

## Implementation order in this repository

1. Add shared protocol constants, validation, and monotonic clock helpers.
2. Add authoritative session/epoch state on the server.
3. Replace one-shot clock calibration with the rolling estimator.
4. Add manifest, PRELOAD, READY, ARM, and ARMED messages.
5. Migrate play, pause, stop, and seek to epoch semantics.
6. Add playout estimator and correction telemetry.
7. Add lifecycle health and degradation rules.
8. Replace the current player summary with layered telemetry.
9. Add protocol and multi-client fault-injection tests.
