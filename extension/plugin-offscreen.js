import {
  appendPluginTimingSample,
  bestClockOffset,
  choosePluginRoomTarget,
  clockOffsetSample,
  DEFAULT_SIGNALING_ORIGIN,
  normalizeSignalingOrigin,
  PLUGIN_ROOM_POLICY,
  signalingWebSocketUrl,
  stablePluginTiming
} from "./plugin-room.js";

const INITIALIZATION_TIMEOUT_MS = 18_000;
const INITIAL_START_LEAD_MS = 2_500;
const LATE_JOIN_LEAD_MS = 1_800;
const CLOCK_PROBE_COUNT = 6;
const CLOCK_PROBE_INTERVAL_MS = 140;
const HEARTBEAT_INTERVAL_MS = 20_000;

const state = {
  signalingOrigin: DEFAULT_SIGNALING_ORIGIN,
  socket: null,
  connectionPromise: null,
  connectionState: "offline",
  reconnectTimer: null,
  reconnectAttempt: 0,
  heartbeatTimer: null,
  intentionalSockets: new WeakSet(),
  room: null,
  speakers: new Map(),
  iceServers: [],
  stream: null,
  tabTitle: "",
  tabId: null,
  captureStopping: false,
  captureGeneration: 0,
  peers: new Map(),
  peerRepairAttempts: new Map(),
  peerRepairTimers: new Map(),
  requiredPeerIds: new Set(),
  phase: "idle",
  phaseStartedAt: 0,
  initializationIssue: "",
  phaseTimer: null,
  playAt: 0,
  roomTargetMs: PLUGIN_ROOM_POLICY.minimumRoomTargetMs,
  volume: 1,
  audioContext: null,
  localSource: null,
  localDelay: null,
  localGain: null,
  localOutputLatencyMs: 0
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "create-plugin-room-in-offscreen") {
    createPluginRoom(message)
      .then((status) => sendResponse({ ok: true, status }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Could not create a room." }));
    return true;
  }
  if (message.type === "get-plugin-room-status-in-offscreen") {
    sendResponse({ ok: true, status: publicRoomStatus() });
    return;
  }
  if (message.type === "begin-plugin-capture-in-offscreen") {
    startPluginCapture(message)
      .then(() => sendResponse({ ok: true, status: publicRoomStatus() }))
      .catch((error) => {
        setCaptureStatus({ phase: "error", detail: error.message || "Could not capture this tab." });
        sendResponse({ ok: false, error: error.message || "Could not capture this tab." });
      });
    return true;
  }
  if (message.type === "stop-plugin-capture-in-offscreen") {
    stopPluginCapture({ detail: "Tab audio stopped. The room remains open." });
    sendResponse({ ok: true, status: publicRoomStatus() });
    return;
  }
  if (message.type === "close-plugin-room-in-offscreen") {
    closePluginRoom();
    sendResponse({ ok: true, status: publicRoomStatus() });
    return;
  }
  if (message.type === "set-plugin-volume-in-offscreen") {
    setPluginVolume(message.value);
    sendResponse({ ok: true, status: publicRoomStatus() });
  }
});

async function createPluginRoom({ signalingOrigin, controllerName } = {}) {
  const origin = normalizeSignalingOrigin(signalingOrigin || state.signalingOrigin);
  if (state.room && state.signalingOrigin !== origin) closePluginRoom();
  state.signalingOrigin = origin;

  if (state.room) {
    if (state.socket?.readyState !== WebSocket.OPEN) await connectSignaling("resume");
    return publicRoomStatus();
  }

  state.connectionState = "connecting";
  publishRoomStatus();
  await connectSignaling("create", String(controllerName || "Chrome Controller").slice(0, 40));
  return publicRoomStatus();
}

