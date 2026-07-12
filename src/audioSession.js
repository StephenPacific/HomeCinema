function currentAudioSession() {
  return globalThis.navigator?.audioSession || null;
}

export function readAudioSession(audioSession = currentAudioSession()) {
  if (!audioSession) {
    return {
      supported: false,
      configured: false,
      type: "unavailable",
      state: "unavailable"
    };
  }

  return {
    supported: true,
    configured: audioSession.type === "playback",
    type: String(audioSession.type || "auto"),
    state: String(audioSession.state || "unknown")
  };
}

export function configurePlaybackAudioSession(audioSession = currentAudioSession()) {
  if (!audioSession) return readAudioSession(audioSession);

  try {
    if (audioSession.type !== "playback") audioSession.type = "playback";
  } catch {
    return readAudioSession(audioSession);
  }

  return readAudioSession(audioSession);
}
