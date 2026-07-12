# Plugin-only prototype

This branch isolates a Chrome-first architecture from the existing LAN Host version.
End users should eventually install one extension and open one Speaker web page; they
should not need GitHub, Node.js, or `npm`.

## Architecture

1. The Chrome extension is the Controller. It captures the active tab and owns room,
   timing, volume, and WebRTC peer state.
2. The signaling service creates rooms, validates separate Controller and Speaker
   credentials, and relays WebRTC SDP/ICE messages only inside one authenticated room.
3. Each Speaker opens a fixed HTTPS web page from a QR invitation. Audio and timing
   telemetry travel directly between Controller and Speaker over WebRTC and its data
   channel. The signaling service does not receive audio.

## Implemented in this prototype

- Six-character rooms with separate Controller and invite tokens.
- Controller resume grace, room expiry, device replacement, rate limits, and a maximum
  of 12 Speakers.
- QR invitation, browser Speaker page, local audio unlock, device naming, and mobile
  and tablet layouts.
- Chrome tab capture with one WebRTC audio peer per Speaker.
- Muted initialization, recent RTP timing samples, clock-offset probes, a frozen room
  target, and a shared scheduled fade-in.
- Conservative partial-stat fallback for WebKit/iPad browsers.
- Late Speaker join when its path fits the frozen target; otherwise it waits for the
  next room start instead of shifting devices that are already playing.
- Per-peer automatic WebRTC rebuild, signaling reconnect/resume, stop, room close,
  and Controller room volume.
- Smooth runtime post-delay correction with a deadband and bounded adjustment step.

## Local development

```bash
npm run plugin:signal
npm run plugin:probe
```

Load `/extension` as an unpacked extension in `chrome://extensions`. The development
signaling address is `http://127.0.0.1:4180`. A phone cannot use that loopback URL; for
cross-device development set `PLUGIN_PUBLIC_ORIGIN` and the extension setting to an
address reachable by both devices.

The signaling service has no runtime package dependencies and can also be built from
the repository root:

```bash
docker build -f plugin-cloud/Dockerfile -t home-cinema-plugin-signal .
```

## Required before Chrome Web Store release

- Deploy `plugin-cloud` once behind a fixed public HTTPS/WSS origin. This is developer
  infrastructure; end users do not run it.
- Add service-wide room/IP quotas and deployment-level abuse protection before exposing
  public room creation on the internet.
- Add production TURN credentials for networks where direct peer connectivity fails.
- Replace broad optional development host permissions with the fixed production origin.
- Migrate the mature V9 runtime health, quarantine, relock, and diagnostic model. This
  prototype currently proves pairing, direct audio, initialization lock, gentle delay
  correction, and reconnection; it is not yet the full stable-branch recovery engine.
- Complete real-device Chrome/Windows/macOS/iPad soak tests and Chrome Web Store review.

## Security boundary

The QR includes only the Speaker invite token. The Controller token remains in the
extension offscreen session and is never written into the public room status. Room
membership authorizes signaling only; audio remains end-to-end WebRTC media.
