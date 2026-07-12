import assert from "node:assert/strict";
import test from "node:test";
import {
  appendRoomTimingSample,
  fixedPostDelayMs,
  fixedRoomTargetMs,
  fixedTimelineErrorMs,
  latestEligibleRoomSpeakers,
  nextFixedTimelineGuard,
  nextPostDelayCorrection,
  roomCorrectionPlan,
  roomGuardError,
  roomLockTimeoutAction,
  roomTimingSample,
  ROOM_SYNC_POLICY,
  stableRoomTiming,
  supportsRoomSyncVersion
} from "../src/roomSync.js";

test("timeline lock retries are bounded before the room is blocked", () => {
  assert.equal(
    roomLockTimeoutAction({ candidateCount: 1, lockedCount: 0, timedOut: true, lockAttempt: 1 }),
    "retry"
  );
  assert.equal(
    roomLockTimeoutAction({ candidateCount: 1, lockedCount: 0, timedOut: true, lockAttempt: 3 }),
    "block"
  );
  assert.equal(
    roomLockTimeoutAction({ candidateCount: 2, lockedCount: 1, timedOut: true, lockAttempt: 1 }),
    "retry"
  );
  assert.equal(
    roomLockTimeoutAction({ candidateCount: 2, lockedCount: 1, timedOut: true, lockAttempt: 3 }),
    "block"
  );
  assert.equal(
    roomLockTimeoutAction({ candidateCount: 2, lockedCount: 2, timedOut: true, lockAttempt: 3 }),
    "wait"
  );
});

test("preflight requires fresh consecutive RTP samples with stable delay", () => {
  const now = 10_000;
  const samples = [
    roomTimingSample({ at: 6000, playoutDelayMs: 126, outputLatencyMs: 10, deviceOffsetMs: 6, rtcBytesReceived: 100 }),
    roomTimingSample({ at: 8000, playoutDelayMs: 129, outputLatencyMs: 10, deviceOffsetMs: 6, rtcBytesReceived: 200 }),
    roomTimingSample({ at: 10_000, playoutDelayMs: 124, outputLatencyMs: 10, deviceOffsetMs: 6, rtcBytesReceived: 300 })
  ];
  assert.deepEqual(stableRoomTiming(samples, now), { stable: true, delayMs: 130, spreadMs: 5 });

  const stalled = [...samples.slice(0, 2), { ...samples[2], rtcProgress: 200 }];
  assert.equal(stableRoomTiming(stalled, now).stable, false);
  const unstable = [...samples.slice(0, 2), { ...samples[2], normalizedDelayMs: 160 }];
  assert.equal(stableRoomTiming(unstable, now).stable, false);
});

test("room sync version rejects stale speaker pages", () => {
  assert.equal(supportsRoomSyncVersion(undefined), false);
  assert.equal(supportsRoomSyncVersion(2), false);
  assert.equal(supportsRoomSyncVersion(3), false);
  assert.equal(supportsRoomSyncVersion(4), false);
  assert.equal(supportsRoomSyncVersion(5), false);
  assert.equal(supportsRoomSyncVersion(6), true);
});

test("room candidates reject old engines and keep only the newest connection per device", () => {
  const candidates = latestEligibleRoomSpeakers([
    { id: 1, role: "speaker", deviceKey: "living-room", syncEngineVersion: 6, unlocked: true, muted: false },
    { id: 2, role: "speaker", deviceKey: "living-room", syncEngineVersion: 6, unlocked: true, muted: false },
    { id: 3, role: "speaker", deviceKey: "old-page", syncEngineVersion: 3, unlocked: true, muted: false },
    { id: 4, role: "speaker", deviceKey: "muted", syncEngineVersion: 6, unlocked: true, muted: true },
    { id: 5, role: "controller", deviceKey: "controller", syncEngineVersion: 6, unlocked: true, muted: false }
  ]);
  assert.deepEqual(candidates.map((client) => client.id), [2]);
});

test("duplicate status reports do not replace the RTP timing window", () => {
  const first = roomTimingSample({ at: 1000, playoutDelayMs: 120, rtcBytesReceived: 100 });
  const duplicate = roomTimingSample({ at: 1100, playoutDelayMs: 122, rtcBytesReceived: 100 });
  const second = roomTimingSample({ at: 2000, playoutDelayMs: 121, rtcBytesReceived: 200 });
  const once = appendRoomTimingSample([], first);
  assert.strictEqual(appendRoomTimingSample(once, duplicate), once);
  assert.equal(appendRoomTimingSample(once, second).length, 2);
});

test("room target is frozen from the slowest stable speaker plus headroom", () => {
  assert.equal(
    fixedRoomTargetMs([
      { stable: true, delayMs: 118 },
      { stable: true, delayMs: 151 },
      { stable: false, delayMs: 300 }
    ]),
    159
  );
  assert.equal(fixedRoomTargetMs([], 60), 100);
  assert.equal(fixedRoomTargetMs([{ stable: true, delayMs: 600 }]), 500);
});

