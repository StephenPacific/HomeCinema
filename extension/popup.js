import { DEFAULT_SIGNALING_ORIGIN, normalizeSignalingOrigin } from "./plugin-room.js";
import { createQrMatrix } from "./qr.js";

const elements = {
  emptyRoom: document.querySelector("#emptyRoom"),
  roomPanel: document.querySelector("#roomPanel"),
  createRoomButton: document.querySelector("#createRoomButton"),
  roomCode: document.querySelector("#roomCode"),
  roomConnection: document.querySelector("#roomConnection"),
  roomQr: document.querySelector("#roomQr"),
  speakerCount: document.querySelector("#speakerCount"),
  speakerList: document.querySelector("#speakerList"),
  copyLinkButton: document.querySelector("#copyLinkButton"),
  endRoomButton: document.querySelector("#endRoomButton"),
  tabTitle: document.querySelector("#tabTitle"),
  statusText: document.querySelector("#statusText"),
  statusDot: document.querySelector("#statusDot"),
  progressPanel: document.querySelector("#progressPanel"),
  progressLabel: document.querySelector("#progressLabel"),
  progressValue: document.querySelector("#progressValue"),
  progressTrack: document.querySelector("#progressTrack"),
  progressBar: document.querySelector("#progressBar"),
  progressDetail: document.querySelector("#progressDetail"),
  volumeSlider: document.querySelector("#volumeSlider"),
  volumeValue: document.querySelector("#volumeValue"),
  startButton: document.querySelector("#startButton"),
  stopButton: document.querySelector("#stopButton"),
  signalingOrigin: document.querySelector("#signalingOrigin")
};

let activeTab = null;
let busy = false;
let renderedQrValue = "";
let volumeTimer = null;
let roomStatus = idleRoomStatus();
let captureStatus = idleCaptureStatus();

initialize().catch((error) => {
  renderCaptureStatus({ phase: "error", plugin: true, detail: error.message || "Could not open Home Cinema." });
});

elements.createRoomButton.addEventListener("click", async () => {
  await runBusy(async () => {
    const signalingOrigin = normalizeSignalingOrigin(elements.signalingOrigin.value);
    await ensureOriginPermission(signalingOrigin);
    await chrome.storage.local.set({ pluginSignalingOrigin: signalingOrigin });
    const response = await sendMessage({
      type: "create-plugin-room",
      signalingOrigin,
      controllerName: await controllerName()
    });
    if (!response?.ok) throw new Error(response?.error || "Could not create a room.");
    renderRoomStatus(response.status);
  });
});

elements.startButton.addEventListener("click", async () => {
  await runBusy(async () => {
    if (!activeTab?.id) throw new Error("No active browser tab found.");
    renderCaptureStatus({ phase: "connecting", plugin: true, detail: "Preparing tab audio..." });
    const response = await sendMessage({
      type: "start-plugin-capture",
      tabId: activeTab.id,
      tabTitle: activeTab.title || "Current Chrome tab"
    });
    if (!response?.ok) throw new Error(response?.error || "Could not start tab audio.");
  });
});

elements.stopButton.addEventListener("click", async () => {
  await runBusy(async () => {
    const response = await sendMessage({ type: "stop-plugin-capture" });
    if (!response?.ok) throw new Error(response?.error || "Could not stop tab audio.");
    renderCaptureStatus({ phase: "idle", plugin: true, detail: "Tab audio stopped. The room remains open." });
  });
});

elements.endRoomButton.addEventListener("click", async () => {
  await runBusy(async () => {
    const response = await sendMessage({ type: "close-plugin-room" });
    if (!response?.ok) throw new Error(response?.error || "Could not end this room.");
    renderRoomStatus(response.status || idleRoomStatus());
  });
});

elements.copyLinkButton.addEventListener("click", async () => {
  if (!roomStatus.speakerUrl) return;
  try {
    await navigator.clipboard.writeText(roomStatus.speakerUrl);
    const original = elements.copyLinkButton.textContent;
    elements.copyLinkButton.textContent = "Copied";
    setTimeout(() => {
      elements.copyLinkButton.textContent = original;
    }, 1_200);
  } catch {
    renderCaptureStatus({ phase: "error", plugin: true, detail: "The Speaker invite could not be copied." });
  }
});

