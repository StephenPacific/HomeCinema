const WEBRTC_TARGET_BUFFER_MS = 120;

const state = {
  audioContext: null,
  localDelay: null,
  localGain: null,
  localOutputLatencySeconds: 0,
  socket: null,
  stream: null,
  stopping: false,
  peers: new Map(),
  serverUrl: "",
  lastStatus: null,
  tabTitle: "",
  tabId: null,
  livePhase: "idle",
  roomTargetMs: WEBRTC_TARGET_BUFFER_MS,
  phaseProgress: 0,
  phaseSampleCount: 0,
  phaseSampleTarget: 3,
  stableSpeakers: 0,
  requiredSpeakers: 0,
  phaseElapsedMs: 0,
  phaseTimeoutMs: 0,
  phaseBlocked: false,
  unmuteAt: 0,
  countdownTimer: null,
  reconnectTimer: null,
  reconnectAttempt: 0
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "begin-capture-in-offscreen") {
    startCapture(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        finishCapture({ phase: "error", detail: error.message || "Could not capture this tab." });
        sendResponse({ ok: false, error: error.message || "Could not capture this tab." });
      });
    return true;
  }
  if (message.type === "stop-capture-in-offscreen") {
    finishCapture({ phase: "idle", detail: "Capture stopped." });
    sendResponse({ ok: true });
  }
});

async function startCapture({ streamId, serverUrl, tabTitle, tabId }) {
  if (state.stream || state.socket) finishCapture({ phase: "idle", detail: "Restarting capture." });
  state.stopping = false;
  state.serverUrl = serverUrl;
  state.tabTitle = tabTitle;
  state.tabId = tabId;
  setStatus({ phase: "connecting", detail: "Accessing current tab audio...", serverUrl, title: tabTitle });

  if (!globalThis.RTCPeerConnection) throw new Error("This Chrome version does not support WebRTC audio.");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });
  state.stream = stream;
  for (const track of stream.getTracks()) {
    track.addEventListener("ended", () => finishCapture({ phase: "idle", detail: "The captured tab ended." }), { once: true });
  }

  connectCaptureSocket();
}

