import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_ROOM_PROTOCOL_VERSION, RoomRegistry } from "./room-registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(__dirname);
const publicDir = path.join(__dirname, "public");
const maximumFrameBytes = 64 * 1024;

export function createPluginCloudServer({
  port = Number(process.env.PLUGIN_SIGNAL_PORT || process.env.PORT || 4180),
  host = process.env.PLUGIN_SIGNAL_HOST || "0.0.0.0",
  publicOrigin = process.env.PLUGIN_PUBLIC_ORIGIN || "",
  allowedOrigins = splitList(process.env.PLUGIN_ALLOWED_ORIGINS),
  stunUrls = splitList(process.env.STUN_URLS || "stun:stun.l.google.com:19302"),
  turnUrls = splitList(process.env.TURN_URLS),
  turnUsername = process.env.TURN_USERNAME || "",
  turnCredential = process.env.TURN_CREDENTIAL || ""
} = {}) {
  const connections = new Set();
  let nextClientId = 1;
  const send = (client, payload) => sendJsonFrame(client, payload);
  const registry = new RoomRegistry({ send });
  const iceServers = buildIceServers({ stunUrls, turnUrls, turnUsername, turnCredential });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", requestOrigin(req, port, publicOrigin));
    setCommonHeaders(res);
    if (req.method !== "GET") {
      sendText(res, 405, "Method Not Allowed");
      return;
    }
    if (url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "home-cinema-plugin-signal",
        protocolVersion: PLUGIN_ROOM_PROTOCOL_VERSION,
        roomCount: registry.rooms.size
      });
      return;
    }
    if (url.pathname === "/config") {
      sendJson(res, 200, {
        protocolVersion: PLUGIN_ROOM_PROTOCOL_VERSION,
        signalingOrigin: publicOrigin || requestOrigin(req, port),
        iceServers
      });
      return;
    }
    if (url.pathname === "/") {
      sendJson(res, 200, {
        name: "Home Cinema plugin signaling",
        protocolVersion: PLUGIN_ROOM_PROTOCOL_VERSION,
        speakerPath: "/speaker"
      });
      return;
    }

    const staticFiles = new Map([
      ["/speaker", path.join(publicDir, "speaker.html")],
      ["/speaker.html", path.join(publicDir, "speaker.html")],
      ["/speaker.js", path.join(publicDir, "speaker.js")],
      ["/speaker.css", path.join(publicDir, "speaker.css")],
      ["/plugin-room.js", path.join(projectDir, "extension", "plugin-room.js")]
    ]);
    const filePath = staticFiles.get(url.pathname);
    if (!filePath) {
      sendText(res, 404, "Not Found");
      return;
    }
    serveFile(filePath, res);
  });

  server.on("upgrade", (req, socket) => {
    const requestUrl = new URL(req.url || "/", "http://localhost");
    if (requestUrl.pathname !== "/signal" || req.headers.upgrade?.toLowerCase() !== "websocket") {
      socket.destroy();
      return;
    }
    if (!originAllowed(req.headers.origin, requestOrigin(req, port, publicOrigin), allowedOrigins)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      ""
    ].join("\r\n"));

    const client = {
      id: `socket-${nextClientId++}`,
      socket,
      buffer: Buffer.alloc(0),
      closed: false,
      roomId: null,
      role: null,
      peerId: null,
      messageWindowStartedAt: Date.now(),
      messageCount: 0,
      publicOrigin: publicOrigin || requestOrigin(req, port)
    };
    connections.add(client);
    socket.on("data", (chunk) => {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      readFrames(client, (message) => handleMessage(client, message, registry));
    });
    socket.on("close", () => closeClient(client, registry, connections));
    socket.on("error", () => closeClient(client, registry, connections));
    send(client, {
      type: "hello",
      protocolVersion: PLUGIN_ROOM_PROTOCOL_VERSION,
      serverTime: Date.now(),
      iceServers
    });
  });

  const cleanupTimer = setInterval(() => registry.cleanup(), 15_000);
  cleanupTimer.unref?.();

  return {
    server,
    registry,
    iceServers,
    start() {
      return new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once("error", onError);
        server.listen(port, host, () => {
          server.off("error", onError);
          resolve(server.address());
        });
      });
    },
    stop() {
      clearInterval(cleanupTimer);
      for (const client of connections) {
        try {
          client.socket.destroy();
        } catch {}
      }
      return new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  };
}

function handleMessage(client, message, registry) {
  if (!allowMessage(client)) throw protocolError("RATE_LIMITED");
  const type = String(message?.type || "");
  let response = null;
  if (type === "room:create") {
    response = registry.createRoom(client, {
      controllerName: message.controllerName,
      publicOrigin: client.publicOrigin
    });
  } else if (type === "room:resume") {
    response = registry.resumeController(client, message);
  } else if (type === "room:join") {
    response = registry.joinSpeaker(client, message);
  } else if (type === "room:close") {
    response = registry.closeRoom(client);
  } else if (type === "signal") {
    registry.relaySignal(client, message);
  } else if (type === "heartbeat") {
    response = registry.heartbeat(client);
  } else {
    throw protocolError("MESSAGE_UNSUPPORTED");
  }
  if (response) sendJsonFrame(client, response);
}

