# Home Cinema LAN Sync

Synchronize music playback across phones, tablets, and computers on the same local network. You can play a single track, or upload multiple stems from the same song so each device plays a different layer.

## Usage

1. Run the host server:

   ```bash
   npm start
   ```

2. Open the recommended `Network` URL shown in the terminal from phones, tablets, and computers on the same Wi-Fi, or scan the QR code shown in the Controller UI. Physical Wi-Fi and Ethernet adapters are listed ahead of VMware, Hyper-V, WSL, VPN, and bridge adapters.

3. Tap `Enable speaker` once on every device. Browsers require a real user gesture before web audio can play.

4. Keep one device in `Controller` mode, choose one or more audio files, then press play. Other devices stay in `Speaker` mode.

5. If you upload multiple stems, each device can choose its own `Local Stem`.

6. Each device can choose a sound-field position: Front Left, Front Right, Center, Rear Left, or Rear Right.

7. Use the `Players` panel on the host to check online status, stem assignment, position, latency, local offset, and test tones.

The QR code opens `?mode=player`, which gives phones and tablets a lighter Speaker view with device name, local stem, sound-field position, latency, and offset controls. A remote LAN URL without an explicit mode also defaults to Speaker. Controller mode is opened explicitly by the extension with `?mode=controller`, so a previously saved browser setting cannot make another computer take control.

## Chrome Tab Audio Extension

The included Chrome extension can relay audio from the current desktop Chrome tab into the Home Cinema room. This is useful for browser music, video, and web players: the video stays on the host computer while the tab's audio is relayed to the joined speakers.

1. Start one Home Cinema coordination service with `npm start`. During development this can run on the same Windows computer as the extension or on a different computer in the room; only one service is needed.
2. In Chrome, open `chrome://extensions`, turn on Developer mode, then choose **Load unpacked** and select the [`extension`](extension/) folder.
3. Open Home Cinema, have speakers join from the QR code, and tap **Enable speaker** on each device before beginning the live capture.
4. The extension's `Controller service` field is the address it uses for coordination. If the service runs on the same Windows computer, press **Use this computer** to pin `http://127.0.0.1:4173`. If the service runs on another computer, enter that computer's LAN address. This saved address is deliberately separate from the Speaker join link: the Controller page always defaults its QR code to the server-recommended physical WLAN or Ethernet address, even if the page itself was opened through a VMware adapter.
5. Press **Open Controller** from the extension to open an explicit Controller page. With the music or video tab active, press **Start audio**. The original tab audio remains audible on the Controller computer with the same short playout target used by the room. Press **Stop** in the extension to end the session.

Live tab audio uses WebRTC with Opus. WebSocket remains responsible for room state, device discovery, clock measurements, and WebRTC signaling. Current Chrome and Edge releases are the recommended speaker browsers for this mode. Uploaded tracks retain the wider browser support described below. Only one live tab capture can be active in a room at a time. Protected DRM playback may not permit capture; the extension does not bypass DRM.

Live WebRTC sessions use a four-phase startup: `Measuring`, `Locking`, `Armed`, and `Playing`. The extension and speakers establish their media paths while muted. The server waits for consecutive RTP timing samples and chooses a fixed room target from the slowest stable speaker. Each faster speaker then fills its one-time gap with a deterministic Web Audio delay instead of forcing Chrome's advisory jitter-buffer target. Only after the combined browser and fixed local delay is verified does the server schedule the shared start timestamp.

If any required speaker misses timeline lock within the locking window, the whole room automatically retries the existing WebRTC connections up to three times while keeping every output muted. Playback begins only when every required Speaker is locked. After the third failed attempt, Controller shows the failing receiver diagnostics and a manual **Retry lock** action. Controller also provides a room volume slider for every output, including the capture computer, and an independent volume slider for each Speaker. Changes use a short gain ramp to avoid clicks and do not alter the locked playback timeline.

Speaker pages report a room-sync engine version. Version `v4` is required for the fast recovery envelope. Stale pages and superseded connections remain visible for diagnosis but are not counted as timing candidates and do not receive the live WebRTC track. Reloading the page upgrades the receiver without allowing an old tab to block the room at 90%.

The room target stays frozen after playback starts. Speakers monitor WebRTC playout every 500 ms while keeping audible delay correction limited to 3 ms every two seconds, applied as a 1.8-second Web Audio ramp. A single 80 ms timeline jump, or three consecutive samples beyond 25 ms, isolates only that Speaker with a 120 ms fade. While silent it can retune by 3 ms per monitor sample. Rejoining requires six consecutive samples within 8 ms, remains cancellable during a 1.2-second arming window, and then fades in over 650 ms. If a device has no delay headroom left, it remains muted instead of disrupting healthy outputs.

Extension version `0.3.9` keeps the `v4` fast recovery envelope and fixes Windows Speaker address selection so a VMware current connection cannot replace the recommended WLAN QR link. It includes bounded timeline-lock retries, manual lock recovery, room and per-Speaker volume controls, the explicit **Use this computer** action, and Controller output telemetry.

## Stems

Stem mode works best when you prepare separate files from the same song, for example:

- drums
- bass
- vocal
- pad / ambience
- lead / melody

All stem files should start at the same timestamp and have roughly the same length. The app uses one shared playback timeline, while each device only loads and plays its selected stem.

## Supported Devices

- iPhone and Android phones
- iPad and Android tablets
- Mac, Windows, and Linux computers
- Any modern browser device on the same Wi-Fi that can play web audio

Avoid Bluetooth speakers, AirPlay, and TV casting when you need tight sync. Those paths often add tens or hundreds of milliseconds of extra latency.

## Reducing Latency

- Default sync mode is a `3 sec` countdown. Pressing play queues all players first, then starts them together.
- Switch to `4 sec` or `5 sec` if some devices are slow to prepare.
- Enable every speaker and let audio cache before playback.
- Use `Local offset` to advance or delay each player until the echo disappears.
- Prefer 5 GHz Wi-Fi and keep mobile browsers in the foreground.

## How It Works

- The server uses only built-in Node.js modules.
- The frontend is a React app built with Vite and served by the same LAN server.
- Browsers receive playback commands and WebRTC signaling over WebSocket; live tab audio travels over WebRTC/Opus.
- Every device estimates its clock offset from the server with repeated time samples.
- The host schedules playback at a future server timestamp; each device converts that into local time and starts Web Audio there.
- Multi-stem playback uses one shared timeline; each device loads only its selected stem.
- Resync re-queues all players from the server's current playback position so every device gets a fresh shared start timestamp.

## Notes

- All devices must be on the same local network, and the host firewall must allow the server port, default `4173`.
- On Windows, allow Node.js on private networks when Windows Defender Firewall asks. If another device cannot open the recommended address, use the IPv4 address under `Wireless LAN adapter Wi-Fi` in `ipconfig`; do not use a VMware or `vEthernet` address.
- Phone browsers may pause web audio when locked or backgrounded.
- This is a home sync prototype, not Dolby/AVR multichannel decoding.
