import { ProtocolViolationError } from "./errors.js";

export const PROTOCOL_VERSION = "1.0";

export const MESSAGE_TYPES = Object.freeze({
  ENDPOINT_HELLO: "endpoint.hello",
  ENDPOINT_HEARTBEAT: "endpoint.heartbeat",
  CLOCK_PROBE: "clock.probe",
  CLOCK_PROBE_RESPONSE: "clock.probe_response",
  SESSION_SNAPSHOT: "session.snapshot",
  ASSET_PRELOAD: "asset.preload",
  ASSET_READY: "asset.ready",
  PLAYBACK_ARM: "playback.arm",
  PLAYBACK_CANCEL: "playback.cancel",
  PLAYBACK_STOP: "playback.stop",
  PLAYBACK_STATUS: "playback.status",
  TELEMETRY_REPORT: "telemetry.report"
});

export function createEnvelope({
  messageType,
  snapshot,
  messageId,
  sentAtServerMs,
  payload,
  sequence = snapshot.sequence
}) {
  return Object.freeze({
    protocol_version: PROTOCOL_VERSION,
    message_type: messageType,
    session_id: snapshot.session_id,
    server_incarnation_id: snapshot.server_incarnation_id,
    epoch: snapshot.epoch,
    sequence,
    message_id: messageId,
    sent_at_server_ms: sentAtServerMs,
    payload: Object.freeze({ ...payload })
  });
}

export function assertEnvelopeIdentity(envelope, snapshot) {
  if (envelope.protocol_version !== PROTOCOL_VERSION) {
    throw new ProtocolViolationError("PROTOCOL_VERSION_MISMATCH", "Unsupported protocol version");
  }
  if (envelope.server_incarnation_id !== snapshot.server_incarnation_id) {
    throw new ProtocolViolationError("SERVER_INCARNATION_MISMATCH", "Server incarnation changed", {
      expected: snapshot.server_incarnation_id,
      received: envelope.server_incarnation_id
    });
  }
  if (envelope.session_id !== snapshot.session_id) {
    throw new ProtocolViolationError("SESSION_MISMATCH", "Message belongs to another session");
  }
  if (envelope.epoch < snapshot.epoch) {
    throw new ProtocolViolationError("STALE_EPOCH", "Message epoch is stale", {
      current_epoch: snapshot.epoch,
      received_epoch: envelope.epoch
    });
  }
}

export function armFingerprint(envelope) {
  const payload = envelope.payload || {};
  return JSON.stringify({
    epoch: envelope.epoch,
    effective_at_server_ms: payload.effective_at_server_ms,
    start_position_ms: payload.start_position_ms,
    manifest_hash: payload.manifest_hash,
    render_plan_hash: payload.render_plan_hash
  });
}

export class EndpointMessageGuard {
  constructor() {
    this.incarnationId = null;
    this.sessionId = null;
    this.epoch = -1;
    this.sequence = -1;
    this.messageIds = new Set();
    this.armByEpoch = new Map();
  }

  accept(envelope) {
    if (this.incarnationId && envelope.server_incarnation_id !== this.incarnationId) {
      this.reset();
      return { accepted: false, reason: "SERVER_INCARNATION_CHANGED", reset_required: true };
    }

    if (this.sessionId && envelope.session_id !== this.sessionId) {
      return { accepted: false, reason: "SESSION_MISMATCH" };
    }

    if (this.messageIds.has(envelope.message_id)) {
      return { accepted: false, reason: "DUPLICATE_MESSAGE", idempotent: true };
    }

    if (envelope.epoch < this.epoch) {
      return { accepted: false, reason: "STALE_EPOCH" };
    }

    if (envelope.epoch === this.epoch && envelope.sequence <= this.sequence) {
      return { accepted: false, reason: "OUT_OF_ORDER_SEQUENCE" };
    }

    if (envelope.message_type === MESSAGE_TYPES.PLAYBACK_ARM) {
      const fingerprint = armFingerprint(envelope);
      const existing = this.armByEpoch.get(envelope.epoch);
      if (existing && existing !== fingerprint) {
        return { accepted: false, reason: "CONFLICTING_ARM", protocol_violation: true };
      }
      this.armByEpoch.set(envelope.epoch, fingerprint);
    }

    this.incarnationId = envelope.server_incarnation_id;
    this.sessionId = envelope.session_id;
    this.epoch = envelope.epoch;
    this.sequence = envelope.sequence;
    this.messageIds.add(envelope.message_id);
    return { accepted: true };
  }

  reset() {
    this.incarnationId = null;
    this.sessionId = null;
    this.epoch = -1;
    this.sequence = -1;
    this.messageIds.clear();
    this.armByEpoch.clear();
  }
}
