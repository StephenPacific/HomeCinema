import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeServerUrl,
  resolveServerUrl,
  serverUrlFromHomeCinemaTab
} from "../extension/server-url.js";

test("extension server URL has no hard-coded loopback fallback", () => {
  assert.throws(() => normalizeServerUrl(""), /Enter the Home Cinema server address/);
  assert.equal(
    normalizeServerUrl("http://192.168.20.8:4173/controller?mode=room"),
    "http://192.168.20.8:4173"
  );
});

test("active Home Cinema tab overrides a stale saved loopback address", () => {
  const activeTab = {
    title: "Home Cinema LAN Sync",
    url: "http://192.168.20.8:4173/?mode=player"
  };
  assert.equal(serverUrlFromHomeCinemaTab(activeTab), "http://192.168.20.8:4173");
  assert.equal(
    resolveServerUrl({
      savedUrl: "http://127.0.0.1:4173",
      captureStatus: { phase: "idle" },
      activeTab
    }),
    "http://192.168.20.8:4173"
  );
});

test("active capture address takes priority when no Controller tab is active", () => {
  assert.equal(
    resolveServerUrl({
      savedUrl: "http://127.0.0.1:4173",
      captureStatus: { phase: "capturing", serverUrl: "http://192.168.20.8:4173" },
      activeTab: { title: "Video", url: "https://example.com/watch" }
    }),
    "http://192.168.20.8:4173"
  );
});
