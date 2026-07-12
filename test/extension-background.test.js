import assert from "node:assert/strict";
import test from "node:test";

test("background start capture normalizes the service URL", async () => {
  let runtimeListener = null;
  let offscreenMessage = null;
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
        return `chrome-extension://home-cinema/${path}`;
      },
      async getContexts() {
        return [];
      },
      sendMessage(message, callback) {
        offscreenMessage = message;
        callback({ ok: true });
      }
    },
    storage: {
      local: {
        async set() {}
      }
    },
    tabCapture: {
      getMediaStreamId(_options, callback) {
        callback("stream-id");
      }
    },
    offscreen: {
      async createDocument() {}
    }
  };

  try {
    await import(`../extension/background.js?test=${Date.now()}`);
    assert.equal(typeof runtimeListener, "function");

    const response = await new Promise((resolve) => {
      const asynchronous = runtimeListener(
        {
          type: "start-capture",
          tabId: 42,
          serverUrl: "http://192.168.20.8:4173/controller?mode=room",
          tabTitle: "Piano"
        },
        null,
        resolve
      );
      assert.equal(asynchronous, true);
    });

    assert.deepEqual(response, { ok: true });
    assert.equal(offscreenMessage.serverUrl, "http://192.168.20.8:4173");
    assert.equal(offscreenMessage.streamId, "stream-id");
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});