function connectSignaling(intent, controllerName = "Chrome Controller") {
  if (state.connectionPromise) return state.connectionPromise;
  if (intent === "resume" && !state.room) return Promise.reject(new Error("This Controller room no longer exists."));

  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  if (state.socket) {
    state.intentionalSockets.add(state.socket);
    try {
      state.socket.close();
    } catch {}
    state.socket = null;
  }
  const socket = new WebSocket(signalingWebSocketUrl(state.signalingOrigin));
  state.socket = socket;
  state.connectionState = "connecting";
  publishRoomStatus();

  let settleConnection;
  let rejectConnection;
  const connectionPromise = new Promise((resolve, reject) => {
    settleConnection = resolve;
    rejectConnection = reject;
  });
  state.connectionPromise = connectionPromise;
  const timeout = setTimeout(() => {
    rejectConnection(new Error("The signaling service did not answer in time."));
    try {
      socket.close();
    } catch {}
  }, 8_000);

  socket.addEventListener("open", () => {
    if (state.socket !== socket) return;
    const payload = intent === "create"
      ? { type: "room:create", controllerName }
      : { type: "room:resume", roomId: state.room.id, controllerToken: state.room.controllerToken };
    socket.send(JSON.stringify(payload));
  });

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleSignalingMessage(message).catch((error) => {
      setCaptureStatus({ phase: "error", detail: error.message || "WebRTC signaling failed." });
    });
    if ((intent === "create" && message.type === "room:created") ||
        (intent === "resume" && message.type === "room:resumed")) {
      state.connectionState = "online";
      state.reconnectAttempt = 0;
      clearTimeout(timeout);
      settleConnection(publicRoomStatus());
    } else if (message.type === "error" && state.connectionState === "connecting") {
      clearTimeout(timeout);
      rejectConnection(new Error(message.message || "The signaling service rejected this room."));
    }
  });

  socket.addEventListener("close", () => {
    clearTimeout(timeout);
    if (state.socket === socket) state.socket = null;
    if (state.connectionState === "connecting") {
      rejectConnection(new Error("The signaling service connection closed."));
    }
    if (state.intentionalSockets.has(socket)) return;
    state.connectionState = state.room ? "reconnecting" : "offline";
    publishRoomStatus();
    if (state.room) scheduleSignalingReconnect();
  });

  socket.addEventListener("error", () => {
    if (state.socket !== socket) return;
    state.connectionState = "reconnecting";
    publishRoomStatus();
  });

  connectionPromise.finally(() => {
    clearTimeout(timeout);
    if (state.connectionPromise === connectionPromise) state.connectionPromise = null;
  }).catch(() => {});
  return connectionPromise;
}

async function handleSignalingMessage(message) {
  if (message.type === "hello") {
    if (Array.isArray(message.iceServers)) state.iceServers = message.iceServers;
    return;
  }
  if (message.type === "room:created") {
    state.room = {
      id: String(message.roomId || ""),
      controllerToken: String(message.controllerToken || ""),
      inviteToken: String(message.inviteToken || ""),
      speakerUrl: message.speakerUrl || speakerUrlForRoom(message.roomId, message.inviteToken),
      expiresAt: Number(message.expiresAt || 0)
    };
    state.speakers.clear();
    state.connectionState = "online";
    startHeartbeat();
    publishRoomStatus();
    setCaptureStatus({ phase: "idle", detail: "Room ready. Add a Speaker before starting audio." });
    return;
  }
  if (message.type === "room:resumed") {
    state.connectionState = "online";
    if (state.room) state.room.expiresAt = Number(message.expiresAt || state.room.expiresAt);
    reconcileSpeakers(message.speakers || []);
    startHeartbeat();
    publishRoomStatus();
    return;
  }
  if (message.type === "room:state") {
    if (state.room) state.room.expiresAt = Number(message.expiresAt || state.room.expiresAt);
    publishRoomStatus();
    return;
  }
  if (message.type === "peer:joined") {
    const speaker = normalizeSpeaker(message.peer);
    if (!speaker) return;
    state.speakers.set(speaker.peerId, speaker);
    if (state.stream && state.phase === "measuring") state.requiredPeerIds.add(speaker.peerId);
    publishRoomStatus();
    if (state.stream) await createPeer(speaker.peerId);
    return;
  }
  if (message.type === "peer:left") {
    const peerId = String(message.peerId || "");
    state.speakers.delete(peerId);
    state.requiredPeerIds.delete(peerId);
    closePeer(peerId);
    publishRoomStatus();
    evaluateInitialLock();
    return;
  }
  if (message.type === "signal") {
    await handlePeerSignal(String(message.fromPeerId || ""), message.signal);
    return;
  }
  if (message.type === "heartbeat") {
    if (state.room) state.room.expiresAt = Math.max(state.room.expiresAt, Date.now() + 60_000);
    return;
  }
  if (message.type === "room:replaced") {
    state.connectionState = "offline";
    setCaptureStatus({ phase: "error", detail: "This Controller room was opened by another extension session." });
    return;
  }
  if (message.type === "room:closed") {
    clearRoomLocally("Room ended. Create a new room to continue.");
    return;
  }
  if (message.type === "error") {
    setCaptureStatus({ phase: "error", detail: message.message || "The signaling service reported an error." });
  }
}

