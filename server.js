import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendRoomTimingSample,
  automaticReconnectPlan,
  fixedRoomTargetMs,
  latestEligibleRoomSpeakers,
  ROOM_SYNC_ENGINE_VERSION,
  ROOM_SYNC_POLICY,
  roomLockTimeoutAction,
  roomTimingCohort,
  runtimeRoomRelockPlan,
  roomTimingSample,
  stableRoomTiming,
  supportsRoomSyncVersion
} from "./src/roomSync.js";
import { isLocalClientAddress, lanAddressCandidates } from "./src/networkAddresses.js";
import { sanitizeControllerAudioMetrics } from "./src/controllerMetrics.js";
import {
  classifyDeviceHealth,
  roomHealthContext,
  summarizeRoomHealth
} from "./src/deviceHealth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const distDir = path.join(__dirname, "dist");
const mediaDir = path.join(__dirname, "media");
const layersDir = path.join(mediaDir, "layers");
const uploadPath = path.join(mediaDir, "current-audio");
const metaPath = path.join(mediaDir, "track.json");
const port = Number(process.env.PORT || 4173);
let leadMs = clamp(Number(process.env.SYNC_LEAD_MS || 3000), 550, 6000);
const liveStartLeadMs = clamp(Number(process.env.LIVE_START_LEAD_MS || 1800), 1200, 5000);
const webRtcBufferMs = clamp(Number(process.env.WEBRTC_BUFFER_MS || 120), 60, 1000);

const clients = new Set();
const speakerVolumes = new Map();
const deviceRecoveryStates = new Map();
const deviceIncidents = [];
let nextClientId = 1;
let nextIncidentId = 1;
let roomDiagnostic = { state: "healthy", label: "Room ready", reason: "HEALTHY" };

let state = {
  track: null,
  layers: [],
  live: null,
  playing: false,
  roomVolume: 1,
  position: 0,
  startedAt: null,
  updatedAt: Date.now()
};
let liveOwnerClientId = null;
let liveBootstrapChunk = null;
let livePreflight = null;
let livePhaseTimer = null;
let runtimeRelockState = { violationCount: 0, lastRelockAt: 0 };

await fsp.mkdir(mediaDir, { recursive: true });
await fsp.mkdir(layersDir, { recursive: true });
await loadTrackMeta();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/config") {
      const networkAddresses = getLanAddressCandidates(port);
      return sendJson(res, {
        port,
        addresses: networkAddresses.map((candidate) => candidate.url),
        networkAddresses,
        serverTime: Date.now(),
        leadMs,
        liveStartLeadMs,
        webRtcBufferMs
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

  const requestUrl = new URL(req.url || "/", "http://localhost");
  const networkInterfaces = os.networkInterfaces();
  const client = {
    id: nextClientId++,
    socket,
    remoteAddress: socket.remoteAddress,
    hidden: requestUrl.searchParams.get("probe") === "controller-address",
    userAgent: req.headers["user-agent"] || "",
    buffer: Buffer.alloc(0),
    role: "speaker",
    layerId: null,
    zone: "front-left",
    ready: false,
    unlocked: false,
    muted: false,
    volume: state.roomVolume,
    volumeAnnounced: false,
    health: "connecting",
    status: "Connecting",
    syncErrorMs: null,
    rawSyncErrorMs: null,
    playoutDelayMs: null,
    postDelayMs: 0,
    fixedTargetMs: null,
    latencyMs: null,
    outputLatencyMs: 0,
    outputLatencyDeltaMs: 0,
    deviceOffsetMs: 0,
    audioContextState: "none",
    audioSessionType: "unavailable",
    audioSessionState: "unavailable",
    outputPath: "none",
    controllerAudioMetrics: null,
    lastControllerMetricsLogAt: 0,
    livePaused: true,
    liveMuted: false,
    liveReadyState: 0,
    rtcBytesReceived: 0,
    rtcEmittedCount: 0,
    rtcAudioLevel: null,
    rtcJitterMs: null,
    rtcPacketsReceived: 0,
    rtcPacketsLost: 0,
    rtcConcealedSamples: 0,
    rtcTotalSamplesReceived: 0,
    rtcPacketLossRate: null,
    rtcConcealmentRate: null,
    rtcRtpStallMs: 0,
    rtcConnectionState: "idle",
    fastFuseReason: "",
    controllerOutputLatencyDeltaMs: 0,
    diagnostic: null,
    diagnosticKey: "",
    autoReconnectRequested: false,
    hasIdentified: false,
    timingSamples: [],
    timingStable: false,
    timingSpreadMs: null,
    timingLiveId: null,
    timelineState: "idle",
    syncEngineVersion: 0,
    deviceKey: null,
    liveId: null,
    liveBootstrapId: null,
    webRtcAnnouncedLiveId: null,
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
    localConnection: isLocalClientAddress(client.remoteAddress, networkInterfaces),
    localControllerUrl: `http://127.0.0.1:${port}`,
    state: publicState(),
    peers: peerList(),
    roomDiagnostic,
    incidents: recentIncidents()
  });
  broadcastPeers();
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Home Cinema LAN Sync`);
  console.log(`Local:   http://localhost:${port}`);
  console.log(`Lead:    ${leadMs}ms`);
  for (const candidate of getLanAddressCandidates(port)) {
    const label = candidate.recommended ? "Network (recommended)" : "Network (alternate)";
    console.log(`${label}: ${candidate.url} [${candidate.interfaceName}]`);
  }
});

setInterval(() => {
  evaluateLivePreflight();
  broadcast({
    type: "sync",
    serverTime: Date.now(),
    state: publicState()
  });
}, 1000);