elements.volumeSlider.addEventListener("input", () => {
  const value = Number(elements.volumeSlider.value);
  elements.volumeValue.textContent = `${value}%`;
  clearTimeout(volumeTimer);
  volumeTimer = setTimeout(() => {
    sendMessage({ type: "set-plugin-volume", value: value / 100 }).catch(() => {});
    chrome.storage.local.set({ pluginVolume: value / 100 });
  }, 70);
});

elements.signalingOrigin.addEventListener("change", () => {
  try {
    const value = normalizeSignalingOrigin(elements.signalingOrigin.value);
    elements.signalingOrigin.value = value;
    chrome.storage.local.set({ pluginSignalingOrigin: value });
  } catch (error) {
    renderCaptureStatus({ phase: "error", plugin: true, detail: error.message || "Invalid signaling address." });
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "plugin-room-status") renderRoomStatus(message.status);
  if (message.type === "capture-status" && message.status?.plugin) renderCaptureStatus(message.status);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "session" && changes.pluginRoomStatus) renderRoomStatus(changes.pluginRoomStatus.newValue);
  if (areaName === "local" && changes.captureStatus?.newValue?.plugin) {
    renderCaptureStatus(changes.captureStatus.newValue);
  }
});

async function initialize() {
  const [{ pluginSignalingOrigin, pluginVolume }, tab, roomResponse, captureResponse] = await Promise.all([
    chrome.storage.local.get(["pluginSignalingOrigin", "pluginVolume"]),
    activeTabQuery(),
    sendMessage({ type: "get-plugin-room-status" }),
    sendMessage({ type: "get-capture-status" })
  ]);
  activeTab = tab;
  elements.tabTitle.textContent = tab?.title || "No active tab";
  elements.signalingOrigin.value = pluginSignalingOrigin || DEFAULT_SIGNALING_ORIGIN;
  const volume = Math.round(Math.max(0, Math.min(1, Number(pluginVolume ?? 1))) * 100);
  elements.volumeSlider.value = String(volume);
  elements.volumeValue.textContent = `${volume}%`;
  renderRoomStatus(roomResponse?.status || idleRoomStatus());
  renderCaptureStatus(captureResponse?.status?.plugin ? captureResponse.status : idleCaptureStatus());
  if (roomStatus.exists && volume !== Math.round(Number(roomStatus.volume ?? 1) * 100)) {
    sendMessage({ type: "set-plugin-volume", value: volume / 100 }).catch(() => {});
  }
}

async function runBusy(action) {
  if (busy) return;
  busy = true;
  updateActionState();
  try {
    await action();
  } catch (error) {
    renderCaptureStatus({ phase: "error", plugin: true, detail: error.message || "Home Cinema could not complete this action." });
  } finally {
    busy = false;
    updateActionState();
  }
}

function renderRoomStatus(status) {
  roomStatus = { ...idleRoomStatus(), ...(status || {}) };
  const exists = Boolean(roomStatus.exists);
  elements.emptyRoom.hidden = exists;
  elements.roomPanel.hidden = !exists;
  elements.roomCode.textContent = roomStatus.roomId || "------";
  const count = Math.max(0, Number(roomStatus.speakerCount || 0));
  elements.speakerCount.textContent = `${count} Speaker${count === 1 ? "" : "s"}`;
  elements.roomConnection.textContent = connectionLabel(roomStatus.connection);
  elements.roomConnection.className = `connection-badge ${roomStatus.connection || "offline"}`;
  elements.statusDot.classList.toggle("active", roomStatus.connection === "online");
  renderSpeakers(roomStatus.speakers || []);
  renderQr(roomStatus.speakerUrl || "");
  if (document.activeElement !== elements.volumeSlider && Number.isFinite(Number(roomStatus.volume))) {
    const volume = Math.round(Number(roomStatus.volume) * 100);
    elements.volumeSlider.value = String(volume);
    elements.volumeValue.textContent = `${volume}%`;
  }
  if (exists && captureStatus.phase === "idle") {
    elements.statusText.textContent = count
      ? `${count} Speaker${count === 1 ? " is" : "s are"} ready for the current tab.`
      : "Room ready; waiting for a Speaker.";
  }
  updateActionState();
}

function renderSpeakers(speakers) {
  elements.speakerList.replaceChildren();
  if (!speakers.length) {
    const empty = document.createElement("div");
    empty.className = "speaker-empty";
    empty.textContent = "No Speakers joined";
    elements.speakerList.append(empty);
    return;
  }
  for (const speaker of speakers.slice(0, 6)) {
    const item = document.createElement("div");
    item.className = "speaker-item";
    const name = document.createElement("span");
    name.textContent = speaker.name || "Speaker";
    const stateLabel = document.createElement("span");
    stateLabel.textContent = "Joined";
    item.append(name, stateLabel);
    elements.speakerList.append(item);
  }
}

