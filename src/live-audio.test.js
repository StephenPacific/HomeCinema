import assert from "node:assert/strict";
import test from "node:test";
import { decodeLivePacket, LiveAudioPlayer } from "./live-audio.js";

function packet(sequence, { sampleRate = 8000, channels = 2, frames = 160, value = 0.25 } = {}) {
  const data = new ArrayBuffer(20 + frames * channels * 4);
  const view = new DataView(data);
  view.setUint32(0, 0x48434131, false);
  [sampleRate, channels, frames, sequence].forEach((item, index) => view.setUint32(4 + index * 4, item, true));
  for (let i = 0; i < frames * channels; i += 1) view.setFloat32(20 + i * 4, i % channels === 0 ? value : -value, true);
  return data;
}

function context() {
  const created = [];
  const gain = { value: 0, cancelScheduledValues() {}, setValueAtTime(value) { this.value = value; }, linearRampToValueAtTime(value) { this.value = value; } };
  return {
    currentTime: 0, state: "running", sampleRate: 44100, destination: {}, created,
    createGain: () => ({ gain, connect() {} }),
    createBuffer(channels, frames, sampleRate) {
      const samples = Array.from({ length: channels }, () => new Float32Array(frames));
      return { duration: frames / sampleRate, sampleRate, length: frames, getChannelData: (channel) => samples[channel] };
    },
    createBufferSource() {
      const source = { playbackRate: { value: 1 }, connect() {}, disconnect() {},
        start(time) { this.startTime = time; }, stop(time) { this.stopTime = time; } };
      created.push(source);
      return source;
    }
  };
}

function packet2(sequence, { captureMasterMs = 100000 + sequence * 20, sourceFrame = sequence * 160,
  streamId = 1, presentationDelayMs = 700 } = {}) {
  const data = new ArrayBuffer(48 + 160 * 2 * 4);
  const view = new DataView(data);
  view.setUint32(0, 0x48434132, false);
  [8000, 2, 160, sequence, streamId].forEach((value, index) => view.setUint32(4 + index * 4, value, true));
  view.setUint32(24, sourceFrame % 0x100000000, true);
  view.setUint32(28, Math.floor(sourceFrame / 0x100000000), true);
  view.setFloat64(32, captureMasterMs, true);
  view.setFloat64(40, presentationDelayMs, true);
  return data;
}

test("packet decoding rejects malformed lengths/rates and sanitizes non-finite samples", () => {
  assert.throws(() => decodeLivePacket(new ArrayBuffer(8)));
  assert.throws(() => decodeLivePacket(packet(0, { sampleRate: 1000 })));
  const input = packet(3);
  const view = new DataView(input);
  view.setFloat32(20, Infinity, true);
  view.setFloat32(24, 2, true);
  const decoded = decodeLivePacket(input);
  assert.equal(decoded.sequence, 3);
  assert.equal(decoded.samples[0], 0);
  assert.equal(decoded.samples[1], 1);
  assert.equal(decoded.peak, 1);
  view.setUint32(12, 1000, true);
  assert.throws(() => decodeLivePacket(input));
});

test("receiver waits for jitter buffer then schedules continuous 100ms blocks at source sample rate", () => {
  const ctx = context();
  const player = new LiveAudioPlayer(ctx, { autoPump: false });
  for (let i = 0; i < 24; i += 1) player.push(packet(i));
  assert.equal(ctx.created.length, 0);
  player.push(packet(24));
  assert.equal(ctx.created.length, 2);
  const [first, second] = ctx.created;
  assert.equal(first.buffer.sampleRate, 8000); // Context is 44.1k: browser resamples.
  assert.equal(first.buffer.length, 800);
  assert.equal(first.buffer.getChannelData(0)[0], 0.25);
  assert.equal(first.buffer.getChannelData(1)[0], -0.25);
  assert.ok(Math.abs(second.startTime - first.startTime - first.buffer.duration / first.playbackRate.value) < 1e-9);
  assert.ok(player.getStats().queueMs <= 600);
  assert.equal(player.getStats().inputPeak, 0.25);
  player.close();
});

