import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { PCMFrameParser, createLiveAudioRelay } from "./live-audio-server.mjs";

function packet(sequence = 0, frames = 960) {
  const data = Buffer.alloc(20 + frames * 2 * 4);
  data.write("HCA1"); data.writeUInt32LE(48000, 4); data.writeUInt32LE(2, 8);
  data.writeUInt32LE(frames, 12); data.writeUInt32LE(sequence, 16);
  for (let i = 20; i < data.length; i += 4) data.writeFloatLE(Math.sin(i / 100) * 0.2, i);
  return data;
}

function timedPacket({ sequence = 0, sourceFrame = 0, captureMasterMs = 100000, presentationDelayMs = 700, streamId = 7 } = {}) {
  const legacy = packet(sequence);
  const data = Buffer.alloc(48 + legacy.length - 20);
  legacy.copy(data, 0, 0, 20); data.write("HCA2"); data.writeUInt32LE(streamId, 20);
  data.writeBigUInt64LE(BigInt(sourceFrame), 24); data.writeDoubleLE(captureMasterMs, 32); data.writeDoubleLE(presentationDelayMs, 40);
  legacy.copy(data, 48, 20);
  return data;
}

test("PCM framing survives fragmented headers, split samples and coalesced frames", () => {
  const parser = new PCMFrameParser(), received = [];
  const data = Buffer.concat([packet(0), packet(1), packet(0xffffffff)]);
  for (let at = 0; at < data.length; at += 137) parser.push(data.subarray(at, at + 137), f => received.push(f));
  parser.finish();
  assert.deepEqual(received.map(f => f.sequence), [0, 1, 0xffffffff]);
  assert.deepEqual(received[1].data, packet(1));
  assert.equal(parser.buffer.length, 0);
});

test("non-finite audio and malformed or truncated frames are rejected", () => {
  const bad = packet(); bad.writeFloatLE(NaN, 28);
  assert.throws(() => new PCMFrameParser().push(bad, () => {}), /Non-finite/);
  const huge = packet(); huge.writeUInt32LE(0xffffffff, 12);
  assert.throws(() => new PCMFrameParser().push(huge, () => {}), /format/);
  const parser = new PCMFrameParser(); parser.push(packet().subarray(0, 23), () => {});
  assert.throws(() => parser.finish(), /Truncated/);
});

test("HCA2 timestamps and source frame identity survive byte fragmentation unchanged", () => {
  const parser = new PCMFrameParser(), frames = [];
  const data = timedPacket({ sourceFrame: 480000, captureMasterMs: 123456.125 });
  for (let at = 0; at < data.length; at += 13) parser.push(data.subarray(at, at + 13), f => frames.push(f));
  parser.finish();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].version, 2);
  assert.equal(frames[0].sourceFrame, 480000);
  assert.equal(frames[0].captureMasterMs, 123456.125);
  assert.equal(frames[0].presentationDelayMs, 700);
  assert.equal(frames[0].streamId, 7);
  assert.deepEqual(frames[0].data, data);
});

test("HCA2 rejects invalid presentation metadata before forwarding any audio", () => {
  for (const options of [{ captureMasterMs: NaN }, { presentationDelayMs: Infinity }, { presentationDelayMs: 1201 }, { sourceFrame: Number.MAX_SAFE_INTEGER }]) {
    assert.throws(() => new PCMFrameParser().push(timedPacket(options), () => assert.fail("must not forward")), /timing/);
  }
});

