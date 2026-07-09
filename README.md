# Home Cinema LAN Sync

Synchronize music playback across phones, tablets, and computers on the same local network. You can play a single track, or upload multiple stems from the same song so each device plays a different layer.

## Usage

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
- Browsers receive playback commands over WebSocket.
- Every device estimates its clock offset from the server with repeated time samples.
- The host schedules playback at a future server timestamp; each device converts that into local time and starts Web Audio there.
- Multi-stem playback uses one shared timeline; each device loads only its selected stem.
- Resync re-queues all players from the server's current playback position so every device gets a fresh shared start timestamp.

## Notes

- All devices must be on the same local network, and the host firewall must allow the server port, default `4173`.
- Phone browsers may pause web audio when locked or backgrounded.
- This is a home sync prototype, not Dolby/AVR multichannel decoding.
