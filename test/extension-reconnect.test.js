import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { canonicalControllerServiceUrl } from "../extension/server-url.js";

async function loadOffscreenSource() {
  const source = await readFile(new URL("../extension/offscreen.js", import.meta.url), "utf8");
  return source.replace(/^import .*?;\n\n/, "");
}

test("capture reconnect keeps the tab stream alive until the user stops it", async () => {
  const source = await loadOffscreenSource();
  const sockets = [];
  const timers = new Map();
  let nextTimerId = 1;
  let runtimeListener = null;
  let trackStopCount = 0;
  const runtimeMessages = [];

  class FakeWebSocket {
    static OPEN = 1;

    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = new Map();
      this.sent = [];
      sockets.push(this);
    }

    addEventListener(type, listener) {
      this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
    }

    send(payload) {
      this.sent.push(JSON.parse(payload));
    }

    close() {
      this.readyState = 3;
      this.emit("close");
    }

    emit(type, event = {}) {
      for (const listener of this.listeners.get(type) || []) listener(event);
    }
  }

  const track = {
    addEventListener() {},
    stop() {
      trackStopCount += 1;
    }
  };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track]
  };
  const context = vm.createContext({
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) {
            runtimeListener = listener;
          }
        },
        sendMessage(message) {
          runtimeMessages.push(message);
        }
      }
    },
    navigator: {
      mediaDevices: {
        getUserMedia: async () => stream
      }
    },
    RTCPeerConnection: class {},
    WebSocket: FakeWebSocket,
    URL,
    canonicalControllerServiceUrl,
    console,
    clearInterval() {},
    clearTimeout(timerId) {
      timers.delete(timerId);
    },
    setInterval() {
      return 1;
    },
    setTimeout(callback, delay) {
      const timerId = nextTimerId++;
      timers.set(timerId, { callback, delay });
      return timerId;
    }
  });
  vm.runInContext(source, context, { filename: "extension/offscreen.js" });

  let startResponse = null;
  assert.equal(
    runtimeListener(
      {
        type: "begin-capture-in-offscreen",
        streamId: "stream-id",
        serverUrl: "http://192.168.26.1:4173",
        tabTitle: "Test tab",
        tabId: 42
      },
      null,
      (response) => {
        startResponse = response;
      }
    ),
    true
  );
  for (let attempt = 0; attempt < 5 && !startResponse; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(startResponse?.ok, true);
  assert.equal(sockets.length, 1);
  sockets[0].readyState = FakeWebSocket.OPEN;
  sockets[0].emit("open");
  assert.equal(sockets[0].sent.some((message) => message.type === "liveStart"), true);
  sockets[0].emit("message", {
    data: JSON.stringify({
      type: "hello",
      localConnection: true,
      localControllerUrl: "http://127.0.0.1:4173",
      state: { addresses: ["http://192.168.20.8:4173"] }
    })
  });
  assert.equal(runtimeMessages.at(-1)?.status?.serverUrl, "http://127.0.0.1:4173");

  sockets[0].readyState = 3;
  sockets[0].emit("close");
  assert.equal(trackStopCount, 0);
  const reconnectTimer = [...timers.values()].find(({ delay }) => delay === 500);
  assert.ok(reconnectTimer);
  reconnectTimer.callback();
  assert.equal(sockets.length, 2);
  assert.equal(sockets[1].url, "ws://127.0.0.1:4173/");
  assert.equal(trackStopCount, 0);

  runtimeListener({ type: "stop-capture-in-offscreen" }, null, () => {});
  assert.equal(trackStopCount, 1);
});

test("capture output stays muted through locking, then arms once at Controller volume", async () => {
  const source = await loadOffscreenSource();
  const sockets = [];
  const gainEvents = [];
  const sentMessages = [];
  let runtimeListener = null;

  class FakeParam {
    setValueAtTime(value, at) {
      gainEvents.push({ type: "set", value, at });
    }
    linearRampToValueAtTime(value, at) {
      gainEvents.push({ type: "ramp", value, at });
    }
    cancelScheduledValues() {}
  }

  class FakeNode {
    connect(target) {
      return target;
    }
  }

  class FakeAudioContext {
    constructor() {
      this.currentTime = 10;
      this.state = "running";
      this.baseLatency = 0;
      this.outputLatency = 0.04;
      this.sampleRate = 48_000;
      this.destination = new FakeNode();
    }
    createMediaStreamSource() {
      return new FakeNode();
    }
    createDelay() {
      const node = new FakeNode();
      node.delayTime = new FakeParam();
      return node;
    }
    createGain() {
      const node = new FakeNode();
      node.gain = new FakeParam();
      return node;
    }
    getOutputTimestamp() {
      return { contextTime: this.currentTime, performanceTime: 10_000 };
    }
    async resume() {}
    async close() {}
  }

  class FakeWebSocket {
    static OPEN = 1;
    constructor() {
      this.readyState = 0;
      this.listeners = new Map();
      sockets.push(this);
    }
    addEventListener(type, listener) {
      this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
    }
    send(payload) {
      sentMessages.push(JSON.parse(payload));
    }
    close() {}
    emit(type, event = {}) {
      for (const listener of this.listeners.get(type) || []) listener(event);
    }
  }

  const track = { addEventListener() {}, stop() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const context = vm.createContext({
    AudioContext: FakeAudioContext,
    window: { AudioContext: FakeAudioContext },
    chrome: {
      runtime: {
        onMessage: { addListener(listener) { runtimeListener = listener; } },
        sendMessage() {}
      }
    },
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    RTCPeerConnection: class {},
    WebSocket: FakeWebSocket,
    URL,
    canonicalControllerServiceUrl,
    console,
    clearInterval() {},
    clearTimeout() {},
    setInterval() { return 1; },
    setTimeout() { return 1; }
  });
  vm.runInContext(source, context, { filename: "extension/offscreen.js" });

  runtimeListener(
    {
      type: "begin-capture-in-offscreen",
      streamId: "stream-id",
      serverUrl: "http://127.0.0.1:4173",
      tabTitle: "Piano",
      tabId: 9
    },
    null,
    () => {}
  );
  await new Promise((resolve) => setImmediate(resolve));
  sockets[0].readyState = FakeWebSocket.OPEN;
  sockets[0].emit("open");

  const emitState = (type, live) => sockets[0].emit("message", {
    data: JSON.stringify({ type, state: { serverTime: 1000, live } })
  });
  emitState("liveStart", { id: "live-1", transport: "webrtc", phase: "measuring", bufferMs: 120 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gainEvents.some((event) => event.type === "ramp" && event.value === 1), false);
  const metricsMessage = sentMessages.find((message) => message.type === "captureMetrics");
  assert.equal(metricsMessage?.metrics?.sampleRate, 48_000);
  assert.equal(metricsMessage?.metrics?.totalOutputLatencyMs, 40);
  assert.ok(Math.abs(metricsMessage?.metrics?.estimatedTimelineErrorMs || 0) < 0.000001);

  emitState("liveLock", { id: "live-1", transport: "webrtc", phase: "locking", roomTargetMs: 155 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gainEvents.some((event) => event.type === "ramp" && event.value === 1), false);
  sockets[0].emit("message", {
    data: JSON.stringify({ type: "deviceCommand", action: "setVolume", value: 0.4 })
  });

  emitState("liveArm", {
    id: "live-1",
    transport: "webrtc",
    phase: "armed",
    roomTargetMs: 155,
    playAt: 2000
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gainEvents.filter((event) => event.type === "ramp" && event.value === 0.4).length, 1);
  assert.equal(gainEvents.some((event) => event.type === "ramp" && event.value === 1), false);
});
