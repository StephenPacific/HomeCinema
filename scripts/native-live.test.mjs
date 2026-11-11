import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const launcher = fileURLToPath(new URL("./native-audio.mjs", import.meta.url));
const token = "local-test-publisher-token-0123456789";
const publisherConfig = (ingestUrl = "/live/ingest") => ({ token, ingestUrl,
  clockId: "offline-test-master-clock", serverTimeMs: Date.now() + 35 });

async function fixture(t, handler, { longRunning = false, idleMs = 0 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "homecinema-live-test-"));
  const binary = path.join(dir, "sfctl");
  await fs.writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] !== 'stream') process.exit(2);
fs.writeFileSync(${JSON.stringify(path.join(dir, "argv.json"))}, JSON.stringify(process.argv.slice(2)));
process.on('SIGINT', () => { fs.writeFileSync(${JSON.stringify(path.join(dir, "stopped"))}, 'cleaned'); process.exit(130); });
let seq=0;
setTimeout(() => { const tick=setInterval(() => {
  const p=Buffer.alloc(20+16); p.write('HCA1'); p.writeUInt32LE(48000,4); p.writeUInt32LE(2,8); p.writeUInt32LE(2,12); p.writeUInt32LE(seq++,16); p.writeFloatLE(0.25,20);
  process.stdout.write(p);
  if (seq===3 && !${longRunning}) { clearInterval(tick); process.stdout.end(); }
},20); }, ${idleMs});
`, { mode: 0o755 });
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const env = { ...process.env, SYNCFORGE_BIN: binary, HOMECINEMA_URL: `http://127.0.0.1:${port}` };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { env, dir };
}

function run(env) {
  const child = spawn(process.execPath, [launcher, "live", "--out", "speaker with spaces:output"], { env });
  let stdout = "", stderr = "";
  child.stdout.on("data", d => { stdout += d; });
  child.stderr.on("data", d => { stderr += d; });
  const done = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, done };
}

test("live bridge authenticates and preserves complete PCM bytes", async t => {
  let received;
  const { env, dir } = await fixture(t, (req, res) => {
    if (req.url === "/live/publisher-config") {
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(publisherConfig())); return;
    }
    assert.equal(req.url, "/live/ingest");
    assert.equal(req.headers["x-homecinema-publisher"], token);
    const chunks = []; req.on("data", d => chunks.push(d)); req.on("end", () => { received = Buffer.concat(chunks); res.end("ok"); });
  });
  const result = await run(env).done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(received.length, 3 * 36);
  assert.equal(received.subarray(0, 4).toString(), "HCA1");
  assert.equal(received.readFloatLE(20), 0.25);
  assert.equal(received.readUInt32LE(36 + 16), 1);
  const argv = JSON.parse(await fs.readFile(path.join(dir, "argv.json"), "utf8"));
  assert.equal(argv[argv.indexOf("--sync-delay-ms") + 1], "700");
  assert.ok(Number.isFinite(Number(argv[argv.indexOf("--master-offset-ms") + 1])));
  const streamId = Number(argv[argv.indexOf("--stream-id") + 1]);
  assert.ok(Number.isInteger(streamId) && streamId > 0 && streamId <= 0xffffffff);
  assert.ok(!result.stdout.includes(token)); assert.ok(!result.stderr.includes(token));
});

test("rejected publication stops the native child cleanly", async t => {
  const { env, dir } = await fixture(t, (req, res) => {
    if (req.url === "/live/publisher-config") { res.end(JSON.stringify(publisherConfig())); return; }
    // Wait until the mock has initialized its SIGINT handler. A rejection
    // immediately after flushed headers may legitimately terminate it before
    // JS startup, in which case there is no cleanup-marker file to assert.
    req.once("data", () => { res.writeHead(403); res.end("rejected"); });
  }, { longRunning: true });
  const result = await run(env).done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /rejected live audio \(403\)/);
  assert.equal(await fs.readFile(path.join(dir, "stopped"), "utf8"), "cleaned");
});

test("publisher refuses off-box URLs before launching native capture", async () => {
  const result = await run({ ...process.env, SYNCFORGE_BIN: process.execPath, HOMECINEMA_URL: "http://example.com:4173" }).done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /must be a local/);
});

test("SIGTERM forwards cleanup to the native child", async t => {
  let reportStarted;
  const started = new Promise(resolve => { reportStarted = resolve; });
  const { env, dir } = await fixture(t, (req, res) => {
    if (req.url === "/live/publisher-config") { res.end(JSON.stringify(publisherConfig())); return; }
    req.once("data", reportStarted);
    req.on("end", () => res.end("ok"));
  }, { longRunning: true });
  const { child, done } = run(env);
  t.after(() => child.kill("SIGKILL"));
  await started;
  child.kill("SIGTERM");
  const result = await done;
  assert.equal(result.code, 130, result.stderr);
  assert.equal(await fs.readFile(path.join(dir, "stopped"), "utf8"), "cleaned");
});

test("idle publisher announces HTTP headers before any captured PCM", async t => {
  let reportConnected;
  let receivedBytes = 0;
  const connected = new Promise(resolve => { reportConnected = resolve; });
  const { env } = await fixture(t, (req, res) => {
    if (req.url === "/live/publisher-config") { res.end(JSON.stringify(publisherConfig())); return; }
    reportConnected();
    req.on("data", chunk => { receivedBytes += chunk.length; });
    req.on("end", () => res.end("ok"));
  }, { idleMs: 1500 });
  const { child, done } = run(env);
  t.after(() => child.kill("SIGKILL"));
  let timer;
  await Promise.race([
    connected,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("publisher headers waited for PCM")), 1000); })
  ]).finally(() => clearTimeout(timer));
  assert.equal(receivedBytes, 0, "the connection should exist while capture is still idle");
  const result = await done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(receivedBytes, 3 * 36);
});

test("missing master clock refuses to launch native capture", async t => {
  const { env, dir } = await fixture(t, (_req, res) => {
    res.end(JSON.stringify({ token, ingestUrl: "/live/ingest" }));
  });
  const result = await run(env).done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /master-clock handshake/);
  await assert.rejects(fs.access(path.join(dir, "argv.json")), { code: "ENOENT" });
});