function reconcileSpeakers(speakers) {
  const next = new Map();
  for (const value of speakers) {
    const speaker = normalizeSpeaker(value);
    if (speaker) next.set(speaker.peerId, speaker);
  }
  for (const peerId of state.speakers.keys()) {
    if (!next.has(peerId)) closePeer(peerId);
  }
  state.speakers = next;
  if (state.stream && state.phase === "measuring") {
    state.requiredPeerIds = new Set(next.keys());
  }
  if (state.stream) {
    for (const peerId of next.keys()) createPeer(peerId).catch(() => schedulePeerRepair(peerId));
  }
}

function scheduleSignalingReconnect() {
  if (state.reconnectTimer || !state.room) return;
  const delayMs = Math.min(5_000, 500 * 2 ** Math.min(state.reconnectAttempt, 3));
  state.reconnectAttempt += 1;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connectSignaling("resume").catch(() => scheduleSignalingReconnect());
  }, delayMs);
}

function startHeartbeat() {
  clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = setInterval(() => sendSignaling({ type: "heartbeat" }), HEARTBEAT_INTERVAL_MS);
}

async function startPluginCapture({ streamId, tabTitle, tabId } = {}) {
  if (!state.room) throw new Error("Create a room first.");
  if (!state.speakers.size) throw new Error("Add at least one Speaker before starting audio.");
  if (state.socket?.readyState !== WebSocket.OPEN) await connectSignaling("resume");
  if (!globalThis.RTCPeerConnection) throw new Error("This Chrome version does not support WebRTC audio.");
  if (state.stream) stopPluginCapture({ publishStatus: false });

  state.captureStopping = false;
  state.captureGeneration += 1;
  const generation = state.captureGeneration;
  state.tabTitle = String(tabTitle || "Current Chrome tab").slice(0, 120);
  state.tabId = tabId;
  state.phase = "measuring";
  state.phaseStartedAt = Date.now();
  state.playAt = 0;
  state.initializationIssue = "";
  state.roomTargetMs = PLUGIN_ROOM_POLICY.minimumRoomTargetMs;
  state.requiredPeerIds = new Set(state.speakers.keys());
  setCaptureStatus({ phase: "connecting", detail: "Accessing current tab audio..." });

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });
  if (generation !== state.captureGeneration) {
    for (const track of stream.getTracks()) track.stop();
    return;
  }
  state.stream = stream;
  for (const track of stream.getAudioTracks()) {
    try {
      track.contentHint = "music";
    } catch {}
  }
  for (const track of stream.getTracks()) {
    track.addEventListener("ended", () => {
      if (generation === state.captureGeneration) {
        stopPluginCapture({ detail: "The captured tab ended. The room remains open." });
      }
    }, { once: true });
  }

  await prepareLocalOutput(stream, state.roomTargetMs);
  for (const peerId of state.requiredPeerIds) {
    createPeer(peerId).catch(() => schedulePeerRepair(peerId));
  }
  clearInterval(state.phaseTimer);
  state.phaseTimer = setInterval(updateCaptureStatus, 250);
  updateCaptureStatus();
  publishRoomStatus();
}