function renderCaptureStatus(status) {
  captureStatus = status?.plugin ? status : idleCaptureStatus();
  elements.statusText.textContent = captureStatus.detail || "Ready.";
  elements.statusText.classList.toggle("error", captureStatus.phase === "error");
  const progress = Math.max(0, Math.min(100, Number(captureStatus.progress || 0)));
  const showProgress = ["measuring", "armed"].includes(captureStatus.stage);
  elements.progressPanel.hidden = !showProgress;
  elements.progressPanel.classList.toggle("blocked", Boolean(captureStatus.blocked));
  elements.progressLabel.textContent = captureStatus.blocked
    ? "Waiting"
    : captureStatus.stage === "armed" ? "Starting" : "Measuring";
  elements.progressValue.textContent = `${Math.round(progress)}%`;
  elements.progressBar.style.width = `${progress}%`;
  elements.progressTrack.setAttribute("aria-valuenow", String(Math.round(progress)));
  const samples = Math.max(0, Number(captureStatus.sampleCount || 0));
  const sampleTarget = Math.max(1, Number(captureStatus.sampleTarget || 3));
  const stable = Math.max(0, Number(captureStatus.stableSpeakers || 0));
  const required = Math.max(0, Number(captureStatus.requiredSpeakers || 0));
  elements.progressDetail.textContent = captureStatus.stage === "armed"
    ? `${stable}/${required} Speakers locked`
    : `${samples}/${sampleTarget} samples · ${stable}/${required} Speakers stable`;
  updateActionState();
}

function updateActionState() {
  const active = ["connecting", "capturing"].includes(captureStatus.phase);
  const roomReady = roomStatus.exists && roomStatus.connection === "online";
  const hasSpeaker = Number(roomStatus.speakerCount || 0) > 0;
  elements.createRoomButton.disabled = busy;
  elements.startButton.disabled = busy || active || !roomReady || !hasSpeaker || !activeTab?.id;
  elements.stopButton.disabled = busy || !active;
  elements.copyLinkButton.disabled = busy || !roomStatus.speakerUrl;
  elements.endRoomButton.disabled = busy || !roomStatus.exists;
  elements.volumeSlider.disabled = !roomStatus.exists;
}

function renderQr(value) {
  if (!value || value === renderedQrValue) return;
  renderedQrValue = value;
  const matrix = createQrMatrix(value);
  const quietZone = 4;
  const cellCount = matrix.length + quietZone * 2;
  const scale = 4;
  const canvas = elements.roomQr;
  canvas.width = cellCount * scale;
  canvas.height = cellCount * scale;
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = false;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#080a0b";
  for (let y = 0; y < matrix.length; y += 1) {
    for (let x = 0; x < matrix.length; x += 1) {
      if (matrix[y][x]) context.fillRect((x + quietZone) * scale, (y + quietZone) * scale, scale, scale);
    }
  }
}

async function ensureOriginPermission(origin) {
  if (!chrome.permissions) return;
  const url = new URL(origin);
  const pattern = `${url.protocol}//${url.host}/*`;
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) throw new Error("Home Cinema needs access to the selected signaling service.");
}

function activeTabQuery() {
  return chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => tab);
}

async function controllerName() {
  try {
    const info = await chrome.runtime.getPlatformInfo();
    return `${platformLabel(info.os)} Chrome`;
  } catch {
    return "Chrome Controller";
  }
}

function platformLabel(os) {
  return { mac: "Mac", win: "Windows", android: "Android", cros: "ChromeOS", linux: "Linux" }[os] || "Chrome";
}

function connectionLabel(connection) {
  return {
    online: "Room online",
    connecting: "Connecting",
    reconnecting: "Reconnecting",
    offline: "Offline"
  }[connection] || "Offline";
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function idleRoomStatus() {
  return {
    exists: false,
    roomId: "",
    speakerUrl: "",
    speakerCount: 0,
    speakers: [],
    connection: "offline",
    capturePhase: "idle",
    volume: 1
  };
}

function idleCaptureStatus() {
  return { phase: "idle", plugin: true, detail: "Create a room to begin." };
}
