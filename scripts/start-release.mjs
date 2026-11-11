import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error("HomeCinema requires Node.js 22.12 or newer. No npm install is needed for this package.");
  process.exit(1);
}

const portText = process.env.PORT || "4173";
if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
  console.error("PORT must be an integer from 1 to 65535.");
  process.exit(1);
}
const port = Number(portText);
const url = `http://localhost:${port}/?source=live`;

function portInUse() {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let done = false;
    const finish = result => { if (!done) { done = true; socket.destroy(); resolve(result); } };
    socket.once("connect", () => finish(true));
    socket.once("error", error => finish(error.code !== "ECONNREFUSED"));
    socket.setTimeout(1500, () => finish(true));
  });
}

function readLocalJson(route) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: route, timeout: 2000 }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        body += chunk;
        if (body.length > 262144) request.destroy(new Error("Response is too large"));
      });
      response.once("end", () => {
        if (response.statusCode !== 200) return reject(new Error("Unexpected HTTP status"));
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
      response.once("error", reject);
    });
    request.once("timeout", () => request.destroy(new Error("Local service timeout")));
    request.once("error", reject);
  });
}

if (await portInUse()) {
  let isHomeCinema = false;
  try {
    const [config, live] = await Promise.all([readLocalJson("/config"), readLocalJson("/live/status")]);
    isHomeCinema = config.port === port && Array.isArray(config.addresses)
      && typeof config.isHostMachine === "boolean" && typeof live.processRunning === "boolean"
      && typeof live.sourceConnected === "boolean";
  } catch { /* An occupied port is never replaced or terminated. */ }
  if (isHomeCinema) {
    console.log(`HomeCinema is already running. Existing playback is unchanged.\nOpen: ${url}`);
  } else {
    console.error(`Port ${port} is already in use. Nothing was stopped or started. Choose another PORT.`);
    process.exitCode = 1;
  }
} else if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.error("This package contains the macOS Apple Silicon audio helper. Use a browser on other devices to join the Mac host.");
  process.exitCode = 1;
} else {
  const binary = path.join(root, "bin", "sfctl");
  try {
    await access(binary, constants.X_OK);
    await access(path.join(root, "dist", "index.html"));
  } catch {
    console.error("Release files are incomplete. Extract the whole package before starting it.");
    process.exit(1);
  }
  console.log(`Starting HomeCinema.\nOpen: ${url}\nThis starts the server only. Select speakers and start sharing in the page.\nKeep this terminal open; Ctrl-C stops this server and its owned audio sharing.`);
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: { ...process.env, PORT: String(port), SYNCFORGE_BIN: binary },
    stdio: "inherit",
    shell: false
  });
  const signals = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => child.kill(signal);
    signals.set(signal, handler);
    process.on(signal, handler);
  }
  const cleanup = () => { for (const [signal, handler] of signals) process.off(signal, handler); };
  child.once("error", error => { cleanup(); console.error(error.message); process.exitCode = 1; });
  child.once("exit", (code, signal) => { cleanup(); process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1); });
}
