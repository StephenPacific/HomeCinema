import {
  appendPluginTimingSample,
  PLUGIN_ROOM_POLICY,
  signalingWebSocketUrl,
  stablePluginTiming,
  webRtcFallbackDelaySample,
  webRtcPlayoutDelaySample
} from "/plugin-room.js";

const elements = {
  roomCode: document.querySelector("#roomCode"),
  connectionState: document.querySelector("#connectionState"),
  sessionTitle: document.querySelector("#sessionTitle"),
  statusBanner: document.querySelector("#statusBanner"),
  statusTitle: document.querySelector("#statusTitle"),
  statusDetail: document.querySelector("#statusDetail"),
  enableButton: document.querySelector("#enableButton"),
  networkMetric: document.querySelector("#networkMetric"),
  outputMetric: document.querySelector("#outputMetric"),
  targetMetric: document.querySelector("#targetMetric"),
  controllerName: document.querySelector("#controllerName"),
  deviceName: document.querySelector("#deviceName"),
  diagnosticState: document.querySelector("#diagnosticState"),
  rtcState: document.querySelector("#rtcState"),
  audioState: document.querySelector("#audioState"),
  playoutMetric: document.querySelector("#playoutMetric"),
  compensationMetric: document.querySelector("#compensationMetric"),
  clockMetric: document.querySelector("#clockMetric")
};

const params = new URLSearchParams(location.search);
const roomId = String(params.get("room") || "").trim().toUpperCase();
const inviteToken = String(params.get("invite") || "").trim();
const state = {
  socket: null,
  socketReconnectTimer: null,
  peerId: "",
  peerConnection: null,
  peerDisconnectTimer: null,
  pendingCandidates: [],
  receiver: null,
  stream: null,
  control: null,
  audioContext: null,
  source: null,
  delay: null,
  gain: null,
  unlocked: false,
  targetMs: PLUGIN_ROOM_POLICY.minimumRoomTargetMs,
  measuredPlayoutMs: null,
  outputLatencyMs: 0,
  postDelayMs: 0,
  appliedPostDelayMs: null,
  lastDelayAdjustmentAt: 0,
  previousInbound: null,
  timingEstimated: false,
  timingSamples: [],
  statsTimer: null,
  speakerOffsetMs: 0,
  armed: false,
  volume: 1,
  iceServers: [],
  deviceId: localStorage.getItem("homeCinemaPluginDeviceId") || crypto.randomUUID(),
  deviceName: localStorage.getItem("homeCinemaPluginDeviceName") || defaultDeviceName()
};

localStorage.setItem("homeCinemaPluginDeviceId", state.deviceId);
elements.roomCode.textContent = roomId || "INVALID";
elements.deviceName.value = state.deviceName;
elements.enableButton.addEventListener("click", unlockSpeaker);
elements.deviceName.addEventListener("change", () => {
  state.deviceName = String(elements.deviceName.value || "Speaker").trim().slice(0, 40) || "Speaker";
  elements.deviceName.value = state.deviceName;
  localStorage.setItem("homeCinemaPluginDeviceName", state.deviceName);
  sendControl({ type: "speaker:name", name: state.deviceName });
});

if (!roomId || !inviteToken) {
  setConnection("Invalid room", "error");
  setStatus("Invitation missing", "Scan the QR code shown by the Home Cinema extension.", "error");
  elements.enableButton.disabled = true;
} else {
  initialize().catch((error) => {
    setConnection("Unavailable", "error");
    setStatus("Could not join room", error.message || "The signaling service is unavailable.", "error");
  });
}

async function initialize() {
  try {
    const response = await fetch("/config", { cache: "no-store" });
    if (response.ok) {
      const config = await response.json();
      state.iceServers = Array.isArray(config.iceServers) ? config.iceServers : [];
    }
  } catch {}
  connectSocket();
}

