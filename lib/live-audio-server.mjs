import crypto from "node:crypto";
import { isLocalServerRequest } from "./local-request.mjs";

const HEADER_BYTES = 20;
const TIMED_HEADER_BYTES = 48;
const MAX_FRAMES = 16384;
const MAX_PACKET_BYTES = TIMED_HEADER_BYTES + MAX_FRAMES * 2 * 4;
const MAX_RECEIVER_BACKLOG = 256 * 1024;

export class PCMFrameParser {
  buffer = Buffer.alloc(0);
  push(chunk, onFrame) {
    // HTTP chunks can contain several packets; consume bounded pieces so a
    // malformed publisher cannot accumulate an unbounded partial frame.
    for (let offset = 0; offset < chunk.length; offset += MAX_PACKET_BYTES) {
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, offset + MAX_PACKET_BYTES)]);
      while (this.buffer.length >= HEADER_BYTES) {
        const magic = this.buffer.readUInt32LE(0);
        if (magic !== 0x31414348 && magic !== 0x32414348) throw new Error("Invalid PCM frame signature");
        const version = magic === 0x32414348 ? 2 : 1;
        const headerBytes = version === 2 ? TIMED_HEADER_BYTES : HEADER_BYTES;
        if (this.buffer.length < headerBytes) break;
        const sampleRate = this.buffer.readUInt32LE(4);
        const channels = this.buffer.readUInt32LE(8);
        const frames = this.buffer.readUInt32LE(12);
        const sequence = this.buffer.readUInt32LE(16);
        if (sampleRate < 8000 || sampleRate > 192000 || ![1, 2].includes(channels) || frames < 1 || frames > MAX_FRAMES) {
          throw new Error("Invalid PCM frame format");
        }
        let timing = {};
        if (version === 2) {
          const sourceFrame64 = this.buffer.readBigUInt64LE(24);
          const captureMasterMs = this.buffer.readDoubleLE(32);
          const presentationDelayMs = this.buffer.readDoubleLE(40);
          if (sourceFrame64 > BigInt(Number.MAX_SAFE_INTEGER - frames) || !Number.isFinite(captureMasterMs) || captureMasterMs < 0
              || !Number.isFinite(presentationDelayMs) || presentationDelayMs < 100 || presentationDelayMs > 1200) {
            throw new Error("Invalid PCM presentation timing");
          }
          timing = { streamId: this.buffer.readUInt32LE(20), sourceFrame: Number(sourceFrame64), captureMasterMs, presentationDelayMs };
        }
        const size = headerBytes + frames * channels * 4;
        if (this.buffer.length < size) break;
        const data = this.buffer.subarray(0, size);
        for (let i = headerBytes; i < size; i += 4) {
          if (!Number.isFinite(data.readFloatLE(i))) throw new Error("Non-finite PCM sample");
        }
        this.buffer = this.buffer.subarray(size);
        onFrame({ data, sampleRate, channels, frames, sequence, version, ...timing });
      }
      if (this.buffer.length > MAX_PACKET_BYTES) throw new Error("PCM partial frame exceeded limit");
    }
  }
  finish() {
    if (this.buffer.length) throw new Error("Truncated PCM frame");
  }
}

export function websocketFrame(payload, opcode = 2) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (data.length < 126) header = Buffer.from([0x80 | opcode, data.length]);
  else if (data.length < 65536) {
    header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data]);
}

export function isLoopback(address = "") {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
}

