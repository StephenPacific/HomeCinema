import { normalizeServerUrl } from "./server-url.js";

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "capture-status") {
    const updates = { captureStatus: message.status };
    try {
      if (message.status?.serverUrl) updates.homeCinemaUrl = normalizeServerUrl(message.status.serverUrl);
    } catch {}
    chrome.storage.local.set(updates).then(() => sendResponse({ ok: true }));
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
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl]
  });
  if (contexts.length) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Capture the selected tab's audio and preserve local playback while it is shared with Home Cinema."
  });
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
