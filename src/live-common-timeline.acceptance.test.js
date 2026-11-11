import assert from "node:assert/strict";
import test from "node:test";
import { PCMFrameParser } from "../lib/live-audio-server.mjs";
import { LiveAudioPlayer } from "./live-audio.js";
import { LiveClockSync } from "./live-clock.js";

// No audio devices, sockets or browser are involved. These tests invert an
// independent fake hardware clock to inspect actual source.start() deadlines.
const MASTER_ORIGIN = 1_700_000_000_000;
const RATE = 48000, PACKET_FRAMES = 960, PRESENTATION_MS = 700;
const marker = frame => (frame % RATE) / RATE * 0.25;

function wirePacket(index, { streamId = 37, sourceFrame = index * PACKET_FRAMES,
  captureMasterMs = MASTER_ORIGIN + index * 20, delayMs = PRESENTATION_MS } = {}) {
  const packet = Buffer.alloc(48 + PACKET_FRAMES * 2 * 4);
  packet.write("HCA2", 0);
  packet.writeUInt32LE(RATE, 4); packet.writeUInt32LE(2, 8);
  packet.writeUInt32LE(PACKET_FRAMES, 12); packet.writeUInt32LE(index >>> 0, 16);
  packet.writeUInt32LE(streamId, 20); packet.writeBigUInt64LE(BigInt(sourceFrame), 24);
  packet.writeDoubleLE(captureMasterMs, 32); packet.writeDoubleLE(delayMs, 40);
  for (let frame = 0; frame < PACKET_FRAMES; frame++) {
    packet.writeFloatLE(marker(sourceFrame + frame), 48 + frame * 8);
    packet.writeFloatLE(-marker(sourceFrame + frame), 52 + frame * 8);
  }
  return packet;
}