async function createPeer(peerId) {
  const id = String(peerId || "");
  if (!id || !state.stream || !state.speakers.has(id)) return;
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  if (state.peers.has(id)) return;

  const connection = new RTCPeerConnection({ iceServers: state.iceServers });
  const control = connection.createDataChannel("home-cinema-control", { ordered: true });
  const peer = {
    id,
    connection,
    control,
    pendingRemoteCandidates: [],
    pendingLocalCandidates: [],
    localDescriptionSent: false,
    ready: false,
    unlocked: false,
    timingSamples: [],
    timing: { stable: false, delayMs: null, spreadMs: null },
    clockSamples: [],
    clock: null,
    clockTimers: [],
    disconnectTimer: null,
    playbackJoined: false,
    lateBlocked: false,
    timingEstimated: false,
    closing: false
  };
  state.peers.set(id, peer);

  for (const track of state.stream.getAudioTracks()) connection.addTrack(track, state.stream);
  setupControlChannel(peer);
  connection.addEventListener("icecandidate", (event) => {
    if (!event.candidate) return;
    const candidate = event.candidate.toJSON ? event.candidate.toJSON() : event.candidate;
    if (!peer.localDescriptionSent) peer.pendingLocalCandidates.push(candidate);
    else sendPeerSignal(id, { candidate });
  });
  connection.addEventListener("connectionstatechange", () => {
    if (peer.closing) return;
    if (connection.connectionState === "connected") {
      clearTimeout(peer.disconnectTimer);
      state.peerRepairAttempts.delete(id);
      updateCaptureStatus();
      return;
    }
    if (connection.connectionState === "failed") {
      schedulePeerRepair(id);
      return;
    }
    if (connection.connectionState === "disconnected" && !peer.disconnectTimer) {
      peer.disconnectTimer = setTimeout(() => {
        if (connection.connectionState === "disconnected") schedulePeerRepair(id);
      }, 2_500);
    }
  });

  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  sendPeerSignal(id, { description: serializeDescription(connection.localDescription) });
  peer.localDescriptionSent = true;
  for (const candidate of peer.pendingLocalCandidates.splice(0)) sendPeerSignal(id, { candidate });
}

function setupControlChannel(peer) {
  const channel = peer.control;
  channel.addEventListener("open", () => {
    sendControl(peer, {
      type: "session",
      title: state.tabTitle || "Live tab audio",
      roomTargetMs: state.roomTargetMs
    });
    probePeerClock(peer);
  });
  channel.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleControlMessage(peer, message);
  });
  channel.addEventListener("close", () => {
    if (!peer.closing && state.stream && !state.captureStopping && state.speakers.has(peer.id)) {
      schedulePeerRepair(peer.id);
    }
  });
}

function handleControlMessage(peer, message) {
  if (message.type === "speaker:ready") {
    peer.ready = true;
    peer.unlocked = Boolean(message.unlocked);
    const speaker = state.speakers.get(peer.id);
    if (speaker && message.name) speaker.name = String(message.name).slice(0, 40);
    publishRoomStatus();
    evaluatePeerTiming(peer);
    return;
  }
  if (message.type === "speaker:name") {
    const speaker = state.speakers.get(peer.id);
    if (speaker && message.name) speaker.name = String(message.name).slice(0, 40);
    publishRoomStatus();
    return;
  }
  if (message.type === "clock:pong") {
    const sample = clockOffsetSample({
      controllerSentAt: message.controllerSentAt,
      speakerReceivedAt: message.speakerReceivedAt,
      speakerSentAt: message.speakerSentAt,
      controllerReceivedAt: Date.now()
    });
    if (!sample) return;
    peer.clockSamples = [...peer.clockSamples, sample].slice(-CLOCK_PROBE_COUNT);
    peer.clock = bestClockOffset(peer.clockSamples);
    if (peer.clock) {
      sendControl(peer, {
        type: "clock:sync",
        speakerOffsetMs: peer.clock.speakerOffsetMs,
        roundTripMs: peer.clock.roundTripMs
      });
    }
    evaluatePeerTiming(peer);
    return;
  }
  if (message.type === "speaker:timing") {
    peer.timingEstimated = Boolean(message.estimated);
    peer.timingSamples = appendPluginTimingSample(peer.timingSamples, {
      observedAt: Date.now(),
      playoutDelayMs: message.playoutDelayMs,
      outputLatencyMs: message.outputLatencyMs,
      rtpProgress: message.rtpProgress
    });
    peer.timing = stablePluginTiming(peer.timingSamples);
    evaluatePeerTiming(peer);
  }
}

