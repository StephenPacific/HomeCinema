export const ROOM_SYNC_ENGINE_VERSION = 8;

export const ROOM_SYNC_POLICY = Object.freeze({
  sampleWindow: 3,
  maximumSampleAgeMs: 8000,
  maximumStableSpreadMs: 12,
  preflightTimeoutMs: 12_000,
  lockTimeoutMs: 12_000,
  maximumLockAttempts: 3,
  lockToleranceMs: 10,
  roomSafetyMarginMs: 8,
  minimumRoomTargetMs: 100,
  maximumRoomTargetMs: 500,
  monitorIntervalMs: 250,
  silentCorrectionIntervalMs: 500,
  audibleCorrectionIntervalMs: 2_000,
  hardSyncErrorMs: 25,
  emergencySyncErrorMs: 80,
  recoverySyncErrorMs: 8,
  recoveryGraceErrorMs: 16,
  runtimeRelockErrorMs: 40,
  runtimeRelockPostDelayHeadroomMs: 2,
  runtimeRelockSamples: 6,
  runtimeRelockCooldownMs: 15_000,
  runtimeRelockMinimumIncreaseMs: 12,
  speakerOutlierThresholdMs: 45,
  softCorrectionGain: 0.25,
  softCorrectionStepMs: 3,
  quarantinedCorrectionStepMs: 3,
  softCorrectionRampSeconds: 1.8,
  startFadeSeconds: 0.04,
  fastFuseFadeSeconds: 0.16,
  quarantineFadeSeconds: 0.45,
  rejoinLeadMs: 1_200,
  rejoinFadeSeconds: 1.2,
  violationSamples: 3,
  recoverySamples: 6
});

export function roomLockTimeoutAction({
  candidateCount,
  lockedCount,
  timedOut,
  lockAttempt,
  policy = ROOM_SYNC_POLICY
}) {
  const candidates = Math.max(0, Number(candidateCount) || 0);
  const locked = Math.max(0, Number(lockedCount) || 0);
  if (!timedOut || candidates <= 0 || locked >= candidates) return "wait";
  return Number(lockAttempt) < policy.maximumLockAttempts ? "retry" : "block";
}

export function supportsRoomSyncVersion(value, requiredVersion = ROOM_SYNC_ENGINE_VERSION) {
  const version = Number(value);
  const required = Number(requiredVersion);
  return Number.isFinite(version) && Number.isFinite(required) && version >= required;
}

export function latestEligibleRoomSpeakers(clients, requiredVersion = ROOM_SYNC_ENGINE_VERSION) {
  const latestByDevice = new Map();
  for (const client of clients || []) {
    if (client?.role !== "speaker" || !supportsRoomSyncVersion(client.syncEngineVersion, requiredVersion)) continue;
    const identity = client.deviceKey || `socket-${client.id}`;
    const existing = latestByDevice.get(identity);
    if (!existing || Number(client.id) > Number(existing.id)) latestByDevice.set(identity, client);
  }
  return [...latestByDevice.values()].filter((client) => client.unlocked && !client.muted);
}

export function roomTimingSample({
  at = Date.now(),
  playoutDelayMs,
  outputLatencyMs = 0,
  postDelayMs = 0,
  deviceOffsetMs = 0,
  rtcBytesReceived = 0,
  rtcProgress = rtcBytesReceived
}) {
  if (playoutDelayMs === null || playoutDelayMs === undefined || playoutDelayMs === "") return null;
  const delay = Number(playoutDelayMs);
  const output = Number(outputLatencyMs);
  const postDelay = Number(postDelayMs);
  const offset = Number(deviceOffsetMs);
  const progress = Number(rtcProgress);
  if (![at, delay, output, postDelay, offset, progress].every(Number.isFinite)) return null;
  return {
    at,
    normalizedDelayMs: Math.max(0, delay + output + postDelay - offset),
    rtcProgress: Math.max(0, progress)
  };
}

export function fixedPostDelayMs({
  roomTargetMs,
  playoutDelayMs,
  outputLatencyMs = 0,
  deviceOffsetMs = 0,
  maximumDelayMs = 1000
}) {
  const values = [roomTargetMs, playoutDelayMs, outputLatencyMs, deviceOffsetMs, maximumDelayMs].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [target, playout, output, offset, maximum] = values;
  return clamp(target + offset - playout - output, 0, Math.max(0, maximum));
}

export function fixedTimelineErrorMs({
  roomTargetMs,
  playoutDelayMs,
  outputLatencyMs = 0,
  postDelayMs = 0,
  deviceOffsetMs = 0
}) {
  const values = [roomTargetMs, playoutDelayMs, outputLatencyMs, postDelayMs, deviceOffsetMs].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [target, playout, output, postDelay, offset] = values;
  return playout + output + postDelay - target - offset;
}