function parsedPacket(packet) {
  const parser = new PCMFrameParser();
  const decoded = [];
  // Deliberately split both the 48-byte header and the PCM payload.
  for (let at = 0; at < packet.length; at += 137) {
    parser.push(packet.subarray(at, at + 137), frame => decoded.push(frame.data));
  }
  parser.finish();
  assert.equal(decoded.length, 1);
  const bytes = decoded[0];
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function receiver(world, { perfOrigin, perfPpm, audioOrigin, audioPpm, latencyMs,
  outputTimestamp = true, bufferMs = 500, useEstimator = true } = {}) {
  const perfRate = 1 + perfPpm / 1e6, audioRate = 1 + audioPpm / 1e6;
  const perf = realMs => perfOrigin + realMs * perfRate;
  const created = [], records = [], sync = new LiveClockSync();
  const gain = { value: 0, cancelScheduledValues() {}, setValueAtTime(v) { this.value = v; }, linearRampToValueAtTime(v) { this.value = v; } };
  const context = {
    state: "running", destination: {}, sampleRate: 44100,
    baseLatency: 0.004, outputLatency: latencyMs / 1000 - 0.004,
    get currentTime() { return audioOrigin + world.realMs / 1000 * audioRate; },
    createGain() { return { gain, connect() {} }; },
    createBuffer(channels, frames, sampleRate) {
      const samples = Array.from({ length: channels }, () => new Float32Array(frames));
      return { duration: frames / sampleRate, length: frames, sampleRate, getChannelData: c => samples[c] };
    },
    createBufferSource() {
      const source = { playbackRate: { value: 1 }, connect() {}, disconnect() {},
        start(time) { this.startTime = time; }, stop(time) { this.stopTime = time; } };
      created.push(source); return source;
    }
  };
  if (outputTimestamp) context.getOutputTimestamp = () => ({
    contextTime: context.currentTime - latencyMs / 1000 * audioRate,
    performanceTime: perf(world.realMs)
  });
  const player = new LiveAudioPlayer(context, {
    autoPump: false, bufferMs, performanceNow: () => perf(world.realMs),
    onSchedule(record) {
      const source = created.at(-1);
      // Invert the independently modelled output clock. Reading only the
      // reported targetMasterMs would let an arrival-relative scheduler pass.
      const physicalMasterMs = MASTER_ORIGIN
        + (source.startTime - audioOrigin) / audioRate * 1000 + latencyMs;
      const lastFrameOffsetMs = (source.buffer.length - 1) / source.buffer.sampleRate * 1000;
      const lastFramePhysicalMasterMs = physicalMasterMs + lastFrameOffsetMs / source.playbackRate.value / audioRate;
      assert.ok(Math.abs(source.buffer.getChannelData(0)[0] - marker(record.sourceFrame)) < 1e-7,
        "scheduled frame identity must match its actual PCM payload");
      records.push({ ...record, physicalMasterMs, lastFrameOffsetMs, lastFramePhysicalMasterMs, source });
    }
  });
  function recordClock(sentRealMs, oneWayMs = 3) {
    const serverProcessingMs = 0.25;
    sync.record({ clientSent: perf(sentRealMs), serverReceivedMs: MASTER_ORIGIN + sentRealMs + oneWayMs,
      serverSentMs: MASTER_ORIGIN + sentRealMs + oneWayMs + serverProcessingMs, clockId: "master-process-A" },
    perf(sentRealMs + 2 * oneWayMs + serverProcessingMs));
    player.setClockMapping(sync.mapping());
  }
  if (useEstimator) {
    for (let at = -30000; at <= -1000; at += 1000) recordClock(at, 3 + (-at / 1000 % 4) * 2);
  } else {
    player.setClockMapping({ clockId: "master-process-A", masterOffsetMs: MASTER_ORIGIN - perfOrigin,
      referenceClientMs: perfOrigin, driftPpm: (1 / perfRate - 1) * 1e6,
      roundTripMs: 0, updatedClientMs: perf(0) });
  }
  return { player, context, created, records, perf, recordClock };
}

function simulate({ outputTimestamp = true, wallJump = false } = {}) {
  const world = { realMs: 0 };
  const a = receiver(world, { perfOrigin: 500000, perfPpm: 40, audioOrigin: 10, audioPpm: 80,
    latencyMs: 18, outputTimestamp, bufferMs: 200 });
  const b = receiver(world, { perfOrigin: 1500000, perfPpm: -60, audioOrigin: 200, audioPpm: -110,
    latencyMs: 84, outputTimestamp, bufferMs: 1000 });
  const arrivals = [];
  let lastA = -Infinity, lastB = -Infinity;
  for (let index = 0; index < 240; index++) {
    const captureMs = index * 20, packet = parsedPacket(wirePacket(index));
    lastA = Math.max(lastA + 0.01, captureMs + 100 + [3, 8, 5, 11][index % 4]);
    arrivals.push({ at: lastA, target: a, packet });
    if (captureMs >= 1400) { // Second receiver joins a live stream; it receives no earlier backlog.
      lastB = Math.max(lastB + 0.01, captureMs + 100 + [65, 2, 42, 11, 90, 4][index % 6]);
      arrivals.push({ at: lastB, target: b, packet });
    }
  }
  arrivals.sort((x, y) => x.at - y.at);
  let cursor = 0;
  const savedDateNow = Date.now;
  try {
    if (wallJump) Date.now = () => MASTER_ORIGIN + world.realMs + (world.realMs >= 2000 ? 3600000 : 0);
    for (world.realMs = 0; world.realMs <= 5400; world.realMs += 5) {
      // Four-timestamp clock exchanges refresh on independent performance clocks.
      if (world.realMs > 10 && world.realMs % 1000 === 10) {
        a.recordClock(world.realMs - 10, 3); b.recordClock(world.realMs - 10, 3);
      }
      while (cursor < arrivals.length && arrivals[cursor].at <= world.realMs) {
        const event = arrivals[cursor++]; event.target.player.push(event.packet);
      }
      a.player.pump(); b.player.pump();
    }
  } finally { Date.now = savedDateNow; a.player.close(); b.player.close(); }
  return { a, b };
}

function assertCommonFrames({ a, b }, expectedMethod) {
  const first = new Map(a.records.map(record => [record.sourceFrame, record]));
  const common = b.records.filter(record => first.has(record.sourceFrame));
  assert.ok(common.length >= 20, "both devices must actually schedule common frame identities");
  const nativeGroupEstimateMs = Math.max(322.6 + 15.9, 0 + 82.5);
  const nativeBaseMs = PRESENTATION_MS - nativeGroupEstimateMs;
  const measurements = { sharedFrames: common.length, maxAErrorMs: 0, maxBErrorMs: 0, maxPairErrorMs: 0 };
  for (const right of common) {
    const left = first.get(right.sourceFrame);
    const expectedMasterMs = MASTER_ORIGIN + right.sourceFrame / RATE * 1000 + nativeBaseMs + nativeGroupEstimateMs;
    assert.equal(left.targetMasterMs, expectedMasterMs); assert.equal(right.targetMasterMs, expectedMasterMs);
    assert.equal(left.clockMethod, expectedMethod); assert.equal(right.clockMethod, expectedMethod);
    assert.ok(Math.abs(left.physicalMasterMs - expectedMasterMs) < 1,
      `receiver A frame ${left.sourceFrame}: ${left.physicalMasterMs - expectedMasterMs} ms`);
    assert.ok(Math.abs(right.physicalMasterMs - expectedMasterMs) < 1,
      `receiver B frame ${right.sourceFrame}: ${right.physicalMasterMs - expectedMasterMs} ms`);
    assert.ok(Math.abs(left.lastFramePhysicalMasterMs - (expectedMasterMs + left.lastFrameOffsetMs)) < 1,
      "receiver A must keep the block's final frame on the common timeline too");
    assert.ok(Math.abs(right.lastFramePhysicalMasterMs - (expectedMasterMs + right.lastFrameOffsetMs)) < 1,
      "receiver B must keep the block's final frame on the common timeline too");
    // Each independent estimator has its own sub-ms model error. Their pair
    // bound is the sum, not a claim of sub-ms acoustic synchronization.
    assert.ok(Math.abs(left.physicalMasterMs - right.physicalMasterMs) < 2,
      `frame ${right.sourceFrame}: A ${left.physicalMasterMs - expectedMasterMs} ms/B ${right.physicalMasterMs - expectedMasterMs} ms; network/late-join/buffer choice must not choose separate playback origins`);
    measurements.maxAErrorMs = Math.max(measurements.maxAErrorMs, Math.abs(left.physicalMasterMs - expectedMasterMs));
    measurements.maxBErrorMs = Math.max(measurements.maxBErrorMs, Math.abs(right.physicalMasterMs - expectedMasterMs));
    measurements.maxPairErrorMs = Math.max(measurements.maxPairErrorMs, Math.abs(left.physicalMasterMs - right.physicalMasterMs));
  }
  assert.ok(b.records[0].sourceFrame >= 1400 / 1000 * RATE, "late joiner cannot replay pre-join frames");
  return measurements;
}

test("HCA2 relay-to-player acceptance: independent clocks, jitter and a late join schedule the same native target", t => {
  t.diagnostic(JSON.stringify(assertCommonFrames(simulate(), "output-timestamp")));
});

test("fallback output-latency model reaches the common target without an output timestamp", t => {
  t.diagnostic(JSON.stringify(assertCommonFrames(simulate({ outputTimestamp: false }), "latency-estimate")));
});

test("an adjustable wall-clock jump does not retime stamped frames on either receiver", t => {
  t.diagnostic(JSON.stringify(assertCommonFrames(simulate({ wallJump: true }), "output-timestamp")));
});

test("late packets are dropped instead of becoming a new arrival-relative playback origin", () => {
  const world = { realMs: 2000 };
  const device = receiver(world, { perfOrigin: 900000, perfPpm: 0, audioOrigin: 20,
    audioPpm: 0, latencyMs: 40, useEstimator: false });
  for (let index = 0; index < 5; index++) device.player.push(parsedPacket(wirePacket(index)));
  assert.equal(device.records.length, 0);
  assert.ok(device.player.getStats().lateDrops > 0);
  for (let index = 100; index < 105; index++) device.player.push(parsedPacket(wirePacket(index)));
  world.realMs = 2580; device.player.pump();
  assert.ok(device.records.length > 0);
  assert.equal(device.records[0].sourceFrame, RATE * 2);
  assert.equal(device.records[0].targetMasterMs, MASTER_ORIGIN + 2700);
  assert.ok(Math.abs(device.records[0].physicalMasterMs - (MASTER_ORIGIN + 2700)) < 0.001);
  device.player.close();
});