function probePeerClock(peer) {
  for (const timer of peer.clockTimers) clearTimeout(timer);
  peer.clockTimers = [];
  for (let sequence = 0; sequence < CLOCK_PROBE_COUNT; sequence += 1) {
    const timer = setTimeout(() => {
      sendControl(peer, { type: "clock:ping", sequence, controllerSentAt: Date.now() });
    }, sequence * CLOCK_PROBE_INTERVAL_MS);
    peer.clockTimers.push(timer);
  }
}

function evaluatePeerTiming(peer) {
  if (!state.stream) return;
  if (state.phase === "measuring") {
    evaluateInitialLock();
    return;
  }
  if (["armed", "playing"].includes(state.phase)) tryArmLatePeer(peer);
}

function evaluateInitialLock() {
  if (state.phase !== "measuring" || !state.stream) return;
  const required = [...state.requiredPeerIds].filter((peerId) => state.speakers.has(peerId));
  if (!required.length) {
    updateCaptureStatus();
    return;
  }
  const peers = required.map((peerId) => state.peers.get(peerId));
  const allStable = peers.every((peer) => peer && peer.ready && peer.unlocked && peer.clock && peer.timing.stable);
  if (allStable) armInitialRoom(peers).catch((error) => {
    setCaptureStatus({ phase: "error", detail: error.message || "Could not arm synchronized playback." });
  });
  else updateCaptureStatus();
}

async function armInitialRoom(peers) {
  if (state.phase !== "measuring") return;
  const timingCandidates = [
    ...peers.map((peer) => ({
      ...peer.timing,
      delayMs: Number(peer.timing.delayMs) + (peer.timingEstimated ? PLUGIN_ROOM_POLICY.estimatedTimingSafetyMs : 0)
    })),
    { stable: true, delayMs: state.localOutputLatencyMs }
  ];
  if (timingCandidates.some((timing) => Number(timing.delayMs) > PLUGIN_ROOM_POLICY.maximumRoomTargetMs)) {
    state.initializationIssue = "A Speaker audio path is slower than the 500 ms room limit.";
    updateCaptureStatus();
    return;
  }
  state.initializationIssue = "";
  state.phase = "armed";
  state.roomTargetMs = choosePluginRoomTarget(timingCandidates);
  await setLocalRoomTarget(state.roomTargetMs);
  const controllerStartMs = Date.now() + INITIAL_START_LEAD_MS;
  state.playAt = controllerStartMs;
  for (const peer of peers) {
    peer.playbackJoined = true;
    sendControl(peer, { type: "target", roomTargetMs: state.roomTargetMs });
    sendControl(peer, {
      type: "arm",
      controllerStartMs,
      roomTargetMs: state.roomTargetMs,
      volume: state.volume
    });
  }
  armLocalOutput(controllerStartMs);
  updateCaptureStatus();
  publishRoomStatus();
}

function tryArmLatePeer(peer) {
  if (!peer || peer.playbackJoined || !peer.ready || !peer.unlocked || !peer.clock || !peer.timing.stable) return;
  const effectiveDelayMs = Number(peer.timing.delayMs) +
    (peer.timingEstimated ? PLUGIN_ROOM_POLICY.estimatedTimingSafetyMs : 0);
  if (effectiveDelayMs > state.roomTargetMs) {
    peer.lateBlocked = true;
    updateCaptureStatus();
    return;
  }
  const controllerStartMs = Date.now() + LATE_JOIN_LEAD_MS;
  peer.playbackJoined = true;
  peer.lateBlocked = false;
  sendControl(peer, { type: "target", roomTargetMs: state.roomTargetMs });
  sendControl(peer, {
    type: "arm",
    controllerStartMs,
    roomTargetMs: state.roomTargetMs,
    volume: state.volume
  });
  updateCaptureStatus();
}

