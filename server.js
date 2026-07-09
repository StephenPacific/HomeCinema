import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const distDir = path.join(__dirname, "dist");
const mediaDir = path.join(__dirname, "media");
const layersDir = path.join(mediaDir, "layers");
const uploadPath = path.join(mediaDir, "current-audio");
const metaPath = path.join(mediaDir, "track.json");
const port = Number(process.env.PORT || 4173);
let leadMs = clamp(Number(process.env.SYNC_LEAD_MS || 3000), 550, 6000);

const clients = new Set();
let nextClientId = 1;

let state = {
  track: null,
  layers: [],
  playing: false,
  position: 0,
  startedAt: null,
  updatedAt: Date.now()
};

await fsp.mkdir(mediaDir, { recursive: true });
await fsp.mkdir(layersDir, { recursive: true });
await loadTrackMeta();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/config") {
      return sendJson(res, {
        port,
        addresses: getLanAddresses(port),
        serverTime: Date.now(),
        leadMs
      });
    }

    if (req.method === "GET" && url.pathname === "/state") {
      return sendJson(res, publicState());
    }

    if (req.method === "POST" && url.pathname === "/upload") {
      return handleUpload(req, res);
    }

    if (req.method === "POST" && url.pathname === "/clear") {
      return handleClear(res);
    }

    if (req.method === "GET" && url.pathname === "/audio") {
      return serveAudio(req, res);
    }

    if (req.method === "GET") {
      return serveStatic(url.pathname, res);
    }

    sendText(res, 405, "Method Not Allowed");
  } catch (error) {
    console.error(error);
    sendText(res, 500, "Internal Server Error");
  }
});

server.on("upgrade", (req, socket) => {
  if (req.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      ""
    ].join("\r\n")
  );

  const client = {
    id: nextClientId++,
    socket,
    remoteAddress: socket.remoteAddress,
    userAgent: req.headers["user-agent"] || "",
    buffer: Buffer.alloc(0),
    role: "speaker",
    layerId: null,
    zone: "front-left",
    ready: false,
    unlocked: false,
    latencyMs: null,
    deviceOffsetMs: 0,
    deviceKey: null,
    lastSeen: Date.now(),
    name: `Device ${nextClientId - 1}`
  };
  clients.add(client);

  socket.on("data", (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    readFrames(client);
  });
  socket.on("close", () => removeClient(client));
  socket.on("error", () => removeClient(client));

  send(client, {
    type: "hello",
    id: client.id,
    state: publicState(),
    peers: peerList()
  });
  broadcastPeers();
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Home Cinema LAN Sync`);
  console.log(`Local:   http://localhost:${port}`);
  console.log(`Lead:    ${leadMs}ms`);
  for (const address of getLanAddresses(port)) {
    console.log(`Network: ${address}`);
  }
});

setInterval(() => {
  broadcast({
    type: "sync",
    serverTime: Date.now(),
    state: publicState()
  });
}, 1000);

async function loadTrackMeta() {
  try {
    const meta = JSON.parse(await fsp.readFile(metaPath, "utf8"));
    if (Array.isArray(meta.layers)) {
      const layers = [];
      for (const layer of meta.layers) {
        try {
          await fsp.access(layerFilePath(layer.id));
          layers.push(layer);
        } catch {}
      }
      state.layers = layers;
      state.track = primaryTrack(layers);
    } else {
      await fsp.access(uploadPath);
      const legacy = {
        id: "main",
        name: meta.name || "Main",
        type: meta.type || "application/octet-stream",
        size: meta.size || 0,
        version: meta.version || Date.now()
      };
      await fsp.copyFile(uploadPath, layerFilePath(legacy.id)).catch(() => {});
      state.layers = [legacy];
      state.track = legacy;
      await persistTrackMeta();
    }
    state.updatedAt = Date.now();
  } catch {
    state.layers = [];
    state.track = null;
  }
}