export function nextPostDelayCorrection({
  currentPostDelayMs,
  syncErrorMs,
  maximumStepMs = ROOM_SYNC_POLICY.softCorrectionStepMs,
  maximumDelayMs = 1000,
  policy = ROOM_SYNC_POLICY
}) {
  const values = [currentPostDelayMs, syncErrorMs, maximumStepMs, maximumDelayMs].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [current, error, stepLimit, delayLimit] = values;
  const boundedCurrent = clamp(current, 0, Math.max(0, delayLimit));
  if (Math.abs(error) <= policy.recoverySyncErrorMs || stepLimit <= 0) {
    return { delayMs: boundedCurrent, adjustmentMs: 0, saturated: false };
  }

  const requestedAdjustmentMs = -error * policy.softCorrectionGain;
  const boundedAdjustmentMs = clamp(requestedAdjustmentMs, -stepLimit, stepLimit);
  const delayMs = clamp(boundedCurrent + boundedAdjustmentMs, 0, Math.max(0, delayLimit));
  const adjustmentMs = delayMs - boundedCurrent;
  return {
    delayMs,
    adjustmentMs,
    saturated: Math.abs(adjustmentMs - requestedAdjustmentMs) > 0.01
  };
}

export function roomCorrectionPlan({
  silent = false,
  now = Date.now(),
  lastCorrectionAt = 0,
  policy = ROOM_SYNC_POLICY
}) {
  const intervalMs = silent
    ? policy.silentCorrectionIntervalMs || policy.monitorIntervalMs
    : policy.audibleCorrectionIntervalMs;
  const currentTime = Number(now);
  const previousTime = Number(lastCorrectionAt);
  return {
    due:
      Number.isFinite(currentTime) &&
      (!Number.isFinite(previousTime) || previousTime <= 0 || currentTime - previousTime >= intervalMs),
    intervalMs,
    maximumStepMs: silent ? policy.quarantinedCorrectionStepMs : policy.softCorrectionStepMs
  };
}

export function roomGuardError({
  smoothedErrorMs,
  rawErrorMs,
  policy = ROOM_SYNC_POLICY
}) {
  const smoothed = Number(smoothedErrorMs);
  const raw = Number(rawErrorMs);
  if (Number.isFinite(raw) && Math.abs(raw) >= policy.emergencySyncErrorMs) return raw;
  return Number.isFinite(smoothed) ? smoothed : raw;
}

export function stableRoomTiming(samples, now = Date.now(), policy = ROOM_SYNC_POLICY) {
  const window = (samples || []).filter(Boolean).slice(-policy.sampleWindow);
  if (window.length < policy.sampleWindow) return { stable: false, delayMs: null, spreadMs: null };
  if (now - window[window.length - 1].at > policy.maximumSampleAgeMs) {
    return { stable: false, delayMs: null, spreadMs: null };
  }

  for (let index = 1; index < window.length; index += 1) {
    if (window[index].at <= window[index - 1].at) return { stable: false, delayMs: null, spreadMs: null };
    if (window[index].rtcProgress <= window[index - 1].rtcProgress) {
      return { stable: false, delayMs: null, spreadMs: null };
    }
  }

  const delays = window.map((sample) => sample.normalizedDelayMs);
  const spreadMs = Math.max(...delays) - Math.min(...delays);
  if (spreadMs > policy.maximumStableSpreadMs) return { stable: false, delayMs: null, spreadMs };
  return { stable: true, delayMs: median(delays), spreadMs };
}

export function appendRoomTimingSample(samples, sample, policy = ROOM_SYNC_POLICY) {
  if (!sample) return [...(samples || [])];
  const previous = samples?.at(-1);
  if (previous?.rtcProgress === sample.rtcProgress) return samples;
  const base = previous && sample.rtcProgress < previous.rtcProgress ? [] : [...(samples || [])];
  return [...base, sample].slice(-(policy.sampleWindow + 2));
}

export function fixedRoomTargetMs(stableTimings, fallbackMs = 120, policy = ROOM_SYNC_POLICY) {
  const delays = (stableTimings || [])
    .filter((timing) => timing?.stable && Number.isFinite(timing.delayMs))
    .map((timing) => timing.delayMs);
  const slowestDelayMs = delays.length ? Math.max(...delays) : Number(fallbackMs) || policy.minimumRoomTargetMs;
  return Math.round(
    clamp(
      slowestDelayMs + policy.roomSafetyMarginMs,
      policy.minimumRoomTargetMs,
      policy.maximumRoomTargetMs
    )
  );
}

