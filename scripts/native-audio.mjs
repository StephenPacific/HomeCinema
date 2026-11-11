import { spawn } from "node:child_process";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = process.env.SYNCFORGE_DIR
  ? path.resolve(process.env.SYNCFORGE_DIR)
  : path.resolve(projectDir, "../syncforge");
const [command = "help", ...args] = process.argv.slice(2);
const help = `Home Cinema native Mac outputs (optional SyncForge adapter)

  npm run native:build
  npm run native:devices
  npm run native:play -- --out 'UID' --out 'UID' --seconds 20
  npm run native:calibrate -- --out 'UID' --out 'UID' --mic 'MIC_UID' --hold 300
  npm run native:live -- --out 'UID' --out 'UID' --calibrate --mic 'MIC_UID'

Copy UIDs from native:devices. Each --out selects one physical output.
Playback uses driver latency estimates; calibrate measures acoustic delays first.
Calibration plays sweeps and needs microphone permission. It defaults to -24 dBFS.
--hold is the number of seconds to keep routing audio after calibration (default 60).
Ctrl-C stops routing and restores normal macOS audio. Calibration is session-only;
starting native:play later does not retain the measured compensation or EQ.

While routing, enable the speaker in ONE Home Cinema browser tab on this Mac.
That tab's selected stem plays on all selected native outputs. All other system
audio is also captured. Phones/tablets remain separate LAN players and need their
own offset adjustment relative to the delayed Mac group.

Source defaults to ../syncforge. Set SYNCFORGE_DIR for another source checkout,
or SYNCFORGE_BIN to use an existing sfctl executable. No downloads are automatic.
native:live routes the selected native outputs AND publishes system audio to
Home Cinema's live receivers. It uses a loopback-only HTTP connection to the
running server (HOMECINEMA_URL, default http://127.0.0.1:4173).
Its default common presentation target is 700 ms (--sync-delay-ms 0 is legacy).
The native speaker arrival is estimated from driver latency plus compensation.
Do not enable live monitoring in a Mac browser: it would feed back into capture.
`;

function executable(file) {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
}

