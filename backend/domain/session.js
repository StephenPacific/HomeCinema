export const SESSION_STATES = Object.freeze({
  IDLE: "IDLE",
  PRELOADING: "PRELOADING",
  READY: "READY",
  ARMED: "ARMED",
  PLAYING: "PLAYING",
  PAUSED: "PAUSED",
  STOPPED: "STOPPED",
  DEGRADED: "DEGRADED"
});

export function createSessionSnapshot({ sessionId, serverIncarnationId }) {
  return freezeSnapshot({
    session_id: sessionId,
    server_incarnation_id: serverIncarnationId,
    epoch: 0,
    sequence: 0,
    state: SESSION_STATES.IDLE,
    manifest_hash: null,
    render_plan_hash: null,
    timeline_position_ms: 0,
    effective_at_server_ms: null,
    revision: 0
  });
}

export function freezeSnapshot(snapshot) {
  return Object.freeze({ ...snapshot });
}

export function isSessionState(value) {
  return Object.values(SESSION_STATES).includes(value);
}
