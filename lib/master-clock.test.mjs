import test from "node:test";
import assert from "node:assert/strict";
import { createMasterClock } from "./master-clock.mjs";

test("live time reply exposes receive/send times from the same master clock", () => {
  let value = 100000;
  const clock = createMasterClock({ now: () => value++, clockId: "clock-1" });
  assert.deepEqual(clock.reply({ clientSent: 42 }), {
    type: "liveTime", clientSent: 42, serverReceivedMs: 100000, serverSentMs: 100001, clockId: "clock-1"
  });
  assert.deepEqual(clock.info(), { clockId: "clock-1", serverTimeMs: 100002 });
});

test("malformed client times are ignored and independent master epochs have distinct identities", () => {
  const clock = createMasterClock();
  for (const clientSent of [NaN, Infinity, -1, "42", null, undefined]) assert.equal(clock.reply({ clientSent }), null);
  assert.notEqual(clock.info().clockId, createMasterClock().info().clockId);
});