async function handlePeerSignal(peerId, signal) {
  if (!peerId || !signal || typeof signal !== "object") return;
  let peer = state.peers.get(peerId);
  if (!peer && state.peerRepairTimers.has(peerId)) return;
  if (!peer && state.stream && state.speakers.has(peerId)) {
    await createPeer(peerId);
    peer = state.peers.get(peerId);
  }
  if (!peer) return;
  if (signal.description) {
    await peer.connection.setRemoteDescription(signal.description);
    for (const candidate of peer.pendingRemoteCandidates.splice(0)) {
      await peer.connection.addIceCandidate(candidate);
    }
    return;
  }
  if (signal.candidate) {
    if (peer.connection.remoteDescription) await peer.connection.addIceCandidate(signal.candidate);
    else peer.pendingRemoteCandidates.push(signal.candidate);
  }
}

function schedulePeerRepair(peerId) {
  const id = String(peerId || "");
  if (!id || state.captureStopping || !state.stream || !state.speakers.has(id)) return;
  if (state.peerRepairTimers.has(id)) return;
  closePeer(id);
  const attempt = (state.peerRepairAttempts.get(id) || 0) + 1;
  state.peerRepairAttempts.set(id, attempt);
  const delayMs = Math.min(5_000, 700 * 2 ** Math.min(attempt - 1, 3));
  const timer = setTimeout(() => {
    state.peerRepairTimers.delete(id);
    createPeer(id).catch(() => schedulePeerRepair(id));
  }, delayMs);
  state.peerRepairTimers.set(id, timer);
  updateCaptureStatus();
}

function closePeer(peerId) {
  const id = String(peerId || "");
  const peer = state.peers.get(id);
  if (!peer) return;
  state.peers.delete(id);
  peer.closing = true;
  clearTimeout(peer.disconnectTimer);
  for (const timer of peer.clockTimers) clearTimeout(timer);
  try {
    peer.control.close();
  } catch {}
  try {
    peer.connection.close();
  } catch {}
}

async function prepareLocalOutput(stream, targetMs) {
  if (state.audioContext) {
    await setLocalRoomTarget(targetMs);
    return;
  }
  const AudioApi = window.AudioContext || window.webkitAudioContext;
  if (!AudioApi) throw new Error("Web Audio is not available in this Chrome version.");
  let audioContext;
  try {
    audioContext = new AudioApi({ latencyHint: "interactive" });
  } catch {
    audioContext = new AudioApi();
  }
  const source = audioContext.createMediaStreamSource(stream);
  const delay = audioContext.createDelay(1.2);
  const gain = audioContext.createGain();
  gain.gain.setValueAtTime(0, audioContext.currentTime);
  source.connect(delay).connect(gain).connect(audioContext.destination);
  state.audioContext = audioContext;
  state.localSource = source;
  state.localDelay = delay;
  state.localGain = gain;
  if (audioContext.state === "suspended") await audioContext.resume();
  await setLocalRoomTarget(targetMs);
}

async function setLocalRoomTarget(targetMs) {
  if (!state.audioContext || !state.localDelay) return;
  state.localOutputLatencyMs = Math.max(
    0,
    (Number(state.audioContext.baseLatency || 0) + Number(state.audioContext.outputLatency || 0)) * 1000
  );
  const delaySeconds = Math.max(0, Math.min(1, (Number(targetMs) - state.localOutputLatencyMs) / 1000));
  const now = state.audioContext.currentTime;
  state.localDelay.delayTime.cancelScheduledValues(now);
  state.localDelay.delayTime.setValueAtTime(delaySeconds, now);
}

function armLocalOutput(controllerStartMs) {
  if (!state.audioContext || !state.localGain) return;
  const now = state.audioContext.currentTime;
  const startAt = now + Math.max(
    0,
    (controllerStartMs - Date.now() - state.localOutputLatencyMs) / 1000
  );
  const parameter = state.localGain.gain;
  parameter.cancelScheduledValues(now);
  parameter.setValueAtTime(0, now);
  parameter.setValueAtTime(0, startAt);
  parameter.linearRampToValueAtTime(state.volume, startAt + 0.1);
}