function connectCaptureSocket() {
  if (state.stopping || !state.stream || !state.serverUrl) return;
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;

  const socket = new WebSocket(toWebSocketUrl(state.serverUrl));
  state.socket = socket;

  socket.addEventListener("open", () => {
    if (state.socket !== socket || state.stopping) return;
    state.reconnectAttempt = 0;
    socket.send(
      JSON.stringify({
        type: "identify",
        role: "capture",
        name: "Chrome tab capture",
        deviceKey: `chrome-tab-${state.tabId}`,
        ready: true,
        unlocked: true
      })
    );
    socket.send(
      JSON.stringify({
        type: "liveStart",
        name: state.tabTitle,
        mimeType: "audio/opus",
        transport: "webrtc",
        bufferMs: WEBRTC_TARGET_BUFFER_MS
      })
    );
    setStatus({
      phase: "connecting",
      detail: "Starting WebRTC audio...",
      serverUrl: state.serverUrl,
      title: state.tabTitle
    });
  });

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === "error") {
      setStatus({
        phase: "connecting",
        detail: `${message.message || "Home Cinema rejected the live stream."} Retrying...`,
        serverUrl: state.serverUrl,
        title: state.tabTitle
      });
      try {
        socket.close();
      } catch {}
      return;
    }
    if (message.type === "liveStart" && message.state?.live?.transport === "webrtc") {
      state.livePhase = message.state.live.phase || "measuring";
      state.roomTargetMs = Number(message.state.live.roomTargetMs || message.state.live.bufferMs || WEBRTC_TARGET_BUFFER_MS);
      updateLiveProgress(message.state.live);
      state.unmuteAt = 0;
      prepareLocalPlayback(state.stream, state.roomTargetMs).catch((error) => {
        finishCapture({ phase: "error", detail: error.message || "Could not start local audio." });
      });
      clearInterval(state.countdownTimer);
      state.countdownTimer = setInterval(updateCaptureStatus, 200);
      updateCaptureStatus();
      return;
    }
    if (message.type === "liveLock" && message.state?.live?.transport === "webrtc") {
      state.livePhase = "locking";
      state.roomTargetMs = Number(message.state.live.roomTargetMs || WEBRTC_TARGET_BUFFER_MS);
      updateLiveProgress(message.state.live);
      prepareLocalPlayback(state.stream, state.roomTargetMs).catch((error) => {
        finishCapture({ phase: "error", detail: error.message || "Could not lock local audio timing." });
      });
      updateCaptureStatus();
      return;
    }
    if (message.type === "liveArm" && message.state?.live?.transport === "webrtc") {
      state.livePhase = "armed";
      state.roomTargetMs = Number(message.state.live.roomTargetMs || WEBRTC_TARGET_BUFFER_MS);
      updateLiveProgress(message.state.live);
      const startDelayMs = Math.max(0, Number(message.state.live.playAt || 0) - Number(message.state.serverTime || 0));
      state.unmuteAt = Date.now() + startDelayMs;
      armLocalPlayback(state.stream, state.roomTargetMs, startDelayMs).catch((error) => {
        finishCapture({ phase: "error", detail: error.message || "Could not arm local audio." });
      });
      updateCaptureStatus();
      return;
    }
    if (message.type === "sync" && message.state?.live?.transport === "webrtc") {
      updateLiveProgress(message.state.live);
      updateCaptureStatus();
      return;
    }
    if (message.type === "liveStop") {
      finishCapture({ phase: "idle", detail: "Live capture was stopped by Home Cinema." }, false);
      return;
    }
    if (message.type === "webrtcPeerJoin") {
      createWebRtcPeer(Number(message.peerId)).catch((error) => {
        setStatus({ phase: "capturing", detail: error.message || "A speaker could not join WebRTC audio." });
      });
      return;
    }
    if (message.type === "webrtcPeerLeave") {
      closeWebRtcPeer(Number(message.peerId));
      updateCaptureStatus();
      return;
    }
    if (message.type === "webrtcSignal") {
      handleWebRtcSignal(Number(message.fromId), message.signal).catch((error) => {
        setStatus({ phase: "capturing", detail: error.message || "WebRTC signaling failed." });
      });
    }
  });

  socket.addEventListener("error", () => {
    if (state.socket !== socket || state.stopping) return;
    setStatus({
      phase: "connecting",
      detail: "Home Cinema connection interrupted. Retrying...",
      serverUrl: state.serverUrl,
      title: state.tabTitle
    });
  });
  socket.addEventListener("close", () => {
    if (!state.stopping && state.socket === socket) scheduleCaptureReconnect(socket);
  });
}

function scheduleCaptureReconnect(socket) {
  if (state.socket === socket) state.socket = null;
  for (const peerId of [...state.peers.keys()]) closeWebRtcPeer(peerId);
  clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  state.unmuteAt = 0;
  state.livePhase = "measuring";
  state.phaseProgress = 0;
  state.phaseSampleCount = 0;
  state.phaseBlocked = false;
  muteLocalPlayback();
  if (state.stopping || !state.stream || state.reconnectTimer) return;

  const retryMs = Math.min(5000, 500 * 2 ** Math.min(state.reconnectAttempt, 3));
  state.reconnectAttempt += 1;
  setStatus({
    phase: "connecting",
    detail: `Home Cinema disconnected. Retrying in ${Math.max(1, Math.ceil(retryMs / 1000))}s...`,
    serverUrl: state.serverUrl,
    title: state.tabTitle
  });
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connectCaptureSocket();
  }, retryMs);
}

