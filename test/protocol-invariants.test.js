import assert from "node:assert/strict";
import test from "node:test";
import { EndpointMessageGuard, MESSAGE_TYPES, PROTOCOL_VERSION } from "../backend/domain/commands.js";
import { ProtocolViolationError } from "../backend/domain/errors.js";
import { readySession } from "../test_support/helpers.js";

function message(overrides = {}) {
  return {
    protocol_version: PROTOCOL_VERSION,
    message_type: "session.snapshot",
    session_id: "session-test",
    server_incarnation_id: "incarnation-a",
    epoch: 8,
    sequence: 1,
    message_id: "message-1",
    sent_at_server_ms: 1000,
    payload: {},
    ...overrides
  };
}

test("duplicate message id is idempotently rejected", () => {
  const guard = new EndpointMessageGuard();
  assert.equal(guard.accept(message()).accepted, true);
  assert.deepEqual(guard.accept(message()), {
    accepted: false,
    reason: "DUPLICATE_MESSAGE",
    idempotent: true
  });
});

test("stale epoch and out-of-order sequence cannot replace newer state", () => {
  const guard = new EndpointMessageGuard();
  assert.equal(guard.accept(message({ epoch: 8, sequence: 12 })).accepted, true);
  assert.equal(guard.accept(message({ epoch: 7, sequence: 99, message_id: "old-epoch" })).reason, "STALE_EPOCH");
  assert.equal(guard.accept(message({ epoch: 8, sequence: 11, message_id: "old-sequence" })).reason, "OUT_OF_ORDER_SEQUENCE");
});

test("server incarnation change forces a full reset before accepting messages", () => {
  const guard = new EndpointMessageGuard();
  assert.equal(guard.accept(message()).accepted, true);
  const changed = message({ server_incarnation_id: "incarnation-b", epoch: 1, message_id: "new-server" });
  assert.deepEqual(guard.accept(changed), {
    accepted: false,
    reason: "SERVER_INCARNATION_CHANGED",
    reset_required: true
  });
  assert.equal(guard.accept(changed).accepted, true);
});

test("same epoch cannot carry conflicting ARM plans", () => {
  const guard = new EndpointMessageGuard();
  const first = message({
    message_type: MESSAGE_TYPES.PLAYBACK_ARM,
    epoch: 9,
    sequence: 1,
    payload: {
      effective_at_server_ms: 5000,
      start_position_ms: 0,
      manifest_hash: "sha256:manifest",
      render_plan_hash: "sha256:render"
    }
  });
  assert.equal(guard.accept(first).accepted, true);
  const conflicting = {
    ...first,
    sequence: 2,
    message_id: "arm-conflict",
    payload: { ...first.payload, effective_at_server_ms: 6000 }
  };
  assert.equal(guard.accept(conflicting).reason, "CONFLICTING_ARM");
});

test("service executes a repeated message id only once", async () => {
  const { service } = await readySession();
  const command = {
    sessionId: "session-test",
    messageId: "arm-once",
    manifestHash: "sha256:manifest",
    renderPlanHash: "sha256:render",
    effectiveAtServerMs: 1_002_000,
    minimumBufferLeadMs: 500
  };
  const first = await service.armPlayback(command);
  const second = await service.armPlayback(command);
  assert.strictEqual(second, first);
  assert.equal(second.snapshot.epoch, 1);
});

test("concurrent delivery of one message id performs one transition", async () => {
  const { service } = await readySession();
  const command = {
    sessionId: "session-test",
    messageId: "arm-concurrent",
    manifestHash: "sha256:manifest",
    renderPlanHash: "sha256:render",
    effectiveAtServerMs: 1_002_000,
    minimumBufferLeadMs: 500
  };
  const [first, second] = await Promise.all([
    service.armPlayback(command),
    service.armPlayback(command)
  ]);
  assert.strictEqual(second, first);
  assert.equal((await service.getSession("session-test")).epoch, 1);
});

test("ARM rejects manifest mismatch and insufficient lead", async () => {
  const { service } = await readySession();
  await assert.rejects(
    service.armPlayback({
      sessionId: "session-test",
      messageId: "wrong-manifest",
      manifestHash: "sha256:other",
      renderPlanHash: "sha256:render",
      effectiveAtServerMs: 1_002_000,
      minimumBufferLeadMs: 500
    }),
    (error) => error instanceof ProtocolViolationError && error.code === "MANIFEST_MISMATCH"
  );

  await assert.rejects(
    service.armPlayback({
      sessionId: "session-test",
      messageId: "too-late",
      manifestHash: "sha256:manifest",
      renderPlanHash: "sha256:render",
      effectiveAtServerMs: 1_000_020,
      minimumBufferLeadMs: 500
    }),
    (error) => error instanceof ProtocolViolationError && error.code === "INSUFFICIENT_LEAD"
  );
});