function connectSocket() {
  clearTimeout(state.socketReconnectTimer);
  state.socketReconnectTimer = null;
  setConnection("Connecting");
  const socket = new WebSocket(signalingWebSocketUrl(location.origin));
  state.socket = socket;
  socket.addEventListener("open", () => {
    if (state.socket !== socket) return;
    socket.send(JSON.stringify({
      type: "room:join",
      roomId,
      inviteToken,
      deviceId: state.deviceId,
      name: state.deviceName
    }));
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleSocketMessage(message).catch((error) => {
      setStatus("WebRTC setup failed", error.message || "Could not configure this Speaker.", "error");
    });
  });
  socket.addEventListener("close", () => {
    if (state.socket !== socket) return;
    state.socket = null;
    setConnection("Reconnecting");
    setStatus("Room connection interrupted", "Trying to reconnect without changing this device.");
    state.socketReconnectTimer = setTimeout(connectSocket, 1200);
  });
  socket.addEventListener("error", () => setConnection("Reconnecting"));
}

async function handleSocketMessage(message) {
  if (message.type === "hello") {
    if (Array.isArray(message.iceServers)) state.iceServers = message.iceServers;
    return;
  }
  if (message.type === "room:joined") {
    state.peerId = String(message.peerId || "");
    elements.controllerName.textContent = message.controllerName || "Home Cinema Controller";
    setConnection(message.controllerOnline ? "Room ready" : "Waiting");
    setStatus(
      message.controllerOnline ? "Connected to room" : "Waiting for Controller",
      state.unlocked ? "The Speaker is ready for WebRTC audio." : "Tap Enable speaker once on this device."
    );
    return;
  }
  if (message.type === "room:state") {
    setConnection(message.controllerOnline ? "Room ready" : "Waiting");
    return;
  }
  if (message.type === "controller:offline") {
    setConnection("Controller offline");
    setStatus("Waiting for Controller", "The room will remain available briefly while the extension reconnects.");
    return;
  }
  if (message.type === "controller:online") {
    setConnection("Room ready");
    return;
  }
  if (message.type === "signal") {
    await handleSignal(message.signal);
    return;
  }
  if (message.type === "room:closed") {
    setConnection("Room closed", "error");
    setStatus("Room ended", "Create or scan a new room from the extension.", "error");
    closePeer();
    return;
  }
  if (message.type === "room:replaced") {
    setStatus("Opened on another tab", "This Speaker identity moved to a newer connection.", "error");
    return;
  }
  if (message.type === "error") {
    setConnection("Join failed", "error");
    setStatus("Could not join room", message.message || message.code || "Signaling error", "error");
  }
}

async function handleSignal(signal) {
  if (!signal || typeof signal !== "object") return;
  if (signal.description?.type === "offer") {
    closePeer();
    createPeer();
    await state.peerConnection.setRemoteDescription(signal.description);
    for (const candidate of state.pendingCandidates.splice(0)) {
      await state.peerConnection.addIceCandidate(candidate);
    }
    const answer = await state.peerConnection.createAnswer();
    await state.peerConnection.setLocalDescription(answer);
    sendSignal({ description: serializeDescription(state.peerConnection.localDescription) });
    return;
  }
  if (signal.candidate) {
    if (!state.peerConnection) createPeer();
    if (state.peerConnection.remoteDescription) await state.peerConnection.addIceCandidate(signal.candidate);
    else state.pendingCandidates.push(signal.candidate);
  }
}

