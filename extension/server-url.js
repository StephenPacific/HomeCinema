export function normalizeServerUrl(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) throw new Error("Enter the Home Cinema server address.");
  const url = new URL(rawValue);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Use an http:// or https:// Home Cinema address.");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function serverUrlFromHomeCinemaTab(tab) {
  if (!tab?.url || tab.title !== "Home Cinema LAN Sync") return "";
  try {
    return normalizeServerUrl(tab.url);
  } catch {
    return "";
  }
}

export function controllerPageUrl(value) {
  const url = new URL(normalizeServerUrl(value));
  url.pathname = "/";
  url.searchParams.set("mode", "controller");
  url.hash = "";
  return url.toString();
}

export function controllerProbeWebSocketUrl(value) {
  const url = new URL(normalizeServerUrl(value));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/";
  url.searchParams.set("probe", "controller-address");
  url.hash = "";
  return url.toString();
}

export function canonicalControllerServiceUrl(value, hello) {
  const configuredUrl = normalizeServerUrl(value);
  if (!hello?.localConnection) return configuredUrl;
  return normalizedOrEmpty(hello.localControllerUrl) || configuredUrl;
}

export function resolveServerUrl({ savedUrl, captureStatus, activeTab }) {
  const captureUrl = normalizedOrEmpty(captureStatus?.serverUrl);
  if (["connecting", "capturing"].includes(captureStatus?.phase) && captureUrl) return captureUrl;
  const configuredUrl = normalizedOrEmpty(savedUrl);
  if (configuredUrl) return configuredUrl;
  return serverUrlFromHomeCinemaTab(activeTab) || captureUrl;
}

function normalizedOrEmpty(value) {
  try {
    return normalizeServerUrl(value);
  } catch {
    return "";
  }
}
