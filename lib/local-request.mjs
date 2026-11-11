import os from "node:os";

function authority(value, port) {
  if (typeof value !== "string" || value.length > 512 || /[\u0000-\u0020\u007f]/.test(value)
      || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  // A Host is an authority, not a URL. Reject credentials, paths, whitespace
  // and alternate numeric IPv4 spellings instead of letting URL repair them.
  const match = /^(?:\[([\da-f:.]+)\]|([\da-z.-]+))(?::(\d{1,5}))?$/i.exec(value);
  if (!match) return null;
  try {
    const parsed = new URL(`http://${value}`);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    if (Number(parsed.port || 80) !== port || (match[2] && match[2].toLowerCase() !== hostname)) return null;
    return { hostname, host: parsed.host };
  } catch { return null; }
}

export function isLocalServerRequest(req, port, { allowNoOrigin = true, getInterfaces = os.networkInterfaces } = {}) {
  const target = authority(req?.headers?.host, port);
  if (!target) return false;
  const allowed = new Set(["localhost", "127.0.0.1", "::1"]);
  try {
    for (const entries of Object.values(getInterfaces())) {
      for (const entry of entries || []) {
        if (typeof entry?.address !== "string") continue;
        const ip = entry.address.split("%", 1)[0];
        try {
          const parsed = new URL(`http://${ip.includes(":") ? `[${ip}]` : ip}`);
          allowed.add(parsed.hostname.replace(/^\[|\]$/g, ""));
        } catch { /* An unusable interface address cannot authorize a Host. */ }
      }
    }
  } catch { return false; }
  if (!allowed.has(target.hostname)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return allowNoOrigin;
  if (typeof origin !== "string") return false;
  const originMatch = /^http:\/\/([^/?#]+)$/i.exec(origin);
  const originTarget = originMatch && authority(originMatch[1], port);
  return Boolean(originTarget && originTarget.host === target.host);
}
