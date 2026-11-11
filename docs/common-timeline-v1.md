# Shared playback timeline — first iteration

This iteration changes live playback from independent buffer-filled starts to a common presentation deadline. It does not claim independently measured acoustic synchronization.

## Behavior

For a source frame:

```text
target master time = capture master time + shared delay
iPad target        = target master time + local trim
```

The default shared delay is 700 ms. Native playback changes its base buffer so the largest predicted output arrival reaches that target. With the existing explicit Mac compensation of 322.6 ms and reported built-in latency of about 15.9 ms, the group path estimate is 338.5 ms and the native base is about 361.5 ms. These are configured/driver-derived estimates; Bluetooth's physical path can change independently.

The iPad receives the frame early, keeps it queued, and schedules it for the common deadline. It does not independently start when 300 or 500 ms has accumulated. Late frames are discarded; a late-joining device joins a future frame instead of replaying old history. A small bounded playback-rate correction follows the timing estimate, while queue limits continue to protect stability.

Normal source startup does not trigger sweeps. The host's microphone-calibration checkbox is off by default and remains an explicit optional action. User-provided native delay settings can be reused inside the current server session when all selected devices have values. They are not a new acoustic measurement and are not a durable calibration database.

## Clock and protocol

- The Node master uses `performance.timeOrigin + performance.now()` with a random clock identity, not the adjustable wall clock on each packet.
- The local publisher performs a loopback clock handshake. Native pins a Date/HostTime pair before optional calibration and timestamps frames from the capture ring's frame/host mapping thereafter.
- HCA2 has a 48-byte little-endian header: `HCA2`, sample rate, channels, frame count, sequence, stream ID, UInt64 source frame, Float64 capture master milliseconds, Float64 presentation delay milliseconds. Stereo Float32 PCM follows.
- The receiver uses four timestamps from the control socket to map its `performance.now()` clock to the master. Low-RTT samples reduce queuing bias; conservative drift estimation updates the mapping.
- Browser output scheduling uses `getOutputTimestamp()` when a valid fresh mapping exists. That timestamp already maps a context sample to device-output performance time; its latency is not subtracted twice. The fallback uses a clearly labelled estimate from current context time and reported output latency. [W3C definition](https://www.w3.org/TR/webaudio/#dom-audiocontext-getoutputtimestamp).
- Source/clock/format/target changes invalidate queued scheduling. Rejoining uses future deadlines. HCA1 remains available as an explicit legacy path with `syncDelayMs: 0`.

The source advertises its effective shared delay. If the native engine increases its base after a real underrun, it updates the presentation epoch and deadline rather than silently leaving the receiver on the old target. This iteration accepts a requested shared delay from 450–1000 ms; the wire allows up to 1200 ms for bounded adaptation.

## Controls

On the Mac use **System audio** and **Start system audio**. On the iPad refresh the player and tap **Enable live audio**. Keep its page in the foreground. The iPad's **Earlier/Later** trim adjusts its own target in milliseconds; the shared target and the legacy buffering knob are separate concepts.

If iPad audio is later than the native group, use Earlier; if it is early, use Later. The trim is deliberately bounded to ±200 ms. Large persistent errors require checking the native output estimates, route changes and clock mapping rather than stacking unbounded offsets.

**Timing estimate** reports a software deadline error. It cannot include every speaker's actual acoustic path. The UI does not label it as a measured speaker-arrival difference.

## Validation boundary

The offline suite includes exact HCA2 packets passing through the production relay parser and two production players. Independent fake performance/audio clocks, differing device latency, packet jitter, buffer choices, a late join, fallback timestamp support, expired frames and a one-hour wall-clock jump are exercised. The acceptance tests invert the fake output clocks and check actual scheduled PCM frame identity and both ends of each block against the common native target.

Those synthetic tests show the scheduling model can align frames under its clock assumptions. Their millisecond error figures are not hardware or room measurements. Network asymmetry, browser timestamp precision, driver latency accuracy, Bluetooth changes and listening position still affect real sound arrival. Sleep/wake and prolonged hardware sessions are not qualified by this iteration.

No automatic music, test melody or calibration sweep is needed for these tests. Hardware audition should use the listener's ordinary music, with its result recorded separately.

## Local rollout observation — 2026-11-11

The running Mac service was switched once, preserving the explicit Mac 322.6 ms / STOCKWELL II 0 ms compensation and without calibration or generated playback. Native startup reported a 338.54 ms group-path estimate and 361.46 ms base, totalling 700 ms. The live relay received HCA2; a silent three-second observation received 150 consecutive packets with zero sequence gaps and roughly 543–566 ms remaining to their advertised deadlines. Both native outputs reported zero underruns/resyncs during the sampled interval. The actual control WebSocket returned four-timestamp clock replies.

These observations verify the deployed transport and configured timing. The listener subsequently refreshed/enabled the iPad and reported that ordinary music sounded nearly coincident, with clearly reduced echo. That is a successful listening check for this device group; it is not an independent acoustic measurement or a long-session qualification.
