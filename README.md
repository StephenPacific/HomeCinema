# Home Cinema LAN Sync

Play your Mac's system audio through its connected speakers and live on an iPad over Wi-Fi. You can also synchronize uploaded music or separate stems across phones, tablets, and computers on the same local network.

## Local release package

`npm run release:package` builds the frontend and creates a macOS Apple Silicon ZIP with the prebuilt native helper, launcher, source, licences and SHA-256 manifest. The extracted package needs Node.js 22.12+ but does not need `npm install`. Double-click **Start HomeCinema.command**, open its local URL, select connected outputs and start sharing. See [Chinese package and device guide](README.package.md).

The package launcher starts the server; Bluetooth pairing is managed in macOS, and joining a running output group remains an explicit selection. Windows computers can use the LAN browser receiver path, which has not yet been tested on Windows hardware. Windows system-audio capture is not implemented.

## Live system audio: Mac to iPad

1. Start the server with `npm start`, then open its Local URL on the Mac. Select **System audio**.
2. Select the Mac's physical outputs, such as MacBook Pro Speakers and a Bluetooth speaker. Ordinary startup does not play test sounds. **Calibrate speakers first** is an explicit optional action that plays short sweeps using the chosen microphone.
3. Click **Start system audio**. The native audio helper must be built first; this workspace already includes it. Fresh checkout setup is in [native setup and validation](docs/system-audio-live.md).
4. On the iPad, join the same Wi-Fi, scan the live QR code or open the displayed `?mode=player&source=live` URL in Safari. Tap **Enable live audio** on the iPad. If it pauses after leaving the page, tap **Resume live audio**.
5. Play music in any Mac app. No file upload is required in System audio mode. Keep the iPad player in the foreground.

The host Mac plays through the native outputs; its browser does not monitor the live stream, which prevents captured audio feeding back into itself. **Stop sharing to all devices** stops the owned capture process and restores default macOS playback. A GUI-started session is bounded to two hours and can be started again afterwards.

The current live protocol uses a **shared playback target of about 700 ms** after capture. Audio packets carry source-frame identity and timestamps; native outputs and the iPad schedule against the same master clock. iPad **Earlier/Later** controls provide a separate ±200 ms trim for residual device/room differences. Timing estimate is software scheduling information, not a measured acoustic error. [Shared-timeline iteration and limits](docs/common-timeline-v1.md).

Older HCA1 sources retain the legacy 300/500/800 ms buffering choices. In the shared-timeline mode the receiver waits for a frame's deadline, rather than starting whenever its own buffer fills. Queues remain bounded and late audio is discarded instead of being replayed behind the group.

All system audio is captured while the source runs, including other apps' sounds. Audio travels on the local network as PCM, without an account or cloud service. This implementation keeps audio in memory and does not record it to disk. [Implementation, stability checks and current limits](docs/system-audio-live.md).

## Music files and stems

Select **Music files** to use uploaded tracks instead of the live system source.

1. Run the host server:

   ```bash
   npm start
   ```

2. Open the `Network` URL shown in the terminal from phones, tablets, and computers on the same Wi-Fi, or scan the QR code shown in the host UI.

3. Tap `Enable speaker` once on every device. Browsers require a real user gesture before web audio can play.

4. Keep one device in `Host` mode, choose one or more audio files, then press play. Other devices can stay in `Player` mode.

5. If you upload multiple stems, each device can choose its own `Local Stem`.

6. Each device can choose a sound-field position: Front Left, Front Right, Center, Rear Left, or Rear Right.

7. Use the `Players` panel on the host to check online status, stem assignment, position, latency, local offset, and test tones.

The QR code opens `?mode=player`, which gives phones and tablets a lighter player view with playback controls, device name, local stem, sound-field position, latency, and offset controls.

## Stems

Stem mode works best when you prepare separate files from the same song, for example:

- drums
- bass
- vocal
- pad / ambience
- lead / melody

All stem files should start at the same timestamp and have roughly the same length. The app uses one shared playback timeline, while each device only loads and plays its selected stem.

## Supported Devices

This list describes browser receivers. The native system-audio publisher is macOS-only; Windows browser reception still needs a real-device check.

