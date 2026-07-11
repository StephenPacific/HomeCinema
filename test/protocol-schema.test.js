import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

const files = [
  "protocol/schemas/envelope.schema.json",
  "protocol/schemas/session.schema.json",
  "protocol/schemas/manifest.schema.json",
  "protocol/schemas/endpoint.schema.json",
  "protocol/schemas/commands.schema.json",
  "protocol/schemas/telemetry.schema.json",
  "protocol/examples/playback-arm.json",
  "protocol/examples/session-snapshot.json"
];

test("protocol schemas and examples are valid JSON", async () => {
  for (const file of files) {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    assert.equal(typeof parsed, "object", file);
  }
});

test("protocol examples carry the required identity fields", async () => {
  for (const file of files.filter((path) => path.includes("/examples/"))) {
    const message = JSON.parse(await readFile(file, "utf8"));
    for (const field of [
      "protocol_version",
      "message_type",
      "session_id",
      "server_incarnation_id",
      "epoch",
      "sequence",
      "message_id",
      "sent_at_server_ms",
      "payload"
    ]) {
      assert.ok(Object.hasOwn(message, field), `${file} is missing ${field}`);
    }
  }
});

test("protocol examples validate against the wire schemas", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const envelopeSchema = JSON.parse(await readFile("protocol/schemas/envelope.schema.json", "utf8"));
  const sessionSchema = JSON.parse(await readFile("protocol/schemas/session.schema.json", "utf8"));
  const commandsSchema = JSON.parse(await readFile("protocol/schemas/commands.schema.json", "utf8"));
  const arm = JSON.parse(await readFile("protocol/examples/playback-arm.json", "utf8"));
  const snapshot = JSON.parse(await readFile("protocol/examples/session-snapshot.json", "utf8"));

  const validateEnvelope = ajv.compile(envelopeSchema);
  const validateSession = ajv.compile(sessionSchema);
  const validateCommand = ajv.compile(commandsSchema);

  assert.equal(validateEnvelope(arm), true, JSON.stringify(validateEnvelope.errors));
  assert.equal(validateCommand(arm.payload), true, JSON.stringify(validateCommand.errors));
  assert.equal(validateEnvelope(snapshot), true, JSON.stringify(validateEnvelope.errors));
  assert.equal(validateSession(snapshot.payload), true, JSON.stringify(validateSession.errors));
});
