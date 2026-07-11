import { controllerPageUrl, normalizeServerUrl, resolveServerUrl, serverUrlFromHomeCinemaTab } from "./server-url.js";

const serverUrlInput = document.querySelector("#serverUrl");
const tabTitle = document.querySelector("#tabTitle");
const statusText = document.querySelector("#statusText");
const statusDot = document.querySelector("#statusDot");
const progressPanel = document.querySelector("#progressPanel");
const progressLabel = document.querySelector("#progressLabel");
const progressValue = document.querySelector("#progressValue");
const progressTrack = progressPanel.querySelector(".progress-track");
const progressBar = document.querySelector("#progressBar");
const progressDetail = document.querySelector("#progressDetail");
const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const openButton = document.querySelector("#openButton");

let activeTab = null;
let captureStatus = { phase: "idle", detail: "Ready to capture the active tab." };

initialize().catch((error) => renderStatus({ phase: "error", detail: error.message || "Could not open Home Cinema." }));

startButton.addEventListener("click", async () => {
  try {
    const serverUrl = normalizeServerUrl(serverUrlInput.value);
    if (!activeTab?.id) throw new Error("No active browser tab found.");
    renderStatus({ phase: "connecting", detail: "Preparing tab audio..." });
    const response = await sendMessage({
      type: "start-capture",
      tabId: activeTab.id,
      tabTitle: activeTab.title || "Current Chrome tab",
      serverUrl
    });
    if (!response?.ok) throw new Error(response?.error || "Could not start capture.");
    await chrome.storage.local.set({ homeCinemaUrl: serverUrl });
  } catch (error) {
    renderStatus({ phase: "error", detail: error.message || "Could not start capture." });
  }
});

stopButton.addEventListener("click", async () => {
  await sendMessage({ type: "stop-capture" });
  renderStatus({ phase: "idle", detail: "Stopping capture..." });
});

openButton.addEventListener("click", async () => {
  try {
    const serverUrl = normalizeServerUrl(serverUrlInput.value);
    await chrome.storage.local.set({ homeCinemaUrl: serverUrl });
    await chrome.tabs.create({ url: controllerPageUrl(serverUrl) });
  } catch (error) {
    renderStatus({ phase: "error", detail: error.message || "Invalid Home Cinema address." });
  }
});

serverUrlInput.addEventListener("change", () => {
  try {
    chrome.storage.local.set({ homeCinemaUrl: normalizeServerUrl(serverUrlInput.value) });
  } catch {}
});

serverUrlInput.addEventListener("input", updateActionState);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.homeCinemaUrl && document.activeElement !== serverUrlInput) {
    serverUrlInput.value = changes.homeCinemaUrl.newValue || "";
    updateActionState();
  }
  if (changes.captureStatus) renderStatus(changes.captureStatus.newValue);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "capture-status") renderStatus(message.status);
});

async function initialize() {
  const [{ homeCinemaUrl }, tab, response] = await Promise.all([
    chrome.storage.local.get("homeCinemaUrl"),
    activeTabQuery(),
    sendMessage({ type: "get-capture-status" })
  ]);
  activeTab = tab;
  const nextStatus = response?.status || captureStatus;
  const detectedTabUrl = serverUrlFromHomeCinemaTab(tab);
  const serverUrl = resolveServerUrl({ savedUrl: homeCinemaUrl, captureStatus: nextStatus, activeTab: tab });
  serverUrlInput.value = serverUrl;
  if (detectedTabUrl && detectedTabUrl !== homeCinemaUrl) {
    await chrome.storage.local.set({ homeCinemaUrl: detectedTabUrl });
  }
  tabTitle.textContent = tab?.title || "No active tab";
  renderStatus(
    serverUrl || nextStatus.phase !== "idle"
      ? nextStatus
      : { ...nextStatus, detail: "Enter the Home Cinema address, or open its Controller page and reopen this extension." }
  );
}

function activeTabQuery() {
  return chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => tab);
}

function renderStatus(status) {
  captureStatus = status || captureStatus;
  statusText.textContent = captureStatus.detail || "Ready to capture the active tab.";
  const active = captureStatus.phase === "capturing" || captureStatus.phase === "connecting";
  statusDot.classList.toggle("active", active);
  statusText.classList.toggle("error", captureStatus.phase === "error");
  const progress = Math.max(0, Math.min(100, Number(captureStatus.progress || 0)));
  const showProgress = ["measuring", "locking", "armed"].includes(captureStatus.stage);
  progressPanel.hidden = !showProgress;
  progressPanel.classList.toggle("blocked", Boolean(captureStatus.blocked));
  progressLabel.textContent = captureStatus.blocked
    ? "Blocked"
    : { measuring: "Measuring", locking: "Locking", armed: "Armed" }[captureStatus.stage] || "Preparing";
  progressValue.textContent = `${Math.round(progress)}%`;
  progressBar.style.width = `${progress}%`;
  progressTrack.setAttribute("aria-valuenow", String(Math.round(progress)));
  const sampleCount = Math.max(0, Number(captureStatus.sampleCount || 0));
  const sampleTarget = Math.max(1, Number(captureStatus.sampleTarget || 3));
  const stableSpeakers = Math.max(0, Number(captureStatus.stableSpeakers || 0));
  const requiredSpeakers = Math.max(0, Number(captureStatus.requiredSpeakers || 0));
  const speakerLabel = captureStatus.stage === "locking" ? "locked" : "stable";
  progressDetail.textContent = requiredSpeakers
    ? `${sampleCount}/${sampleTarget} samples · ${stableSpeakers}/${requiredSpeakers} speakers ${speakerLabel}`
    : `${sampleCount}/${sampleTarget} samples · waiting for a speaker`;
  updateActionState();
}

function updateActionState() {
  const active = captureStatus.phase === "capturing" || captureStatus.phase === "connecting";
  let configured = false;
  try {
    configured = Boolean(normalizeServerUrl(serverUrlInput.value));
  } catch {}
  startButton.disabled = active || !configured;
  stopButton.disabled = !active;
  openButton.disabled = !configured;
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
