const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function resolvePageRole({ search = "", hostname = "" } = {}) {
  const mode = new URLSearchParams(search).get("mode");
  if (mode === "controller") return "controller";
  if (mode === "player" || mode === "speaker") return "speaker";
  return isLoopbackHost(hostname) ? "controller" : "speaker";
}

export function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname || "").toLowerCase());
}
