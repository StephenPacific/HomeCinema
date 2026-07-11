import assert from "node:assert/strict";
import test from "node:test";
import { RevisionConflictError } from "../backend/domain/errors.js";
import { SESSION_STATES } from "../backend/domain/session.js";
import { createTestService, readySession } from "../test_support/helpers.js";

test("preload and ready do not create a playback epoch", async () => {
  const { service } = createTestService();
  await service.createSession("session-test");
  const preload = await service.preload({
    sessionId: "session-test",
    messageId: "preload-1",
    manifestHash: "sha256:manifest"
  });
  assert.equal(preload.snapshot.epoch, 0);
  assert.equal(preload.snapshot.state, SESSION_STATES.PRELOADING);

  const ready = await service.markReady({
    sessionId: "session-test",
    messageId: "ready-1",
    manifestHash: "sha256:manifest"
  });
  assert.equal(ready.epoch, 0);
  assert.equal(ready.state, SESSION_STATES.READY);
});

test("arm creates a new timeline epoch and stop invalidates it", async () => {
  const { service } = await readySession();
  const arm = await service.armPlayback({
    sessionId: "session-test",
    messageId: "arm-1",
    manifestHash: "sha256:manifest",
    renderPlanHash: "sha256:render",
    effectiveAtServerMs: 1_002_000,
    minimumBufferLeadMs: 500
  });
  assert.equal(arm.snapshot.epoch, 1);
  assert.equal(arm.snapshot.sequence, 1);
  assert.equal(arm.snapshot.state, SESSION_STATES.ARMED);

  const stop = await service.stop({
    sessionId: "session-test",
    messageId: "stop-1",
    timelinePositionMs: 450
  });
  assert.equal(stop.snapshot.epoch, 2);
  assert.equal(stop.snapshot.sequence, 1);
  assert.equal(stop.snapshot.state, SESSION_STATES.STOPPED);
});

test("session store rejects stale compare-and-swap revision", async () => {
  const { service, store } = createTestService();
  const initial = await service.createSession("session-test");
  await store.transition("session-test", initial.revision, (state) => ({ ...state, state: SESSION_STATES.PRELOADING }));

  await assert.rejects(
    store.transition("session-test", initial.revision, (state) => state),
    RevisionConflictError
  );
});
