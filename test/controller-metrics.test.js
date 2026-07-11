import assert from "node:assert/strict";
import test from "node:test";
import { controllerAudioHealth, sanitizeControllerAudioMetrics } from "../src/controllerMetrics.js";

test("Controller audio metrics are bounded before entering room state", () => {
  const metrics = sanitizeControllerAudioMetrics({
    observedAt: 1000,
    sampleCount: 24,
    observationWindowMs: 12_000,
    contextState: "running",
    sampleRate: 48_000,
    baseLatencyMs: 10,
    outputLatencyMs: 42,
    totalOutputLatencyMs: 52,
    initialOutputLatencyMs: 50,
    latencyDeltaMs: 2,
    latencySpreadMs: 3,
    clockDriftPpm: 85,
    timestampAvailable: true,
    localDelayMs: 108,
    roomTargetMs: 160,
    estimatedTimelineErrorMs: 0
  });

  assert.equal(metrics.totalOutputLatencyMs, 52);
  assert.equal(metrics.sampleRate, 48_000);
  assert.equal(metrics.clockDriftPpm, 85);
  assert.equal(metrics.timestampAvailable, true);
});

test("Controller output health observes without claiming stability too early", () => {
  assert.deepEqual(controllerAudioHealth(null), { label: "Waiting for extension", tone: "waiting" });
  assert.deepEqual(
    controllerAudioHealth({ contextState: "running", sampleCount: 5, observationWindowMs: 4000 }),
    { label: "Collecting", tone: "waiting" }
  );
});

test("Controller output health distinguishes stable and changing windows", () => {
  const stable = {
    contextState: "running",
    sampleCount: 30,
    observationWindowMs: 15_000,
    latencySpreadMs: 2,
    estimatedTimelineErrorMs: 3,
    clockDriftPpm: 120
  };
  assert.deepEqual(controllerAudioHealth(stable), { label: "Observed stable", tone: "ready" });
  assert.deepEqual(
    controllerAudioHealth({ ...stable, latencySpreadMs: 7 }),
    { label: "Changing", tone: "attention" }
  );
  assert.deepEqual(
    controllerAudioHealth({ ...stable, estimatedTimelineErrorMs: -12 }),
    { label: "Changing", tone: "attention" }
  );
});

test("invalid Controller audio metrics are rejected", () => {
  assert.equal(sanitizeControllerAudioMetrics(null), null);
  assert.equal(sanitizeControllerAudioMetrics({ totalOutputLatencyMs: "not-a-number" }), null);
});
