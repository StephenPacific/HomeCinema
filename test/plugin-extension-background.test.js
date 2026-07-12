import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createQrMatrix } from "../extension/qr.js";

test("plugin background creates a room and captures a tab without a local Controller URL", async () => {
  let runtimeListener = null;
  const offscreenMessages = [];
  const sessionValues = {};
  let offscreenExists = false;
  const previousChrome = globalThis.chrome;

  globalThis.chrome = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(listener) {
          runtimeListener = listener;
        }
      },
      getURL(path) {
        return `chrome-extension://plugin-prototype/${path}`;
      },
      async getContexts() {
        return offscreenExists ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : [];
      },
      sendMessage(message, callback) {
        offscreenMessages.push(message);
        callback({
          ok: true,
          status: message.type === "create-plugin-room-in-offscreen"
            ? { exists: true, roomId: "ABC123", speakerCount: 0 }
            : message.type === "get-plugin-room-status-in-offscreen"
              ? sessionValues.pluginRoomStatus
            : undefined
        });
      }
    },
    storage: {
      local: {
        async set() {},
        async get() {
          return {};
        }
      },
      session: {
        async set(value) {
          Object.assign(sessionValues, value);
        },
        async get(key) {
          return { [key]: sessionValues[key] };
        }
      }
    },
    tabCapture: {
      getMediaStreamId({ targetTabId }, callback) {
        callback(`stream-${targetTabId}`);
      }
    },
    offscreen: {
      async createDocument() {
        offscreenExists = true;
      }
    }
  };

  try {
    await import(`../extension/background.js?plugin-test=${Date.now()}`);
    assert.equal(typeof runtimeListener, "function");

    const created = await dispatch(runtimeListener, {
      type: "create-plugin-room",
      signalingOrigin: "https://signal.example",
      controllerName: "Windows Chrome"
    });
    assert.equal(created.ok, true);
    assert.equal(created.status.roomId, "ABC123");
    assert.deepEqual(offscreenMessages.at(-1), {
      type: "create-plugin-room-in-offscreen",
      signalingOrigin: "https://signal.example",
      controllerName: "Windows Chrome"
    });

    const started = await dispatch(runtimeListener, {
      type: "start-plugin-capture",
      tabId: 27,
      tabTitle: "Piano"
    });
    assert.equal(started.ok, true);
    assert.deepEqual(offscreenMessages.at(-1), {
      type: "begin-plugin-capture-in-offscreen",
      streamId: "stream-27",
      tabTitle: "Piano",
      tabId: 27
    });
    assert.equal("serverUrl" in offscreenMessages.at(-1), false);

    await dispatch(runtimeListener, {
      type: "plugin-room-status",
      status: { exists: true, roomId: "ABC123", speakerUrl: "https://signal.example/speaker" }
    });
    const stored = await dispatch(runtimeListener, { type: "get-plugin-room-status" });
    assert.equal(stored.status.roomId, "ABC123");
    assert.equal("controllerToken" in stored.status, false);

    offscreenExists = false;
    const cleared = await dispatch(runtimeListener, { type: "get-plugin-room-status" });
    assert.equal(cleared.status.exists, false);
    assert.equal(cleared.status.roomId, "");
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test("plugin extension package includes the plugin audio worker and optional service permission", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  const offscreen = await readFile(new URL("../extension/offscreen.html", import.meta.url), "utf8");
  assert.equal(manifest.version, "0.4.0");
  assert.deepEqual(manifest.optional_host_permissions, ["http://*/*", "https://*/*"]);
  assert.match(offscreen, /plugin-offscreen\.js/);
});

test("Speaker invitations fit the bundled offline QR encoder", () => {
  const matrix = createQrMatrix("https://signal.example/speaker?room=ABC123&invite=abcdefghijklmnopqrstuvwxyz");
  assert.equal(matrix.length, 37);
  assert.equal(matrix.every((row) => row.length === 37 && row.every((cell) => cell === 0 || cell === 1)), true);
});

function dispatch(listener, message) {
  return new Promise((resolve) => {
    const asynchronous = listener(message, null, resolve);
    if (asynchronous !== true) resolve(undefined);
  });
}