test("fixed post delay fills only the initialization gap", () => {
  assert.equal(
    fixedPostDelayMs({ roomTargetMs: 180, playoutDelayMs: 112, outputLatencyMs: 18, deviceOffsetMs: 10 }),
    60
  );
  assert.equal(
    fixedPostDelayMs({ roomTargetMs: 100, playoutDelayMs: 120, outputLatencyMs: 20, deviceOffsetMs: 0 }),
    0
  );
  assert.equal(
    fixedTimelineErrorMs({
      roomTargetMs: 180,
      playoutDelayMs: 112,
      outputLatencyMs: 18,
      postDelayMs: 60,
      deviceOffsetMs: 10
    }),
    0
  );
});

test("lock timing includes the deterministic post delay", () => {
  const sample = roomTimingSample({
    at: 1000,
    playoutDelayMs: 112,
    outputLatencyMs: 18,
    postDelayMs: 60,
    deviceOffsetMs: 10,
    rtcBytesReceived: 100
  });
  assert.equal(sample.normalizedDelayMs, 180);
});

test("soft correction moves toward the room target with a bounded step", () => {
  assert.deepEqual(
    nextPostDelayCorrection({ currentPostDelayMs: 31, syncErrorMs: 30 }),
    { delayMs: 28, adjustmentMs: -3, saturated: true }
  );
  assert.deepEqual(
    nextPostDelayCorrection({ currentPostDelayMs: 10, syncErrorMs: -20 }),
    { delayMs: 13, adjustmentMs: 3, saturated: true }
  );
  assert.deepEqual(
    nextPostDelayCorrection({ currentPostDelayMs: 10, syncErrorMs: 7 }),
    { delayMs: 10, adjustmentMs: 0, saturated: false }
  );
});

test("quarantined correction can relock faster but cannot create negative delay", () => {
  assert.deepEqual(
    nextPostDelayCorrection({ currentPostDelayMs: 40, syncErrorMs: 36, maximumStepMs: 12 }),
    { delayMs: 31, adjustmentMs: -9, saturated: false }
  );
  assert.deepEqual(
    nextPostDelayCorrection({ currentPostDelayMs: 2, syncErrorMs: 30, maximumStepMs: 12 }),
    { delayMs: 0, adjustmentMs: -2, saturated: true }
  );
});

test("fast monitoring does not accelerate audible correction", () => {
  assert.deepEqual(
    roomCorrectionPlan({ silent: false, now: 1_500, lastCorrectionAt: 1_000 }),
    { due: false, intervalMs: 2_000, maximumStepMs: 3 }
  );
  assert.deepEqual(
    roomCorrectionPlan({ silent: false, now: 3_000, lastCorrectionAt: 1_000 }),
    { due: true, intervalMs: 2_000, maximumStepMs: 3 }
  );
  assert.deepEqual(
    roomCorrectionPlan({ silent: true, now: 1_500, lastCorrectionAt: 1_000 }),
    { due: true, intervalMs: 500, maximumStepMs: 3 }
  );
});

test("recovery envelope favors fast isolation and a slower verified return", () => {
  assert.equal(ROOM_SYNC_POLICY.monitorIntervalMs, 250);
  assert.equal(ROOM_SYNC_POLICY.silentCorrectionIntervalMs, 500);
  assert.equal(ROOM_SYNC_POLICY.fastFuseFadeSeconds, 0.16);
  assert.equal(ROOM_SYNC_POLICY.quarantineFadeSeconds, 0.45);
  assert.equal(ROOM_SYNC_POLICY.recoverySamples, 6);
  assert.equal(ROOM_SYNC_POLICY.rejoinLeadMs, 1_200);
  assert.equal(ROOM_SYNC_POLICY.rejoinFadeSeconds, 1.2);
});

test("fixed timeline quarantines sustained drift and rejoins only after sustained recovery", () => {
  let guard = nextFixedTimelineGuard(null, 31);
  guard = nextFixedTimelineGuard(guard, 29);
  assert.equal(guard.action, "none");
  guard = nextFixedTimelineGuard(guard, 27);
  assert.equal(guard.action, "quarantine");
  assert.equal(guard.quarantined, true);

  for (const error of [5, 7, 4, 6, 3]) {
    guard = nextFixedTimelineGuard(guard, error);
    assert.equal(guard.action, "none");
  }
  guard = nextFixedTimelineGuard(guard, 5);
  assert.equal(guard.action, "rejoin");
  assert.equal(guard.quarantined, false);
});

test("recovery tolerates a noisy near-lock sample without starting over", () => {
  let guard = { quarantined: true, violationCount: 3, recoveryCount: 3 };
  guard = nextFixedTimelineGuard(guard, 11);
  assert.equal(guard.recoveryCount, 2);
  for (const error of [6, 7, 5, 8]) guard = nextFixedTimelineGuard(guard, error);
  assert.equal(guard.action, "rejoin");
});

test("an emergency timeline jump is isolated on the first monitor sample", () => {
  assert.equal(roomGuardError({ smoothedErrorMs: 24, rawErrorMs: 96 }), 96);
  assert.equal(roomGuardError({ smoothedErrorMs: 28, rawErrorMs: 42 }), 28);
  const guard = nextFixedTimelineGuard(null, 90);
  assert.equal(guard.action, "quarantine");
  assert.equal(guard.quarantined, true);
});
