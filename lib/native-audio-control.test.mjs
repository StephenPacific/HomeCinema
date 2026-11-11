import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createNativeAudioControl } from "./native-audio-control.mjs";

const oddUID = "Speaker with spaces:output;$(not-a-command)";
const nativeDevices = {
  outputs: [{ uid: oddUID, name: "Test speaker", transport: "bluetooth", transportName: "Bluetooth", isDefault: true, ignored: "extra" }],
  inputs: [{ uid: "mic:1", name: "Test microphone", transport: "builtIn", transportName: "Built-in", isDefault: true }],
  recommendedMicrophoneUID: "mic:1"
};

async function fixture(t, mode = "normal", options = {}) {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "homecinema-native-control-"));
  await fs.mkdir(path.join(projectDir, "scripts"));
  const deviceFile = path.join(projectDir, "devices.json"), resultFile = path.join(projectDir, "result.json");
  const binary = path.join(projectDir, "fake sfctl");
  await fs.writeFile(deviceFile, JSON.stringify(nativeDevices));
  await fs.writeFile(binary, `#!/usr/bin/env node
import fs from 'node:fs';
if (process.argv.slice(2).join(' ') !== 'devices --json') process.exit(9);
if (process.env.TEST_DISCOVERY === 'invalid') { console.log('not JSON'); process.exit(0); }
if (process.env.TEST_DISCOVERY === 'slow') { setTimeout(() => {}, 15000); }
else console.log(fs.readFileSync(process.env.TEST_DEVICE_FILE, 'utf8'));
`, { mode: 0o755 });
  await fs.writeFile(path.join(projectDir, "scripts/native-audio.mjs"), `import fs from 'node:fs';
fs.writeFileSync(process.env.TEST_RESULT_FILE, JSON.stringify({ args: process.argv.slice(2), url: process.env.HOMECINEMA_URL, binary: process.env.SYNCFORGE_BIN, pid: process.pid }));
if (process.env.TEST_MODE === 'fail') { console.error('native test failure'); process.exit(7); }
console.log('Calibrating native outputs before live publication…');
setTimeout(() => console.log('Publishing captured system audio as stereo Float32 PCM'), 20);
if (process.env.TEST_MODE === 'verbose') console.error('x'.repeat(12000));
if (process.env.TEST_MODE === 'ignore') process.on('SIGTERM', () => {});
else process.on('SIGTERM', () => { console.log('Normal audio restored'); process.exit(0); });
setInterval(() => {}, 1000);
`);
  const env = { ...process.env, SYNCFORGE_BIN: binary, TEST_DEVICE_FILE: deviceFile, TEST_RESULT_FILE: resultFile, TEST_MODE: mode, ...options.env };
  const updates = [];
  const control = createNativeAudioControl({ projectDir, env, getServerUrl: () => "http://127.0.0.1:4173", onState: state => updates.push(state), stopTimeoutMs: options.stopTimeoutMs ?? 5000 });
  t.after(async () => { await control.close(); await fs.rm(projectDir, { recursive: true, force: true }); });
  return { control, projectDir, binary, deviceFile, resultFile, updates };
}

async function eventually(predicate, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Expected asynchronous lifecycle state was not reached.");
}

test("device discovery uses JSON argv, normalizes fields and preserves exact UID bytes", async t => {
  const { control } = await fixture(t);
  const devices = await control.devices();
  assert.equal(devices.outputs[0].uid, oddUID);
  assert.equal(devices.outputs[0].transport, "bluetooth");
  assert.equal(devices.outputs[0].ignored, undefined);
  assert.equal(devices.recommendedMicrophoneUID, "mic:1");
  assert.deepEqual(control.status(), { processRunning: false, phase: "off", error: null, diagnostics: "", lastExit: null });
});

test("start validates durations, distinct output choices and microphone against fresh devices", async t => {
  const { control, deviceFile } = await fixture(t);
  for (const options of [
    {}, { outputs: [] }, { outputs: [oddUID, oddUID] }, { outputs: [oddUID], seconds: 29 },
    { outputs: [oddUID], seconds: 7201 }, { outputs: [oddUID], seconds: NaN },
    { outputs: [oddUID], calibrate: "yes" }, { outputs: [oddUID], syncDelayMs: 449 },
    { outputs: [oddUID], syncDelayMs: 1001 }, { outputs: [oddUID], syncDelayMs: NaN }, { outputs: ["not connected"] },
    { outputs: [oddUID], microphoneUID: "missing microphone" }
  ]) await assert.rejects(control.start(options), error => error.statusCode === 400);
  const listed = await control.devices(); assert.equal(listed.outputs.length, 1);
  await fs.writeFile(deviceFile, JSON.stringify({ ...nativeDevices, outputs: [] }));
  await assert.rejects(control.start({ outputs: [oddUID] }), /no longer connected/);
  assert.equal(control.status().processRunning, false);
});