async function createWebRtcPeer(peerId) {
  if (!peerId || !state.stream || !state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  if (state.peers.has(peerId)) return;

  const connection = new RTCPeerConnection({ iceServers: [] });
  const peer = {
    connection,
    pendingRemoteCandidates: [],
    pendingLocalCandidates: [],
    localDescriptionSent: false
  };
  state.peers.set(peerId, peer);

  for (const track of state.stream.getAudioTracks()) {
    try {
      track.contentHint = "music";
    } catch {}
    connection.addTrack(track, state.stream);
  }
  connection.addEventListener("icecandidate", (event) => {
    if (!event.candidate) return;
    const candidate = event.candidate.toJSON ? event.candidate.toJSON() : event.candidate;
    if (!peer.localDescriptionSent) {
      peer.pendingLocalCandidates.push(candidate);
      return;
    }
    sendWebRtcSignal(peerId, { candidate });
  });
  connection.addEventListener("connectionstatechange", () => {
    if (connection.connectionState === "failed") {
      closeWebRtcPeer(peerId);
      setStatus({ phase: "capturing", detail: "A speaker lost its WebRTC audio connection." });
      return;
    }
    updateCaptureStatus();
  });

  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  const description = connection.localDescription?.toJSON
    ? connection.localDescription.toJSON()
    : connection.localDescription;
  sendWebRtcSignal(peerId, { description });
  peer.localDescriptionSent = true;
  for (const candidate of peer.pendingLocalCandidates.splice(0)) {
    sendWebRtcSignal(peerId, { candidate });
  }
}

async function handleWebRtcSignal(peerId, signal) {
  if (!peerId || !signal || typeof signal !== "object") return;
  const peer = state.peers.get(peerId);
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

function sendWebRtcSignal(peerId, signal) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify({ type: "webrtcSignal", targetId: peerId, signal }));
}

function closeWebRtcPeer(peerId) {
  const peer = state.peers.get(peerId);
  if (!peer) return;
  state.peers.delete(peerId);
  try {
    peer.connection.close();
  } catch {}
}

async function prepareLocalPlayback(stream, delayMs = WEBRTC_TARGET_BUFFER_MS) {
  if (state.audioContext) {
    setLocalDelay(delayMs);
    muteLocalPlayback();
    return;
  }
  const AudioApi = window.AudioContext || window.webkitAudioContext;
  if (!AudioApi) return;

  let audioContext;
  try {
    audioContext = new AudioApi({ latencyHint: "interactive" });
  } catch {
    audioContext = new AudioApi();
  }
  const source = audioContext.createMediaStreamSource(stream);
  const outputLatencySeconds = Math.max(
    0,
    Number(audioContext.baseLatency || 0) + Number(audioContext.outputLatency || 0)
  );
  const delay = audioContext.createDelay(1.1);
  const gain = audioContext.createGain();
  gain.gain.setValueAtTime(0, audioContext.currentTime);
  source.connect(delay).connect(gain).connect(audioContext.destination);
  state.audioContext = audioContext;
  state.localDelay = delay;
  state.localGain = gain;
  state.localOutputLatencySeconds = outputLatencySeconds;
  setLocalDelay(delayMs);
  if (audioContext.state === "suspended") await audioContext.resume();
}

async function armLocalPlayback(stream, delayMs, startDelayMs) {
  await prepareLocalPlayback(stream, delayMs);
  const audioContext = state.audioContext;
  const gain = state.localGain;
  if (!audioContext || !gain) return;
  const now = audioContext.currentTime;
  const unmuteAt = now + Math.max(
    0,
    Number(startDelayMs || 0) / 1000 - Number(state.localOutputLatencySeconds || 0)
  );
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(0, now);
  gain.gain.setValueAtTime(0, unmuteAt);
  gain.gain.linearRampToValueAtTime(1, unmuteAt + 0.04);
}

function setLocalDelay(delayMs) {
  if (!state.audioContext || !state.localDelay) return;
  const delaySeconds = Math.max(
    0,
    Math.min(1, Number(delayMs || 0) / 1000 - Number(state.localOutputLatencySeconds || 0))
  );
  state.localDelay.delayTime.setValueAtTime(delaySeconds, state.audioContext.currentTime);
}

function muteLocalPlayback() {
  if (!state.audioContext || !state.localGain) return;
  const now = state.audioContext.currentTime;
  state.localGain.gain.cancelScheduledValues(now);
  state.localGain.gain.setValueAtTime(0, now);
}

