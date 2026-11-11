// Keep a local stem's end separate from the shared server timeline. A shorter
// stem must finish quietly while other devices may still have audio to play.
export function localPlaybackTiming(state, {
  nowMs = Date.now(),
  serverOffsetMs = 0,
  deviceOffsetMs = 0,
  durationSeconds
} = {}) {
  const startPosition = Number.isFinite(state?.position) ? Math.max(0, state.position) : 0;
  const elapsed = state?.playing && Number.isFinite(state.startedAt)
    ? Math.max(0, (nowMs + serverOffsetMs - state.startedAt - deviceOffsetMs) / 1000)
    : 0;
  const rawPosition = startPosition + elapsed;
  const knownDuration = Number.isFinite(durationSeconds) && durationSeconds > 0;
  return {
    rawPosition,
    position: knownDuration ? Math.min(rawPosition, durationSeconds) : rawPosition,
    atEnd: knownDuration && rawPosition >= durationSeconds
  };
}