function setPluginVolume(value) {
  state.volume = Math.max(0, Math.min(1, Number(value) || 0));
  for (const peer of state.peers.values()) sendControl(peer, { type: "volume", value: state.volume });
  if (state.phase === "playing" && state.audioContext && state.localGain) {
    state.localGain.gain.linearRampToValueAtTime(state.volume, state.audioContext.currentTime + 0.08);
  }
  publishRoomStatus();
}

function updateCaptureStatus() {
  if (!state.stream) return;
  if (state.phase === "measuring") {
    const required = [...state.requiredPeerIds].filter((peerId) => state.speakers.has(peerId));
    const peers = required.map((peerId) => state.peers.get(peerId));
    const stableCount = peers.filter((peer) => peer?.ready && peer?.unlocked && peer?.clock && peer?.timing?.stable).length;
    const sampleCount = peers.length
      ? Math.min(...peers.map((peer) => Math.min(PLUGIN_ROOM_POLICY.sampleWindow, peer?.timingSamples?.length || 0)))
      : 0;
    const elapsedMs = Math.max(0, Date.now() - state.phaseStartedAt);
    const blocked = elapsedMs >= INITIALIZATION_TIMEOUT_MS || Boolean(state.initializationIssue);
    const sampleProgress = sampleCount / PLUGIN_ROOM_POLICY.sampleWindow;
    const speakerProgress = required.length ? stableCount / required.length : 0;
    const progress = Math.min(90, Math.round((sampleProgress * 0.65 + speakerProgress * 0.35) * 90));
    const lockedButMuted = peers.filter((peer) => peer?.ready && !peer?.unlocked).length;
    setCaptureStatus({
      phase: "connecting",
      stage: "measuring",
      progress,
      sampleCount,
      sampleTarget: PLUGIN_ROOM_POLICY.sampleWindow,
      stableSpeakers: stableCount,
      requiredSpeakers: required.length,
      elapsedMs,
      timeoutMs: INITIALIZATION_TIMEOUT_MS,
      blocked,
      detail: state.initializationIssue || (blocked
        ? "Initialization is waiting for a Speaker. Check that every Speaker is enabled."
        : lockedButMuted
          ? "A Speaker is connected but still needs Enable speaker."
          : `Measuring ${stableCount}/${required.length} Speakers; all outputs remain muted...`)
    });
    return;
  }
  if (state.phase === "armed") {
    const remainingMs = state.playAt - Date.now();
    if (remainingMs > 0) {
      setCaptureStatus({
        phase: "connecting",
        stage: "armed",
        progress: Math.min(99, Math.round(90 + (1 - remainingMs / INITIAL_START_LEAD_MS) * 10)),
        sampleCount: PLUGIN_ROOM_POLICY.sampleWindow,
        sampleTarget: PLUGIN_ROOM_POLICY.sampleWindow,
        stableSpeakers: state.requiredPeerIds.size,
        requiredSpeakers: state.requiredPeerIds.size,
        detail: `Synchronized playback starts in ${Math.max(1, Math.ceil(remainingMs / 1000))}...`
      });
      return;
    }
    state.phase = "playing";
    publishRoomStatus();
  }
  if (state.phase === "playing") {
    const joined = [...state.peers.values()].filter((peer) => peer.playbackJoined).length;
    const blocked = [...state.peers.values()].filter((peer) => peer.lateBlocked).length;
    const repairing = state.peerRepairTimers.size;
    setCaptureStatus({
      phase: "capturing",
      stage: "playing",
      progress: 100,
      detail: blocked
        ? `${joined} Speakers playing; ${blocked} joined too late and needs the next restart.`
        : repairing
          ? `${joined} Speakers playing; repairing ${repairing} connection${repairing === 1 ? "" : "s"}.`
          : `Sharing synchronized audio with ${joined} Speaker${joined === 1 ? "" : "s"}.`
    });
  }
}

