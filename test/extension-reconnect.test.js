import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("capture reconnect keeps the tab stream alive until the user stops it", async () => {
  const source = await readFile(new URL("../extension/offscreen.js", import.meta.url), "utf8");
  const sockets = [];
  const timers = new Map();
  let nextTimerId = 1;
  let runtimeListener = null;
  let trackStopCount = 0;

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
        sendMessage() {}
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
        serverUrl: "http://127.0.0.1:4173",
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

  sockets[0].readyState = 3;
  sockets[0].emit("close");
  assert.equal(trackStopCount, 0);
  const reconnectTimer = [...timers.values()].find(({ delay }) => delay === 500);
  assert.ok(reconnectTimer);
  reconnectTimer.callback();
  assert.equal(sockets.length, 2);
  assert.equal(trackStopCount, 0);

  runtimeListener({ type: "stop-capture-in-offscreen" }, null, () => {});
  assert.equal(trackStopCount, 1);
});

test("capture output stays muted through measuring and locking, then arms once", async () => {
  const source = await readFile(new URL("../extension/offscreen.js", import.meta.url), "utf8");
  const sockets = [];
  const gainEvents = [];
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
      this.outputLatency = 0;
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
    send() {}
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

  emitState("liveLock", { id: "live-1", transport: "webrtc", phase: "locking", roomTargetMs: 155 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gainEvents.some((event) => event.type === "ramp" && event.value === 1), false);

  emitState("liveArm", {
    id: "live-1",
    transport: "webrtc",
    phase: "armed",
    roomTargetMs: 155,
    playAt: 2000
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gainEvents.filter((event) => event.type === "ramp" && event.value === 1).length, 1);
});