setInterval(() => {
  if (state.live) {
    evaluateLiveRuntimeRelock();
    evaluateAutomaticSpeakerRecovery();
    broadcastPeers();
  }
}, 500);

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
    stopLive("track-replaced");
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
  stopLive("track-cleared");
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
    client.hasIdentified = true;
    client.name = String(message.name || client.name).slice(0, 40);
    client.deviceKey = String(message.deviceKey || client.deviceKey || "").slice(0, 120) || null;
    client.role = message.role === "controller" ? "controller" : message.role === "capture" ? "capture" : "speaker";
    const acceptsRoomVolume = client.role === "speaker" || client.role === "capture";
    if (acceptsRoomVolume && !client.volumeAnnounced) {
      const savedVolume = client.role === "speaker" && client.deviceKey
        ? speakerVolumes.get(client.deviceKey)
        : null;
      client.volume = Number.isFinite(savedVolume) ? savedVolume : state.roomVolume;
      if (client.role === "speaker" && client.deviceKey) speakerVolumes.set(client.deviceKey, client.volume);
      client.volumeAnnounced = true;
      send(client, { type: "deviceCommand", action: "setVolume", value: client.volume });
    } else if (!acceptsRoomVolume) {
      client.volumeAnnounced = false;
    }
    client.layerId = message.layerId || client.layerId;
    client.zone = normalizeZone(message.zone || client.zone);
    client.ready = Boolean(message.ready);
    client.unlocked = Boolean(message.unlocked);
    if (message.syncEngineVersion !== undefined) {
      client.syncEngineVersion = clamp(Math.round(finiteNumber(message.syncEngineVersion, 0)), 0, 999);
    }
    if (message.muted !== undefined) client.muted = Boolean(message.muted);
    client.health = message.health === undefined
      ? client.muted ? "stopped" : client.ready ? "ready" : client.unlocked ? "connecting" : "locked"
      : normalizeHealth(message.health, client.health);
    client.status = message.status === undefined
      ? client.health === "ready" ? "Ready" : client.health === "locked" ? "Needs local tap" : client.status
      : String(message.status || "").replace(/[\r\n]+/g, " ").slice(0, 80);
    if (message.syncErrorMs !== undefined) client.syncErrorMs = nullableMetric(message.syncErrorMs, -1000, 1000);
    if (message.rawSyncErrorMs !== undefined) {
      client.rawSyncErrorMs = nullableMetric(message.rawSyncErrorMs, -1000, 1000);
    }
    if (message.playoutDelayMs !== undefined) client.playoutDelayMs = nullableMetric(message.playoutDelayMs, 0, 4000);
    if (message.postDelayMs !== undefined) client.postDelayMs = nullableMetric(message.postDelayMs, 0, 1000) ?? 0;
    if (message.fixedTargetMs !== undefined) client.fixedTargetMs = nullableMetric(message.fixedTargetMs, 0, 4000);
    else if (message.adaptiveTargetMs !== undefined) {
      client.fixedTargetMs = nullableMetric(message.adaptiveTargetMs, 0, 4000);
    }
    client.latencyMs = finiteNumber(message.latencyMs, client.latencyMs);
    client.outputLatencyMs = clamp(finiteNumber(message.outputLatencyMs, client.outputLatencyMs), 0, 1000);
    if (message.outputLatencyDeltaMs !== undefined) {
      client.outputLatencyDeltaMs = nullableMetric(message.outputLatencyDeltaMs, -1000, 1000) ?? 0;
    }
    client.deviceOffsetMs = finiteNumber(message.deviceOffsetMs, client.deviceOffsetMs);
    if (message.audioContextState !== undefined) {
      client.audioContextState = String(message.audioContextState || "none").slice(0, 24);
    }
    if (message.audioSessionType !== undefined) {
      client.audioSessionType = String(message.audioSessionType || "unavailable").slice(0, 24);
    }
    if (message.audioSessionState !== undefined) {
      client.audioSessionState = String(message.audioSessionState || "unavailable").slice(0, 24);
    }
    if (message.outputPath !== undefined) client.outputPath = String(message.outputPath || "none").slice(0, 40);
    if (message.livePaused !== undefined) client.livePaused = Boolean(message.livePaused);
    if (message.liveMuted !== undefined) client.liveMuted = Boolean(message.liveMuted);
    if (message.liveReadyState !== undefined) {
      client.liveReadyState = clamp(Math.round(finiteNumber(message.liveReadyState, client.liveReadyState)), 0, 4);
    }
    if (message.rtcBytesReceived !== undefined) {
      client.rtcBytesReceived = clamp(
        Math.round(finiteNumber(message.rtcBytesReceived, client.rtcBytesReceived)),
        0,
        Number.MAX_SAFE_INTEGER
      );
    }
    if (message.rtcEmittedCount !== undefined) {
      client.rtcEmittedCount = clamp(
        Math.round(finiteNumber(message.rtcEmittedCount, client.rtcEmittedCount)),
        0,
        Number.MAX_SAFE_INTEGER
      );
    }
    if (message.rtcAudioLevel !== undefined) client.rtcAudioLevel = nullableMetric(message.rtcAudioLevel, 0, 1);
    if (message.rtcJitterMs !== undefined) client.rtcJitterMs = nullableMetric(message.rtcJitterMs, 0, 10_000);
    if (message.rtcPacketsReceived !== undefined) {
      client.rtcPacketsReceived = boundedCounter(message.rtcPacketsReceived, client.rtcPacketsReceived);
    }
    if (message.rtcPacketsLost !== undefined) {
      client.rtcPacketsLost = boundedCounter(message.rtcPacketsLost, client.rtcPacketsLost);
    }
    if (message.rtcConcealedSamples !== undefined) {
      client.rtcConcealedSamples = boundedCounter(message.rtcConcealedSamples, client.rtcConcealedSamples);
    }
    if (message.rtcTotalSamplesReceived !== undefined) {
      client.rtcTotalSamplesReceived = boundedCounter(message.rtcTotalSamplesReceived, client.rtcTotalSamplesReceived);
    }
    if (message.rtcPacketLossRate !== undefined) {
      client.rtcPacketLossRate = nullableMetric(message.rtcPacketLossRate, 0, 1);
    }
    if (message.rtcConcealmentRate !== undefined) {
      client.rtcConcealmentRate = nullableMetric(message.rtcConcealmentRate, 0, 1);
    }
    if (message.rtcRtpStallMs !== undefined) {
      client.rtcRtpStallMs = nullableMetric(message.rtcRtpStallMs, 0, 120_000) ?? 0;
    }
    if (message.rtcConnectionState !== undefined) {
      const connectionState = String(message.rtcConnectionState || "idle").toLowerCase();
      client.rtcConnectionState = ["new", "connecting", "connected", "disconnected", "failed", "closed", "idle"].includes(connectionState)
        ? connectionState
        : "unknown";
    }
    if (message.fastFuseReason !== undefined) {
      client.fastFuseReason = String(message.fastFuseReason || "").replace(/[^A-Z0-9_]/g, "").slice(0, 48);
    }
    if (message.timelineState !== undefined) {
      const timelineState = String(message.timelineState || "idle");
      client.timelineState = ["idle", "measuring", "locking", "armed", "locked", "recovering"].includes(timelineState)
        ? timelineState
        : client.timelineState;
    }
    client.lastSeen = Date.now();
    retireSupersededSpeakerRoutes(client);
    recordLiveTiming(client);
    if (
      state.live &&
      state.live.transport !== "webrtc" &&
      liveBootstrapChunk &&
      client.role !== "capture" &&
      client.unlocked &&
      client.liveBootstrapId !== state.live.id
    ) {
      sendBinary(client, liveBootstrapChunk);
      client.liveBootstrapId = state.live.id;
    }
    announceWebRtcPeer(client);
    evaluateLivePreflight();
    broadcastPeers();
    return;
  }

  if (message.type === "captureMetrics") {
    if (client.role !== "capture") return;
    const metrics = sanitizeControllerAudioMetrics(message.metrics);
    if (!metrics) return;
    client.controllerOutputLatencyDeltaMs = Number.isFinite(client.controllerAudioMetrics?.totalOutputLatencyMs)
      ? metrics.totalOutputLatencyMs - client.controllerAudioMetrics.totalOutputLatencyMs
      : 0;
    client.controllerAudioMetrics = metrics;
    client.lastSeen = Date.now();
    logControllerAudioMetrics(client, metrics);
    broadcastPeers();
    return;
  }

  if (message.type === "liveStart") {
    startLive(client, message);
    return;
  }

  if (message.type === "liveStop") {
    if (liveOwnerClientId === client.id) stopLive("capture-stopped");
    return;
  }

  if (message.type === "webrtcSignal") {
    relayWebRtcSignal(client, message);
    return;
  }

  if (message.type === "deviceCommand") {
    if (client.role !== "controller") return;
    const targetId = Number(message.targetId || 0);
    const target = [...clients].find((item) => item.id === targetId && item.role === "speaker");
    const action = String(message.action || "");
    if (!target || !["mute", "unmute", "reconnect", "setOffset", "setVolume"].includes(action)) return;

    if (action === "mute" || action === "unmute") target.muted = action === "mute";
    if (action === "setOffset") {
      target.deviceOffsetMs = clamp(finiteNumber(message.value, target.deviceOffsetMs), -300, 300);
    }
    if (action === "setVolume") {
      target.volume = clamp(finiteNumber(message.value, target.volume), 0, 1);
      if (target.deviceKey) speakerVolumes.set(target.deviceKey, target.volume);
    }
    send(target, {
      type: "deviceCommand",
      action,
      value: action === "setOffset" ? target.deviceOffsetMs : action === "setVolume" ? target.volume : undefined,
      requestedBy: client.name
    });
    evaluateLivePreflight();
    broadcastPeers();
    return;
  }

  if (message.type === "roomCommand") {
    if (client.role !== "controller") return;
    const action = String(message.action || "");
    if (!["muteSpeakers", "resumeSpeakers", "retryIssues", "retryLock", "setVolume"].includes(action)) return;
    if (action === "setVolume") {
      state.roomVolume = clamp(finiteNumber(message.value, state.roomVolume), 0, 1);
      state.updatedAt = Date.now();
      for (const target of clients) {
        if (target.role !== "speaker" && target.role !== "capture") continue;
        target.volume = state.roomVolume;
        if (target.role === "speaker" && target.deviceKey) speakerVolumes.set(target.deviceKey, target.volume);
        send(target, { type: "deviceCommand", action: "setVolume", value: target.volume, requestedBy: client.name });
      }
      broadcast({ type: "sync", serverTime: Date.now(), state: publicState() });
      broadcastPeers();
      return;
    }
    if (action === "retryLock") {
      if (!state.live?.phaseBlocked || state.live.phase !== "locking" || !livePreflight) return;
      const candidates = eligibleRoomSpeakers().filter((target) =>
        livePreflight.candidateKeys.has(speakerIdentity(target))
      );
      const stableCandidates = stableLiveCandidates(candidates);
      retryLiveRoomLock(candidates, stableCandidates, { resetAttempts: true });
      return;
    }
    if (action === "retryIssues") {
      for (const target of clients) {
        if (target.role === "speaker" && target.health === "failed") {
          send(target, { type: "deviceCommand", action: "reconnect", requestedBy: client.name });
        }
      }
      return;
    }
    const muted = action === "muteSpeakers";
    for (const target of clients) {
      if (target.role !== "speaker") continue;
      target.muted = muted;
      send(target, { type: "deviceCommand", action: muted ? "mute" : "unmute", requestedBy: client.name });
    }
    evaluateLivePreflight();
    broadcastPeers();
    return;
  }

  if (message.type === "setLead") {
    if (client.role !== "controller") return;
    leadMs = clamp(Number(message.leadMs || leadMs), 550, 6000);
    state.updatedAt = Date.now();
    broadcast({ type: "lead", state: publicState() });
    return;
  }

  if (message.type === "testTone") {
    if (client.role !== "controller") return;
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
    if (client.role !== "controller") return;
    if (state.live) return;
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
    if (client.role !== "controller") return;
    if (state.live) return;
    if (!state.layers.length || !state.playing) return;
    state.position = currentPosition();
    state.startedAt = Date.now() + leadMs;
    state.updatedAt = Date.now();
    broadcast({ type: "play", state: publicState() });
    return;
  }

  if (message.type === "pause") {
    if (client.role !== "controller") return;
    if (state.live) return;
    state.position = currentPosition();
    state.playing = false;
    state.startedAt = null;
    state.updatedAt = Date.now();
    broadcast({ type: "pause", state: publicState() });
    return;
  }

  if (message.type === "stop") {
    if (client.role !== "controller") return;
    if (state.live) {
      stopLive("controller-stopped");
      return;
    }
    state.position = 0;
    state.playing = false;
    state.startedAt = null;
    state.updatedAt = Date.now();
    broadcast({ type: "stop", state: publicState() });
    return;
  }

  if (message.type === "seek") {
    if (client.role !== "controller") return;
    if (state.live) return;
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

function startLive(client, message) {
  if (client.role !== "capture") {
    send(client, { type: "error", message: "Only a capture endpoint can start live audio." });
    return;
  }
  if (state.live) {
    send(client, { type: "error", message: "A live tab audio session is already active." });
    return;
  }

  const transport = message.transport === "webrtc" ? "webrtc" : "websocket";
  const mimeType = transport === "webrtc" ? "audio/opus" : String(message.mimeType || "").toLowerCase();
  if (transport !== "webrtc" && !isSupportedLiveMimeType(mimeType)) {
    send(client, { type: "error", message: "Unsupported live audio format." });
    return;
  }

  const now = Date.now();
  const bufferMs = transport === "webrtc"
    ? clamp(finiteNumber(message.bufferMs, webRtcBufferMs), 60, 1000)
    : liveStartLeadMs;
  const joinDelayMs = transport === "webrtc" ? leadMs : bufferMs;
  const candidateKeys = new Set(
    eligibleRoomSpeakers().map(speakerIdentity)
  );
  state.playing = false;
  state.position = 0;
  state.startedAt = null;
  state.live = {
    id: crypto.randomUUID(),
    name: String(message.name || "Browser tab audio").replace(/[\r\n]+/g, " ").slice(0, 120),
    mimeType,
    transport,
    startedAt: now,
    phase: transport === "webrtc" ? "measuring" : "armed",
    playAt: transport === "webrtc" ? null : now + joinDelayMs,
    bufferMs,
    roomTargetMs: transport === "webrtc" ? null : bufferMs,
    joinDelayMs,
    requiredSpeakers: candidateKeys.size,
    stableSpeakers: 0,
    excludedSpeakers: 0,
    phaseProgress: 0,
    phaseSampleCount: 0,
    phaseSampleTarget: ROOM_SYNC_POLICY.sampleWindow,
    phaseElapsedMs: 0,
    phaseTimeoutMs: ROOM_SYNC_POLICY.preflightTimeoutMs,
    phaseBlocked: false,
    lockAttempt: 0,
    maximumLockAttempts: ROOM_SYNC_POLICY.maximumLockAttempts,
    participantIds: []
  };
  state.updatedAt = Date.now();
  liveOwnerClientId = client.id;
  liveBootstrapChunk = null;
  livePreflight = transport === "webrtc"
    ? { liveId: state.live.id, phaseStartedAt: now, candidateKeys }
    : null;
  runtimeRelockState = { violationCount: 0, lastRelockAt: 0 };
  deviceRecoveryStates.clear();
  clearTimeout(livePhaseTimer);
  livePhaseTimer = null;
  for (const peer of clients) {
    peer.timingSamples = [];
    peer.timingStable = false;
    peer.timingSpreadMs = null;
    peer.timingLiveId = state.live.id;
    if (peer.role === "speaker") {
      peer.syncErrorMs = null;
      peer.playoutDelayMs = null;
      peer.postDelayMs = 0;
      peer.fixedTargetMs = null;
      peer.rtcBytesReceived = 0;
      peer.rtcEmittedCount = 0;
      peer.timelineState = "measuring";
    }
  }
  client.liveId = state.live.id;
  broadcast({ type: "liveStart", state: publicState() });
  if (transport === "webrtc") {
    for (const peer of eligibleRoomSpeakers()) announceWebRtcPeer(peer);
    evaluateLivePreflight();
  }
}

function recordLiveTiming(client) {
  if (
    !state.live ||
    state.live.transport !== "webrtc" ||
    !["measuring", "locking"].includes(state.live.phase) ||
    !livePreflight
  ) return;
  if (!isCompatibleSpeaker(client) || !client.unlocked || client.muted) return;
  const identity = speakerIdentity(client);
  if (state.live.phase === "measuring") livePreflight.candidateKeys.add(identity);
  if (!livePreflight.candidateKeys.has(identity)) return;
  if (client.timingLiveId !== state.live.id) {
    client.timingLiveId = state.live.id;
    client.timingSamples = [];
  }

  const sample = roomTimingSample({
    at: client.lastSeen,
    playoutDelayMs: client.playoutDelayMs,
    outputLatencyMs: client.outputLatencyMs,
    postDelayMs: client.postDelayMs,
    deviceOffsetMs: client.deviceOffsetMs,
    rtcBytesReceived: client.rtcBytesReceived,
    rtcProgress: client.rtcEmittedCount || client.rtcBytesReceived
  });
  if (!sample) return;
  const nextSamples = appendRoomTimingSample(client.timingSamples, sample);
  if (nextSamples === client.timingSamples) return;
  client.timingSamples = nextSamples;
  const timing = stableRoomTiming(client.timingSamples, client.lastSeen);
  client.timingStable = timing.stable;
  client.timingSpreadMs = timing.spreadMs;
}

function evaluateLivePreflight() {
  if (
    !state.live ||
    state.live.transport !== "webrtc" ||
    !["measuring", "locking"].includes(state.live.phase) ||
    !livePreflight
  ) return;
  const now = Date.now();
  const candidates = eligibleRoomSpeakers().filter((client) =>
    livePreflight.candidateKeys.has(speakerIdentity(client))
  );
  const stableCandidates = stableLiveCandidates(candidates);

  state.live.requiredSpeakers = candidates.length;
  state.live.stableSpeakers = stableCandidates.length;
  state.live.excludedSpeakers = Math.max(0, candidates.length - stableCandidates.length);
  state.updatedAt = now;

  if (state.live.phase === "locking") {
    const initiallyExcluded = Math.max(0, Number(livePreflight.excludedCount || 0));
    const lockedCandidates = stableCandidates.filter((client) => {
      const timing = stableRoomTiming(client.timingSamples, now);
      return timing.stable && Math.abs(timing.delayMs - state.live.roomTargetMs) <= ROOM_SYNC_POLICY.lockToleranceMs;
    });
    state.live.stableSpeakers = lockedCandidates.length;
    state.live.excludedSpeakers = initiallyExcluded + Math.max(0, candidates.length - lockedCandidates.length);
    const lockTimedOut = now - livePreflight.phaseStartedAt >= ROOM_SYNC_POLICY.lockTimeoutMs;
    updateLivePhaseProgress(candidates, lockedCandidates, now, ROOM_SYNC_POLICY.lockTimeoutMs);
    const timeoutAction = roomLockTimeoutAction({
      candidateCount: candidates.length,
      lockedCount: lockedCandidates.length,
      timedOut: lockTimedOut,
      lockAttempt: state.live.lockAttempt
    });
    if (timeoutAction === "retry") {
      retryLiveRoomLock(candidates, stableCandidates);
      return;
    }
    state.live.phaseBlocked = timeoutAction === "block";
    if (state.live.phaseBlocked || lockedCandidates.length !== candidates.length) return;
    armLiveRoom(lockedCandidates, candidates);
    return;
  }

  const timedOut = now - livePreflight.phaseStartedAt >= ROOM_SYNC_POLICY.preflightTimeoutMs;
  updateLivePhaseProgress(candidates, stableCandidates, now, ROOM_SYNC_POLICY.preflightTimeoutMs);
  state.live.phaseBlocked = candidates.length > 0 && timedOut && !stableCandidates.length;
  if (!stableCandidates.length) return;
  if (stableCandidates.length !== candidates.length && !timedOut) return;
  lockLiveRoom(stableCandidates, candidates);
}

function stableLiveCandidates(candidates) {
  return candidates.filter((client) =>
    client.timingStable &&
    (client.rtcEmittedCount > 0 || client.rtcBytesReceived > 0) &&
    client.outputPath.endsWith("source") &&
    client.audioContextState === "running"
  );
}

function lockLiveRoom(stableCandidates, candidates) {
  if (!state.live || state.live.phase !== "measuring") return;
  const stableEntries = stableCandidates.map((client) => ({
    client,
    timing: stableRoomTiming(client.timingSamples)
  }));
  const cohort = roomTimingCohort(stableEntries.map(({ timing }) => ({ delayMs: timing.delayMs })));
  const acceptedCandidates = cohort.includedIndexes.map((index) => stableEntries[index].client);
  const timings = cohort.includedIndexes.map((index) => stableEntries[index].timing);
  if (!acceptedCandidates.length) return;
  const roomTargetMs = fixedRoomTargetMs(timings, state.live.bufferMs);
  state.live.phase = "locking";
  state.live.roomTargetMs = roomTargetMs;
  state.live.stableSpeakers = 0;
  state.live.requiredSpeakers = acceptedCandidates.length;
  state.live.excludedSpeakers = Math.max(0, candidates.length - acceptedCandidates.length);
  state.live.phaseProgress = 0;
  state.live.phaseSampleCount = 0;
  state.live.phaseElapsedMs = 0;
  state.live.phaseTimeoutMs = ROOM_SYNC_POLICY.lockTimeoutMs;
  state.live.phaseBlocked = false;
  state.live.lockAttempt = 1;
  state.live.maximumLockAttempts = ROOM_SYNC_POLICY.maximumLockAttempts;
  state.live.participantIds = acceptedCandidates.map((client) => client.id);
  state.updatedAt = Date.now();
  livePreflight = {
    liveId: state.live.id,
    phaseStartedAt: Date.now(),
    candidateKeys: new Set(acceptedCandidates.map(speakerIdentity)),
    excludedCount: Math.max(0, candidates.length - acceptedCandidates.length)
  };
  for (const client of acceptedCandidates) {
    client.timingSamples = [];
    client.timingStable = false;
    client.timingSpreadMs = null;
  }
  broadcast({ type: "liveLock", state: publicState() });
}

function retryLiveRoomLock(candidates, stableCandidates, { resetAttempts = false } = {}) {
  if (!state.live || state.live.phase !== "locking" || !livePreflight || !candidates.length) return false;
  const initiallyExcluded = Math.max(0, Number(livePreflight.excludedCount || 0));
  const stableTimings = stableCandidates
    .map((client) => stableRoomTiming(client.timingSamples))
    .filter((timing) =>
      timing.stable && timing.delayMs > state.live.roomTargetMs + ROOM_SYNC_POLICY.lockToleranceMs
    );
  if (stableTimings.length) {
    state.live.roomTargetMs = Math.max(
      state.live.roomTargetMs,
      fixedRoomTargetMs(stableTimings, state.live.roomTargetMs)
    );
  }
  state.live.lockAttempt = resetAttempts ? 1 : Math.min(
    ROOM_SYNC_POLICY.maximumLockAttempts,
    Number(state.live.lockAttempt || 1) + 1
  );
  state.live.maximumLockAttempts = ROOM_SYNC_POLICY.maximumLockAttempts;
  state.live.stableSpeakers = 0;
  state.live.requiredSpeakers = candidates.length;
  state.live.excludedSpeakers = initiallyExcluded + candidates.length;
  state.live.phaseProgress = 0;
  state.live.phaseSampleCount = 0;
  state.live.phaseElapsedMs = 0;
  state.live.phaseTimeoutMs = ROOM_SYNC_POLICY.lockTimeoutMs;
  state.live.phaseBlocked = false;
  state.updatedAt = Date.now();
  livePreflight = {
    liveId: state.live.id,
    phaseStartedAt: Date.now(),
    candidateKeys: new Set(candidates.map(speakerIdentity)),
    excludedCount: initiallyExcluded
  };
  for (const client of candidates) {
    client.timingSamples = [];
    client.timingStable = false;
    client.timingSpreadMs = null;
    client.postDelayMs = 0;
    client.timelineState = "locking";
  }
  broadcast({ type: "liveLock", state: publicState() });
  return true;
}

function updateLivePhaseProgress(candidates, acceptedCandidates, now, timeoutMs) {
  const sampleCount = candidates.length
    ? Math.min(...candidates.map((client) => Math.min(client.timingSamples.length, ROOM_SYNC_POLICY.sampleWindow)))
    : 0;
  const allAccepted = candidates.length > 0 && acceptedCandidates.length === candidates.length;
  const sampleProgress = Math.min(0.9, sampleCount / ROOM_SYNC_POLICY.sampleWindow);
  state.live.phaseProgress = allAccepted ? 100 : Math.round(sampleProgress * 100);
  state.live.phaseSampleCount = sampleCount;
  state.live.phaseSampleTarget = ROOM_SYNC_POLICY.sampleWindow;
  state.live.phaseElapsedMs = Math.max(0, now - livePreflight.phaseStartedAt);
  state.live.phaseTimeoutMs = timeoutMs;
}

function armLiveRoom(stableCandidates, candidates) {
  if (!state.live || state.live.phase !== "locking") return;
  const roomTargetMs = state.live.roomTargetMs;
  const playAt = Date.now() + leadMs;
  const liveId = state.live.id;
  state.live.phase = "armed";
  state.live.playAt = playAt;
  state.live.roomTargetMs = roomTargetMs;
  state.live.stableSpeakers = stableCandidates.length;
  state.live.requiredSpeakers = candidates.length;
  state.live.excludedSpeakers =
    Math.max(0, Number(livePreflight?.excludedCount || 0)) +
    Math.max(0, candidates.length - stableCandidates.length);
  state.live.participantIds = stableCandidates.map((client) => client.id);
  state.live.phaseProgress = 100;
  state.live.phaseSampleCount = ROOM_SYNC_POLICY.sampleWindow;
  state.live.phaseElapsedMs = Date.now() - livePreflight.phaseStartedAt;
  state.live.phaseBlocked = false;
  state.updatedAt = Date.now();
  livePreflight = null;
  broadcast({ type: "liveArm", state: publicState() });
  clearTimeout(livePhaseTimer);
  livePhaseTimer = setTimeout(() => {
    if (!state.live || state.live.id !== liveId || state.live.phase !== "armed") return;
    state.live.phase = "playing";
    state.live.runtimeRelock = false;
    state.updatedAt = Date.now();
    broadcast({ type: "sync", serverTime: Date.now(), state: publicState() });
  }, Math.max(0, playAt - Date.now()) + 80);
}

function evaluateLiveRuntimeRelock(now = Date.now()) {
  if (!state.live || state.live.transport !== "webrtc" || state.live.phase !== "playing") {
    runtimeRelockState.violationCount = 0;
    return;
  }
  if (now - runtimeRelockState.lastRelockAt < ROOM_SYNC_POLICY.runtimeRelockCooldownMs) return;
  const candidates = eligibleRoomSpeakers();
  const plan = runtimeRoomRelockPlan(candidates, state.live.roomTargetMs);
  if (!plan.shouldRelock) {
    runtimeRelockState.violationCount = 0;
    return;
  }
  runtimeRelockState.violationCount += 1;
  if (runtimeRelockState.violationCount < ROOM_SYNC_POLICY.runtimeRelockSamples) return;
  const acceptedCandidates = plan.includedIndexes.map((index) => candidates[index]).filter(Boolean);
  beginRuntimeRelock(
    acceptedCandidates,
    plan.roomTargetMs,
    now,
    Math.max(0, candidates.length - acceptedCandidates.length)
  );
}

function beginRuntimeRelock(candidates, roomTargetMs, now = Date.now(), initiallyExcluded = 0) {
  if (!state.live || state.live.phase !== "playing" || !candidates.length) return false;
  clearTimeout(livePhaseTimer);
  livePhaseTimer = null;
  state.live.phase = "locking";
  state.live.playAt = null;
  state.live.roomTargetMs = roomTargetMs;
  state.live.runtimeRelock = true;
  state.live.stableSpeakers = 0;
  state.live.requiredSpeakers = candidates.length;
  state.live.excludedSpeakers = initiallyExcluded + candidates.length;
  state.live.phaseProgress = 0;
  state.live.phaseSampleCount = 0;
  state.live.phaseElapsedMs = 0;
  state.live.phaseTimeoutMs = ROOM_SYNC_POLICY.lockTimeoutMs;
  state.live.phaseBlocked = false;
  state.live.lockAttempt = 1;
  state.live.maximumLockAttempts = ROOM_SYNC_POLICY.maximumLockAttempts;
  state.live.participantIds = candidates.map((client) => client.id);
  state.updatedAt = now;
  livePreflight = {
    liveId: state.live.id,
    phaseStartedAt: now,
    candidateKeys: new Set(candidates.map(speakerIdentity)),
    excludedCount: initiallyExcluded
  };
  runtimeRelockState = { violationCount: 0, lastRelockAt: now };
  for (const client of candidates) {
    client.timingSamples = [];
    client.timingStable = false;
    client.timingSpreadMs = null;
    client.postDelayMs = 0;
    client.timelineState = "locking";
  }
  console.log(`[Room relock] Raising target to ${roomTargetMs} ms for ${candidates.length} speaker(s)`);
  broadcast({ type: "liveLock", state: publicState() });
  return true;
}

function evaluateAutomaticSpeakerRecovery(now = Date.now()) {
  if (!state.live || state.live.transport !== "webrtc" || state.live.phase !== "playing") return;
  const speakers = latestVisibleClients().filter((client) => isCompatibleSpeaker(client));
  for (const client of speakers) {
    const key = speakerIdentity(client);
    if (client.muted) {
      deviceRecoveryStates.delete(key);
      continue;
    }
    if (client.timelineState === "locked" && client.health === "ready") {
      deviceRecoveryStates.delete(key);
      continue;
    }
    const needsRecovery =
      client.timelineState === "recovering" ||
      ["failed", "disconnected", "closed"].includes(client.rtcConnectionState);
    if (!needsRecovery) continue;

    const recovery = deviceRecoveryStates.get(key) || {
      recoverySince: now,
      lastAttemptAt: null,
      attempts: 0,
      exhaustedLogged: false
    };
    const plan = automaticReconnectPlan({
      timelineState: client.timelineState,
      connectionState: client.rtcConnectionState,
      audioContextState: client.audioContextState,
      unlocked: client.unlocked,
      muted: client.muted,
      recoverySince: recovery.recoverySince,
      lastAttemptAt: recovery.lastAttemptAt,
      attempts: recovery.attempts,
      now
    });

    if (plan.reason === "attempts-exhausted" && !recovery.exhaustedLogged) {
      recovery.exhaustedLogged = true;
      addIncident({
        deviceId: client.id,
        deviceName: client.name,
        state: "critical",
        layer: "connection",
        reason: "AUTO_RECONNECT_EXHAUSTED",
        label: "Automatic reconnect stopped after 3 attempts",
        action: "Inspect device"
      });
    }
    if (plan.shouldReconnect) {
      recovery.attempts += 1;
      recovery.lastAttemptAt = now;
      recovery.recoverySince = now;
      recovery.exhaustedLogged = false;
      client.autoReconnectRequested = true;
      addIncident({
        deviceId: client.id,
        deviceName: client.name,
        state: "repairing",
        layer: "connection",
        reason: "AUTO_RECONNECT",
        label: `Automatic reconnect ${recovery.attempts}/${ROOM_SYNC_POLICY.automaticReconnectMaximumAttempts}`,
        action: "Reconnect transport"
      });
      send(client, {
        type: "deviceCommand",
        action: "reconnect",
        automatic: true,
        attempt: recovery.attempts,
        maximumAttempts: ROOM_SYNC_POLICY.automaticReconnectMaximumAttempts
      });
    }
    deviceRecoveryStates.set(key, recovery);
  }
}

function stopLive(reason) {
  if (!state.live) return;
  clearTimeout(livePhaseTimer);
  livePhaseTimer = null;
  livePreflight = null;
  runtimeRelockState = { violationCount: 0, lastRelockAt: 0 };
  deviceRecoveryStates.clear();
  state.live = null;
  state.updatedAt = Date.now();
  liveOwnerClientId = null;
  liveBootstrapChunk = null;
  broadcast({ type: "liveStop", state: publicState(), reason });
}

function handleBinaryMessage(client, payload) {
  if (!state.live || state.live.transport === "webrtc" || liveOwnerClientId !== client.id) return;
  if (payload.length > 2 * 1024 * 1024) {
    send(client, { type: "error", message: "Live audio chunk is too large." });
    stopLive("chunk-too-large");
    return;
  }
  const isBootstrap = !liveBootstrapChunk;
  if (isBootstrap) liveBootstrapChunk = Buffer.from(payload);
  broadcastBinary(payload, client, isBootstrap ? state.live.id : null);
}

function announceWebRtcPeer(client) {
  if (
    !state.live ||
    state.live.transport !== "webrtc" ||
    !liveOwnerClientId ||
    client.id === liveOwnerClientId ||
    client.role !== "speaker" ||
    !client.unlocked ||
    !isCompatibleSpeaker(client) ||
    newestSpeakerConnection(client) !== client ||
    client.webRtcAnnouncedLiveId === state.live.id
  ) {
    return;
  }

  const owner = [...clients].find((item) => item.id === liveOwnerClientId);
  if (!owner) return;
  client.webRtcAnnouncedLiveId = state.live.id;
  send(owner, {
    type: "webrtcPeerJoin",
    peerId: client.id,
    name: client.name,
    bufferMs: state.live.bufferMs,
    joinDelayMs: state.live.joinDelayMs
  });
}

function relayWebRtcSignal(client, message) {
  if (!state.live || state.live.transport !== "webrtc" || !liveOwnerClientId) return;
  const targetId = Number(message.targetId || 0);
  const target = [...clients].find((item) => item.id === targetId);
  const isOwnerRoute = client.id === liveOwnerClientId || targetId === liveOwnerClientId;
  if (!target || !isOwnerRoute || !message.signal || typeof message.signal !== "object") return;
  send(target, {
    type: "webrtcSignal",
    fromId: client.id,
    signal: message.signal
  });
}

function publicState() {
  const now = Date.now();
  return {
    ...state,
    track: primaryTrack(state.layers),
    serverTime: now,
    position: state.position,
    currentPosition: currentPosition(now),
    leadMs,
    requiredSyncEngineVersion: ROOM_SYNC_ENGINE_VERSION,
    addresses: getLanAddresses(port)
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

    if (opcode === 0x2) {
      handleBinaryMessage(client, payload);
      continue;
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
  sendFrame(client, 0x1, data);
}

function sendBinary(client, payload) {
  if (client.socket.destroyed) return;
  sendFrame(client, 0x2, payload);
}

function sendFrame(client, opcode, data) {
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  client.socket.write(Buffer.concat([header, data]));
}

function broadcast(payload) {
  for (const client of clients) send(client, payload);
}

function broadcastBinary(payload, sender, bootstrapId = null) {
  for (const client of clients) {
    if (client !== sender && client.role !== "capture" && client.unlocked) {
      sendBinary(client, payload);
      if (bootstrapId) client.liveBootstrapId = bootstrapId;
    }
  }
}

function removeClient(client) {
  if (!clients.has(client)) return;
  if (!client.hidden && liveOwnerClientId && liveOwnerClientId !== client.id) {
    const owner = [...clients].find((item) => item.id === liveOwnerClientId);
    if (owner) send(owner, { type: "webrtcPeerLeave", peerId: client.id });
  }
  if (
    !client.hidden &&
    client.hasIdentified &&
    ["speaker", "capture"].includes(client.role) &&
    !client.autoReconnectRequested
  ) {
    addIncident({
      deviceId: client.id,
      deviceName: client.name,
      state: "critical",
      layer: "connection",
      reason: "CONTROL_OFFLINE",
      label: "Connection: Offline",
      action: "Reconnect transport"
    });
  }
  if (liveOwnerClientId === client.id) stopLive("capture-disconnected");
  clients.delete(client);
  evaluateLivePreflight();
  broadcastPeers();
}

function broadcastPeers() {
  refreshDeviceDiagnostics();
  broadcast({
    type: "peers",
    peers: peerList(),
    roomDiagnostic,
    incidents: recentIncidents()
  });
}

function latestVisibleClients() {
  const latestByDevice = new Map();
  for (const client of clients) {
    if (client.hidden) continue;
    const key = `${client.role}:${client.deviceKey || `socket-${client.id}`}`;
    const existing = latestByDevice.get(key);
    if (!existing || client.id > existing.id) {
      latestByDevice.set(key, client);
    }
  }
  return [...latestByDevice.values()];
}

function refreshDeviceDiagnostics() {
  const monitored = latestVisibleClients().filter((client) =>
    client.hasIdentified && ["speaker", "capture"].includes(client.role)
  );
  const metricsByClient = monitored.map((client) => ({ client, metrics: diagnosticMetrics(client) }));
  const context = roomHealthContext(metricsByClient.map(({ metrics }) => metrics));

  for (const { client, metrics } of metricsByClient) {
    const previousDiagnostic = client.diagnostic;
    const nextDiagnostic = classifyDeviceHealth(metrics, context);
    client.diagnostic = nextDiagnostic;
    const nextKey = `${nextDiagnostic.overall.state}:${nextDiagnostic.overall.layer || "room"}:${nextDiagnostic.overall.reason}`;
    if (nextKey !== client.diagnosticKey) {
      const previousIssue = isDiagnosticIssue(previousDiagnostic);
      const nextIssue = isDiagnosticIssue(nextDiagnostic);
      if (previousIssue || nextIssue) {
        addIncident({
          deviceId: client.id,
          deviceName: client.name,
          state: nextDiagnostic.overall.state,
          layer: nextDiagnostic.overall.layer,
          reason: nextDiagnostic.overall.reason,
          label: previousIssue && !nextIssue
            ? "Recovered"
            : `${titleCase(nextDiagnostic.overall.layer || "device")}: ${nextDiagnostic.overall.label}`,
          action: nextDiagnostic.overall.action
        });
      }
      client.diagnosticKey = nextKey;
    }
  }

  roomDiagnostic = summarizeRoomHealth(
    metricsByClient.map(({ client }) => ({ id: client.id, name: displayDeviceName(client), diagnostic: client.diagnostic })),
    context
  );
}

function diagnosticMetrics(client) {
  const liveActive = Boolean(state.live?.id);
  if (client.role === "capture") {
    const metrics = client.controllerAudioMetrics;
    return {
      role: "capture",
      active: liveActive,
      online: true,
      unlocked: true,
      muted: client.muted,
      telemetryAgeMs: Math.max(0, Date.now() - client.lastSeen),
      connectionState: "connected",
      audioContextState: metrics?.contextState || "none",
      outputPath: metrics ? "controller-local-output" : "none",
      outputLatencyDeltaMs: client.controllerOutputLatencyDeltaMs,
      syncErrorMs: metrics?.estimatedTimelineErrorMs,
      rawSyncErrorMs: metrics?.estimatedTimelineErrorMs,
      timelineState: liveActive ? state.live.phase === "playing" ? "locked" : state.live.phase : "idle"
    };
  }
  return {
    role: client.role,
    active: liveActive,
    online: true,
    unlocked: client.unlocked,
    muted: client.muted,
    telemetryAgeMs: Math.max(0, Date.now() - client.lastSeen),
    connectionState: client.rtcConnectionState,
    jitterMs: client.rtcJitterMs,
    packetLossRate: client.rtcPacketLossRate,
    concealmentRate: client.rtcConcealmentRate,
    rtpStallMs: client.rtcRtpStallMs,
    audioContextState: client.audioContextState,
    outputPath: client.outputPath,
    outputLatencyDeltaMs: client.outputLatencyDeltaMs,
    syncErrorMs: client.syncErrorMs,
    rawSyncErrorMs: client.rawSyncErrorMs,
    timelineState: client.timelineState,
    fastFuseReason: client.fastFuseReason
  };
}

function isDiagnosticIssue(diagnostic) {
  return ["warning", "critical", "repairing"].includes(diagnostic?.overall?.state);
}

function addIncident({ deviceId = null, deviceName, state, layer, reason, label, action }) {
  const previous = deviceIncidents[0];
  const key = `${deviceId || "room"}:${state}:${layer || "room"}:${reason}`;
  if (previous?.key === key && Date.now() - previous.at < 1000) return;
  deviceIncidents.unshift({
    id: nextIncidentId++,
    key,
    at: Date.now(),
    deviceId,
    deviceName: deviceName || "Room",
    state,
    layer: layer || null,
    reason,
    label,
    action
  });
  if (deviceIncidents.length > 40) deviceIncidents.length = 40;
}

function recentIncidents() {
  return deviceIncidents.slice(0, 12).map(({ key: _key, ...incident }) => incident);
}

function displayDeviceName(client) {
  return client.role === "capture" ? "Controller output" : client.name;
}

function peerList() {
  return latestVisibleClients().map((client) => {
    const compatible = client.role !== "speaker" || isCompatibleSpeaker(client);
    const recovery = client.role === "speaker"
      ? deviceRecoveryStates.get(speakerIdentity(client))
      : null;
    return {
      id: client.id,
      name: client.name,
      role: client.role,
      layerId: client.layerId,
      zone: client.zone,
      ready: compatible && client.ready,
      unlocked: client.unlocked,
      muted: client.muted,
      volume: client.volume,
      health: compatible ? client.health : "needs-action",
      status: compatible ? client.status : `Refresh speaker page (sync engine v${ROOM_SYNC_ENGINE_VERSION})`,
      syncErrorMs: client.syncErrorMs,
      playoutDelayMs: client.playoutDelayMs,
      postDelayMs: client.postDelayMs,
      fixedTargetMs: client.fixedTargetMs,
      latencyMs: client.latencyMs,
      outputLatencyMs: client.outputLatencyMs,
      deviceOffsetMs: client.deviceOffsetMs,
      audioContextState: client.audioContextState,
      audioSessionType: client.audioSessionType,
      audioSessionState: client.audioSessionState,
      outputPath: client.outputPath,
      controllerAudioMetrics: client.controllerAudioMetrics,
      livePaused: client.livePaused,
      liveMuted: client.liveMuted,
      liveReadyState: client.liveReadyState,
      rtcBytesReceived: client.rtcBytesReceived,
      rtcEmittedCount: client.rtcEmittedCount,
      rtcAudioLevel: client.rtcAudioLevel,
      rtcJitterMs: client.rtcJitterMs,
      rtcPacketsReceived: client.rtcPacketsReceived,
      rtcPacketsLost: client.rtcPacketsLost,
      rtcConcealedSamples: client.rtcConcealedSamples,
      rtcTotalSamplesReceived: client.rtcTotalSamplesReceived,
      rtcPacketLossRate: client.rtcPacketLossRate,
      rtcConcealmentRate: client.rtcConcealmentRate,
      rtcRtpStallMs: client.rtcRtpStallMs,
      rtcConnectionState: client.rtcConnectionState,
      rawSyncErrorMs: client.rawSyncErrorMs,
      outputLatencyDeltaMs: client.outputLatencyDeltaMs,
      fastFuseReason: client.fastFuseReason,
      diagnostic: compatible ? client.diagnostic : null,
      automaticReconnectAttempts: recovery?.attempts || 0,
      automaticReconnectMaximumAttempts: ROOM_SYNC_POLICY.automaticReconnectMaximumAttempts,
      timingStable: compatible && client.timingStable,
      timingSpreadMs: client.timingSpreadMs,
      timelineState: compatible ? client.timelineState : "idle",
      syncEngineVersion: client.syncEngineVersion,
      online: true
    };
  });
}

function logControllerAudioMetrics(client, metrics) {
  const now = Date.now();
  if (now - client.lastControllerMetricsLogAt < 5000) return;
  client.lastControllerMetricsLogAt = now;
  const signed = (value, suffix) => Number.isFinite(value)
    ? `${value >= 0 ? "+" : ""}${Math.round(value * 10) / 10}${suffix}`
    : "collecting";
  console.log(
    `[Controller audio] ${client.name}: ${metrics.sampleRate || "--"} Hz | ` +
    `output ${Math.round(metrics.totalOutputLatencyMs * 10) / 10} ms | ` +
    `change ${signed(metrics.latencyDeltaMs, " ms")} | ` +
    `spread ${Math.round((metrics.latencySpreadMs || 0) * 10) / 10} ms | ` +
    `clock ${signed(metrics.clockDriftPpm, " ppm")} | ${metrics.contextState}`
  );
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

function speakerIdentity(client) {
  return client.deviceKey || `socket-${client.id}`;
}

function isCompatibleSpeaker(client) {
  return client.role === "speaker" && supportsRoomSyncVersion(client.syncEngineVersion);
}

function newestSpeakerConnection(client) {
  if (!isCompatibleSpeaker(client)) return null;
  const identity = speakerIdentity(client);
  let newest = null;
  for (const candidate of clients) {
    if (!isCompatibleSpeaker(candidate) || speakerIdentity(candidate) !== identity) continue;
    if (!newest || candidate.id > newest.id) newest = candidate;
  }
  return newest;
}

function eligibleRoomSpeakers() {
  return latestEligibleRoomSpeakers([...clients]);
}

function retireSupersededSpeakerRoutes(client) {
  if (!state.live || state.live.transport !== "webrtc" || newestSpeakerConnection(client) !== client) return;
  const owner = [...clients].find((item) => item.id === liveOwnerClientId);
  if (!owner) return;
  const identity = speakerIdentity(client);
  for (const candidate of clients) {
    if (
      candidate === client ||
      !isCompatibleSpeaker(candidate) ||
      speakerIdentity(candidate) !== identity ||
      candidate.webRtcAnnouncedLiveId !== state.live.id
    ) continue;
    send(owner, { type: "webrtcPeerLeave", peerId: candidate.id });
    candidate.webRtcAnnouncedLiveId = null;
  }
}

function normalizeHealth(value, fallback = "connecting") {
  const allowed = new Set(["ready", "connecting", "failed", "locked", "needs-action", "stopped"]);
  return allowed.has(value) ? value : fallback;
}

function isSupportedLiveMimeType(value) {
  return value === "audio/webm" || value === "audio/webm;codecs=opus";
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nullableMetric(value, min, max) {
  if (value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? clamp(number, min, max) : null;
}

function boundedCounter(value, fallback = 0) {
  return clamp(Math.round(finiteNumber(value, fallback)), 0, Number.MAX_SAFE_INTEGER);
}

function titleCase(value) {
  const text = String(value || "");
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "Device";
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
  return getLanAddressCandidates(serverPort).map((candidate) => candidate.url);
}

function getLanAddressCandidates(serverPort) {
  return lanAddressCandidates(os.networkInterfaces(), serverPort);
}

function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}