test("sequence gaps and format changes flush scheduled/stale audio and rebuffer", () => {
  const ctx = context();
  const player = new LiveAudioPlayer(ctx, { autoPump: false });
  for (let i = 0; i < 25; i += 1) player.push(packet(i));
  const first = ctx.created[0];
  player.push(packet(30));
  assert.equal(player.started, false);
  assert.ok(first.stopTime >= ctx.currentTime);
  assert.equal(player.getStats().discontinuities, 1);
  player.push(packet(31, { sampleRate: 48000, frames: 960 }));
  assert.equal(player.sampleRate, 48000);
  assert.equal(player.started, false);
  player.close();
});

test("starvation is counted once and cannot repeat old audio blocks", () => {
  const ctx = context();
  const player = new LiveAudioPlayer(ctx, { autoPump: false });
  for (let i = 0; i < 25; i += 1) player.push(packet(i));
  ctx.currentTime = 1;
  player.pump();
  assert.equal(player.getStats().underruns, 1);
  assert.equal(player.started, false);
  const count = ctx.created.length;
  player.pump();
  assert.equal(ctx.created.length, count);
  assert.equal(player.getStats().underruns, 1);
  player.close();
});

test("paused or stalled receivers keep a bounded backlog and drop old audio", () => {
  const ctx = context();
  ctx.state = "suspended";
  const player = new LiveAudioPlayer(ctx, { autoPump: false });
  for (let i = 0; i < 200; i += 1) player.push(packet(i));
  assert.equal(ctx.created.length, 0);
  assert.ok(player.getStats().queueMs <= 1200);
  assert.ok(player.getStats().droppedMs > 0);
  ctx.state = "running";
  player.pump();
  assert.ok(player.getStats().queueMs <= 1200);
  player.close();
});

test("buffer choices are bounded and reset, with drift correction bounded to 0.3 percent", () => {
  const ctx = context();
  const player = new LiveAudioPlayer(ctx, { autoPump: false });
  player.setBufferMs(1);
  assert.equal(player.bufferMs, 200);
  player.setBufferMs(10000);
  assert.equal(player.bufferMs, 1000);
  for (let i = 0; i < 50; i += 1) player.push(packet(i));
  assert.ok(ctx.created.every((source) => source.playbackRate.value >= 0.997 && source.playbackRate.value <= 1.003));
  player.close();
});

test("a continuous stream with mild clock drift stays bounded with no starvation", () => {
  const ctx = context();
  const player = new LiveAudioPlayer(ctx, { autoPump: false });
  for (let i = 0; i < 1500; i += 1) {
    ctx.currentTime = i * 0.02 * 1.0002;
    player.push(packet(i));
    assert.ok(player.getStats().queueMs <= 1200);
    if (player.started) assert.ok(player.nextTime - ctx.currentTime <= 0.252);
  }
  assert.equal(player.getStats().underruns, 0);
  assert.ok(player.getStats().queueMs >= 300);
  assert.ok(player.getStats().queueMs <= 700);
  player.close();
});

test("disconnect/reset stops every scheduled source and discards queued audio", () => {
  const ctx = context();
  const player = new LiveAudioPlayer(ctx, { autoPump: false });
  for (let i = 0; i < 25; i += 1) player.push(packet(i));
  player.reset();
  assert.equal(player.getStats().queueMs, 0);
  assert.equal(player.getStats().playing, false);
  assert.ok(ctx.created.every((source) => source.stopTime <= ctx.currentTime + 0.02));
  const count = ctx.created.length;
  player.close();
  player.push(packet(26));
  assert.equal(ctx.created.length, count);
});

