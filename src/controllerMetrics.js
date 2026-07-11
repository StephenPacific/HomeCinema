const CONTEXT_STATES = new Set(["closed", "interrupted", "none", "running", "suspended", "unknown"]);

export function sanitizeControllerAudioMetrics(value) {
  if (!value || typeof value !== "object") return null;
  const totalOutputLatencyMs = boundedMetric(value.totalOutputLatencyMs, 0, 2000);
  if (totalOutputLatencyMs === null) return null;

  const contextState = String(value.contextState || "unknown").toLowerCase();
  return {
    observedAt: Math.round(boundedMetric(value.observedAt, 0, Number.MAX_SAFE_INTEGER) || Date.now()),
    sampleCount: Math.round(boundedMetric(value.sampleCount, 0, 1000) || 0),
    observationWindowMs: Math.round(boundedMetric(value.observationWindowMs, 0, 120_000) || 0),
    contextState: CONTEXT_STATES.has(contextState) ? contextState : "unknown",
    sampleRate: roundedNullableMetric(value.sampleRate, 8000, 384_000),
    baseLatencyMs: boundedMetric(value.baseLatencyMs, 0, 2000),
    outputLatencyMs: boundedMetric(value.outputLatencyMs, 0, 2000),
    totalOutputLatencyMs,
    initialOutputLatencyMs: boundedMetric(value.initialOutputLatencyMs, 0, 2000),
    latencyDeltaMs: boundedMetric(value.latencyDeltaMs, -1000, 1000),
    latencySpreadMs: boundedMetric(value.latencySpreadMs, 0, 2000),
    clockDriftPpm: boundedMetric(value.clockDriftPpm, -100_000, 100_000),
    timestampAvailable: Boolean(value.timestampAvailable),
    localDelayMs: boundedMetric(value.localDelayMs, 0, 2000),
    roomTargetMs: boundedMetric(value.roomTargetMs, 0, 4000),
    estimatedTimelineErrorMs: boundedMetric(value.estimatedTimelineErrorMs, -2000, 2000)
  };
}

export function controllerAudioHealth(metrics) {
  if (!metrics) return { label: "Waiting for extension", tone: "waiting" };
  if (metrics.contextState !== "running") {
    return { label: `Audio ${metrics.contextState}`, tone: "attention" };
  }
  if (metrics.sampleCount < 8 || metrics.observationWindowMs < 8000) {
    return { label: "Collecting", tone: "waiting" };
  }

  const timelineChanging = Math.abs(metrics.estimatedTimelineErrorMs || 0) > 8;
  const latencyChanging = Number(metrics.latencySpreadMs || 0) > 4;
  const clockChanging = Number.isFinite(metrics.clockDriftPpm) && Math.abs(metrics.clockDriftPpm) > 300;
  if (timelineChanging || latencyChanging || clockChanging) {
    return { label: "Changing", tone: "attention" };
  }
  return { label: "Observed stable", tone: "ready" };
}

function roundedNullableMetric(value, min, max) {
  const metric = boundedMetric(value, min, max);
  return metric === null ? null : Math.round(metric);
}

function boundedMetric(value, min, max) {
  if (value === null || value === undefined || value === "") return null;
  const metric = Number(value);
  if (!Number.isFinite(metric)) return null;
  return Math.min(max, Math.max(min, metric));
}
