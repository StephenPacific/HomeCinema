const els = {
  connectionDot: document.querySelector("#connectionDot"),
  connectionText: document.querySelector("#connectionText"),
  countdown: document.querySelector("#countdown"),
  trackLabel: document.querySelector("#trackLabel"),
  syncLabel: document.querySelector("#syncLabel"),
  playBtn: document.querySelector("#playBtn"),
  playIcon: document.querySelector("#playIcon"),
  stopBtn: document.querySelector("#stopBtn"),
  resyncBtn: document.querySelector("#resyncBtn"),
  seek: document.querySelector("#seek"),
  currentTime: document.querySelector("#currentTime"),
  duration: document.querySelector("#duration"),
  controllerMode: document.querySelector("#controllerMode"),
  speakerMode: document.querySelector("#speakerMode"),
  fileInput: document.querySelector("#fileInput"),
  uploadText: document.querySelector("#uploadText"),
  layerChoices: document.querySelector("#layerChoices"),
  zoneChoices: document.querySelector("#zoneChoices"),
  addresses: document.querySelector("#addresses"),
  peers: document.querySelector("#peers"),
  testAllBtn: document.querySelector("#testAllBtn"),
  offsetStat: document.querySelector("#offsetStat"),
  latencyStat: document.querySelector("#latencyStat"),
  leadStat: document.querySelector("#leadStat"),
  deviceOffsetStat: document.querySelector("#deviceOffsetStat"),
  offsetDown: document.querySelector("#offsetDown"),
  offsetReset: document.querySelector("#offsetReset"),
  offsetUp: document.querySelector("#offsetUp"),
  readyStat: document.querySelector("#readyStat"),
  gesture: document.querySelector("#gesture"),
  unlockBtn: document.querySelector("#unlockBtn"),
  disc: document.querySelector(".disc"),
  meter: document.querySelector(".meter"),
  leadButtons: [...document.querySelectorAll("[data-lead]")],
  zoneButtons: [...document.querySelectorAll("[data-zone]")]
};

let socket;
let clientId = null;
let reconnectTimer;
let role = localStorage.getItem("role") || "controller";
let audioContext;
let gain;
let audioBuffer;
let source;
let currentLayerId = null;
let currentLayerVersion = null;
let loadingLayerKey = null;
let selectedLayerId = localStorage.getItem("selectedLayerId");
let selectedZone = localStorage.getItem("selectedZone") || "front-left";
let deviceOffsetMs = Number(localStorage.getItem("deviceOffsetMs") || 0);
let serverOffsetMs = 0;
let latencyMs = 0;
let statusTimer = null;
let state = null;
let localPlayback = null;
let seeking = false;
let unlocked = false;

boot();

async function boot() {
  setRole(role);
  connect();
  loadConfig();
  els.unlockBtn.addEventListener("click", unlockAudio);
  els.controllerMode.addEventListener("click", () => setRole("controller"));
  els.speakerMode.addEventListener("click", () => setRole("speaker"));
  els.fileInput.addEventListener("change", uploadSelectedFile);
  els.playBtn.addEventListener("click", togglePlay);
  els.stopBtn.addEventListener("click", () => send({ type: "stop" }));
  els.resyncBtn.addEventListener("click", hardResync);
  els.testAllBtn.addEventListener("click", () => send({ type: "testTone" }));
  els.offsetDown.addEventListener("click", () => adjustDeviceOffset(-10));
  els.offsetReset.addEventListener("click", () => setDeviceOffset(0));
  els.offsetUp.addEventListener("click", () => adjustDeviceOffset(10));
  els.seek.addEventListener("input", () => {
    seeking = true;
    els.currentTime.textContent = formatTime(Number(els.seek.value));
  });
  els.seek.addEventListener("change", () => {
    seeking = false;
    send({ type: "seek", position: Number(els.seek.value) });
  });

  setInterval(updateClockUi, 200);
  renderZoneChoices();
  renderDeviceOffset();
}

