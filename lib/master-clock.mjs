import crypto from "node:crypto";
import { performance } from "node:perf_hooks";

// Epoch-shaped for easy diagnostics, but advances with this process's monotonic
// clock. A wall-clock correction must not move already scheduled audio.
export function createMasterClock({ now = () => performance.timeOrigin + performance.now(), clockId = crypto.randomUUID() } = {}) {
  function info() { return { clockId, serverTimeMs: now() }; }
  function reply(message) {
    if (!Number.isFinite(message?.clientSent) || message.clientSent < 0) return null;
    const serverReceivedMs = now();
    return { type: "liveTime", clientSent: message.clientSent, serverReceivedMs, serverSentMs: now(), clockId };
  }
  return { now, info, reply };
}