test("HCA2 preserves 64-bit source positions and rejects invalid timeline fields", () => {
  assert.equal(decodeLivePacket(packet2(0, { sourceFrame: 0x100000000 + 123 })).sourceFrame, 0x100000000 + 123);
  assert.throws(() => decodeLivePacket(packet2(0, { sourceFrame: 2 ** 53 })));
  assert.throws(() => decodeLivePacket(packet2(0, { captureMasterMs: NaN })));
  assert.throws(() => decodeLivePacket(packet2(0, { presentationDelayMs: 5000 })));
});

test("HCA2 does not start at a full local buffer; it schedules the common future deadline", () => {
  const ctx = context();
  const scheduled = [];
  const player = new LiveAudioPlayer(ctx, { autoPump: false, performanceNow: () => ctx.currentTime * 1000,
    onSchedule: (record) => scheduled.push(record) });
  for (let i = 0; i < 25; i += 1) player.push(packet2(i));
  assert.equal(ctx.created.length, 0); // Clock has not been established.
  player.setClockMapping({ masterOffsetMs: 100000, clockId: "A" });
  assert.equal(ctx.created.length, 0); // Even 500ms queued cannot override a future deadline.
  ctx.currentTime = 0.56;
  player.pump();
  assert.equal(ctx.created.length, 1);
  assert.ok(Math.abs(ctx.created[0].startTime - 0.7) < 1e-9);
  assert.equal(scheduled[0].sourceFrame, 0);
  assert.equal(scheduled[0].targetMasterMs, 100700);
  assert.equal(player.getStats().syncMode, "common-timeline");
  player.close();
});

test("late HCA2 frames are discarded and a late joiner keeps the future deadline", () => {
  const ctx = context();
  ctx.currentTime = 5;
  const scheduled = [];
  const player = new LiveAudioPlayer(ctx, { autoPump: false, performanceNow: () => 5000,
    onSchedule: (record) => scheduled.push(record) });
  player.setClockMapping({ masterOffsetMs: 100000, clockId: "A" });
  for (let i = 200; i < 225; i += 1) player.push(packet2(i));
  assert.ok(player.getStats().lateDrops > 0);
  assert.ok(scheduled.length > 0);
  for (const record of scheduled) {
    assert.ok(record.startContextTime >= 5.02 - 1e-8);
    assert.ok(Math.abs(record.startContextTime - (record.targetMasterMs - 100000) / 1000) < 1e-8);
  }
  player.close();
});

test("negative device trim uses causal future frames without the legacy buffer threshold", () => {
  const ctx = context();
  ctx.currentTime = 0.36;
  const scheduled = [];
  const player = new LiveAudioPlayer(ctx, { autoPump: false, bufferMs: 800, localTrimMs: -200,
    performanceNow: () => 360, onSchedule: (record) => scheduled.push(record) });
  player.setClockMapping({ masterOffsetMs: 100000, clockId: "A" });
  for (let i = 0; i < 5; i += 1) player.push(packet2(i));
  assert.equal(scheduled.length, 1); // 100ms grouping, not an800ms local-start gate.
  assert.equal(scheduled[0].targetMasterMs, 100500);
  assert.ok(Math.abs(scheduled[0].startContextTime - 0.5) < 1e-8);
  player.close();
});

test("stream and clock epochs invalidate previously scheduled audio", () => {
  const ctx = context();
  ctx.currentTime = 0.56;
  const player = new LiveAudioPlayer(ctx, { autoPump: false, performanceNow: () => 560 });
  player.setClockMapping({ masterOffsetMs: 100000, clockId: "A" });
  for (let i = 0; i < 5; i += 1) player.push(packet2(i));
  const source = ctx.created[0];
  player.push(packet2(0, { streamId: 2, captureMasterMs: 100600 }));
  assert.ok(source.stopTime <= ctx.currentTime + 0.02);
  assert.equal(player.started, false);
  player.setClockMapping({ masterOffsetMs: 200000, clockId: "B" });
  assert.equal(player.queuedFrames, 0);
  player.close();
});
