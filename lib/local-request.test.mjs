import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { isLocalServerRequest } from "./local-request.mjs";

const port = 4173;
const interfaces = () => ({ en0: [{ address: "192.168.40.9", family: "IPv4" }, { address: "fd00::9", family: "IPv6" }] });
const request = (host, origin) => ({ headers: { host, ...(origin === undefined ? {} : { origin }) } });

test("local request guard allows loopback, current LAN IPs and matching HTTP origins", () => {
  for (const host of ["localhost:4173", "127.0.0.1:4173", "[::1]:4173", "192.168.40.9:4173", "[fd00::9]:4173"]) {
    assert.equal(isLocalServerRequest(request(host, `http://${host}`), port, { getInterfaces: interfaces }), true, host);
    assert.equal(isLocalServerRequest(request(host), port, { getInterfaces: interfaces }), true, host);
    assert.equal(isLocalServerRequest(request(host), port, { allowNoOrigin: false, getInterfaces: interfaces }), false, host);
  }
  assert.equal(isLocalServerRequest(request("LOCALHOST:4173", "http://localhost:4173"), port), true);
});

test("local request guard accepts the machine's actual LAN address without a fixture", () => {
  const address = Object.values(os.networkInterfaces()).flat().find(entry => entry?.family === "IPv4" && !entry.internal)?.address;
  if (!address) return;
  assert.equal(isLocalServerRequest(request(`${address}:4173`, `http://${address}:4173`), port), true);
});

test("matching malicious DNS origins cannot authorize a rebinding Host", () => {
  for (const host of ["rebind.example:4173", "192.168.40.10:4173", "localhost.evil.example:4173"]) {
    assert.equal(isLocalServerRequest(request(host, `http://${host}`), port, { getInterfaces: interfaces }), false, host);
  }
});

test("cross-origin, non-HTTP, missing and malformed authorities fail closed", () => {
  for (const host of [undefined, ["localhost:4173"], "localhost", "localhost:4174", "localhost:0", "localhost:65536", "localhost:4173/", "user@localhost:4173", "localhost:4173?x", "localhost:4173#x", " localhost:4173", "localhost:4173\r\n", "localhost:4173\n", "127.1:4173", "2130706433:4173", "[::1]oops:4173"]) {
    assert.equal(isLocalServerRequest(request(host), port), false, String(host));
  }
  for (const origin of ["http://evil.example:4173", "http://127.0.0.1:4173", "https://localhost:4173", "ws://localhost:4173", "http://localhost:4174", "http://localhost:4173/path", "http://localhost:4173?x", "http://localhost:4173\n", "null", "", ["http://localhost:4173"]]) {
    assert.equal(isLocalServerRequest(request("localhost:4173", origin), port), false, String(origin));
  }
  assert.equal(isLocalServerRequest({ headers: {} }, port), false);
  assert.equal(isLocalServerRequest(request("localhost:4173"), NaN), false);
  assert.equal(isLocalServerRequest(request("localhost:4173"), port, { getInterfaces: () => { throw new Error("unavailable"); } }), false);
});

test("default HTTP ports compare by their effective numeric port", () => {
  assert.equal(isLocalServerRequest(request("localhost", "http://localhost:80"), 80), true);
  assert.equal(isLocalServerRequest(request("localhost:80", "http://localhost"), 80), true);
});
