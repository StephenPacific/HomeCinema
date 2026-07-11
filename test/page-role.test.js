import assert from "node:assert/strict";
import test from "node:test";
import { resolvePageRole } from "../src/pageRole.js";

test("an explicit Controller URL owns the controls on any computer", () => {
  assert.equal(resolvePageRole({ search: "?mode=controller", hostname: "192.168.20.15" }), "controller");
});

test("a remote room URL defaults to Speaker and ignores old browser role state", () => {
  assert.equal(resolvePageRole({ hostname: "192.168.20.15" }), "speaker");
  assert.equal(resolvePageRole({ search: "?mode=player", hostname: "127.0.0.1" }), "speaker");
});

test("the service host loopback URL remains a convenient local Controller fallback", () => {
  assert.equal(resolvePageRole({ hostname: "127.0.0.1" }), "controller");
  assert.equal(resolvePageRole({ hostname: "localhost" }), "controller");
});