test("the owned launcher receives literal argv and local URL, reports phases and stops cleanly", async t => {
  const { control, resultFile, updates, binary } = await fixture(t);
  const result = await control.start({ outputs: [oddUID], microphoneUID: "mic:1", calibrate: true, seconds: 120 });
  assert.equal(result.processRunning, true);
  await eventually(() => control.status().phase === "streaming");
  const invocation = JSON.parse(await fs.readFile(resultFile, "utf8"));
  assert.deepEqual(invocation.args, ["live", "--out", oddUID, "--calibrate", "--mic", "mic:1", "--seconds", "120", "--sync-delay-ms", "700"]);
  assert.equal(invocation.url, "http://127.0.0.1:4173"); assert.equal(invocation.binary, binary);
  assert.ok(updates.some(update => update.phase === "calibrating"));
  await assert.rejects(control.start({ outputs: [oddUID] }), error => error.statusCode === 409);
  const stopped = await control.stop();
  assert.equal(stopped.phase, "off"); assert.equal(stopped.processRunning, false);
  assert.match(stopped.diagnostics, /Normal audio restored/);
});

test("concurrent starts cannot race through asynchronous device discovery", async t => {
  const { control } = await fixture(t);
  const starting = control.start({ outputs: [oddUID] });
  await assert.rejects(control.start({ outputs: [oddUID] }), error => error.statusCode === 409);
  await starting;
  await control.stop();
});

test("previously measured explicit delays resume routing without calibration sweeps", async t => {
  const { control, resultFile } = await fixture(t);
  await assert.rejects(control.start({ outputs: [oddUID], delaysMs: { missing: 12 } }), /Output delays/);
  await assert.rejects(control.start({ outputs: [oddUID], delaysMs: { [oddUID]: NaN } }), /Output delays/);
  await assert.rejects(control.start({ outputs: [oddUID], calibrate: true, delaysMs: { [oddUID]: 12 } }), /Choose measured/);
  await control.start({ outputs: [oddUID], calibrate: false, delaysMs: { [oddUID]: 322.6 } });
  await eventually(() => control.status().phase === "streaming");
  const invocation = JSON.parse(await fs.readFile(resultFile, "utf8"));
  assert.deepEqual(invocation.args, ["live", "--out", `${oddUID}:322.6`, "--seconds", "7200", "--sync-delay-ms", "700"]);
  assert.equal(invocation.args.includes("--calibrate"), false);
  await control.stop();
  await control.start({ outputs: [oddUID], calibrate: false });
  await eventually(() => control.status().phase === "streaming");
  const reused = JSON.parse(await fs.readFile(resultFile, "utf8"));
  assert.deepEqual(reused.args, invocation.args);
  await control.stop();
});

test("failed launch releases ownership and bounded logs do not grow with noisy stderr", async t => {
  const { control } = await fixture(t, "fail");
  await control.start({ outputs: [oddUID] });
  await eventually(() => control.status().phase === "error");
  assert.equal(control.status().processRunning, false);
  assert.match(control.status().error, /native test failure/);
  const noisy = await fixture(t, "verbose");
  await noisy.control.start({ outputs: [oddUID] });
  await eventually(() => noisy.control.status().diagnostics.includes("x".repeat(100)));
  assert.ok(Buffer.byteLength(noisy.control.status().diagnostics) <= 4096);
  await noisy.control.stop();
});

test("a process ignoring graceful termination is forcibly reaped", async t => {
  const { control } = await fixture(t, "ignore", { stopTimeoutMs: 60 });
  await control.start({ outputs: [oddUID] });
  await eventually(() => control.status().phase === "streaming");
  const stopped = await control.stop();
  assert.equal(stopped.phase, "off"); assert.equal(stopped.processRunning, false);
});

test("invalid discovery output fails before any audio wrapper is spawned", async t => {
  const { control, resultFile } = await fixture(t, "normal", { env: { TEST_DISCOVERY: "invalid" } });
  await assert.rejects(control.devices(), error => error.statusCode === 503);
  await assert.rejects(control.start({ outputs: [oddUID] }), error => error.statusCode === 503);
  await assert.rejects(fs.access(resultFile));
});
