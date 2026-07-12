export const PLUGIN_ROOM_PROTOCOL_VERSION = 1;
export const DEFAULT_SIGNALING_ORIGIN = "http://127.0.0.1:4180";
export const PLUGIN_ROOM_POLICY = Object.freeze({
  sampleWindow: 3,
  maximumSampleAgeMs: 8_000,
  maximumStableSpreadMs: 12,
  minimumRoomTargetMs: 120,
  maximumRoomTargetMs: 500,
  roomSafetyMarginMs: 8,
  estimatedTimingSafetyMs: 28,
  receiverBufferTargetMs: 120
});

export function normalizeSignalingOrigin(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Enter the Home Cinema signaling address.");
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Use an http:// or https:// signaling address.");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function signalingWebSocketUrl(value) {
  const url = new URL(normalizeSignalingOrigin(value));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/signal";
  return url.toString();
}

export function appendPluginTimingSample(samples, sample, policy = PLUGIN_ROOM_POLICY) {
  if (!sample) return [...(samples || [])];
  const normalized = normalizeTimingSample(sample);
  if (!normalized) return [...(samples || [])];
  const previous = samples?.at(-1);
  if (previous?.rtpProgress === normalized.rtpProgress) return samples;
  const base = previous && normalized.rtpProgress < previous.rtpProgress ? [] : [...(samples || [])];
  return [...base, normalized].slice(-(policy.sampleWindow + 2));
}

export function stablePluginTiming(samples, now = Date.now(), policy = PLUGIN_ROOM_POLICY) {
  const window = (samples || []).slice(-policy.sampleWindow);
  if (window.length < policy.sampleWindow) return { stable: false, delayMs: null, spreadMs: null };
  if (now - window.at(-1).observedAt > policy.maximumSampleAgeMs) {
    return { stable: false, delayMs: null, spreadMs: null };
  }
  for (let index = 1; index < window.length; index += 1) {
    if (
      window[index].observedAt <= window[index - 1].observedAt ||
      window[index].rtpProgress <= window[index - 1].rtpProgress
    ) {
      return { stable: false, delayMs: null, spreadMs: null };
    }
  }
  const delays = window.map((sample) => sample.playoutDelayMs + sample.outputLatencyMs);
  const spreadMs = Math.max(...delays) - Math.min(...delays);
  if (spreadMs > policy.maximumStableSpreadMs) return { stable: false, delayMs: null, spreadMs };
  return { stable: true, delayMs: median(delays), spreadMs };
}

export function choosePluginRoomTarget(timings, policy = PLUGIN_ROOM_POLICY) {
  const delays = (timings || [])
    .filter((timing) => timing?.stable && Number.isFinite(Number(timing.delayMs)))
    .map((timing) => Number(timing.delayMs));
  const slowest = delays.length ? Math.max(...delays) : policy.minimumRoomTargetMs;
  return Math.round(clamp(
    slowest + policy.roomSafetyMarginMs,
    policy.minimumRoomTargetMs,
    policy.maximumRoomTargetMs
  ));
}

export function webRtcPlayoutDelaySample(current, previous) {
  const emitted = finite(current?.jitterBufferEmittedCount);
  const previousEmitted = finite(previous?.jitterBufferEmittedCount);
  const delay = finite(current?.jitterBufferDelay);
  const previousDelay = finite(previous?.jitterBufferDelay);
  if (![emitted, previousEmitted, delay, previousDelay].every(Number.isFinite)) return null;
  const emittedDelta = emitted - previousEmitted;
  const delayDelta = delay - previousDelay;
  if (emittedDelta <= 0 || delayDelta < 0) return null;
  return {
    actualDelayMs: clamp((delayDelta / emittedDelta) * 1000, 0, 4000),
    emittedCount: emittedDelta,
    rtpProgress: emitted
  };
}

export function webRtcFallbackDelaySample(
  current,
  previous,
  fallbackDelayMs = PLUGIN_ROOM_POLICY.receiverBufferTargetMs
) {
  const progressFields = ["totalSamplesReceived", "packetsReceived", "bytesReceived"];
  let currentProgress = Number.NaN;
  let previousProgress = Number.NaN;
  for (const field of progressFields) {
    const next = finite(current?.[field]);
    const before = finite(previous?.[field]);
    if (Number.isFinite(next) && Number.isFinite(before)) {
      currentProgress = next;
      previousProgress = before;
      break;
    }
  }
  if (!Number.isFinite(currentProgress) || currentProgress <= previousProgress) return null;

  const emitted = finite(current?.jitterBufferEmittedCount);
  const delay = finite(current?.jitterBufferDelay);
  const lifetimeDelayMs = emitted > 0 && Number.isFinite(delay) ? (delay / emitted) * 1000 : Number.NaN;
  const jitterMs = Math.max(0, finite(current?.jitter) * 1000 || 0);
  const actualDelayMs = Number.isFinite(lifetimeDelayMs)
    ? lifetimeDelayMs
    : Math.max(40, Number(fallbackDelayMs) || 0) + jitterMs;
  return {
    actualDelayMs: clamp(actualDelayMs, 0, 4000),
    emittedCount: currentProgress - previousProgress,
    rtpProgress: currentProgress,
    estimated: true
  };
}

export function clockOffsetSample({ controllerSentAt, speakerReceivedAt, speakerSentAt, controllerReceivedAt }) {
  const values = [controllerSentAt, speakerReceivedAt, speakerSentAt, controllerReceivedAt].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [t0, t1, t2, t3] = values;
  const roundTripMs = Math.max(0, t3 - t0 - Math.max(0, t2 - t1));
  const speakerOffsetMs = ((t1 - t0) + (t2 - t3)) / 2;
  return { roundTripMs, speakerOffsetMs };
}

export function bestClockOffset(samples) {
  const usable = (samples || []).filter((sample) =>
    Number.isFinite(Number(sample?.roundTripMs)) && Number.isFinite(Number(sample?.speakerOffsetMs))
  );
  if (!usable.length) return null;
  return usable.reduce((best, sample) => sample.roundTripMs < best.roundTripMs ? sample : best);
}

function normalizeTimingSample(sample) {
  const observedAt = finite(sample?.observedAt);
  const playoutDelayMs = finite(sample?.playoutDelayMs);
  const outputLatencyMs = finite(sample?.outputLatencyMs);
  const rtpProgress = finite(sample?.rtpProgress);
  if (![observedAt, playoutDelayMs, outputLatencyMs, rtpProgress].every(Number.isFinite)) return null;
  return {
    observedAt,
    playoutDelayMs: Math.max(0, playoutDelayMs),
    outputLatencyMs: Math.max(0, outputLatencyMs),
    rtpProgress: Math.max(0, rtpProgress)
  };
}

function finite(value) {
  if (value === null || value === undefined || value === "") return Number.NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
