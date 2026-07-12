export const LIVE_SYNC_POLICY = Object.freeze({
  startBufferSeconds: 1.0,
  minimumStartBufferSeconds: 0.65,
  maximumStartWaitMs: 1800,
  lowBufferSeconds: 0.45,
  recoverBufferSeconds: 0.8,
  hardCorrectionSeconds: 0.18,
  correctionGain: 0.08,
  minPlaybackRate: 0.985,
  maxPlaybackRate: 1.015
});

export const WEBRTC_SYNC_POLICY = Object.freeze({
  measurementSmoothing: 0.35,
  receiverBufferTargetMs: 120
});

export function setWebRtcJitterBufferTarget(receiver, targetMs = WEBRTC_SYNC_POLICY.receiverBufferTargetMs) {
  if (!receiver || !("jitterBufferTarget" in receiver)) return false;
  const target = Number(targetMs);
  if (!Number.isFinite(target)) return false;
  try {
    receiver.jitterBufferTarget = clamp(target, 0, 4000);
    return true;
  } catch {
    return false;
  }
}

export function shouldStartLiveBuffer(bufferedSeconds, waitedMs, policy = LIVE_SYNC_POLICY) {
  return (
    bufferedSeconds >= policy.startBufferSeconds ||
    (bufferedSeconds >= policy.minimumStartBufferSeconds && waitedMs >= policy.maximumStartWaitMs)
  );
}

export function webRtcPlayoutDelaySample(current, previous) {
  const emittedCount = finiteMetric(current?.jitterBufferEmittedCount);
  const previousEmittedCount = finiteMetric(previous?.jitterBufferEmittedCount);
  const delay = finiteMetric(current?.jitterBufferDelay);
  const previousDelay = finiteMetric(previous?.jitterBufferDelay);
  if (![emittedCount, previousEmittedCount, delay, previousDelay].every(Number.isFinite)) return null;
  const emittedDelta = emittedCount - previousEmittedCount;
  const delayDelta = delay - previousDelay;
  if (emittedDelta <= 0 || delayDelta < 0) return null;

  return {
    actualDelayMs: metricDeltaMs(current, previous, "jitterBufferDelay", emittedDelta),
    targetDelayMs: metricDeltaMs(current, previous, "jitterBufferTargetDelay", emittedDelta),
    minimumDelayMs: metricDeltaMs(current, previous, "jitterBufferMinimumDelay", emittedDelta),
    emittedCount: emittedDelta
  };
}

export function liveStartLocalMs({
  playAtServerMs,
  serverOffsetMs = 0,
  outputLatencyMs = 0,
  manualOffsetMs = 0
}) {
  return playAtServerMs - serverOffsetMs - outputLatencyMs + manualOffsetMs;
}

export function expectedLivePositionSeconds({
  nowLocalMs,
  playAtServerMs,
  serverOffsetMs = 0,
  outputLatencyMs = 0,
  manualOffsetMs = 0
}) {
  return Math.max(
    0,
    (nowLocalMs + serverOffsetMs + outputLatencyMs - manualOffsetMs - playAtServerMs) / 1000
  );
}

export function liveDriftCorrection(actualSeconds, expectedSeconds, policy = LIVE_SYNC_POLICY) {
  const driftSeconds = actualSeconds - expectedSeconds;
  const shouldSeek = Math.abs(driftSeconds) >= policy.hardCorrectionSeconds;
  const playbackRate = clamp(
    1 - driftSeconds * policy.correctionGain,
    policy.minPlaybackRate,
    policy.maxPlaybackRate
  );
  return { driftSeconds, playbackRate, shouldSeek };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function metricDeltaMs(current, previous, field, emittedDelta) {
  const currentValue = Number(current?.[field]);
  const previousValue = Number(previous?.[field]);
  if (!Number.isFinite(currentValue) || !Number.isFinite(previousValue)) return null;
  const delta = currentValue - previousValue;
  if (delta < 0) return null;
  return clamp((delta / emittedDelta) * 1000, 0, 4000);
}

function finiteMetric(value) {
  if (value === null || value === undefined || value === "") return Number.NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}
