const origin = String(process.env.PLUGIN_SIGNAL_ORIGIN || "http://127.0.0.1:4180").replace(/\/$/, "");
const websocketUrl = `${origin.replace(/^http/, "ws")}/signal`;
const socket = new WebSocket(websocketUrl);
let heartbeat = null;

socket.addEventListener("open", () => {
  socket.send(JSON.stringify({ type: "room:create", controllerName: "Browser Preview" }));
});

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.type !== "room:created") return;
  console.log(`Room: ${message.roomId}`);
  console.log(`Speaker: ${message.speakerUrl}`);
  heartbeat = setInterval(() => socket.send(JSON.stringify({ type: "heartbeat" })), 20_000);
});

socket.addEventListener("error", () => {
  console.error("Could not connect to the plugin signaling service.");
  process.exitCode = 1;
});

socket.addEventListener("close", () => {
  clearInterval(heartbeat);
  process.exit();
});

process.on("SIGINT", () => {
  clearInterval(heartbeat);
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "room:close" }));
  socket.close();
});