function readFrames(client, onMessage) {
  try {
    while (client.buffer.length >= 2) {
      const first = client.buffer[0];
      const second = client.buffer[1];
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (!masked) throw protocolError("FRAME_NOT_MASKED");

      if (length === 126) {
        if (client.buffer.length < offset + 2) return;
        length = client.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (client.buffer.length < offset + 8) return;
        const high = client.buffer.readUInt32BE(offset);
        const low = client.buffer.readUInt32BE(offset + 4);
        length = high * 2 ** 32 + low;
        offset += 8;
      }
      if (length > maximumFrameBytes) throw protocolError("FRAME_TOO_LARGE");

      const frameLength = offset + 4 + length;
      if (client.buffer.length < frameLength) return;
      const mask = client.buffer.subarray(offset, offset + 4);
      const encoded = client.buffer.subarray(offset + 4, frameLength);
      const payload = Buffer.from(encoded.map((byte, index) => byte ^ mask[index % 4]));
      client.buffer = client.buffer.subarray(frameLength);

      if (opcode === 0x8) {
        client.socket.end();
        return;
      }
      if (opcode === 0x9) {
        sendFrame(client, 0x0a, payload);
        continue;
      }
      if (opcode !== 0x1) continue;
      let message;
      try {
        message = JSON.parse(payload.toString("utf8"));
      } catch {
        throw protocolError("MESSAGE_INVALID_JSON");
      }
      try {
        onMessage(message);
      } catch (error) {
        sendJsonFrame(client, {
          type: "error",
          code: error?.code || "SERVER_ERROR",
          message: publicErrorMessage(error?.code)
        });
      }
    }
  } catch (error) {
    sendJsonFrame(client, {
      type: "error",
      code: error?.code || "PROTOCOL_ERROR",
      message: publicErrorMessage(error?.code)
    });
    client.socket.end();
  }
}

function sendJsonFrame(client, payload) {
  if (!client || client.closed || client.socket.destroyed) return;
  sendFrame(client, 0x1, Buffer.from(JSON.stringify(payload)));
}

function sendFrame(client, opcode, data) {
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length]);
  } else if (data.length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  client.socket.write(Buffer.concat([header, data]));
}

function closeClient(client, registry, connections) {
  if (!client || client.closed) return;
  client.closed = true;
  registry.detach(client);
  connections.delete(client);
}

function allowMessage(client) {
  const now = Date.now();
  if (now - client.messageWindowStartedAt >= 10_000) {
    client.messageWindowStartedAt = now;
    client.messageCount = 0;
  }
  client.messageCount += 1;
  return client.messageCount <= 240;
}

function originAllowed(origin, requestBase, configured) {
  if (!origin) return true;
  if (origin.startsWith("chrome-extension://")) return true;
  let requestOriginValue = "";
  try {
    requestOriginValue = new URL(requestBase).origin;
  } catch {}
  return origin === requestOriginValue || configured.includes(origin);
}

function requestOrigin(req, port, configuredOrigin = "") {
  if (configuredOrigin) return configuredOrigin;
  const forwardedProtocol = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProtocol === "https" ? "https" : "http";
  return `${protocol}://${req.headers.host || `127.0.0.1:${port}`}`;
}

function buildIceServers({ stunUrls, turnUrls, turnUsername, turnCredential }) {
  const output = [];
  if (stunUrls.length) output.push({ urls: stunUrls });
  if (turnUrls.length && turnUsername && turnCredential) {
    output.push({ urls: turnUrls, username: turnUsername, credential: turnCredential });
  }
  return output;
}

function serveFile(filePath, res) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error("Not a file");
    res.writeHead(200, {
      "Content-Type": mimeType(filePath),
      "Cache-Control": "no-store"
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    sendText(res, 404, "Not Found");
  }
}

function setCommonHeaders(res) {
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self' ws: wss:; media-src 'self' blob:; style-src 'self'; script-src 'self'; img-src 'self' data:"
  );
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

function mimeType(filePath) {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8"
  }[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function splitList(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function protocolError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function publicErrorMessage(code) {
  return {
    ROOM_NOT_FOUND: "This room no longer exists.",
    ROOM_AUTH_FAILED: "The Controller token is invalid.",
    ROOM_INVITE_INVALID: "This Speaker invitation is invalid.",
    ROOM_FULL: "This room already has the maximum number of Speakers.",
    ROOM_NOT_JOINED: "Join a room before sending signaling messages.",
    CONTROLLER_REQUIRED: "Only the Controller can perform this action.",
    PEER_OFFLINE: "The target device is offline.",
    SIGNAL_INVALID: "The WebRTC signaling payload is invalid.",
    SIGNAL_TARGET_INVALID: "The WebRTC signaling target is invalid.",
    RATE_LIMITED: "Too many signaling messages were sent.",
    FRAME_TOO_LARGE: "The signaling message is too large.",
    FRAME_NOT_MASKED: "The WebSocket frame is invalid.",
    MESSAGE_INVALID_JSON: "The signaling message is not valid JSON.",
    MESSAGE_UNSUPPORTED: "The signaling message type is unsupported."
  }[code] || "The signaling service could not process this request.";
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const app = createPluginCloudServer();
  const address = await app.start();
  const activePort = typeof address === "object" && address
    ? address.port
    : Number(process.env.PLUGIN_SIGNAL_PORT || process.env.PORT || 4180);
  console.log("Home Cinema plugin signaling prototype");
  console.log(`Local: http://127.0.0.1:${activePort}`);
  if (!process.env.PLUGIN_PUBLIC_ORIGIN) {
    console.log("Set PLUGIN_PUBLIC_ORIGIN to the public HTTPS origin before remote testing.");
  }
}
