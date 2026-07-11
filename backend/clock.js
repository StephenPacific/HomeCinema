import crypto from "node:crypto";

export function createServerClock({
  wallNow = () => Date.now(),
  monotonicNow = () => process.hrtime.bigint()
} = {}) {
  return Object.freeze({
    wallTimeMs() {
      return Number(wallNow());
    },
    monotonicTimeNs() {
      return BigInt(monotonicNow());
    }
  });
}

export function createServerIncarnationId() {
  return `incarnation-${crypto.randomUUID()}`;
}

export function createMessageId(prefix = "message") {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function captureProbeResponse(clock, { probe_id, client_send_monotonic_ms }) {
  const server_receive_wall_ms = clock.wallTimeMs();
  const server_receive_monotonic_ns = clock.monotonicTimeNs();
  const server_send_wall_ms = clock.wallTimeMs();
  const server_send_monotonic_ns = clock.monotonicTimeNs();

  return {
    probe_id,
    client_send_monotonic_ms,
    server_receive_wall_ms,
    server_send_wall_ms,
    server_processing_ns: Number(server_send_monotonic_ns - server_receive_monotonic_ns)
  };
}
