import { normalizeServerUrl } from "./server-url.js";

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "plugin-room-status") {
    roomStatusStorage().set({ pluginRoomStatus: message.status }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "capture-status") {
    chrome.storage.local.set({ captureStatus: message.status }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "create-plugin-room") {
    forwardToPluginOffscreen({
      type: "create-plugin-room-in-offscreen",
      signalingOrigin: message.signalingOrigin,
      controllerName: message.controllerName
    }, sendResponse);
    return true;
  }

  if (message.type === "start-plugin-capture") {
    startPluginCapture(message)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Could not start capture." }));
    return true;
  }

  if (message.type === "stop-plugin-capture") {
    forwardToPluginOffscreen({ type: "stop-plugin-capture-in-offscreen" }, sendResponse);
    return true;
  }

  if (message.type === "close-plugin-room") {
    forwardToPluginOffscreen({ type: "close-plugin-room-in-offscreen" }, sendResponse);
    return true;
  }

  if (message.type === "set-plugin-volume") {
    forwardToPluginOffscreen({ type: "set-plugin-volume-in-offscreen", value: message.value }, sendResponse);
    return true;
  }

  if (message.type === "get-plugin-room-status") {
    getLivePluginRoomStatus()
      .then((status) => sendResponse({ ok: true, status }))
      .catch(() => sendResponse({ ok: true, status: idlePluginRoomStatus() }));
    return true;
  }

  if (message.type === "start-capture") {
    startCapture(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Could not start capture." }));
    return true;
  }

  if (message.type === "stop-capture") {
    sendOffscreenMessage({ type: "stop-capture-in-offscreen" })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Could not stop capture." }));
    return true;
  }

  if (message.type === "get-capture-status") {
    chrome.storage.local.get("captureStatus").then(({ captureStatus }) => {
      sendResponse({ ok: true, status: captureStatus || idleStatus() });
    });
    return true;
  }
});

async function startPluginCapture({ tabId, tabTitle }) {
  if (!Number.isInteger(tabId)) throw new Error("Choose a browser tab first.");
  const streamId = await getMediaStreamId(tabId);
  await ensureOffscreenDocument();
  return sendOffscreenMessage({
    type: "begin-plugin-capture-in-offscreen",
    streamId,
    tabTitle: String(tabTitle || "Current Chrome tab").slice(0, 120),
    tabId
  });
}

async function forwardToPluginOffscreen(message, sendResponse) {
  try {
    await ensureOffscreenDocument();
    const response = await sendOffscreenMessage(message);
    sendResponse(response);
  } catch (error) {
    sendResponse({ ok: false, error: error.message || "The plugin Controller is unavailable." });
  }
}

async function getLivePluginRoomStatus() {
  if (!(await offscreenDocumentExists())) {
    const status = idlePluginRoomStatus();
    await roomStatusStorage().set({ pluginRoomStatus: status });
    return status;
  }
  const response = await sendOffscreenMessage({ type: "get-plugin-room-status-in-offscreen" });
  return response.status || idlePluginRoomStatus();
}

async function startCapture({ tabId, serverUrl, tabTitle }) {
  if (!Number.isInteger(tabId)) throw new Error("Choose a browser tab first.");
  const normalizedUrl = normalizeServerUrl(serverUrl);
  const streamId = await getMediaStreamId(tabId);
  await ensureOffscreenDocument();
  await sendOffscreenMessage({
    type: "begin-capture-in-offscreen",
    streamId,
    serverUrl: normalizedUrl,
    tabTitle: String(tabTitle || "Current Chrome tab").slice(0, 120),
    tabId
  });
}

async function sendOffscreenMessage(message) {
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await runtimeMessage(message);
      if (response?.ok) return response;
      throw new Error(response?.error || "The Home Cinema capture page did not accept the request.");
    } catch (error) {
      lastError = error;
      await delay(80);
    }
  }
  throw lastError || new Error("The Home Cinema capture page did not start.");
}

function runtimeMessage(message) {
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureOffscreenDocument() {
  if (await offscreenDocumentExists()) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Capture the selected tab's audio and preserve local playback while it is shared with Home Cinema."
  });
}

async function offscreenDocumentExists() {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl]
  });
  return contexts.length > 0;
}

function getMediaStreamId(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(streamId);
    });
  });
}

function idleStatus() {
  return { phase: "idle", detail: "Ready to capture the active tab.", updatedAt: Date.now() };
}

function idlePluginRoomStatus() {
  return {
    exists: false,
    roomId: "",
    speakerUrl: "",
    speakerCount: 0,
    speakers: [],
    connection: "offline",
    capturePhase: "idle",
    volume: 1,
    updatedAt: Date.now()
  };
}

function roomStatusStorage() {
  return chrome.storage.session || chrome.storage.local;
}
