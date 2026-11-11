import assert from "node:assert/strict";
import test from "node:test";
import { LiveClockSync, clientToMasterTime, masterToAudioContextTime, masterToClientTime } from "./live-clock.js";

test("four timestamps exclude server work and prefer low RTT instead of queued replies", () => {
  const clock = new LiveClockSync();
  clock.record({ clientSent: 100, serverReceivedMs: 1101, serverSentMs: 1106, clockId: "A" }, 107);
  assert.equal(clock.mapping().roundTripMs, 2);
  assert.equal(clock.mapping().masterOffsetMs, 1000);
  clock.record({ clientSent: 200, serverReceivedMs: 1220, serverSentMs: 1221, clockId: "A" }, 221);
  assert.equal(clock.mapping().masterOffsetMs, 1000);
  assert.equal(clock.record({ clientSent: 400, serverReceivedMs: 1401, serverSentMs: 1400, clockId: "A" }, 402), false);
});

test("a server clock identity change discards the old epoch mapping", () => {
  const clock = new LiveClockSync();
  clock.record({ clientSent: 100, serverReceivedMs: 1101, serverSentMs: 1101, clockId: "A" }, 102);
  clock.record({ clientSent: 200, serverReceivedMs: 5201, serverSentMs: 5201, clockId: "B" }, 202);
  assert.equal(clock.mapping().masterOffsetMs, 5000);
  assert.equal(clock.mapping().clockId, "B");
});

test("master/client monotonic conversion is invertible including conservative drift", () => {
  const mapping = { masterOffsetMs: 1_700_000_000_000, referenceClientMs: 100, driftPpm: 50 };
  assert.ok(Math.abs(masterToClientTime(clientToMasterTime(25000, mapping), mapping) - 25000) < 0.001);
});

test("valid output timestamps already include device latency compensation", () => {
  const context = { currentTime: 5.2, baseLatency: 0.1, outputLatency: 0.1,
    getOutputTimestamp: () => ({ contextTime: 5, performanceTime: 1000 }) };
  const result = masterToAudioContextTime(context, 2700, { masterOffsetMs: 1000 }, 1100);
  assert.equal(result.contextTime, 5.7);
  assert.equal(result.method, "output-timestamp");
});

test("unavailable, zero or stale output timestamps use a labelled latency estimate once", () => {
  for (const getOutputTimestamp of [undefined, () => ({ contextTime: 0, performanceTime: 0 }),
    () => ({ contextTime: 0.1, performanceTime: 1 })]) {
    const result = masterToAudioContextTime({ currentTime: 5, baseLatency: 0.01, outputLatency: 0.04, getOutputTimestamp },
      3600, { masterOffsetMs: 1000 }, 2100);
    assert.ok(Math.abs(result.contextTime - 5.45) < 1e-9);
    assert.equal(result.method, "latency-estimate");
  }
});