function connect() {
  clearTimeout(reconnectTimer);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}`);

  socket.addEventListener("open", () => {
    setConnected(true);
    identify();
    calibrateClock(10);
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    handleMessage(message);
  });

  socket.addEventListener("close", () => {
    setConnected(false);
    reconnectTimer = setTimeout(connect, 900);
  });

  socket.addEventListener("error", () => {
    setConnected(false);
  });
}

function handleMessage(message) {
  if (message.type === "hello") {
    clientId = message.id;
    applyState(message.state);
    renderPeers(message.peers);
    reportStatusSoon();
    return;
  }

  if (message.type === "testTone") {
    playTestTone(message);
    return;
  }

  if (message.type === "time") {
    receiveTimeSample(message);
    return;
  }

  if (message.type === "peers") {
    renderPeers(message.peers);
    return;
  }

  if (message.type === "track" || message.type === "sync" || message.type === "lead") {
    applyState(message.state);
    return;
  }

  if (["play", "pause", "stop", "seek"].includes(message.type)) {
    applyState(message.state, true);
  }
}

function applyState(nextState, immediate = false) {
  state = nextState;
  ensureSelectedLayer();
  renderState();

  const layer = selectedLayer();
  if (!layer) {
    stopLocalSource();
    audioBuffer = null;
    currentLayerId = null;
    currentLayerVersion = null;
    return;
  }

  if (layer.id !== currentLayerId || layer.version !== currentLayerVersion) {
    loadAudio(layer)
      .then(() => {
        if (state.playing) scheduleFromState(true);
      })
      .catch(() => {
        els.readyStat.textContent = "Load failed";
        els.syncLabel.textContent = "Cannot decode audio";
      });
    return;
  }

  if (!audioBuffer) return;

  if (state.playing) {
    scheduleFromState(immediate);
  } else if (immediate) {
    stopLocalSource();
    localPlayback = null;
  }
}

async function loadAudio(track) {
  const loadingKey = `${track.id}:${track.version}`;
  if (loadingLayerKey === loadingKey) return;
  loadingLayerKey = loadingKey;
  audioBuffer = null;
  els.readyStat.textContent = "Loading";
  els.syncLabel.textContent = "Caching audio";

  try {
    const response = await fetch(`/audio?layer=${encodeURIComponent(track.id)}&v=${track.version}`, {
      cache: "no-store"
    });
    if (!response.ok) throw new Error("Audio download failed");
    const bytes = await response.arrayBuffer();
    await ensureAudioContext({ resume: false });
    const decoded = await audioContext.decodeAudioData(bytes);
    if (selectedLayerId !== track.id) return;
    audioBuffer = decoded;
    currentLayerId = track.id;
    currentLayerVersion = track.version;
    els.duration.textContent = formatTime(audioBuffer.duration);
    els.seek.max = String(audioBuffer.duration);
    els.readyStat.textContent = unlocked ? "Ready" : "Locked";
    reportStatusSoon();
    renderState();
  } finally {
    loadingLayerKey = null;
  }
}

async function unlockAudio() {
  await ensureAudioContext();
  const buffer = audioContext.createBuffer(1, 1, audioContext.sampleRate);
  const empty = audioContext.createBufferSource();
  empty.buffer = buffer;
  empty.connect(gain);
  empty.start();
  await audioContext.resume();
  unlocked = true;
  els.gesture.classList.add("hidden");
  els.readyStat.textContent = audioBuffer ? "Ready" : "No audio";
  reportStatusSoon();
  const layer = selectedLayer();
  if (layer && !audioBuffer) {
    try {
      await loadAudio(layer);
    } catch {
      els.readyStat.textContent = "Load failed";
      els.syncLabel.textContent = "Cannot decode audio";
    }
  }
  if (state?.playing && audioBuffer) scheduleFromState(true);
}

async function ensureAudioContext({ resume = true } = {}) {
  if (!audioContext) {
    const AudioApi = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioApi();
    gain = audioContext.createGain();
    gain.gain.value = 1;
    gain.connect(audioContext.destination);
  }
  if (resume && audioContext.state === "suspended") {
    await audioContext.resume();
  }
}

function scheduleFromState(force = false) {
  if (!audioBuffer || !unlocked) return;

  const expected = expectedPosition();
  if (!force && localPlayback) {
    const drift = Math.abs(currentLocalPosition() - expected);
    if (drift < 0.035) return;
  }

  const targetLocalMs = state.startedAt - serverOffsetMs;
  const adjustedTargetLocalMs = targetLocalMs + deviceOffsetMs;
  const delaySeconds = Math.max(0, (adjustedTargetLocalMs - Date.now()) / 1000);
  const offsetSeconds = clamp(
    state.position + Math.max(0, (Date.now() + serverOffsetMs - state.startedAt - deviceOffsetMs) / 1000),
    0,
    audioBuffer.duration - 0.02
  );

  startLocalSource(delaySeconds, offsetSeconds);
  updateCountdown(delaySeconds);
}

function startLocalSource(delaySeconds, offsetSeconds) {
  stopLocalSource();
  const nextSource = audioContext.createBufferSource();
  nextSource.buffer = audioBuffer;
  nextSource.connect(gain);
  const startAtContext = audioContext.currentTime + delaySeconds;
  nextSource.start(startAtContext, offsetSeconds);
  source = nextSource;
  localPlayback = {
    contextStartedAt: startAtContext,
    offset: offsetSeconds
  };
  source.onended = () => {
    if (source === nextSource) {
      localPlayback = null;
      source = null;
    }
  };
}

function stopLocalSource() {
  if (!source) return;
  try {
    source.onended = null;
    source.stop();
    source.disconnect();
  } catch {}
  source = null;
}

function expectedPosition() {
  if (!state) return 0;
  if (!state.playing || !state.startedAt) return state.position || 0;
  return clamp(
    state.position + Math.max(0, (Date.now() + serverOffsetMs - state.startedAt - deviceOffsetMs) / 1000),
    0,
    audioBuffer?.duration || Number.MAX_SAFE_INTEGER
  );
}

function currentLocalPosition() {
  if (!localPlayback || !audioContext) return state?.position || 0;
  return localPlayback.offset + Math.max(0, audioContext.currentTime - localPlayback.contextStartedAt);
}

function togglePlay() {
  if (!state?.layers?.length) return;
  if (state.playing) {
    send({ type: "pause" });
  } else {
    send({ type: "play", position: Number(els.seek.value || state.position || 0) });
  }
}

function hardResync() {
  calibrateClock(10);
  if (state?.playing) {
    setTimeout(() => scheduleFromState(true), 650);
  }
}

async function uploadSelectedFile() {
  const files = [...(els.fileInput.files || [])];
  if (!files.length) return;
  els.uploadText.textContent = `Uploading 0/${files.length}`;
  stopLocalSource();
  audioBuffer = null;
  currentLayerId = null;
  currentLayerVersion = null;

  const clearResponse = await fetch("/clear", { method: "POST" });
  if (!clearResponse.ok) {
    els.uploadText.textContent = "Upload failed";
    return;
  }

  let uploadedState = null;
  for (const [index, file] of files.entries()) {
    els.uploadText.textContent = `Uploading ${index + 1}/${files.length}`;
    const response = await fetch("/upload", {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-File-Name": encodeURIComponent(file.name)
      },
      body: file
    });
    if (!response.ok) {
      els.uploadText.textContent = "Upload failed";
      return;
    }
    uploadedState = await response.json();
  }
  els.uploadText.textContent = files.length > 1 ? "Replace stems" : "Replace track";
  if (uploadedState) applyState(uploadedState);
}

function calibrateClock(samples = 8) {
  for (let i = 0; i < samples; i += 1) {
    setTimeout(() => send({ type: "time", clientSent: Date.now() }), i * 70);
  }
}

function receiveTimeSample(message) {
  const now = Date.now();
  const rtt = now - message.clientSent;
  const midpoint = message.clientSent + rtt / 2;
  const offset = message.serverTime - midpoint;
  if (!Number.isFinite(offset)) return;

  if (!latencyMs || rtt < latencyMs + 12) {
    serverOffsetMs = offset;
    latencyMs = rtt;
  } else {
    serverOffsetMs = serverOffsetMs * 0.85 + offset * 0.15;
    latencyMs = latencyMs * 0.85 + rtt * 0.15;
  }

  els.offsetStat.textContent = `${Math.round(serverOffsetMs)} ms`;
  els.latencyStat.textContent = `${Math.round(latencyMs)} ms`;
  reportStatusSoon();
}

function setRole(nextRole) {
  role = nextRole;
  localStorage.setItem("role", role);
  els.controllerMode.classList.toggle("active", role === "controller");
  els.speakerMode.classList.toggle("active", role === "speaker");
  document.body.dataset.role = role;
  reportStatusNow();
}

function identify() {
  reportStatusNow();
}

function reportStatusSoon() {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(reportStatusNow, 120);
}

function reportStatusNow() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const name = localStorage.getItem("deviceName") || deviceName();
  const layer = selectedLayer();
  send({
    type: "identify",
    role,
    name,
    layerId: selectedLayerId,
    zone: selectedZone,
    ready: Boolean(unlocked && (!layer || audioBuffer)),
    unlocked,
    latencyMs: Math.round(latencyMs || 0),
    deviceOffsetMs
  });
}

function deviceName() {
  const generated = `${navigator.platform || "Device"} ${Math.floor(Math.random() * 900 + 100)}`;
  localStorage.setItem("deviceName", generated);
  return generated;
}

async function loadConfig() {
  const response = await fetch("/config", { cache: "no-store" });
  const config = await response.json();
  const urls = config.addresses.length ? config.addresses : [location.origin];
  updateLeadUi(config.leadMs);
  els.addresses.innerHTML = "";
  for (const url of urls) {
    const row = document.createElement("div");
    row.className = "address-row";
    row.innerHTML = `<code>${url}</code><button class="copy" type="button">Copy</button>`;
    row.querySelector("button").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(url);
        row.querySelector("button").textContent = "Copied";
      } catch {
        row.querySelector("button").textContent = "Copy manually";
      }
    });
    els.addresses.append(row);
  }
}

function renderPeers(peers = []) {
  els.peers.innerHTML = "";
  if (!peers.length) {
    els.peers.textContent = "No players";
    return;
  }
  for (const peer of peers) {
    const layer = layerById(peer.layerId);
    const row = document.createElement("div");
    row.className = "peer-card";
    row.innerHTML = `
      <div class="peer-head">
        <strong>${escapeHtml(peer.name)}</strong>
        <span class="status ${peer.ready ? "ready" : ""}">${peer.ready ? "Ready" : peer.unlocked ? "No audio" : "Locked"}</span>
      </div>
      <div class="peer-grid">
        <span>Stem</span><strong>${escapeHtml(layer?.name || (peer.role === "controller" ? "Host" : "None"))}</strong>
        <span>Position</span><strong>${zoneLabel(peer.zone)}</strong>
        <span>Offset</span><strong>${Math.round(Number(peer.deviceOffsetMs) || 0)} ms</strong>
        <span>Latency</span><strong>${peer.latencyMs ? `${Math.round(peer.latencyMs)} ms` : "--"}</strong>
      </div>
      <button class="mini-button" type="button">Test tone</button>
    `;
    row.querySelector("button").addEventListener("click", () => {
      send({ type: "testTone", targetId: peer.id });
    });
    els.peers.append(row);
  }
  renderState();
}

function renderState() {
  if (!state) return;
  const layers = state.layers || [];
  const layer = selectedLayer();
  const track = state.track;
  updateLeadUi(state.leadMs);
  renderLayerChoices(layers);
  renderZoneChoices();
  renderDeviceOffset();
  els.trackLabel.textContent = layers.length > 1 ? `${layers.length} stems` : track?.name || "No track loaded";
  if (!layers.length) {
    els.syncLabel.textContent = "Choose one or more stems on the host";
  } else if (!audioBuffer) {
    els.syncLabel.textContent = "Preparing audio";
  } else if (state.playing) {
    els.syncLabel.textContent = `Playing: ${layer?.name || "default stem"}`;
  } else {
    els.syncLabel.textContent = `Paused: ${layer?.name || "default stem"}`;
  }
  els.playIcon.innerHTML = state.playing
    ? '<path d="M7 5h4v14H7zm6 0h4v14h-4z" />'
    : '<path d="M8 5v14l11-7z" />';
  els.disc.classList.toggle("playing", Boolean(state.playing));
  els.meter.classList.toggle("playing", Boolean(state.playing));
  if (audioBuffer) {
    els.seek.max = String(audioBuffer.duration);
    els.duration.textContent = formatTime(audioBuffer.duration);
  }
}

function updateClockUi() {
  if (!state || seeking) return;
  const position = expectedPosition();
  els.seek.value = String(position);
  els.currentTime.textContent = formatTime(position);
  if (state.playing && audioBuffer) {
    const remaining = (state.startedAt + deviceOffsetMs - (Date.now() + serverOffsetMs)) / 1000;
    const layer = selectedLayer();
    if (remaining > 0.05) {
      updateCountdown(remaining);
    } else {
      clearCountdown();
      els.syncLabel.textContent = `Playing: ${layer?.name || "default stem"}`;
    }
  }
}

function setConnected(connected) {
  els.connectionDot.classList.toggle("connected", connected);
  els.connectionText.textContent = connected ? "Connected" : "Reconnecting";
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function adjustDeviceOffset(delta) {
  setDeviceOffset(deviceOffsetMs + delta);
}

function setDeviceOffset(value) {
  deviceOffsetMs = clamp(Math.round(Number(value) || 0), -300, 300);
  localStorage.setItem("deviceOffsetMs", String(deviceOffsetMs));
  renderDeviceOffset();
  reportStatusSoon();
  if (state?.playing) scheduleFromState(true);
}

function renderDeviceOffset() {
  els.deviceOffsetStat.textContent = `${deviceOffsetMs} ms`;
}

function selectZone(zone) {
  selectedZone = zone;
  localStorage.setItem("selectedZone", selectedZone);
  renderZoneChoices();
  reportStatusNow();
}

function renderZoneChoices() {
  for (const button of els.zoneButtons) {
    button.classList.toggle("active", button.dataset.zone === selectedZone);
  }
}

function zoneLabel(zone) {
  return {
    "front-left": "Front Left",
    "front-right": "Front Right",
    center: "Center",
    "rear-left": "Rear Left",
    "rear-right": "Rear Right"
  }[zone] || "Front Left";
}

async function playTestTone(message = {}) {
  if (message.targetId && message.targetId !== clientId) return;
  if (!unlocked) {
    els.readyStat.textContent = "Enable speaker first";
    return;
  }
  await ensureAudioContext();
  const oscillator = audioContext.createOscillator();
  const toneGain = audioContext.createGain();
  const now = Date.now();
  const targetLocalMs = (message.toneAt || now + 120) - serverOffsetMs + deviceOffsetMs;
  const startAt = audioContext.currentTime + Math.max(0, (targetLocalMs - now) / 1000);
  const frequency = {
    "front-left": 520,
    "front-right": 620,
    center: 720,
    "rear-left": 430,
    "rear-right": 830
  }[selectedZone] || 600;
  oscillator.type = "sine";
  oscillator.frequency.value = frequency;
  toneGain.gain.setValueAtTime(0.0001, startAt);
  toneGain.gain.exponentialRampToValueAtTime(0.28, startAt + 0.02);
  toneGain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.38);
  oscillator.connect(toneGain).connect(gain);
  oscillator.start(startAt);
  oscillator.stop(startAt + 0.42);
}

function ensureSelectedLayer() {
  const layers = state?.layers || [];
  if (!layers.length) {
    const hadLayer = Boolean(selectedLayerId);
    selectedLayerId = null;
    localStorage.removeItem("selectedLayerId");
    if (hadLayer) reportStatusSoon();
    return;
  }
  if (!layers.some((layer) => layer.id === selectedLayerId)) {
    selectedLayerId = layers[0].id;
    localStorage.setItem("selectedLayerId", selectedLayerId);
    identify();
  }
}

function selectedLayer() {
  return layerById(selectedLayerId) || state?.layers?.[0] || null;
}

function layerById(layerId) {
  return (state?.layers || []).find((layer) => layer.id === layerId);
}

function selectLayer(layerId) {
  if (!layerById(layerId)) return;
  selectedLayerId = layerId;
  localStorage.setItem("selectedLayerId", selectedLayerId);
  reportStatusNow();
  stopLocalSource();
  audioBuffer = null;
  currentLayerId = null;
  currentLayerVersion = null;
  renderState();
  loadAudio(selectedLayer())
    .then(() => {
      if (state?.playing) scheduleFromState(true);
    })
    .catch(() => {
      els.readyStat.textContent = "Load failed";
      els.syncLabel.textContent = "Cannot decode audio";
    });
}

function renderLayerChoices(layers) {
  els.layerChoices.innerHTML = "";
  if (!layers.length) {
    els.layerChoices.textContent = "No stems";
    return;
  }
  for (const [index, layer] of layers.entries()) {
    const button = document.createElement("button");
    button.className = "layer-button";
    button.type = "button";
    button.classList.toggle("active", layer.id === selectedLayerId);
    button.innerHTML = `<strong>${escapeHtml(layer.name)}</strong><span class="badge">${index + 1}</span>`;
    button.addEventListener("click", () => selectLayer(layer.id));
    els.layerChoices.append(button);
  }
}

for (const button of els.leadButtons) {
  button.addEventListener("click", () => {
    send({ type: "setLead", leadMs: Number(button.dataset.lead) });
  });
}

for (const button of els.zoneButtons) {
  button.addEventListener("click", () => selectZone(button.dataset.zone));
}

function updateLeadUi(leadMs) {
  if (!Number.isFinite(Number(leadMs))) return;
  const value = Number(leadMs);
  els.leadStat.textContent = `${Math.round(value)} ms`;
  for (const button of els.leadButtons) {
    button.classList.toggle("active", Number(button.dataset.lead) === value);
  }
}

function updateCountdown(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  if (safe <= 0.05) {
    clearCountdown();
    return;
  }
  const number = Math.max(1, Math.ceil(safe));
  const text = String(number);
  if (els.countdown.textContent !== text) {
    els.countdown.textContent = text;
    els.countdown.classList.remove("tick");
    void els.countdown.offsetWidth;
    els.countdown.classList.add("tick");
  }
  els.countdown.classList.add("active");
  els.syncLabel.textContent = `Starting in ${number}`;
}

function clearCountdown() {
  els.countdown.textContent = "";
  els.countdown.classList.remove("active", "tick");
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = Math.floor(safe % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[char];
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