function createPeer() {
  if (state.peerConnection) return state.peerConnection;
  const connection = new RTCPeerConnection({ iceServers: state.iceServers });
  state.peerConnection = connection;
  state.pendingCandidates = [];
  connection.addEventListener("icecandidate", (event) => {
    if (!event.candidate) return;
    sendSignal({ candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate });
  });
  connection.addEventListener("connectionstatechange", () => {
    elements.rtcState.textContent = titleCase(connection.connectionState || "new");
    elements.diagnosticState.textContent = titleCase(connection.connectionState || "waiting");
    if (connection.connectionState === "connected") {
      clearTimeout(state.peerDisconnectTimer);
      state.peerDisconnectTimer = null;
      setConnection("Receiving", "online");
      setStatus("WebRTC connected", state.unlocked ? "Measuring the local audio path while muted." : "Tap Enable speaker to hear this room.");
    } else if (connection.connectionState === "disconnected") {
      clearTimeout(state.peerDisconnectTimer);
      state.peerDisconnectTimer = setTimeout(() => {
        if (state.peerConnection === connection && connection.connectionState === "disconnected") {
          muteOutput(0.16);
          setStatus("Audio path interrupted", "Waiting for the extension to repair this connection.", "error");
        }
      }, 700);
    } else if (["failed", "closed"].includes(connection.connectionState)) {
      clearTimeout(state.peerDisconnectTimer);
      state.peerDisconnectTimer = null;
      muteOutput(0.16);
      setStatus("WebRTC interrupted", "Waiting for the extension to rebuild this Speaker connection.", "error");
    }
  });
  connection.addEventListener("track", (event) => {
    state.receiver = event.receiver;
    if (state.receiver && "jitterBufferTarget" in state.receiver) {
      try {
        state.receiver.jitterBufferTarget = PLUGIN_ROOM_POLICY.receiverBufferTargetMs;
      } catch {}
    }
    state.stream = event.streams[0] || new MediaStream([event.track]);
    if (state.unlocked) attachAudioGraph().catch(() => {});
    setStatus("Audio path received", state.unlocked ? "Measuring timing before playback." : "Tap Enable speaker to unlock local audio.");
  });
  connection.addEventListener("datachannel", (event) => setupControlChannel(event.channel));
  return connection;
}

function setupControlChannel(channel) {
  state.control = channel;
  channel.addEventListener("open", () => {
    sendControl({ type: "speaker:ready", name: state.deviceName, unlocked: state.unlocked });
  });
  channel.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleControlMessage(message);
  });
  channel.addEventListener("close", () => {
    if (state.control !== channel) return;
    state.control = null;
    muteOutput(0.16);
    setStatus("Controller audio interrupted", "Waiting for the extension to rebuild this connection.", "error");
  });
}

function handleControlMessage(message) {
  if (message.type === "session") {
    elements.sessionTitle.textContent = message.title || "Live tab audio";
    setRoomTarget(message.roomTargetMs);
    return;
  }
  if (message.type === "clock:ping") {
    const receivedAt = Date.now();
    sendControl({
      type: "clock:pong",
      sequence: message.sequence,
      controllerSentAt: message.controllerSentAt,
      speakerReceivedAt: receivedAt,
      speakerSentAt: Date.now()
    });
    return;
  }
  if (message.type === "clock:sync") {
    state.speakerOffsetMs = Number(message.speakerOffsetMs || 0);
    elements.clockMetric.textContent = signedMs(state.speakerOffsetMs);
    return;
  }
  if (message.type === "target") {
    setRoomTarget(message.roomTargetMs);
    return;
  }
  if (message.type === "arm") {
    setRoomTarget(message.roomTargetMs);
    if (Number.isFinite(Number(message.volume))) state.volume = Math.max(0, Math.min(1, Number(message.volume)));
    armOutput(Number(message.controllerStartMs || 0) + state.speakerOffsetMs);
    return;
  }
  if (message.type === "stop") {
    muteOutput(0.16);
    setStatus("Output stopped", "The Controller stopped this room.");
    return;
  }
  if (message.type === "volume") setVolume(message.value);
}

async function unlockSpeaker() {
  elements.enableButton.disabled = true;
  try {
    await configureAudioSession();
    const AudioApi = window.AudioContext || window.webkitAudioContext;
    if (!AudioApi) throw new Error("Web Audio is not available on this browser.");
    if (!state.audioContext) {
      try {
        state.audioContext = new AudioApi({ latencyHint: "playback" });
      } catch {
        state.audioContext = new AudioApi();
      }
      state.delay = state.audioContext.createDelay(1.2);
      state.gain = state.audioContext.createGain();
      state.gain.gain.setValueAtTime(0, state.audioContext.currentTime);
      state.delay.connect(state.gain).connect(state.audioContext.destination);
    }
    await state.audioContext.resume();
    state.unlocked = state.audioContext.state === "running";
    elements.audioState.textContent = titleCase(state.audioContext.state);
    if (!state.unlocked) throw new Error("The browser kept its audio engine suspended.");
    if (state.stream) await attachAudioGraph();
    sendControl({ type: "speaker:ready", name: state.deviceName, unlocked: true });
    setStatus(
      state.stream ? "Speaker enabled" : "Speaker enabled",
      state.stream ? "Measuring timing before playback." : "Waiting for the extension to start tab audio.",
      "ready"
    );
    elements.enableButton.textContent = "Speaker enabled";
    startStats();
  } catch (error) {
    elements.enableButton.disabled = false;
    setStatus("Audio needs attention", error.message || "Tap Enable speaker again.", "error");
  }
}

