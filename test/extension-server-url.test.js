import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalControllerServiceUrl,
  controllerPageUrl,
  controllerProbeWebSocketUrl,
  normalizeServerUrl,
  resolveServerUrl,
  serverUrlFromHomeCinemaTab
} from "../extension/server-url.js";

test("extension opens an explicit Controller page", () => {
  assert.equal(
    controllerPageUrl("http://127.0.0.1:4173"),
    "http://127.0.0.1:4173/?mode=controller"
  );
});

test("a same-machine VMware service address migrates to loopback", () => {
  assert.equal(
    canonicalControllerServiceUrl("http://192.168.26.1:4173", {
      localConnection: true,
      localControllerUrl: "http://127.0.0.1:4173"
    }),
    "http://127.0.0.1:4173"
  );
  assert.equal(
    canonicalControllerServiceUrl("http://192.168.20.8:4173", {
      localConnection: false,
      localControllerUrl: "http://127.0.0.1:4173"
    }),
    "http://192.168.20.8:4173"
  );
  assert.equal(
    controllerProbeWebSocketUrl("http://192.168.26.1:4173"),
    "ws://192.168.26.1:4173/?probe=controller-address"
  );
});

test("extension server URL has no hard-coded loopback fallback", () => {
  assert.throws(() => normalizeServerUrl(""), /Enter the Home Cinema server address/);
  assert.equal(
    normalizeServerUrl("http://192.168.20.8:4173/controller?mode=room"),
    "http://192.168.20.8:4173"
  );
});

test("a configured Controller service is not replaced by the active Home Cinema tab", () => {
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
    "http://127.0.0.1:4173"
  );
});

test("an active Home Cinema tab configures an otherwise empty extension", () => {
  assert.equal(
    resolveServerUrl({
      savedUrl: "",
      captureStatus: { phase: "idle" },
      activeTab: { title: "Home Cinema LAN Sync", url: "http://192.168.20.37:4173/?mode=controller" }
    }),
    "http://192.168.20.37:4173"
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