function updateCaptureStatus() {
  if (!state.stream || !state.socket) return;
  if (state.livePhase === "measuring") {
    setStatus({
      phase: "connecting",
      detail: state.phaseBlocked
        ? "Measurement blocked; open Home Cinema to inspect the speaker."
        : `Measuring speaker timing ${state.phaseSampleCount}/${state.phaseSampleTarget}; local output is muted...`,
      serverUrl: state.serverUrl,
      title: state.tabTitle,
      ...liveProgressStatus()
    });
    return;
  }
  if (state.livePhase === "locking") {
    setStatus({
      phase: "connecting",
      detail: state.phaseBlocked
        ? "Timeline lock blocked; open Home Cinema to inspect the speaker."
        : `Locking the room at ${Math.round(state.roomTargetMs)} ms · ${state.phaseSampleCount}/${state.phaseSampleTarget} samples...`,
      serverUrl: state.serverUrl,
      title: state.tabTitle,
      ...liveProgressStatus()
    });
    return;
  }
  const remainingMs = state.unmuteAt - Date.now();
  if (remainingMs > 0) {
    setStatus({
      phase: "connecting",
      detail: `WebRTC starts in ${Math.max(1, Math.ceil(remainingMs / 1000))}...`,
      serverUrl: state.serverUrl,
      title: state.tabTitle,
      ...liveProgressStatus()
    });
    return;
  }
  if (state.countdownTimer) {
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }
  state.unmuteAt = 0;
  state.livePhase = "playing";
  const connectedPeers = [...state.peers.values()].filter(
    ({ connection }) => connection.connectionState === "connected"
  ).length;
  const detail = connectedPeers
    ? `Sharing WebRTC audio with ${connectedPeers} speaker${connectedPeers === 1 ? "" : "s"}.`
    : "Sharing WebRTC audio; waiting for speakers.";
  setStatus({ phase: "capturing", detail, serverUrl: state.serverUrl, title: state.tabTitle });
}

function updateLiveProgress(live) {
  state.livePhase = live?.phase || state.livePhase;
  state.phaseProgress = Math.max(0, Math.min(100, Number(live?.phaseProgress || 0)));
  state.phaseSampleCount = Math.max(0, Number(live?.phaseSampleCount || 0));
  state.phaseSampleTarget = Math.max(1, Number(live?.phaseSampleTarget || 3));
  state.stableSpeakers = Math.max(0, Number(live?.stableSpeakers || 0));
  state.requiredSpeakers = Math.max(0, Number(live?.requiredSpeakers || 0));
  state.phaseElapsedMs = Math.max(0, Number(live?.phaseElapsedMs || 0));
  state.phaseTimeoutMs = Math.max(0, Number(live?.phaseTimeoutMs || 0));
  state.phaseBlocked = Boolean(live?.phaseBlocked);
}

function liveProgressStatus() {
  return {
    stage: state.livePhase,
    progress: state.phaseProgress,
    sampleCount: state.phaseSampleCount,
    sampleTarget: state.phaseSampleTarget,
    stableSpeakers: state.stableSpeakers,
    requiredSpeakers: state.requiredSpeakers,
    elapsedMs: state.phaseElapsedMs,
    timeoutMs: state.phaseTimeoutMs,
    blocked: state.phaseBlocked
  };
}

function finishCapture(status, notifyServer = true) {
  if (state.stopping) return;
  state.stopping = true;

  const socket = state.socket;
  state.socket = null;
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  state.reconnectAttempt = 0;
  clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  state.unmuteAt = 0;
  state.livePhase = "idle";
  state.roomTargetMs = WEBRTC_TARGET_BUFFER_MS;
  state.phaseProgress = 0;
  state.phaseSampleCount = 0;
  state.phaseSampleTarget = 3;
  state.stableSpeakers = 0;
  state.requiredSpeakers = 0;
  state.phaseElapsedMs = 0;
  state.phaseTimeoutMs = 0;
  state.phaseBlocked = false;
  for (const peerId of [...state.peers.keys()]) closeWebRtcPeer(peerId);
  if (socket && socket.readyState === WebSocket.OPEN && notifyServer) {
    try {
      socket.send(JSON.stringify({ type: "liveStop" }));
    } catch {}
  }
  if (socket) {
    try {
      socket.close();
    } catch {}
  }
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
    state.stream = null;
  }
  if (state.audioContext) {
    state.audioContext.close().catch(() => {});
    state.audioContext = null;
  }
  state.localDelay = null;
  state.localGain = null;
  state.localOutputLatencySeconds = 0;
  state.serverUrl = "";
  state.tabTitle = "";
  state.tabId = null;
  setStatus(status);
  state.stopping = false;
}

function toWebSocketUrl(value) {
  const url = new URL(value);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function setStatus(status) {
  const next = {
    ...status,
    serverUrl: status.serverUrl || state.serverUrl || "",
    updatedAt: Date.now()
  };
  state.lastStatus = next;
  chrome.runtime.sendMessage({ type: "capture-status", status: next });
}