async function configureAudioSession() {
  try {
    if (navigator.audioSession && "type" in navigator.audioSession) navigator.audioSession.type = "playback";
  } catch {}
}

async function attachAudioGraph() {
  if (!state.audioContext || !state.stream || !state.delay || !state.gain || state.source) return;
  state.source = state.audioContext.createMediaStreamSource(state.stream);
  state.source.connect(state.delay);
  startStats();
}

function startStats() {
  if (!state.receiver || !state.audioContext || state.statsTimer) return;
  collectStats();
  state.statsTimer = setInterval(collectStats, 500);
}

async function collectStats() {
  if (!state.receiver || !state.audioContext) return;
  try {
    const report = await state.receiver.getStats();
    let inbound = null;
    report.forEach((entry) => {
      if (entry.type === "inbound-rtp" && (entry.kind === "audio" || entry.mediaType === "audio")) inbound = entry;
    });
    if (!inbound) return;
    const sample = webRtcPlayoutDelaySample(inbound, state.previousInbound) ||
      webRtcFallbackDelaySample(inbound, state.previousInbound);
    state.previousInbound = inbound;
    if (!sample) return;
    state.timingEstimated = Boolean(sample.estimated);
    state.measuredPlayoutMs = Number.isFinite(state.measuredPlayoutMs)
      ? state.measuredPlayoutMs * 0.65 + sample.actualDelayMs * 0.35
      : sample.actualDelayMs;
    state.outputLatencyMs = Math.max(
      0,
      (Number(state.audioContext.baseLatency || 0) + Number(state.audioContext.outputLatency || 0)) * 1000
    );
    state.timingSamples = appendPluginTimingSample(state.timingSamples, {
      observedAt: Date.now(),
      playoutDelayMs: state.measuredPlayoutMs,
      outputLatencyMs: state.outputLatencyMs,
      rtpProgress: sample.rtpProgress
    });
    applyPostDelay();
    const stable = stablePluginTiming(state.timingSamples);
    sendControl({
      type: "speaker:timing",
      observedAt: Date.now(),
      playoutDelayMs: state.measuredPlayoutMs,
      outputLatencyMs: state.outputLatencyMs,
      rtpProgress: sample.rtpProgress,
      stable: stable.stable,
      delayMs: stable.delayMs,
      spreadMs: stable.spreadMs,
      estimated: state.timingEstimated
    });
    elements.playoutMetric.textContent = `${Math.round(state.measuredPlayoutMs)} ms`;
    elements.outputMetric.textContent = `${Math.round(state.outputLatencyMs)} ms`;
    elements.networkMetric.textContent = stable.stable
      ? state.timingEstimated ? "Estimated" : "Stable"
      : "Measuring";
  } catch {}
}

function setRoomTarget(value) {
  const target = Number(value);
  if (!Number.isFinite(target)) return;
  state.targetMs = Math.max(
    PLUGIN_ROOM_POLICY.minimumRoomTargetMs,
    Math.min(PLUGIN_ROOM_POLICY.maximumRoomTargetMs, target)
  );
  elements.targetMetric.textContent = `${Math.round(state.targetMs)} ms`;
  applyPostDelay();
}

function applyPostDelay({ force = false } = {}) {
  if (!state.audioContext || !state.delay || !Number.isFinite(state.measuredPlayoutMs)) return;
  const desiredMs = Math.max(0, state.targetMs - state.measuredPlayoutMs - state.outputLatencyMs);
  const nowEpoch = Date.now();
  if (!Number.isFinite(state.appliedPostDelayMs)) state.appliedPostDelayMs = desiredMs;
  if (state.armed && !force) {
    const errorMs = desiredMs - state.appliedPostDelayMs;
    if (Math.abs(errorMs) < 4 || nowEpoch - state.lastDelayAdjustmentAt < 2_500) return;
    state.appliedPostDelayMs += Math.max(-2, Math.min(2, errorMs * 0.2));
  } else {
    state.appliedPostDelayMs = desiredMs;
  }
  state.postDelayMs = state.appliedPostDelayMs;
  state.lastDelayAdjustmentAt = nowEpoch;
  const now = state.audioContext.currentTime;
  const parameter = state.delay.delayTime;
  const seconds = Math.min(1, state.postDelayMs / 1000);
  parameter.cancelScheduledValues(now);
  parameter.setValueAtTime(parameter.value, now);
  parameter.linearRampToValueAtTime(seconds, now + (state.armed ? 1.5 : 0.25));
  elements.compensationMetric.textContent = `${Math.round(state.postDelayMs)} ms`;
}