export function roomTimingCohort(entries, policy = ROOM_SYNC_POLICY) {
  const usable = (entries || [])
    .map((entry, index) => ({ index, delayMs: Number(entry?.delayMs) }))
    .filter((entry) => Number.isFinite(entry.delayMs));
  if (usable.length < 3) {
    return {
      includedIndexes: usable.map((entry) => entry.index),
      excludedIndexes: [],
      medianDelayMs: usable.length ? median(usable.map((entry) => entry.delayMs)) : null
    };
  }
  const medianDelayMs = median(usable.map((entry) => entry.delayMs));
  const maximumIncludedDelayMs = medianDelayMs + policy.speakerOutlierThresholdMs;
  const included = usable.filter((entry) => entry.delayMs <= maximumIncludedDelayMs);
  const minimumCohortSize = Math.ceil((usable.length * 2) / 3);
  const accepted = included.length >= minimumCohortSize ? included : usable;
  const acceptedIndexes = new Set(accepted.map((entry) => entry.index));
  return {
    includedIndexes: accepted.map((entry) => entry.index),
    excludedIndexes: usable.filter((entry) => !acceptedIndexes.has(entry.index)).map((entry) => entry.index),
    medianDelayMs
  };
}

export function runtimeRoomRelockPlan(devices, currentTargetMs, policy = ROOM_SYNC_POLICY) {
  const candidates = (devices || []).filter((device) =>
    Number.isFinite(Number(device?.syncErrorMs)) &&
    Number.isFinite(Number(device?.playoutDelayMs)) &&
    Number.isFinite(Number(device?.outputLatencyMs))
  );
  if (!candidates.length) {
    return {
      shouldRelock: false,
      roomTargetMs: null,
      lateCount: 0,
      requiredCount: 0,
      includedIndexes: [],
      excludedIndexes: []
    };
  }

  const requiredCount = Math.max(1, Math.ceil((candidates.length * 2) / 3));
  const late = candidates.filter((device) =>
    Number(device.syncErrorMs) >= policy.runtimeRelockErrorMs &&
    Number(device.postDelayMs || 0) <= policy.runtimeRelockPostDelayHeadroomMs
  );
  const observedDelays = candidates.map((device) => ({
    delayMs:
      Number(device.playoutDelayMs) +
      Number(device.outputLatencyMs) +
      Number(device.postDelayMs || 0) -
      Number(device.deviceOffsetMs || 0)
  }));
  const cohort = roomTimingCohort(observedDelays, policy);
  const includedDelays = cohort.includedIndexes.map((index) => observedDelays[index].delayMs);
  const currentTarget = Number(currentTargetMs);
  const roomTargetMs = Math.round(clamp(
    Math.max(...includedDelays) + policy.roomSafetyMarginMs,
    policy.minimumRoomTargetMs,
    policy.maximumRoomTargetMs
  ));
  const shouldRelock =
    late.length >= requiredCount &&
    Number.isFinite(currentTarget) &&
    roomTargetMs >= currentTarget + policy.runtimeRelockMinimumIncreaseMs;
  return {
    shouldRelock,
    roomTargetMs,
    lateCount: late.length,
    requiredCount,
    includedIndexes: cohort.includedIndexes,
    excludedIndexes: cohort.excludedIndexes
  };
}

export function nextFixedTimelineGuard(state, syncErrorMs, policy = ROOM_SYNC_POLICY) {
  const previous = {
    quarantined: Boolean(state?.quarantined),
    violationCount: Math.max(0, Number(state?.violationCount) || 0),
    recoveryCount: Math.max(0, Number(state?.recoveryCount) || 0)
  };
  const error = Math.abs(Number(syncErrorMs));
  if (!Number.isFinite(error)) return { ...previous, action: "none" };

  if (!previous.quarantined) {
    const emergencyError = Number(policy.emergencySyncErrorMs);
    if (Number.isFinite(emergencyError) && error >= emergencyError) {
      return {
        quarantined: true,
        violationCount: policy.violationSamples,
        recoveryCount: 0,
        action: "quarantine"
      };
    }
    const violationCount = error > policy.hardSyncErrorMs ? previous.violationCount + 1 : 0;
    if (violationCount >= policy.violationSamples) {
      return { quarantined: true, violationCount, recoveryCount: 0, action: "quarantine" };
    }
    return { quarantined: false, violationCount, recoveryCount: 0, action: "none" };
  }

  const recoveryCount = error <= policy.recoverySyncErrorMs
    ? previous.recoveryCount + 1
    : error <= policy.recoveryGraceErrorMs
      ? Math.max(0, previous.recoveryCount - 1)
      : 0;
  if (recoveryCount >= policy.recoverySamples) {
    return { quarantined: false, violationCount: 0, recoveryCount, action: "rejoin" };
  }
  return { quarantined: true, violationCount: previous.violationCount, recoveryCount, action: "none" };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