async function handleUpload(req, res) {
  const type = req.headers["content-type"] || "application/octet-stream";
  const originalName = decodeURIComponent(req.headers["x-file-name"] || "audio");
  const safeName = originalName.replace(/[^\w .()[\]-]+/g, "_").slice(0, 120) || "audio";
  const layerId = `layer-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const sizeLimit = 250 * 1024 * 1024;
  let received = 0;

  const tempPath = path.join(mediaDir, `upload-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`);
  const write = fs.createWriteStream(tempPath);

  req.on("data", (chunk) => {
    received += chunk.length;
    if (received > sizeLimit) {
      req.destroy();
      write.destroy();
      fsp.rm(tempPath, { force: true }).catch(() => {});
    }
  });

  req.pipe(write);

  write.on("finish", async () => {
    await fsp.rename(tempPath, layerFilePath(layerId));
    const layer = {
      id: layerId,
      name: safeName,
      type,
      size: received,
      version: Date.now()
    };
    state.layers = [...state.layers, layer];
    state.track = primaryTrack(state.layers);
    state.playing = false;
    state.position = 0;
    state.startedAt = null;
    state.updatedAt = Date.now();
    await persistTrackMeta();
    sendJson(res, publicState());
    broadcast({ type: "track", state: publicState() });
  });

  write.on("error", (error) => {
    console.error(error);
    sendText(res, 500, "Upload failed");
  });
}

async function handleClear(res) {
  state.layers = [];
  state.track = null;
  state.playing = false;
  state.position = 0;
  state.startedAt = null;
  state.updatedAt = Date.now();
  await persistTrackMeta();
  sendJson(res, publicState());
  broadcast({ type: "track", state: publicState() });
}

function serveAudio(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const requestedId = url.searchParams.get("layer") || state.layers[0]?.id;
  const layer = state.layers.find((item) => item.id === requestedId);
  if (!layer) {
    sendText(res, 404, "No audio uploaded");
    return;
  }

  const filePath = layerFilePath(layer.id);
  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  const headers = {
    "Accept-Ranges": "bytes",
    "Content-Type": layer.type || "application/octet-stream",
    "Cache-Control": "no-store"
  };

  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) {
      sendText(res, 416, "Invalid range");
      return;
    }
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : stat.size - 1;
    if (start >= stat.size || end >= stat.size || start > end) {
      sendText(res, 416, "Range not satisfiable");
      return;
    }
    res.writeHead(206, {
      ...headers,
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    ...headers,
    "Content-Length": stat.size
  });
  fs.createReadStream(filePath).pipe(res);
}

function serveStatic(requestPath, res) {
  const pathname = requestPath === "/" ? "/index.html" : decodeURIComponent(requestPath);
  for (const root of [distDir, publicDir]) {
    const filePath = path.normalize(path.join(root, pathname));
    if (!filePath.startsWith(root)) {
      sendText(res, 403, "Forbidden");
      return;
    }
    try {
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) continue;
      res.writeHead(200, {
        "Content-Type": mimeType(filePath),
        "Cache-Control": "no-store"
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    } catch {}
  }

  sendText(res, 404, "Not Found");
}

function handleMessage(client, message) {
  if (message.type === "time") {
    send(client, {
      type: "time",
      clientSent: message.clientSent,
      serverTime: Date.now()
    });
    return;
  }

  if (message.type === "identify") {
    client.name = String(message.name || client.name).slice(0, 40);
    client.deviceKey = String(message.deviceKey || client.deviceKey || "").slice(0, 120) || null;
    client.role = message.role === "controller" ? "controller" : "speaker";
    client.layerId = message.layerId || client.layerId;
    client.zone = normalizeZone(message.zone || client.zone);
    client.ready = Boolean(message.ready);
    client.unlocked = Boolean(message.unlocked);
    client.latencyMs = finiteNumber(message.latencyMs, client.latencyMs);
    client.deviceOffsetMs = finiteNumber(message.deviceOffsetMs, client.deviceOffsetMs);
    client.lastSeen = Date.now();
    broadcastPeers();
    return;
  }

  if (message.type === "setLead") {
    leadMs = clamp(Number(message.leadMs || leadMs), 550, 6000);
    state.updatedAt = Date.now();
    broadcast({ type: "lead", state: publicState() });
    return;
  }

  if (message.type === "testTone") {
    const payload = {
      type: "testTone",
      targetId: Number(message.targetId || 0),
      toneAt: Date.now() + Math.max(450, Math.min(leadMs, 1200)),
      serverTime: Date.now()
    };
    if (payload.targetId) {
      const target = [...clients].find((item) => item.id === payload.targetId);
      if (target) send(target, payload);
    } else {
      broadcast(payload);
    }
    return;
  }

  if (message.type === "play") {
    if (!state.layers.length) return;
    const position = clamp(Number(message.position ?? currentPosition()), 0, trackDurationFallback());
    state.playing = true;
    state.position = position;
    state.startedAt = Date.now() + leadMs;
    state.updatedAt = Date.now();
    broadcast({ type: "play", state: publicState() });
    return;
  }

  if (message.type === "resync") {
    if (!state.layers.length || !state.playing) return;
    state.position = currentPosition();
    state.startedAt = Date.now() + leadMs;
    state.updatedAt = Date.now();
    broadcast({ type: "play", state: publicState() });
    return;
  }

  if (message.type === "pause") {
    state.position = currentPosition();
    state.playing = false;
    state.startedAt = null;
    state.updatedAt = Date.now();
    broadcast({ type: "pause", state: publicState() });
    return;
  }

  if (message.type === "stop") {
    state.position = 0;
    state.playing = false;
    state.startedAt = null;
    state.updatedAt = Date.now();
    broadcast({ type: "stop", state: publicState() });
    return;
  }

  if (message.type === "seek") {
    const position = Math.max(0, Number(message.position || 0));
    state.position = position;
    state.updatedAt = Date.now();
    if (state.playing) {
      state.startedAt = Date.now() + leadMs;
      broadcast({ type: "play", state: publicState() });
      return;
    }
    broadcast({ type: "seek", state: publicState() });
  }
}

function publicState() {
  const now = Date.now();
  return {
    ...state,
    track: primaryTrack(state.layers),
    serverTime: now,
    position: state.position,
    currentPosition: currentPosition(now),
    leadMs
  };
}

function currentPosition(now = Date.now()) {
  if (!state.playing || !state.startedAt) {
    return state.position;
  }
  const elapsed = Math.max(0, (now - state.startedAt) / 1000);
  return state.position + elapsed;
}

function trackDurationFallback() {
  return Number.MAX_SAFE_INTEGER;
}

function readFrames(client) {
  while (client.buffer.length >= 2) {
    const first = client.buffer[0];
    const second = client.buffer[1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (client.buffer.length < offset + 2) return;
      length = client.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (client.buffer.length < offset + 8) return;
      const high = client.buffer.readUInt32BE(offset);
      const low = client.buffer.readUInt32BE(offset + 4);
      length = high * 2 ** 32 + low;
      offset += 8;
    }

    const maskOffset = masked ? 4 : 0;
    const frameLength = offset + maskOffset + length;
    if (client.buffer.length < frameLength) return;

    let payload = client.buffer.subarray(offset + maskOffset, frameLength);
    if (masked) {
      const mask = client.buffer.subarray(offset, offset + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    }
    client.buffer = client.buffer.subarray(frameLength);

    if (opcode === 0x8) {
      client.socket.end();
      removeClient(client);
      return;
    }

    if (opcode !== 0x1) continue;

    try {
      handleMessage(client, JSON.parse(payload.toString("utf8")));
    } catch (error) {
      send(client, { type: "error", message: "Invalid message" });
    }
  }
}

function send(client, payload) {
  if (client.socket.destroyed) return;
  const data = Buffer.from(JSON.stringify(payload));
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x81, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  client.socket.write(Buffer.concat([header, data]));
}

function broadcast(payload) {
  for (const client of clients) send(client, payload);
}

function removeClient(client) {
  if (!clients.has(client)) return;
  clients.delete(client);
  broadcastPeers();
}

function broadcastPeers() {
  broadcast({
    type: "peers",
    peers: peerList()
  });
}

function peerList() {
  const latestByDevice = new Map();
  for (const client of clients) {
    const key = client.deviceKey || `socket-${client.id}`;
    const existing = latestByDevice.get(key);
    if (!existing || client.lastSeen >= existing.lastSeen) {
      latestByDevice.set(key, client);
    }
  }

  return [...latestByDevice.values()].map((client) => ({
    id: client.id,
    name: client.name,
    role: client.role,
    layerId: client.layerId,
    zone: client.zone,
    ready: client.ready,
    unlocked: client.unlocked,
    latencyMs: client.latencyMs,
    deviceOffsetMs: client.deviceOffsetMs,
    online: true
  }));
}

function primaryTrack(layers = state.layers) {
  if (!layers.length) return null;
  if (layers.length === 1) return layers[0];
  return {
    id: "mix",
    name: `${layers.length} stems`,
    type: "audio/multi-layer",
    size: layers.reduce((total, layer) => total + (layer.size || 0), 0),
    version: Math.max(...layers.map((layer) => layer.version || 0))
  };
}

async function persistTrackMeta() {
  await fsp.writeFile(
    metaPath,
    JSON.stringify(
      {
        layers: state.layers
      },
      null,
      2
    )
  );
}

function layerFilePath(id) {
  const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(layersDir, safeId);
}

function normalizeZone(zone) {
  const allowed = new Set(["front-left", "front-right", "center", "rear-left", "rear-right"]);
  return allowed.has(zone) ? zone : "front-left";
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sendJson(res, data) {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(text);
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp"
  }[extension] || "application/octet-stream";
}

function getLanAddresses(serverPort) {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(`http://${entry.address}:${serverPort}`);
      }
    }
  }
  return addresses;
}

function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}