- iPhone and Android phones
- iPad and Android tablets
- Mac, Windows, and Linux computers
- Any modern browser device on the same Wi-Fi that can play web audio

Bluetooth speakers, AirPlay, and TV casting add latency that browser clock synchronization alone cannot measure. For speakers connected to a Mac, an optional native calibration path is available below.

## Native Mac speaker group (experimental)

The [SyncForge](https://github.com/alexandrustefan/syncforge) adapter routes one Mac's system audio to several physical outputs and can measure their relative acoustic latency with a microphone. Our local native patch also exports captured audio for live Wi-Fi receivers. The file-player server can run independently of this helper.

Use macOS 14.4+ and Swift Command Line Tools. Put the patched SyncForge source checkout next to this repository (`../syncforge`), or set `SYNCFORGE_DIR` to its path. Apply [the pinned native patch](native/syncforge-live.patch) when preparing a fresh upstream checkout; see [setup](docs/system-audio-live.md). The upstream source uses [MIT](native/SyncForge-LICENSE.txt). The CLI uses Apple frameworks; its build does not need XcodeGen. The upstream GUI and XCTest suite require full Xcode.

```bash
npm run native:build
npm run native:devices
```

Copy output and microphone UIDs from that device listing, then use them in a separate terminal:

```bash
npm run native:calibrate -- --out 'MAC_OUTPUT_UID' --out 'BLUETOOTH_OUTPUT_UID' --mic 'MIC_UID' --hold 300
```

Calibration plays test sweeps, measures relative arrival times, applies delay and upstream automatic tone correction, then remeasures. Allow System Audio Recording and Microphone access when macOS requests them. The helper defaults to a -24 dBFS sweep and 60 seconds of playback after calibration; `--hold 300` keeps the calibrated session alive for five minutes. Ctrl-C ends the session and restores normal macOS playback. Calibration and EQ from this CLI are kept in memory and discarded when it exits; `native:play` uses driver estimates, not the previous calibration.

While the calibrated session is alive:

1. Start Home Cinema with `npm start` and open it on this Mac.
2. Enable the speaker in exactly one browser tab, choose its stem and play. A Host tab can also enable its speaker; a second Mac Player tab is unnecessary.
3. This Mac's selected stem is copied to every selected native output, along with other system sounds. Each native output is part of one Mac group, not a separate LAN player or stem assignment.
4. Other phones and tablets can join normally. The Mac group now has extra acoustic latency; adjust Local offset by listening and resync. A negative offset advances this Mac's browser playback. The 3-second countdown is preparation time and does not remove output latency. This adapter does not automatically synchronize the Mac group with other LAN players.

For a short uncalibrated routing check:

```bash
npm run native:play -- --out 'MAC_OUTPUT_UID' --out 'BLUETOOTH_OUTPUT_UID' --seconds 20
```

Playback supports multiple selected outputs, subject to the Mac and devices supporting concurrent audio. This adapter exposes upstream CLI playback and calibration; it does not run Live Sync. Upstream Live Sync itself currently requires exactly one wireless output and a non-wireless reference. Multiple Bluetooth outputs and long sessions still need hardware qualification. See [our first hardware check](docs/native-audio-validation.md).

## Reducing Latency

- Default sync mode is a `3 sec` countdown. Pressing play queues all players first, then starts them together.
- Switch to `4 sec` or `5 sec` if some devices are slow to prepare.
- Enable every speaker and let audio cache before playback.
- Use `Local offset` to advance or delay each player until the echo disappears.
- Prefer 5 GHz Wi-Fi and keep mobile browsers in the foreground.

## How It Works

- The server uses only built-in Node.js modules.
- The frontend is a React app built with Vite and served by the same LAN server.
- Browsers receive playback commands over WebSocket.
- Every device estimates its clock offset from the server with repeated time samples.
- The host schedules playback at a future server timestamp; each device converts that into local time and starts Web Audio there.
- Multi-stem playback uses one shared timeline; each device loads only its selected stem.
- Resync re-queues all players from the server's current playback position so every device gets a fresh shared start timestamp.

## Notes

- All devices must be on the same local network, and the host firewall must allow the server port, default `4173`.
- Phone browsers may pause web audio when locked or backgrounded.
- This is a home sync prototype, not Dolby/AVR multichannel decoding.