test("slow receivers are disconnected instead of growing an audio backlog", () => {
  const relay = createLiveAudioRelay({ getPort: () => 4173 });
  class SlowSocket extends EventEmitter {
    writableLength = 300000;
    destroyed = false;
    setNoDelay() {}
    write() { return false; }
    destroy() { this.destroyed = true; this.emit("close"); }
    end() { this.destroy(); }
  }
  const socket = new SlowSocket();
  relay.handleUpgrade({ url: "/live/audio", headers: { upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", host: "localhost:4173" } }, socket);
  assert.equal(socket.destroyed, true);
  assert.equal(relay.status().receivers, 0);
  relay.close();
});

test("live receiver rejects a rebinding Host and cross-origin upgrades before registering listeners", () => {
  const relay = createLiveAudioRelay({ getPort: () => 4173 });
  for (const [host, origin] of [["rebind.example:4173", "http://rebind.example:4173"], ["localhost:4173", "https://evil.example"], ["localhost:4174", "http://localhost:4174"]]) {
    const socket = { response: "", end(value) { this.response = value; } };
    assert.equal(relay.handleUpgrade({ url: "/live/audio", headers: { host, origin, upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } }, socket), true);
    assert.match(socket.response, /^HTTP\/1\.1 403/);
    assert.equal(relay.status().receivers, 0);
  }
  relay.close();
});

test("relay authenticates the local publisher, forwards PCM and releases a stopped source", async t => {
  let server;
  const relay = createLiveAudioRelay({ getPort: () => server.address().port });
  server = http.createServer((req, res) => {
    if (!relay.handleRequest(req, res, new URL(req.url, "http://localhost"))) { res.writeHead(404); res.end(); }
  });
  server.on("upgrade", (req, socket, head) => relay.handleUpgrade(req, socket, head));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { relay.close(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + "/live/publisher-config", { headers: { Origin: "https://other.example" } })).status, 403);
  assert.equal((await fetch(base + "/live/ingest", { method: "POST", body: packet() })).status, 403);
  const config = await (await fetch(base + "/live/publisher-config")).json();
  const receiver = new WebSocket(base.replace("http", "ws") + "/live/audio");
  receiver.binaryType = "arraybuffer";
  await once(receiver, "open");
  t.after(() => receiver.close());
  const gotAudio = new Promise(resolve => receiver.addEventListener("message", e => { if (e.data instanceof ArrayBuffer) resolve(Buffer.from(e.data)); }));
  const upload = http.request(config.ingestUrl, { method: "POST", headers: { "X-HomeCinema-Publisher": config.token, "Content-Type": "application/octet-stream" } });
  const completed = new Promise((resolve, reject) => { upload.on("response", response => { response.resume(); response.on("end", () => resolve(response.statusCode)); }); upload.on("error", reject); });
  upload.write(packet(3));
  assert.deepEqual(await gotAudio, packet(3));
  assert.equal(relay.status().active, true);
  assert.equal(relay.status().receivedFrames, 960);
  assert.equal(relay.status().receivers, 1);
  upload.end();
  assert.equal(await completed, 200);
  assert.equal(relay.status().active, false);
  assert.equal(relay.status().sourceConnected, false);
  receiver.close();
});

test("a fresh stream epoch invalidates old receiver timing and stale capture is inactive", async t => {
  let current = 1000, server;
  const relay = createLiveAudioRelay({ now: () => current, getPort: () => server.address().port });
  server = http.createServer((req, res) => relay.handleRequest(req, res, new URL(req.url, "http://localhost")));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { relay.close(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = await (await fetch(base + "/live/publisher-config")).json();
  const upload = http.request(config.ingestUrl, { method: "POST", headers: { "X-HomeCinema-Publisher": config.token } });
  upload.on("error", () => {}); upload.on("response", response => response.resume());
  upload.write(packet());
  // Observe the server consuming the write without a fixed sleep.
  while (!relay.status().receivedFrames) await new Promise(resolve => setImmediate(resolve));
  assert.equal(relay.status().sourceEpoch, 1);
  assert.equal(relay.status().active, true);
  current += 2001;
  assert.equal(relay.status().active, false);
  upload.end();
});

test("timed relay preserves deadlines and rejects overlapping frames within a source epoch", async t => {
  let server;
  const relay = createLiveAudioRelay({ getPort: () => server.address().port,
    getClock: () => ({ clockId: "master-test", serverTimeMs: 100100 }) });
  server = http.createServer((req, res) => relay.handleRequest(req, res, new URL(req.url, "http://localhost")));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { relay.close(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = await (await fetch(base + "/live/publisher-config")).json();
  assert.equal(config.clockId, "master-test"); assert.equal(config.serverTimeMs, 100100);
  const data = Buffer.concat([timedPacket(), timedPacket({ sequence: 1, sourceFrame: 960, captureMasterMs: 100020 })]);
  let response = await fetch(config.ingestUrl, { method: "POST", headers: { "X-HomeCinema-Publisher": config.token }, body: data });
  assert.equal(response.status, 200);
  assert.equal(relay.status().protocol, "HCA2");
  assert.equal(relay.status().presentationDelayMs, 700);
  assert.equal(relay.status().receivedFrames, 1920);
  response = await fetch(config.ingestUrl, { method: "POST", headers: { "X-HomeCinema-Publisher": config.token },
    body: Buffer.concat([timedPacket(), timedPacket({ sequence: 1, sourceFrame: 900, captureMasterMs: 100020 })]) });
  assert.equal(response.status, 400);
  assert.equal(relay.status().receivedFrames, 960);
});