function stopPluginCapture({ detail = "Tab audio stopped.", publishStatus = true } = {}) {
  if (state.captureStopping) return;
  state.captureStopping = true;
  state.captureGeneration += 1;
  for (const peer of state.peers.values()) sendControl(peer, { type: "stop" });
  for (const peerId of [...state.peers.keys()]) closePeer(peerId);
  for (const timer of state.peerRepairTimers.values()) clearTimeout(timer);
  state.peerRepairTimers.clear();
  state.peerRepairAttempts.clear();
  clearInterval(state.phaseTimer);
  state.phaseTimer = null;
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
    state.stream = null;
  }
  try {
    state.localSource?.disconnect();
  } catch {}
  if (state.audioContext) state.audioContext.close().catch(() => {});
  state.audioContext = null;
  state.localSource = null;
  state.localDelay = null;
  state.localGain = null;
  state.localOutputLatencyMs = 0;
  state.requiredPeerIds.clear();
  state.phase = "idle";
  state.phaseStartedAt = 0;
  state.initializationIssue = "";
  state.playAt = 0;
  state.tabTitle = "";
  state.tabId = null;
  state.captureStopping = false;
  if (publishStatus) setCaptureStatus({ phase: "idle", detail });
  publishRoomStatus();
}

function closePluginRoom() {
  stopPluginCapture({ detail: "Room closed." });
  if (state.socket?.readyState === WebSocket.OPEN) sendSignaling({ type: "room:close" });
  clearRoomLocally("Create a room to add Speakers.");
}

function clearRoomLocally(detail) {
  if (state.stream) stopPluginCapture({ publishStatus: false });
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
  const socket = state.socket;
  state.socket = null;
  if (socket) {
    state.intentionalSockets.add(socket);
    try {
      socket.close();
    } catch {}
  }
  state.room = null;
  state.speakers.clear();
  state.connectionState = "offline";
  state.reconnectAttempt = 0;
  publishRoomStatus();
  setCaptureStatus({ phase: "idle", detail });
}

function sendPeerSignal(peerId, signal) {
  sendSignaling({ type: "signal", targetPeerId: String(peerId), signal });
}

function sendSignaling(message) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return false;
  state.socket.send(JSON.stringify(message));
  return true;
}

function sendControl(peer, message) {
  if (!peer?.control || peer.control.readyState !== "open") return false;
  peer.control.send(JSON.stringify(message));
  return true;
}

function publicRoomStatus() {
  return {
    exists: Boolean(state.room),
    roomId: state.room?.id || "",
    speakerUrl: state.room?.speakerUrl || "",
    speakerCount: state.speakers.size,
    speakers: [...state.speakers.values()].map(({ peerId, name }) => ({ peerId, name })),
    connection: state.connectionState,
    signalingOrigin: state.signalingOrigin,
    expiresAt: state.room?.expiresAt || 0,
    capturePhase: state.phase,
    roomTargetMs: state.roomTargetMs,
    volume: state.volume,
    updatedAt: Date.now()
  };
}

function publishRoomStatus() {
  sendRuntimeMessage({ type: "plugin-room-status", status: publicRoomStatus() });
}

function setCaptureStatus(status) {
  sendRuntimeMessage({
    type: "capture-status",
    status: {
      ...status,
      plugin: true,
      roomId: state.room?.id || "",
      updatedAt: Date.now()
    }
  });
}

function sendRuntimeMessage(message) {
  try {
    const result = chrome.runtime.sendMessage(message);
    result?.catch?.(() => {});
  } catch {}
}

function normalizeSpeaker(value) {
  const peerId = String(value?.peerId || "");
  if (!peerId) return null;
  return {
    peerId,
    name: String(value?.name || "Speaker").slice(0, 40),
    deviceId: String(value?.deviceId || "")
  };
}

function speakerUrlForRoom(roomId, inviteToken) {
  const url = new URL("/speaker", state.signalingOrigin);
  url.searchParams.set("room", String(roomId || ""));
  url.searchParams.set("invite", String(inviteToken || ""));
  return url.toString();
}

function serializeDescription(description) {
  return description?.toJSON ? description.toJSON() : description;
}
