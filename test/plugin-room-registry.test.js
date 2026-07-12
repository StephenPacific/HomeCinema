import assert from "node:assert/strict";
import test from "node:test";
import { RoomRegistry } from "../plugin-cloud/room-registry.js";

function fixture() {
  let now = 1_000;
  let randomValue = 1;
  const deliveries = [];
  const registry = new RoomRegistry({
    send(client, payload) {
      deliveries.push({ client: client.name, payload });
    },
    now: () => now,
    randomBytes(length) {
      const buffer = Buffer.alloc(length, randomValue);
      randomValue += 1;
      return buffer;
    },
    roomTtlMs: 10_000,
    controllerGraceMs: 2_000,
    maximumSpeakers: 2
  });
  return {
    registry,
    deliveries,
    advance(milliseconds) {
      now += milliseconds;
    }
  };
}

test("plugin rooms use separate controller and speaker credentials", () => {
  const { registry } = fixture();
  const controller = { name: "controller" };
  const created = registry.createRoom(controller, {
    controllerName: "Living room",
    publicOrigin: "https://speaker.example"
  });

  assert.equal(created.roomId.length, 6);
  assert.notEqual(created.controllerToken, created.inviteToken);
  assert.match(created.speakerUrl, /^https:\/\/speaker\.example\/speaker\?/);
  assert.equal(new URL(created.speakerUrl).searchParams.get("room"), created.roomId);
  assert.equal(new URL(created.speakerUrl).searchParams.get("invite"), created.inviteToken);
  assert.throws(
    () => registry.joinSpeaker({ name: "bad" }, { roomId: created.roomId, inviteToken: "wrong" }),
    /ROOM_INVITE_INVALID/
  );
});

test("signaling is relayed only between authenticated peers in one room", () => {
  const { registry, deliveries } = fixture();
  const controller = { name: "controller" };
  const speaker = { name: "speaker-socket" };
  const created = registry.createRoom(controller, { publicOrigin: "https://speaker.example" });
  const joined = registry.joinSpeaker(speaker, {
    roomId: created.roomId,
    inviteToken: created.inviteToken,
    deviceId: "ipad-1",
    name: "iPad"
  });

  assert.equal(controller.peerId, "controller");
  assert.equal(speaker.peerId, joined.peerId);
  assert.equal(
    deliveries.some(({ client, payload }) => client === "controller" && payload.type === "peer:joined"),
    true
  );

  registry.relaySignal(controller, {
    targetPeerId: joined.peerId,
    signal: { description: { type: "offer", sdp: "offer" } }
  });
  assert.deepEqual(deliveries.at(-1), {
    client: "speaker-socket",
    payload: {
      type: "signal",
      roomId: created.roomId,
      fromPeerId: "controller",
      signal: { description: { type: "offer", sdp: "offer" } }
    }
  });

  registry.relaySignal(speaker, {
    targetPeerId: "controller",
    signal: { description: { type: "answer", sdp: "answer" } }
  });
  assert.equal(deliveries.at(-1).client, "controller");
  assert.equal(deliveries.at(-1).payload.fromPeerId, joined.peerId);
  assert.throws(() => registry.relaySignal({}, { targetPeerId: "controller", signal: {} }), /ROOM_NOT_JOINED/);
});

test("a controller can resume during the grace window and expired rooms close", () => {
  const { registry, deliveries, advance } = fixture();
  const firstController = { name: "controller-1" };
  const secondController = { name: "controller-2" };
  const speaker = { name: "speaker" };
  const created = registry.createRoom(firstController, { publicOrigin: "https://speaker.example" });
  registry.joinSpeaker(speaker, {
    roomId: created.roomId,
    inviteToken: created.inviteToken,
    deviceId: "phone",
    name: "Phone"
  });

  registry.detach(firstController);
  assert.equal(deliveries.at(-2).payload.type, "controller:offline");
  advance(1_000);
  const resumed = registry.resumeController(secondController, {
    roomId: created.roomId,
    controllerToken: created.controllerToken
  });
  assert.equal(resumed.speakers.length, 1);
  assert.equal(resumed.speakers[0].name, "Phone");

  registry.detach(secondController);
  advance(2_100);
  assert.deepEqual(registry.cleanup(), [created.roomId]);
  assert.equal(deliveries.at(-1).payload.type, "room:closed");
  assert.throws(() => registry.roomSummary(created.roomId), /ROOM_NOT_FOUND/);
});

test("only the controller can close a plugin room", () => {
  const { registry, deliveries } = fixture();
  const controller = { name: "controller" };
  const speaker = { name: "speaker" };
  const created = registry.createRoom(controller, { publicOrigin: "https://speaker.example" });
  registry.joinSpeaker(speaker, {
    roomId: created.roomId,
    inviteToken: created.inviteToken,
    deviceId: "phone",
    name: "Phone"
  });
  assert.throws(() => registry.closeRoom(speaker), /CONTROLLER_REQUIRED/);
  registry.closeRoom(controller);
  assert.equal(deliveries.at(-1).payload.reason, "CONTROLLER_CLOSED");
  assert.throws(() => registry.roomSummary(created.roomId), /ROOM_NOT_FOUND/);
});
