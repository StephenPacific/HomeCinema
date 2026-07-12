import assert from "node:assert/strict";
import test from "node:test";
import {
  expectedLivePositionSeconds,
  liveDriftCorrection,
  liveStartLocalMs,
  setWebRtcJitterBufferTarget,
  shouldStartLiveBuffer,
  webRtcPlayoutDelaySample
} from "../src/liveSync.js";

test("live start compensates clock, output, and manual delay", () => {
  const localStart = liveStartLocalMs({
    playAtServerMs: 10_000,
    serverOffsetMs: 50,
    outputLatencyMs: 120,
    manualOffsetMs: 30
  });
  assert.equal(localStart, 9860);
  assert.equal(
    expectedLivePositionSeconds({
      nowLocalMs: localStart,
      playAtServerMs: 10_000,
      serverOffsetMs: 50,
      outputLatencyMs: 120,
      manualOffsetMs: 30
    }),
    0
  );
});

test("live timeline advances from the shared audible start", () => {
  assert.equal(
    expectedLivePositionSeconds({
      nowLocalMs: 10_860,
      playAtServerMs: 10_000,
      serverOffsetMs: 50,
      outputLatencyMs: 120,
      manualOffsetMs: 30
    }),
    1
  );
});

test("live drift correction speeds up lagging devices and seeks large drift", () => {
  const behind = liveDriftCorrection(1.9, 2);
  assert.equal(behind.shouldSeek, false);
  assert.ok(behind.playbackRate > 1);

  const ahead = liveDriftCorrection(2.1, 2);
  assert.equal(ahead.shouldSeek, false);
  assert.ok(ahead.playbackRate < 1);

  const farBehind = liveDriftCorrection(1.5, 2);
  assert.equal(farBehind.shouldSeek, true);
});

test("live buffer starts at the target or adapts after the maximum wait", () => {
  assert.equal(shouldStartLiveBuffer(1, 200), true);
  assert.equal(shouldStartLiveBuffer(0.84, 1200), false);
  assert.equal(shouldStartLiveBuffer(0.84, 1800), true);
  assert.equal(shouldStartLiveBuffer(0.5, 5000), false);
});

test("WebRTC playout delay uses recent counter deltas instead of lifetime averages", () => {
  const sample = webRtcPlayoutDelaySample(
    {
      jitterBufferEmittedCount: 200,
      jitterBufferDelay: 26,
      jitterBufferTargetDelay: 24,
      jitterBufferMinimumDelay: 10
    },
    {
      jitterBufferEmittedCount: 100,
      jitterBufferDelay: 12,
      jitterBufferTargetDelay: 12,
      jitterBufferMinimumDelay: 5
    }
  );

  assert.equal(sample.actualDelayMs, 140);
  assert.equal(sample.targetDelayMs, 120);
  assert.equal(sample.minimumDelayMs, 50);
  assert.equal(webRtcPlayoutDelaySample({ jitterBufferEmittedCount: 200, jitterBufferDelay: 26 }, null), null);
});

test("supported receivers receive a bounded jitter-buffer target", () => {
  const receiver = { jitterBufferTarget: null };
  assert.equal(setWebRtcJitterBufferTarget(receiver, 120), true);
  assert.equal(receiver.jitterBufferTarget, 120);
  assert.equal(setWebRtcJitterBufferTarget(receiver, 5000), true);
  assert.equal(receiver.jitterBufferTarget, 4000);
  assert.equal(setWebRtcJitterBufferTarget({}, 120), false);
});
