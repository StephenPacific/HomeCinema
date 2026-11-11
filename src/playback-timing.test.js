import assert from "node:assert/strict";
import test from "node:test";
import { localPlaybackTiming } from "./playback-timing.js";

test("a late joiner finishes locally instead of replaying the final samples", () => {
  const state = Object.freeze({ playing: true, position: 0, startedAt: 1000 });
  const timing = localPlaybackTiming(state, { nowMs: 31000, durationSeconds: 16 });
  assert.deepEqual(timing, { rawPosition: 30, position: 16, atEnd: true });
  assert.equal(state.playing, true); // A longer stem on another player continues.
  assert.equal(localPlaybackTiming(state, { nowMs: 31000, durationSeconds: 90 }).atEnd, false);
});

test("the exact end is terminal, while the preceding samples can still play", () => {
  const state = { playing: true, position: 0, startedAt: 1000 };
  assert.equal(localPlaybackTiming(state, { nowMs: 16999, durationSeconds: 16 }).atEnd, false);
  assert.equal(localPlaybackTiming(state, { nowMs: 17000, durationSeconds: 16 }).atEnd, true);
});

test("countdown and clock/device offsets do not cause a premature end", () => {
  const state = { playing: true, position: 5, startedAt: 10000 };
  assert.deepEqual(localPlaybackTiming(state, { nowMs: 9000, durationSeconds: 16 }),
    { rawPosition: 5, position: 5, atEnd: false });
  assert.equal(localPlaybackTiming(state, {
    nowMs: 21100, serverOffsetMs: 50, deviceOffsetMs: 200, durationSeconds: 16
  }).atEnd, false);
});

test("unknown durations are not treated as an ended track", () => {
  for (const durationSeconds of [undefined, NaN, Infinity, 0]) {
    assert.equal(localPlaybackTiming({ playing: true, position: 0, startedAt: 1000 }, {
      nowMs: 31000, durationSeconds
    }).atEnd, false);
  }
});

test("an explicit restart at zero clears the local end condition", () => {
  assert.equal(localPlaybackTiming({ playing: false, position: 16, startedAt: null },
    { durationSeconds: 16 }).atEnd, true);
  assert.deepEqual(localPlaybackTiming({ playing: true, position: 0, startedAt: 40000 },
    { nowMs: 37000, durationSeconds: 16 }), { rawPosition: 0, position: 0, atEnd: false });
});
