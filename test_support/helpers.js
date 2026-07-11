import { createServerClock } from "../backend/clock.js";
import { InMemorySessionStore } from "../backend/session_store.js";
import { SessionService } from "../backend/session_service.js";

export function createTestService({ wallTimeMs = 1_000_000, incarnation = "incarnation-test" } = {}) {
  let wall = wallTimeMs;
  let monotonic = 0n;
  const clock = createServerClock({
    wallNow: () => wall,
    monotonicNow: () => monotonic
  });
  const store = new InMemorySessionStore();
  const service = new SessionService({ store, clock, serverIncarnationId: incarnation });
  return {
    clock,
    store,
    service,
    setWall(value) {
      wall = value;
    },
    advanceMonotonic(value) {
      monotonic += BigInt(value);
    }
  };
}

export async function readySession(options = {}) {
  const context = createTestService(options);
  await context.service.createSession("session-test");
  await context.service.preload({
    sessionId: "session-test",
    messageId: "preload-1",
    manifestHash: "sha256:manifest"
  });
  await context.service.markReady({
    sessionId: "session-test",
    messageId: "ready-1",
    manifestHash: "sha256:manifest"
  });
  return context;
}
