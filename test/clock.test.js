import assert from "node:assert/strict";
import test from "node:test";
import { captureProbeResponse, createServerClock } from "../backend/clock.js";

test("wall and monotonic clocks remain separate", () => {
  let wall = 5000;
  let monotonic = 200n;
  const clock = createServerClock({ wallNow: () => wall, monotonicNow: () => monotonic });

  assert.equal(clock.wallTimeMs(), 5000);
  assert.equal(clock.monotonicTimeNs(), 200n);

  wall -= 1000;
  monotonic += 25n;
  assert.equal(clock.wallTimeMs(), 4000);
  assert.equal(clock.monotonicTimeNs(), 225n);
});

test("clock probe reports wall timestamps and monotonic processing duration", () => {
  const wallValues = [1000, 1000.25];
  const monotonicValues = [100n, 350n];
  const clock = createServerClock({
    wallNow: () => wallValues.shift(),
    monotonicNow: () => monotonicValues.shift()
  });

  const response = captureProbeResponse(clock, {
    probe_id: "probe-1",
    client_send_monotonic_ms: 44
  });
  assert.equal(response.server_receive_wall_ms, 1000);
  assert.equal(response.server_send_wall_ms, 1000.25);
  assert.equal(response.server_processing_ns, 250);
});
