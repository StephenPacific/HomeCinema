import { execFile, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LOG_BYTES = 4096;

function boundedText(value) {
  const bytes = Buffer.from(String(value));
  let text = bytes.subarray(Math.max(0, bytes.length - LOG_BYTES)).toString("utf8");
  // A cut through a UTF-8 code point can produce a replacement character whose
  // encoded width exceeds the original suffix by a byte or two.
  while (Buffer.byteLength(text) > LOG_BYTES) text = text.slice(1);
  return text;
}

function failure(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function canExecute(file) {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
}

function deviceList(value) {
  if (!value || !Array.isArray(value.outputs) || !Array.isArray(value.inputs)) {
    throw failure("Native device discovery returned an invalid device list.", 503);
  }
  const normalize = list => list.map(device => {
    if (!device || typeof device.uid !== "string" || !device.uid || device.uid.length > 1024) {
      throw failure("Native device discovery returned an invalid device UID.", 503);
    }
    return {
      uid: device.uid,
      name: typeof device.name === "string" ? device.name : device.uid,
      transport: typeof device.transport === "string" ? device.transport : "unknown",
      transportName: typeof device.transportName === "string" ? device.transportName : "Unknown",
      isDefault: device.isDefault === true
    };
  });
  const outputs = normalize(value.outputs), inputs = normalize(value.inputs);
  const recommendedMicrophoneUID = inputs.some(device => device.uid === value.recommendedMicrophoneUID)
    ? value.recommendedMicrophoneUID : null;
  return { outputs, inputs, recommendedMicrophoneUID };
}

export function createNativeAudioControl({
  projectDir, getServerUrl, onState = () => {}, env = process.env, stopTimeoutMs = 5000
}) {
  const root = path.resolve(projectDir);
  const childEnv = { ...env };
  let owned = null, pendingStart = false, generation = 0, stopPromise = null;
  let phase = "off", error = null, log = Buffer.alloc(0), phaseTail = "";
  let lastExit = null;
  let savedExplicitDelays = null;

  function status() {
    return { processRunning: Boolean(owned), phase, error, diagnostics: boundedText(log.toString("utf8")), lastExit };
  }
  function announce() {
    try { onState(status()); } catch { /* A UI observer must not abandon an owned audio process. */ }
  }
  function setPhase(next, message = null) {
    phase = next; error = message; announce();
  }
  function binary() {
    const source = childEnv.SYNCFORGE_DIR
      ? path.resolve(root, childEnv.SYNCFORGE_DIR) : path.resolve(root, "../syncforge");
    const candidates = childEnv.SYNCFORGE_BIN ? [path.resolve(root, childEnv.SYNCFORGE_BIN)] : [
      path.join(source, "SyncForgeKit/.build/release/sfctl"),
      path.join(source, `SyncForgeKit/.build/${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx/release/sfctl`)
    ];
    const found = candidates.find(canExecute);
    if (!found) throw failure("Native audio is not built. Run npm run native:build first.", 503);
    return found;
  }
  async function devices() {
    try {
      const { stdout } = await execFileAsync(binary(), ["devices", "--json"], {
        cwd: root, env: childEnv, timeout: 5000, maxBuffer: 256 * 1024, encoding: "utf8", windowsHide: true
      });
      return deviceList(JSON.parse(stdout));
    } catch (cause) {
      if (cause.statusCode) throw cause;
      throw failure(`Could not list native audio devices: ${cause.killed ? "device discovery timed out" : cause.message}`, 503);
    }
  }
  function collect(chunk) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    log = data.length >= LOG_BYTES ? data.subarray(data.length - LOG_BYTES) : Buffer.concat([log, data]).subarray(-LOG_BYTES);
    phaseTail = (phaseTail + data.toString("utf8")).slice(-2048);
    if (["starting", "calibrating"].includes(phase) && /Publishing captured system audio/.test(phaseTail)) {
      phase = "streaming";
    } else if (phase === "starting" && /Calibrating native outputs/.test(phaseTail)) {
      phase = "calibrating";
    }
    announce();
  }
  async function start({ outputs, microphoneUID, calibrate = false, seconds = 7200, delaysMs, syncDelayMs = 700 } = {}) {
    if (owned || pendingStart) throw failure("A native audio session is already running or starting.", 409);
    if (!Array.isArray(outputs) || !outputs.length || outputs.length > 32 ||
        outputs.some(uid => typeof uid !== "string" || !uid || uid.length > 1024) || new Set(outputs).size !== outputs.length) {
      throw failure("Choose one or more distinct native output devices.");
    }
    if (typeof calibrate !== "boolean") throw failure("calibrate must be true or false.");
    if (delaysMs !== undefined && (!delaysMs || typeof delaysMs !== "object" || Array.isArray(delaysMs)
        || Object.entries(delaysMs).some(([uid, delay]) => !outputs.includes(uid) || typeof delay !== "number"
          || !Number.isFinite(delay) || delay < 0 || delay > 3000))) {
      throw failure("Output delays must belong to selected devices and be between 0 and 3000 ms.");
    }
    if (calibrate && delaysMs !== undefined) throw failure("Choose measured calibration or explicit delays for this session.");
    if (!Number.isInteger(syncDelayMs) || (syncDelayMs !== 0 && (syncDelayMs < 450 || syncDelayMs > 1000))) {
      throw failure("Shared playback delay must be 450–1000 ms, or 0 for legacy playback.");
    }
    if (!Number.isInteger(seconds) || seconds < 30 || seconds > 7200) throw failure("Session duration must be 30–7200 seconds.");
    if (microphoneUID !== undefined && microphoneUID !== null && typeof microphoneUID !== "string") {
      throw failure("Choose a valid calibration microphone.");
    }
    const operation = ++generation;
    pendingStart = true; log = Buffer.alloc(0); phaseTail = ""; lastExit = null; setPhase("starting");
    try {
      const available = await devices();
      if (operation !== generation) throw failure("Native audio start was cancelled.", 409);
      const allowedOutputs = new Set(available.outputs.map(device => device.uid));
      if (outputs.some(uid => !allowedOutputs.has(uid))) throw failure("A selected output is no longer connected. Refresh the device list.");
      const mic = microphoneUID ?? undefined;
      if (mic !== undefined && !available.inputs.some(device => device.uid === mic)) {
        throw failure("The selected microphone is no longer connected. Refresh the device list.");
      }
      // Reuse the session's explicitly supplied timing only when every selected
      // route has a value. A partially known group needs a new estimate/calibration.
      const chosenDelays = delaysMs ?? (!calibrate && savedExplicitDelays
        && outputs.every(uid => Object.hasOwn(savedExplicitDelays, uid)) ? savedExplicitDelays : undefined);
      if (calibrate) savedExplicitDelays = null;
      else if (delaysMs !== undefined) savedExplicitDelays = { ...delaysMs };
      const executable = binary();
      const argv = [path.join(root, "scripts/native-audio.mjs"), "live"];
      for (const uid of outputs) argv.push("--out", chosenDelays && Object.hasOwn(chosenDelays, uid) ? `${uid}:${chosenDelays[uid]}` : uid);
      if (calibrate) argv.push("--calibrate");
      if (mic !== undefined) argv.push("--mic", mic);
      argv.push("--seconds", String(seconds));
      argv.push("--sync-delay-ms", String(syncDelayMs));
      const serverUrl = getServerUrl();
      const parsed = new URL(serverUrl);
      if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || parsed.username || parsed.password) {
        throw failure("The native publisher needs this server's loopback HTTP URL.", 503);
      }
      const child = spawn(process.execPath, argv, {
        cwd: root, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
        env: { ...childEnv, SYNCFORGE_BIN: executable, HOMECINEMA_URL: serverUrl }
      });
      owned = child;
      child.stdout.on("data", collect); child.stderr.on("data", collect);
      child.once("error", cause => {
        if (owned === child) { owned = null; setPhase("error", `Cannot start native audio: ${cause.message}`); }
      });
      child.once("close", (code, signal) => {
        if (owned !== child) return;
        const stopped = phase === "stopping";
        lastExit = { code, signal, requestedStop: stopped, at: Date.now() };
        owned = null;
        if (stopped || code === 0) setPhase("off");
        else setPhase("error", boundedText(`Native audio stopped (${signal || code}). ${log.toString("utf8").trim()}`));
      });
      announce();
      return status();
    } catch (cause) {
      if (operation === generation && !owned) setPhase("error", cause.message);
      throw cause;
    } finally {
      if (operation === generation) pendingStart = false;
    }
  }
  async function stop() {
    if (stopPromise) return stopPromise;
    generation++; pendingStart = false;
    const child = owned;
    if (!child) { setPhase("off"); return status(); }
    setPhase("stopping");
    stopPromise = new Promise(resolve => {
      const timer = setTimeout(() => {
        try {
          // The wrapper has its own process group; a forced stop must not leave
          // its native capture child orphaned and muting normal system playback.
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch { child.kill("SIGKILL"); }
      }, stopTimeoutMs);
      child.once("close", () => { clearTimeout(timer); resolve(status()); });
      child.kill("SIGTERM");
    }).finally(() => { stopPromise = null; });
    return stopPromise;
  }
  return { devices, status, start, stop, close: stop };
}
