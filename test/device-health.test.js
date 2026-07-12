import assert from "node:assert/strict";
import test from "node:test";
import {
  captureRtcSnapshot,
  classifyDeviceHealth,
  fastFuseReason,
  roomHealthContext,
  rtcWindowMetrics,
  summarizeRoomHealth
} from "../src/deviceHealth.js";

test("RTC windows expose recent loss, concealment, and stalls", () => {
  const previous = captureRtcSnapshot({
    jitterBufferEmittedCount: 100,
    packetsReceived: 90,
    packetsLost: 10,
    concealedSamples: 200,
    totalSamplesReceived: 10_000,
    bytesReceived: 50_000,
    jitter: 0.004
  });
  const current = captureRtcSnapshot({
    jitterBufferEmittedCount: 120,
    packetsReceived: 108,
    packetsLost: 12,
    concealedSamples: 300,
    totalSamplesReceived: 15_000,
    bytesReceived: 60_000,
    jitter: 0.009
  });
  const metrics = rtcWindowMetrics(current, previous, { now: 1500, lastProgressAt: 1000 });

  assert.equal(metrics.packetLossRate, 0.1);
  assert.equal(metrics.concealmentRate, 0.02);
  assert.equal(metrics.jitterMs, 9);
  assert.equal(metrics.rtpStallMs, 0);
  assert.equal(metrics.lastProgressAt, 1500);

  const stalled = rtcWindowMetrics(current, current, { now: 2400, lastProgressAt: 1500 });
  assert.equal(stalled.rtpStallMs, 900);
});

test("Fast Fuse only reacts immediately to deterministic local faults", () => {
  assert.equal(fastFuseReason({ active: true, rtpStallMs: 800 })?.code, "RTP_STALLED");
  assert.equal(fastFuseReason({ active: true, connectionState: "failed" })?.code, "WEBRTC_FAILED");
  assert.equal(fastFuseReason({ active: true, audioContextState: "suspended" })?.code, "AUDIO_ENGINE_STOPPED");
  assert.equal(fastFuseReason({ active: true, outputLatencyDeltaMs: 30 }), null);
  assert.equal(fastFuseReason({ active: true, rawSyncErrorMs: 40 }), null);
  assert.equal(fastFuseReason({ active: true, packetLossRate: 0.2, packetSampleCount: 20 }), null);
});

test("three or more devices use the room median to identify an outlier", () => {
  const context = roomHealthContext([
    { active: true, syncErrorMs: 1 },
    { active: true, syncErrorMs: 2 },
    { active: true, syncErrorMs: 14 },
    { active: false, syncErrorMs: 80 }
  ]);
  assert.deepEqual(context, {
    medianSyncErrorMs: 2,
    participantCount: 3,
    commonTimelineShift: false
  });

  const diagnostic = classifyDeviceHealth(
    {
      role: "speaker",
      active: true,
      online: true,
      unlocked: true,
      connectionState: "connected",
      audioContextState: "running",
      outputPath: "webrtc-stream-source",
      syncErrorMs: 14,
      timelineState: "locked"
    },
    context
  );
  assert.equal(diagnostic.sync.reason, "SYNC_OUTLIER");
  assert.equal(diagnostic.overall.state, "critical");
});

test("a majority timeline shift is attributed to the common timeline", () => {
  const context = roomHealthContext([
    { active: true, syncErrorMs: 7 },
    { active: true, syncErrorMs: 8 },
    { active: true, syncErrorMs: 9 }
  ]);
  assert.equal(context.commonTimelineShift, true);

  const diagnostic = classifyDeviceHealth(
    {
      role: "speaker",
      active: true,
      online: true,
      unlocked: true,
      connectionState: "connected",
      audioContextState: "running",
      outputPath: "webrtc-stream-source",
      syncErrorMs: 8,
      timelineState: "locked"
    },
    context
  );
  assert.equal(diagnostic.sync.reason, "COMMON_TIMELINE_SHIFT");
  assert.equal(summarizeRoomHealth([{ id: 1, name: "Speaker", diagnostic }], context).reason, "COMMON_TIMELINE_SHIFT");
});

test("the three layers keep audio and connection causes separate", () => {
  const diagnostic = classifyDeviceHealth({
    role: "speaker",
    active: true,
    online: true,
    unlocked: true,
    connectionState: "connected",
    audioContextState: "running",
    outputLatencyDeltaMs: 12,
    outputPath: "webrtc-stream-source",
    syncErrorMs: 1,
    timelineState: "locked"
  });

  assert.equal(diagnostic.connection.state, "healthy");
  assert.equal(diagnostic.audio.reason, "OUTPUT_LATENCY_JUMP");
  assert.equal(diagnostic.sync.state, "healthy");
  assert.equal(diagnostic.overall.action, "Remeasure output");
});

test("stale live telemetry becomes visible before the socket disappears", () => {
  const late = classifyDeviceHealth({
    role: "speaker",
    active: true,
    online: true,
    unlocked: true,
    telemetryAgeMs: 1800,
    connectionState: "connected",
    audioContextState: "running",
    outputPath: "webrtc-stream-source",
    syncErrorMs: 0,
    timelineState: "locked"
  });
  assert.equal(late.connection.reason, "TELEMETRY_LATE");
  assert.equal(late.connection.state, "warning");

  const stale = classifyDeviceHealth({
    role: "speaker",
    active: true,
    online: true,
    unlocked: true,
    telemetryAgeMs: 4500,
    connectionState: "connected",
    audioContextState: "running",
    outputPath: "webrtc-stream-source",
    syncErrorMs: 0,
    timelineState: "locked"
  });
  assert.equal(stale.connection.reason, "TELEMETRY_STALE");
  assert.equal(stale.overall.action, "Reconnect transport");
});
