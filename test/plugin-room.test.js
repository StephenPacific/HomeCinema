import assert from "node:assert/strict";
import test from "node:test";
import {
  appendPluginTimingSample,
  bestClockOffset,
  choosePluginRoomTarget,
  clockOffsetSample,
  normalizeSignalingOrigin,
  signalingWebSocketUrl,
  stablePluginTiming,
  webRtcFallbackDelaySample,
  webRtcPlayoutDelaySample
} from "../extension/plugin-room.js";

test("plugin signaling URLs support secure and local development origins", () => {
  assert.equal(normalizeSignalingOrigin("https://signal.example/path?q=1"), "https://signal.example");
  assert.equal(signalingWebSocketUrl("https://signal.example"), "wss://signal.example/signal");
  assert.equal(signalingWebSocketUrl("http://127.0.0.1:4180"), "ws://127.0.0.1:4180/signal");
  assert.throws(() => normalizeSignalingOrigin("file:///tmp/signal"), /http/);
});

test("plugin timing requires three fresh advancing RTP samples", () => {
  let samples = [];
  samples = appendPluginTimingSample(samples, { observedAt: 1000, playoutDelayMs: 108, outputLatencyMs: 20, rtpProgress: 100 });
  samples = appendPluginTimingSample(samples, { observedAt: 1500, playoutDelayMs: 111, outputLatencyMs: 20, rtpProgress: 200 });
  samples = appendPluginTimingSample(samples, { observedAt: 2000, playoutDelayMs: 109, outputLatencyMs: 20, rtpProgress: 300 });
  assert.deepEqual(stablePluginTiming(samples, 2000), { stable: true, delayMs: 129, spreadMs: 3 });
  assert.equal(choosePluginRoomTarget([stablePluginTiming(samples, 2000)]), 137);
  assert.strictEqual(
    appendPluginTimingSample(samples, { observedAt: 2500, playoutDelayMs: 110, outputLatencyMs: 20, rtpProgress: 300 }),
    samples
  );
});

test("recent WebRTC counters and the lowest RTT clock sample drive plugin sync", () => {
  assert.deepEqual(webRtcPlayoutDelaySample(
    { jitterBufferEmittedCount: 200, jitterBufferDelay: 25 },
    { jitterBufferEmittedCount: 100, jitterBufferDelay: 12 }
  ), { actualDelayMs: 130, emittedCount: 100, rtpProgress: 200 });

  const slow = clockOffsetSample({
    controllerSentAt: 1000,
    speakerReceivedAt: 1040,
    speakerSentAt: 1042,
    controllerReceivedAt: 1082
  });
  const fast = clockOffsetSample({
    controllerSentAt: 2000,
    speakerReceivedAt: 2022,
    speakerSentAt: 2023,
    controllerReceivedAt: 2043
  });
  assert.equal(Math.round(fast.speakerOffsetMs), 1);
  assert.deepEqual(bestClockOffset([slow, fast]), fast);
});

test("WebKit-style partial stats still provide conservative timing progress", () => {
  assert.deepEqual(webRtcFallbackDelaySample(
    { packetsReceived: 180, jitter: 0.006 },
    { packetsReceived: 160, jitter: 0.004 }
  ), {
    actualDelayMs: 126,
    emittedCount: 20,
    rtpProgress: 180,
    estimated: true
  });
  assert.equal(webRtcFallbackDelaySample({ packetsReceived: 180 }, { packetsReceived: 180 }), null);
});
