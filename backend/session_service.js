import { createMessageId } from "./clock.js";
import { createEnvelope, MESSAGE_TYPES } from "./domain/commands.js";
import { InvalidTransitionError, ProtocolViolationError, SessionNotFoundError } from "./domain/errors.js";
import { createSessionSnapshot, SESSION_STATES } from "./domain/session.js";

const ARMABLE_STATES = new Set([
  SESSION_STATES.READY,
  SESSION_STATES.PAUSED,
  SESSION_STATES.PLAYING,
  SESSION_STATES.STOPPED
]);

export class SessionService {
  constructor({ store, clock, serverIncarnationId }) {
    this.store = store;
    this.clock = clock;
    this.serverIncarnationId = serverIncarnationId;
    this.inFlightMessages = new Map();
  }

  async createSession(sessionId) {
    return this.store.create(
      createSessionSnapshot({
        sessionId,
        serverIncarnationId: this.serverIncarnationId
      })
    );
  }

  async getSession(sessionId) {
    const session = await this.store.get(sessionId);
    if (!session) throw new SessionNotFoundError(sessionId);
    return session;
  }

  async preload({ sessionId, messageId, manifestHash }) {
    return this.idempotent(sessionId, messageId, async () => {
      const current = await this.getSession(sessionId);
      const snapshot = await this.store.transition(sessionId, current.revision, (state) => ({
        ...state,
        state: SESSION_STATES.PRELOADING,
        manifest_hash: manifestHash,
        render_plan_hash: null,
        effective_at_server_ms: null
      }));
      return this.command(snapshot, MESSAGE_TYPES.ASSET_PRELOAD, messageId, {
        manifest_hash: manifestHash
      });
    });
  }

  async markReady({ sessionId, messageId, manifestHash }) {
    return this.idempotent(sessionId, messageId, async () => {
      const current = await this.getSession(sessionId);
      if (current.state !== SESSION_STATES.PRELOADING && current.state !== SESSION_STATES.READY) {
        throw new InvalidTransitionError(current.state, "mark assets ready");
      }
      if (current.manifest_hash !== manifestHash) {
        throw new ProtocolViolationError("MANIFEST_MISMATCH", "Ready manifest does not match session manifest", {
          expected: current.manifest_hash,
          received: manifestHash
        });
      }
      return this.store.transition(sessionId, current.revision, (state) => ({
        ...state,
        state: SESSION_STATES.READY
      }));
    });
  }

  async armPlayback({
    sessionId,
    messageId,
    manifestHash,
    renderPlanHash,
    effectiveAtServerMs,
    startPositionMs = 0,
    minimumBufferLeadMs = 500
  }) {
    return this.idempotent(sessionId, messageId, async () => {
      const current = await this.getSession(sessionId);
      if (!ARMABLE_STATES.has(current.state)) {
        throw new InvalidTransitionError(current.state, "arm playback");
      }
      if (current.manifest_hash !== manifestHash) {
        throw new ProtocolViolationError("MANIFEST_MISMATCH", "ARM manifest does not match the ready asset", {
          expected: current.manifest_hash,
          received: manifestHash
        });
      }

      const remainingLeadMs = effectiveAtServerMs - this.clock.wallTimeMs();
      if (remainingLeadMs < minimumBufferLeadMs) {
        throw new ProtocolViolationError("INSUFFICIENT_LEAD", "ARM deadline is too close", {
          remaining_lead_ms: remainingLeadMs,
          minimum_buffer_lead_ms: minimumBufferLeadMs
        });
      }

      const snapshot = await this.store.transition(sessionId, current.revision, (state) => ({
        ...state,
        epoch: state.epoch + 1,
        sequence: 1,
        state: SESSION_STATES.ARMED,
        manifest_hash: manifestHash,
        render_plan_hash: renderPlanHash,
        timeline_position_ms: Math.max(0, Math.round(startPositionMs)),
        effective_at_server_ms: effectiveAtServerMs
      }));

      return this.command(snapshot, MESSAGE_TYPES.PLAYBACK_ARM, messageId, {
        epoch: snapshot.epoch,
        effective_at_server_ms: snapshot.effective_at_server_ms,
        start_position_ms: snapshot.timeline_position_ms,
        manifest_hash: snapshot.manifest_hash,
        render_plan_hash: snapshot.render_plan_hash,
        minimum_buffer_lead_ms: minimumBufferLeadMs
      });
    });
  }

  async markPlaying({ sessionId, messageId, epoch }) {
    return this.idempotent(sessionId, messageId, async () => {
      const current = await this.getSession(sessionId);
      if (current.epoch !== epoch) {
        throw new ProtocolViolationError("STALE_EPOCH", "Playback status is for another epoch", {
          current_epoch: current.epoch,
          received_epoch: epoch
        });
      }
      if (current.state !== SESSION_STATES.ARMED && current.state !== SESSION_STATES.PLAYING) {
        throw new InvalidTransitionError(current.state, "mark playback playing");
      }
      return this.store.transition(sessionId, current.revision, (state) => ({
        ...state,
        sequence: state.sequence + 1,
        state: SESSION_STATES.PLAYING
      }));
    });
  }

  async stop({ sessionId, messageId, timelinePositionMs = 0 }) {
    return this.idempotent(sessionId, messageId, async () => {
      const current = await this.getSession(sessionId);
      const snapshot = await this.store.transition(sessionId, current.revision, (state) => ({
        ...state,
        epoch: state.epoch + 1,
        sequence: 1,
        state: SESSION_STATES.STOPPED,
        timeline_position_ms: Math.max(0, Math.round(timelinePositionMs)),
        effective_at_server_ms: null
      }));
      return this.command(snapshot, MESSAGE_TYPES.PLAYBACK_STOP, messageId, {
        timeline_position_ms: snapshot.timeline_position_ms
      });
    });
  }

  async snapshotEnvelope(sessionId) {
    const snapshot = await this.getSession(sessionId);
    return this.command(snapshot, MESSAGE_TYPES.SESSION_SNAPSHOT, createMessageId("snapshot"), snapshot);
  }

  command(snapshot, messageType, messageId, payload) {
    return Object.freeze({
      snapshot,
      envelope: createEnvelope({
        messageType,
        snapshot,
        messageId,
        sentAtServerMs: this.clock.wallTimeMs(),
        payload
      })
    });
  }

  async idempotent(sessionId, messageId, operation) {
    if (!messageId) throw new ProtocolViolationError("MESSAGE_ID_REQUIRED", "message_id is required");
    const existing = await this.store.getMessageResult(sessionId, messageId);
    if (existing) return existing;
    const key = `${sessionId}:${messageId}`;
    if (this.inFlightMessages.has(key)) return this.inFlightMessages.get(key);

    const pending = (async () => {
      try {
        const result = await operation();
        return this.store.rememberMessageResult(sessionId, messageId, result);
      } finally {
        this.inFlightMessages.delete(key);
      }
    })();
    this.inFlightMessages.set(key, pending);
    return pending;
  }
}
