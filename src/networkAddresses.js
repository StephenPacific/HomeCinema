const VIRTUAL_INTERFACE_PATTERN =
  /(?:vmware|virtualbox|vbox|hyper-v|vethernet|wsl|docker|bridge|utun|tailscale|zerotier|hamachi|loopback|bluetooth|awdl|llw|anpi|^ap\d+$)/i;
const WIFI_INTERFACE_PATTERN = /(?:wi-?fi|wlan|wireless)/i;
const ETHERNET_INTERFACE_PATTERN = /^(?:ethernet|local area connection)(?:\s+\d+)?$/i;
const MAC_INTERFACE_PATTERN = /^en\d+$/i;

export function lanAddressCandidates(networkInterfaces, port) {
  const candidates = [];
  const seen = new Set();

  for (const [interfaceName, entries] of Object.entries(networkInterfaces || {})) {
    for (const entry of entries || []) {
      if (!isUsableIpv4(entry) || seen.has(entry.address)) continue;
      seen.add(entry.address);
      const virtual = VIRTUAL_INTERFACE_PATTERN.test(interfaceName);
      candidates.push({
        url: `http://${entry.address}:${port}`,
        address: entry.address,
        interfaceName,
        virtual,
        score: interfaceScore(interfaceName, entry.address, virtual)
      });
    }
  }

  candidates.sort((left, right) => left.score - right.score || left.interfaceName.localeCompare(right.interfaceName));
  return candidates.map(({ score: _score, ...candidate }, index) => ({
    ...candidate,
    recommended: index === 0
  }));
}

export function speakerJoinAddressCandidates({
  advertised = [],
  currentOrigin = "",
  loopback = false
} = {}) {
  const currentUrl = normalizedOrigin(currentOrigin);
  const seen = new Set();
  const candidates = [];

  for (const candidate of advertised || []) {
    const url = normalizedOrigin(candidate?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    candidates.push({
      ...candidate,
      url,
      current: Boolean(currentUrl && url === currentUrl)
    });
  }

  candidates.sort((left, right) => Number(Boolean(right.recommended)) - Number(Boolean(left.recommended)));
  if (!candidates.length && currentUrl) {
    candidates.push({
      url: currentUrl,
      interfaceName: "Current connection",
      current: true,
      recommended: true
    });
  } else if (!loopback && currentUrl && !seen.has(currentUrl)) {
    candidates.push({
      url: currentUrl,
      interfaceName: "Current connection",
      current: true,
      recommended: false
    });
  }

  return candidates.map((candidate, index) => ({
    ...candidate,
    recommended: index === 0
  }));
}

export function isLocalClientAddress(remoteAddress, networkInterfaces) {
  const remote = normalizedIpAddress(remoteAddress);
  if (!remote) return false;
  if (remote === "::1" || remote.startsWith("127.")) return true;

  for (const entries of Object.values(networkInterfaces || {})) {
    for (const entry of entries || []) {
      if (normalizedIpAddress(entry?.address) === remote) return true;
    }
  }
  return false;
}

function isUsableIpv4(entry) {
  if (!entry || (entry.family !== "IPv4" && entry.family !== 4) || entry.internal) return false;
  const address = String(entry.address || "");
  return Boolean(address) && !address.startsWith("169.254.") && address !== "0.0.0.0";
}

function interfaceScore(interfaceName, address, virtual) {
  let score = virtual ? 100 : 0;
  if (WIFI_INTERFACE_PATTERN.test(interfaceName)) score -= 50;
  else if (ETHERNET_INTERFACE_PATTERN.test(interfaceName)) score -= 45;
  else if (MAC_INTERFACE_PATTERN.test(interfaceName)) score -= 35;
  if (!isPrivateIpv4(address)) score += 20;
  if (address.endsWith(".1")) score += 3;
  return score;
}

function isPrivateIpv4(address) {
  const parts = String(address).split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
}

function normalizedOrigin(value) {
  try {
    return new URL(String(value || "")).origin;
  } catch {
    return "";
  }
}

function normalizedIpAddress(value) {
  const address = String(value || "").trim().toLowerCase().split("%")[0];
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}