function run(binary, argv, cwd = projectDir) {
  const child = spawn(binary, argv, { cwd, stdio: "inherit", shell: false });
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => child.kill("SIGINT"); // sfctl explicitly cleans up on SIGINT.
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  function cleanup() {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
  child.once("error", (error) => {
    cleanup();
    console.error(`Cannot launch ${binary}: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    cleanup();
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
  });
}

async function runLive(binary, options) {
  const base = new URL(process.env.HOMECINEMA_URL || "http://127.0.0.1:4173");
  const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (base.protocol !== "http:" || !loopback.has(base.hostname) || base.username || base.password) {
    throw new Error("HOMECINEMA_URL must be a local http://127.0.0.1, localhost or [::1] address.");
  }
  const clockRequestStartedMs = Date.now();
  const configResponse = await fetch(new URL("/live/publisher-config", base), {
    signal: AbortSignal.timeout(5000), redirect: "error"
  });
  if (!configResponse.ok) throw new Error(`Home Cinema publisher setup failed (${configResponse.status}).`);
  const config = await configResponse.json();
  const clockRequestFinishedMs = Date.now();
  const ingest = new URL(config.ingestUrl, base);
  if (ingest.protocol !== "http:" || !loopback.has(ingest.hostname) || (ingest.port || "80") !== (base.port || "80")
      || ingest.username || ingest.password || ingest.pathname !== "/live/ingest" || ingest.search || ingest.hash
      || typeof config.token !== "string" || config.token.length < 16 || config.token.length > 256) {
    throw new Error("Home Cinema returned an invalid local publisher configuration.");
  }
  if (!Number.isFinite(config.serverTimeMs) || typeof config.clockId !== "string"
      || !config.clockId || config.clockId.length > 128) {
    throw new Error("Home Cinema did not provide a valid master-clock handshake. Update/restart the local server.");
  }
  const masterMinusUnixMs = config.serverTimeMs - (clockRequestStartedMs + clockRequestFinishedMs) / 2;
  if (!Number.isFinite(masterMinusUnixMs) || Math.abs(masterMinusUnixMs) > 86400000) {
    throw new Error("The local master clock differs by more than one day; refusing to start unsynchronized audio.");
  }
  const nativeOptions = [...options];
  if (!nativeOptions.includes("--sync-delay-ms")) nativeOptions.push("--sync-delay-ms", "700");
  const streamId = randomBytes(4).readUInt32LE(0) || 1;
  // These values describe this exact publisher handshake. Append them last so
  // callers cannot accidentally reuse an offset/stream id from an old server.
  nativeOptions.push("--master-offset-ms", String(masterMinusUnixMs), "--stream-id", String(streamId));
  const request = http.request(ingest, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-HomeCinema-Publisher": config.token }
  });
  const child = spawn(binary, ["stream", ...nativeOptions], {
    cwd: projectDir, stdio: ["ignore", "pipe", "inherit"], shell: false
  });
  let failed = false;
  let childEnded = false;
  let sourceEnded = false;
  let shutdownTimer;
  const handlers = new Map();
  function stopChild() {
    if (!childEnded) {
      child.kill("SIGINT");
      shutdownTimer ??= setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }
  }
  function fail(message) {
    if (!failed) console.error(message);
    failed = true;
    process.exitCode = 1;
    child.stdout.unpipe(request);
    request.destroy();
    stopChild();
  }
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => stopChild();
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  child.once("error", error => fail(`Cannot launch the native publisher: ${error.message}`));
  child.once("exit", (code, signal) => {
    childEnded = true;
    clearTimeout(shutdownTimer);
    for (const [name, handler] of handlers) process.off(name, handler);
    if (code !== 0 && !failed) {
      process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
      request.destroy();
    }
  });
  // A process tap can legitimately produce no PCM while idle or calibrating.
  // Socket idleness is not a publisher failure; lifecycle/error events below
  // handle teardown. Announce the publisher before the first audio packet.
  request.on("response", response => {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.resume();
      fail(`Home Cinema rejected live audio (${response.statusCode}).`);
      return;
    }
    response.resume();
    response.once("end", () => {
      if (!childEnded && !sourceEnded) fail("The live-audio receiver closed the publisher connection.");
    });
    response.once("error", () => fail("The live-audio response was interrupted."));
  });
  request.once("error", error => {
    if (!failed && !childEnded) fail(`Live publication failed: ${error.message}`);
  });
  // Node stream backpressure bounds queued PCM. The detached native exporter
  // skips old history after a blocked pipe resumes instead of replaying it.
  child.stdout.once("end", () => { sourceEnded = true; });
  request.flushHeaders();
  child.stdout.pipe(request);
  console.log("Live system audio is publishing to Home Cinema. Keep this process open; Ctrl-C stops routing and publication.");
}

if (command === "help" || command === "--help" || args.includes("--help")) {
  console.log(help);
} else if (!["build", "devices", "play", "calibrate", "live"].includes(command)) {
  console.error(`Unknown native audio command: ${command}\n${help}`);
  process.exitCode = 2;
} else if (process.platform !== "darwin") {
  console.error("Native outputs require macOS 14.4+. LAN browser playback is available separately.");
  process.exitCode = 1;
} else if (command === "build") {
  const packageDir = path.join(sourceDir, "SyncForgeKit");
  try {
    accessSync(path.join(packageDir, "Package.swift"));
    run("swift", ["build", "-c", "release", "--product", "sfctl", "--package-path", packageDir]);
  } catch {
    console.error(`SyncForge sources missing at ${sourceDir}. Clone the repository there or set SYNCFORGE_DIR.`);
    process.exitCode = 1;
  }
} else {
  const candidates = process.env.SYNCFORGE_BIN
    ? [path.resolve(process.env.SYNCFORGE_BIN)]
    : [
        path.join(sourceDir, "SyncForgeKit/.build/release/sfctl"),
        path.join(sourceDir, `SyncForgeKit/.build/${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx/release/sfctl`)
      ];
  const binary = candidates.find(executable);
  if (!binary) {
    console.error("sfctl is missing. Run npm run native:build, or set SYNCFORGE_BIN to an executable.");
    process.exitCode = 1;
  } else if (["play", "calibrate", "live"].includes(command) && !args.includes("--out")) {
    console.error("Select outputs with --out 'UID'. Run npm run native:devices to find UIDs.");
    process.exitCode = 2;
  } else {
    const options = [...args];
    if (command === "calibrate") {
      if (!options.includes("--level")) options.push("--level", "-24");
      if (!options.includes("--hold")) options.push("--hold", "60");
      console.log("Calibration will play sweeps. Keep the microphone and speakers stationary.");
    }
    if (command !== "devices") {
      console.log("Routing this Mac's system audio. Ctrl-C restores normal playback.");
    }
    if (command === "live") {
      if (!options.includes("--level")) options.push("--level", "-24");
      try { await runLive(binary, options); }
      catch (error) { console.error(`Cannot start live audio: ${error.message}`); process.exitCode = 1; }
    } else {
      run(binary, [command === "play" ? "run" : command, ...options]);
    }
  }
}