export function createLiveAudioRelay({ getPort, broadcastControl = () => {}, now = Date.now, getClock } = {}) {
  const token = crypto.randomBytes(32).toString("hex");
  const receivers = new Set();
  let publisher = null;
  let sourceEpoch = 0;
  let sampleRate = null, channels = null, lastPacketAt = null, receivedFrames = 0;
  let protocol = null, streamId = null, captureMasterMs = null, presentationDelayMs = null;
  let lastFrameEnd = null;
  let reason = "System audio is off";
  let closed = false;

  function status() {
    const active = Boolean(publisher && lastPacketAt !== null && now() - lastPacketAt < 2000);
    return { active, sourceConnected: Boolean(publisher), sourceEpoch, sampleRate, channels, receivedFrames,
      receivers: receivers.size, lastPacketAt, protocol, streamId, captureMasterMs, presentationDelayMs,
      ...(getClock ? { clockId: getClock().clockId } : {}), reason: active ? "Streaming system audio" : reason };
  }
  function write(receiver, packet) {
    if (receiver.destroyed || receiver.writableLength > MAX_RECEIVER_BACKLOG) {
      receivers.delete(receiver); receiver.destroy(); return;
    }
    receiver.write(packet);
  }
  function announce() {
    const live = status();
    const packet = websocketFrame(JSON.stringify({ type: "liveStatus", ...live }), 1);
    for (const receiver of receivers) write(receiver, packet);
    broadcastControl({ type: "live", live });
  }
  function json(res, code, data) {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  }
  function localPublisherRequest(req) {
    // Host validation also prevents a DNS-rebinding origin obtaining the token.
    const host = (req.headers.host || "").toLowerCase();
    return isLoopback(req.socket.remoteAddress) && [
      `127.0.0.1:${getPort()}`, `localhost:${getPort()}`, `[::1]:${getPort()}`
    ].includes(host) && !req.headers.origin;
  }
  function handleRequest(req, res, url) {
    if (req.method === "GET" && url.pathname === "/live/status") { json(res, 200, status()); return true; }
    if (req.method === "GET" && url.pathname === "/live/publisher-config") {
      if (!localPublisherRequest(req)) json(res, 403, { error: "Publisher configuration is local only" });
      else json(res, 200, { token, ingestUrl: `http://127.0.0.1:${getPort()}/live/ingest`, ...(getClock ? getClock() : {}) });
      return true;
    }
    if (url.pathname !== "/live/ingest") return false;
    if (req.method !== "POST") { json(res, 405, { error: "Use POST" }); return true; }
    const supplied = req.headers["x-homecinema-publisher"];
    if (!localPublisherRequest(req) || typeof supplied !== "string" || supplied.length !== token.length ||
        !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
      json(res, 403, { error: "Unauthorized local publisher" }); return true;
    }
    if (publisher) { json(res, 409, { error: "A system audio publisher is already active" }); return true; }
    publisher = req; sourceEpoch += 1; sampleRate = null; channels = null; lastPacketAt = null; receivedFrames = 0;
    protocol = null; streamId = null; captureMasterMs = null; presentationDelayMs = null; lastFrameEnd = null;
    reason = "Waiting for system audio";
    const parser = new PCMFrameParser();
    announce();
    let finished = false;
    function finish(message, code = 200) {
      if (finished) return;
      finished = true;
      if (publisher === req) { publisher = null; reason = message; announce(); }
      if (!res.destroyed && !res.writableEnded) json(res, code, { receivedFrames, reason: message });
    }
    req.on("data", chunk => {
      if (finished) return;
      try {
        parser.push(chunk, frame => {
          if (finished) return;
          if (sampleRate !== null && (sampleRate !== frame.sampleRate || channels !== frame.channels)) {
            throw new Error("PCM format changed without a new stream");
          }
          const nextProtocol = frame.version === 2 ? "HCA2" : "HCA1";
          if (protocol !== null && protocol !== nextProtocol) throw new Error("PCM protocol changed without a new publisher");
          if (frame.version === 2) {
            if (frame.streamId === streamId && lastFrameEnd !== null &&
                (frame.sourceFrame < lastFrameEnd || frame.captureMasterMs < captureMasterMs)) {
              throw new Error("PCM presentation timeline moved backwards");
            }
            streamId = frame.streamId; captureMasterMs = frame.captureMasterMs;
            presentationDelayMs = frame.presentationDelayMs; lastFrameEnd = frame.sourceFrame + frame.frames;
          }
          protocol = nextProtocol;
          sampleRate = frame.sampleRate; channels = frame.channels; lastPacketAt = now(); receivedFrames += frame.frames;
          const packet = websocketFrame(frame.data);
          for (const receiver of receivers) write(receiver, packet);
        });
      } catch (error) { finish(error.message, 400); req.resume(); }
    });
    req.on("end", () => { try { parser.finish(); finish("System audio stopped"); } catch (error) { finish(error.message, 400); } });
    req.on("aborted", () => finish("System audio disconnected"));
    req.on("error", () => finish("System audio connection failed"));
    res.on("close", () => { if (!finished) { finish("System audio disconnected"); req.destroy(); } });
    return true;
  }
  function handleUpgrade(req, socket, head = Buffer.alloc(0)) {
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch { return false; }
    if (url.pathname !== "/live/audio") return false;
    if (!isLocalServerRequest(req, getPort()) || req.headers.upgrade?.toLowerCase() !== "websocket" || !req.headers["sec-websocket-key"]) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return true;
    }
    const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    receivers.add(socket);
    const remove = () => { if (receivers.delete(socket) && !closed) announce(); };
    socket.on("close", remove); socket.on("error", remove);
    // Receivers send no application data. Process only bounded close/ping
    // frames so an ordinary websocket close releases the connection promptly.
    let input = Buffer.alloc(0);
    socket.on("data", chunk => {
      input = Buffer.concat([input, chunk]);
      if (input.length > 1024) { socket.destroy(); return; }
      while (input.length >= 2) {
        const opcode = input[0] & 15, masked = Boolean(input[1] & 128), length = input[1] & 127;
        if (length > 125) { socket.destroy(); return; }
        const header = masked ? 6 : 2;
        if (input.length < header + length) return;
        let data = input.subarray(header, header + length);
        if (masked) data = Buffer.from(data.map((v, i) => v ^ input[2 + i % 4]));
        input = input.subarray(header + length);
        if (opcode === 8) { socket.end(websocketFrame(data, 8)); return; }
        if (opcode === 9) socket.write(websocketFrame(data, 10));
      }
    });
    if (head.length) socket.emit("data", head);
    announce();
    return true;
  }
  const heartbeat = setInterval(() => {
    if (publisher && lastPacketAt !== null && now() - lastPacketAt >= 2000) reason = "Waiting for system audio";
    if (publisher || receivers.size) announce();
  }, 1000);
  heartbeat.unref();
  function close() { closed = true; clearInterval(heartbeat); publisher?.destroy(); for (const socket of receivers) socket.destroy(); receivers.clear(); }
  function stopPublisher() {
    const current = publisher;
    publisher = null;
    reason = "System audio stopped";
    current?.destroy();
    announce();
  }
  return { status, handleRequest, handleUpgrade, stopPublisher, close };
}
