const origin = String(process.env.PLUGIN_SIGNAL_ORIGIN || "http://127.0.0.1:4180").replace(/\/$/, "");
const websocketUrl = `${origin.replace(/^http/, "ws")}/signal`;
const timeoutMs = 5_000;

const result = await new Promise((resolve, reject) => {
  const controller = new WebSocket(websocketUrl);
  let speaker = null;
  let roomId = "";
  let speakerPeerId = "";
  let relayObserved = false;
  let settled = false;
  const timeout = setTimeout(() => reject(new Error("Plugin signaling probe timed out")), timeoutMs);

  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    try {
      controller.close();
      speaker?.close();
    } catch {}
    if (error) reject(error);
    else resolve(value);
  };

  controller.addEventListener("open", () => {
    controller.send(JSON.stringify({ type: "room:create", controllerName: "Probe Controller" }));
  });
  controller.addEventListener("error", () => finish(new Error("Controller WebSocket failed")));
  controller.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "room:created") {
      roomId = message.roomId;
      speaker = new WebSocket(websocketUrl);
      speaker.addEventListener("open", () => {
        speaker.send(JSON.stringify({
          type: "room:join",
          roomId,
          inviteToken: message.inviteToken,
          deviceId: "probe-speaker",
          name: "Probe Speaker"
        }));
      });
      speaker.addEventListener("message", (speakerEvent) => {
        const speakerMessage = JSON.parse(speakerEvent.data);
        if (speakerMessage.type === "signal" && speakerMessage.signal?.probe === "controller-to-speaker") {
          relayObserved = true;
          controller.send(JSON.stringify({ type: "room:close" }));
        }
        if (speakerMessage.type === "room:closed" && relayObserved) {
          finish(null, { roomCreated: true, speakerJoined: true, signalRelayed: true, roomClosed: true });
        }
      });
      speaker.addEventListener("error", () => finish(new Error("Speaker WebSocket failed")));
      return;
    }
    if (message.type === "peer:joined") {
      speakerPeerId = message.peer?.peerId || "";
      controller.send(JSON.stringify({
        type: "signal",
        targetPeerId: speakerPeerId,
        signal: { probe: "controller-to-speaker" }
      }));
    }
    if (message.type === "error") finish(new Error(message.message || message.code || "Signaling error"));
  });
});

console.log(JSON.stringify(result));