function armOutput(localStartEpochMs) {
  if (!state.audioContext || !state.gain || !state.unlocked) {
    setStatus("Tap Enable speaker", "Audio is ready, but this browser still requires a local tap.", "error");
    return;
  }
  const outputLatencySeconds = state.outputLatencyMs / 1000;
  const now = state.audioContext.currentTime;
  const startAt = now + Math.max(0, (localStartEpochMs - Date.now()) / 1000 - outputLatencySeconds);
  const parameter = state.gain.gain;
  parameter.cancelScheduledValues(now);
  parameter.setValueAtTime(0, now);
  parameter.setValueAtTime(0, startAt);
  parameter.linearRampToValueAtTime(state.volume, startAt + 1.2);
  state.armed = true;
  setStatus("Joining synchronized playback", "This Speaker will fade in after its timing lock.", "ready");
  setTimeout(() => {
    if (!state.armed) return;
    setStatus("Playing room audio", "Timing remains controlled by the Home Cinema extension.", "ready");
  }, Math.max(0, localStartEpochMs - Date.now()) + 1300);
}

function muteOutput(seconds = 0) {
  state.armed = false;
  if (!state.audioContext || !state.gain) return;
  const now = state.audioContext.currentTime;
  const parameter = state.gain.gain;
  parameter.cancelScheduledValues(now);
  parameter.setValueAtTime(parameter.value, now);
  if (seconds > 0) parameter.linearRampToValueAtTime(0, now + seconds);
  else parameter.setValueAtTime(0, now);
}

function setVolume(value) {
  const volume = Math.max(0, Math.min(1, Number(value) || 0));
  state.volume = volume;
  if (!state.audioContext || !state.gain || !state.armed) return;
  state.gain.gain.linearRampToValueAtTime(volume, state.audioContext.currentTime + 0.06);
}

function sendSignal(signal) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify({ type: "signal", targetPeerId: "controller", signal }));
}

function sendControl(message) {
  if (!state.control || state.control.readyState !== "open") return;
  state.control.send(JSON.stringify(message));
}

function closePeer() {
  clearTimeout(state.peerDisconnectTimer);
  state.peerDisconnectTimer = null;
  clearInterval(state.statsTimer);
  state.statsTimer = null;
  state.previousInbound = null;
  state.timingEstimated = false;
  state.timingSamples = [];
  state.appliedPostDelayMs = null;
  state.lastDelayAdjustmentAt = 0;
  state.receiver = null;
  state.stream = null;
  state.control = null;
  try {
    state.source?.disconnect();
  } catch {}
  state.source = null;
  muteOutput(0.12);
  try {
    state.peerConnection?.close();
  } catch {}
  state.peerConnection = null;
}

function setConnection(label, tone = "") {
  elements.connectionState.textContent = label;
  elements.connectionState.className = `connection-state ${tone}`.trim();
}

function setStatus(title, detail, tone = "") {
  elements.statusTitle.textContent = title;
  elements.statusDetail.textContent = detail;
  elements.statusBanner.className = `status-banner ${tone}`.trim();
}

function serializeDescription(description) {
  return description?.toJSON ? description.toJSON() : description;
}

function signedMs(value) {
  const rounded = Math.round(Number(value) || 0);
  return `${rounded >= 0 ? "+" : ""}${rounded} ms`;
}

function defaultDeviceName() {
  const platform = navigator.userAgentData?.platform || navigator.platform || "Speaker";
  return `${platform} Speaker`.slice(0, 40);
}

function titleCase(value) {
  const text = String(value || "");
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "Unknown";
}
