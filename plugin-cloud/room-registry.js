import crypto from "node:crypto";

export const PLUGIN_ROOM_PROTOCOL_VERSION = 1;

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export class RoomRegistry {
  constructor({
    send,
    now = () => Date.now(),
    randomBytes = crypto.randomBytes,
    roomTtlMs = 4 * 60 * 60 * 1000,
    controllerGraceMs = 60_000,
    maximumSpeakers = 12
  } = {}) {
    if (typeof send !== "function") throw new Error("RoomRegistry requires a send function");
    this.send = send;
    this.now = now;
    this.randomBytes = randomBytes;
    this.roomTtlMs = roomTtlMs;
    this.controllerGraceMs = controllerGraceMs;
    this.maximumSpeakers = maximumSpeakers;
    this.rooms = new Map();
  }

  createRoom(client, { controllerName = "Home Cinema", publicOrigin } = {}) {
    this.detach(client);
    const roomId = this.createUniqueCode(6);
    const controllerToken = this.createToken(24);
    const inviteToken = this.createToken(18);
    const now = this.now();
    const room = {
      id: roomId,
      controller: client,
      controllerName: cleanText(controllerName, 40) || "Home Cinema",
      controllerToken,
      inviteToken,
      controllerDisconnectedAt: null,
      createdAt: now,
      expiresAt: now + this.roomTtlMs,
      speakers: new Map()
    };
    this.rooms.set(roomId, room);
    attachClient(client, roomId, "controller", "controller");

    return {
      type: "room:created",
      protocolVersion: PLUGIN_ROOM_PROTOCOL_VERSION,
      roomId,
      controllerToken,
      inviteToken,
      speakerUrl: speakerJoinUrl(publicOrigin, roomId, inviteToken),
      expiresAt: room.expiresAt,
      speakerCount: 0
    };
  }

  resumeController(client, { roomId, controllerToken } = {}) {
    const room = this.requireRoom(roomId);
    if (!safeTokenEqual(room.controllerToken, controllerToken)) throw roomError("ROOM_AUTH_FAILED");
    this.detach(client);
    if (room.controller && room.controller !== client) {
      this.send(room.controller, { type: "room:replaced", roomId: room.id });
    }
    room.controller = client;
    room.controllerDisconnectedAt = null;
    this.touch(room);
    attachClient(client, room.id, "controller", "controller");
    for (const speaker of room.speakers.values()) {
      this.send(speaker.client, { type: "controller:online", roomId: room.id });
    }
    return {
      type: "room:resumed",
      protocolVersion: PLUGIN_ROOM_PROTOCOL_VERSION,
      roomId: room.id,
      expiresAt: room.expiresAt,
      speakers: [...room.speakers.values()].map(publicSpeaker)
    };
  }

  joinSpeaker(client, { roomId, inviteToken, deviceId, name } = {}) {
    const room = this.requireRoom(roomId);
    if (!safeTokenEqual(room.inviteToken, inviteToken)) throw roomError("ROOM_INVITE_INVALID");
    this.detach(client);

    const cleanDeviceId = cleanIdentifier(deviceId, 80) || this.createToken(9);
    const existing = [...room.speakers.values()].find((speaker) => speaker.deviceId === cleanDeviceId);
    if (existing) {
      this.send(existing.client, { type: "room:replaced", roomId: room.id });
      room.speakers.delete(existing.peerId);
    }
    if (room.speakers.size >= this.maximumSpeakers) throw roomError("ROOM_FULL");

    const peerId = this.createUniquePeerId(room);
    const speaker = {
      peerId,
      deviceId: cleanDeviceId,
      name: cleanText(name, 40) || "Speaker",
      client,
      joinedAt: this.now()
    };
    room.speakers.set(peerId, speaker);
    attachClient(client, room.id, "speaker", peerId);
    this.touch(room);

    if (room.controller) {
      this.send(room.controller, { type: "peer:joined", roomId: room.id, peer: publicSpeaker(speaker) });
    }
    this.broadcastRoomState(room);
    return {
      type: "room:joined",
      protocolVersion: PLUGIN_ROOM_PROTOCOL_VERSION,
      roomId: room.id,
      peerId,
      controllerOnline: Boolean(room.controller),
      controllerName: room.controllerName,
      expiresAt: room.expiresAt
    };
  }

  relaySignal(client, { targetPeerId, signal } = {}) {
    const room = this.roomForClient(client);
    if (!signal || typeof signal !== "object") throw roomError("SIGNAL_INVALID");
    const targetId = String(targetPeerId || "");
    const target = targetId === "controller"
      ? room.controller
      : room.speakers.get(targetId)?.client;
    if (!target) throw roomError("PEER_OFFLINE");
    if (target === client) throw roomError("SIGNAL_TARGET_INVALID");

    this.touch(room);
    this.send(target, {
      type: "signal",
      roomId: room.id,
      fromPeerId: client.peerId,
      signal
    });
    return { type: "signal:relayed", targetPeerId: targetId };
  }

  heartbeat(client) {
    const room = this.roomForClient(client);
    this.touch(room);
    return { type: "heartbeat", serverTime: this.now(), roomId: room.id };
  }

  closeRoom(client, reason = "CONTROLLER_CLOSED") {
    const room = this.roomForClient(client);
    if (client.role !== "controller" || room.controller !== client) throw roomError("CONTROLLER_REQUIRED");
    this.closeRoomRecord(room, reason);
    return { type: "room:closed", roomId: room.id, reason };
  }

  detach(client) {
    if (!client?.roomId) return;
    const room = this.rooms.get(client.roomId);
    const role = client.role;
    const peerId = client.peerId;
    clearClient(client);
    if (!room) return;

    if (role === "controller" && room.controller === client) {
      room.controller = null;
      room.controllerDisconnectedAt = this.now();
      for (const speaker of room.speakers.values()) {
        this.send(speaker.client, { type: "controller:offline", roomId: room.id });
      }
      this.broadcastRoomState(room);
      return;
    }

    if (role === "speaker" && room.speakers.get(peerId)?.client === client) {
      const speaker = room.speakers.get(peerId);
      room.speakers.delete(peerId);
      if (room.controller) {
        this.send(room.controller, { type: "peer:left", roomId: room.id, peerId, deviceId: speaker.deviceId });
      }
      this.broadcastRoomState(room);
    }
  }

  cleanup() {
    const now = this.now();
    const removed = [];
    for (const room of this.rooms.values()) {
      const controllerExpired =
        !room.controller &&
        Number.isFinite(room.controllerDisconnectedAt) &&
        now - room.controllerDisconnectedAt >= this.controllerGraceMs;
      if (now < room.expiresAt && !controllerExpired) continue;
      removed.push(room.id);
      this.closeRoomRecord(room, "ROOM_EXPIRED");
    }
    return removed;
  }

  roomSummary(roomId) {
    const room = this.requireRoom(roomId);
    return {
      roomId: room.id,
      controllerOnline: Boolean(room.controller),
      speakerCount: room.speakers.size,
      expiresAt: room.expiresAt
    };
  }

  roomForClient(client) {
    if (!client?.roomId) throw roomError("ROOM_NOT_JOINED");
    return this.requireRoom(client.roomId);
  }

  requireRoom(roomId) {
    const id = String(roomId || "").trim().toUpperCase();
    const room = this.rooms.get(id);
    if (!room || this.now() >= room.expiresAt) throw roomError("ROOM_NOT_FOUND");
    return room;
  }

  touch(room) {
    room.expiresAt = this.now() + this.roomTtlMs;
  }

  broadcastRoomState(room) {
    const payload = {
      type: "room:state",
      roomId: room.id,
      controllerOnline: Boolean(room.controller),
      speakerCount: room.speakers.size,
      expiresAt: room.expiresAt
    };
    if (room.controller) this.send(room.controller, payload);
    for (const speaker of room.speakers.values()) this.send(speaker.client, payload);
  }

  closeRoomRecord(room, reason) {
    if (room.controller) {
      this.send(room.controller, { type: "room:closed", roomId: room.id, reason });
      clearClient(room.controller);
    }
    for (const speaker of room.speakers.values()) {
      this.send(speaker.client, { type: "room:closed", roomId: room.id, reason });
      clearClient(speaker.client);
    }
    room.speakers.clear();
    this.rooms.delete(room.id);
  }

  createUniqueCode(length) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const bytes = this.randomBytes(length);
      let code = "";
      for (let index = 0; index < length; index += 1) {
        code += ROOM_ALPHABET[bytes[index] % ROOM_ALPHABET.length];
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new Error("Could not allocate a room code");
  }

  createUniquePeerId(room) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const peerId = this.createToken(7);
      if (!room.speakers.has(peerId)) return peerId;
    }
    throw new Error("Could not allocate a peer id");
  }

  createToken(bytes) {
    return this.randomBytes(bytes).toString("base64url");
  }
}

export function roomError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function attachClient(client, roomId, role, peerId) {
  client.roomId = roomId;
  client.role = role;
  client.peerId = peerId;
}

function clearClient(client) {
  if (!client) return;
  client.roomId = null;
  client.role = null;
  client.peerId = null;
}

function publicSpeaker(speaker) {
  return {
    peerId: speaker.peerId,
    deviceId: speaker.deviceId,
    name: speaker.name,
    joinedAt: speaker.joinedAt
  };
}

function speakerJoinUrl(publicOrigin, roomId, inviteToken) {
  if (!publicOrigin) return "";
  const url = new URL("/speaker", publicOrigin);
  url.searchParams.set("room", roomId);
  url.searchParams.set("invite", inviteToken);
  return url.toString();
}

function cleanText(value, maximumLength) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, maximumLength);
}

function cleanIdentifier(value, maximumLength) {
  return String(value || "").replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, maximumLength);
}

function safeTokenEqual(expected, actual) {
  const left = Buffer.from(String(expected || ""));
  const right = Buffer.from(String(actual || ""));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}
