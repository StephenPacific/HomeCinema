export const DEVICE_HEALTH_POLICY = Object.freeze({
  fastFuseSyncErrorMs: 20,
  fastFuseOutputLatencyDeltaMs: 10,
  fastFuseRtpStallMs: 750,
  fastFusePacketLossRate: 0.08,
  fastFuseConcealmentRate: 0.08,
  warningPacketLossRate: 0.01,
  warningJitterMs: 15,
  warningOutputLatencyDeltaMs: 4,
  warningTelemetryAgeMs: 1500,
  criticalTelemetryAgeMs: 4000,
  healthySyncErrorMs: 2,
  warningSyncErrorMs: 4,
  outlierSyncErrorMs: 8,
  commonTimelineShiftMs: 4,
  commonTimelineAlignmentMs: 12
});

const SEVERITY = Object.freeze({
  unknown: 0,
  inactive: 0,
  healthy: 1,
  watching: 2,
  measuring: 2,
  repairing: 3,
  warning: 4,
  critical: 5
});

export function captureRtcSnapshot(report = {}) {
  return {
    jitterBufferEmittedCount: finiteOrNull(report.jitterBufferEmittedCount),
    jitterBufferDelay: finiteOrNull(report.jitterBufferDelay),
    jitterBufferTargetDelay: finiteOrNull(report.jitterBufferTargetDelay),
    jitterBufferMinimumDelay: finiteOrNull(report.jitterBufferMinimumDelay),
    packetsReceived: finiteOrNull(report.packetsReceived),
    packetsLost: finiteOrNull(report.packetsLost),
    concealedSamples: finiteOrNull(report.concealedSamples),
    totalSamplesReceived: finiteOrNull(report.totalSamplesReceived),
    bytesReceived: finiteOrNull(report.bytesReceived),
    jitter: finiteOrNull(report.jitter)
  };
}

export function rtcWindowMetrics(current, previous, {
  now = Date.now(),
  lastProgressAt = now
} = {}) {
  const currentProgress = progressMetric(current);
  const previousProgress = progressMetric(previous);
  const progressReset = Number.isFinite(currentProgress) && Number.isFinite(previousProgress) && currentProgress < previousProgress;
  const progressAdvanced =
    Number.isFinite(currentProgress) &&
    (!Number.isFinite(previousProgress) || currentProgress > previousProgress || progressReset);
  const nextLastProgressAt = progressAdvanced || !Number.isFinite(Number(lastProgressAt))
    ? Number(now)
    : Number(lastProgressAt);

  const receivedDelta = nonNegativeDelta(current?.packetsReceived, previous?.packetsReceived);
  const lostDelta = nonNegativeDelta(current?.packetsLost, previous?.packetsLost);
  const packetSampleCount = Number.isFinite(receivedDelta) && Number.isFinite(lostDelta)
    ? receivedDelta + lostDelta
    : 0;
  const packetLossRate = packetSampleCount > 0 ? lostDelta / packetSampleCount : null;
  const totalSamplesDelta = nonNegativeDelta(current?.totalSamplesReceived, previous?.totalSamplesReceived);
  const concealedSamplesDelta = nonNegativeDelta(current?.concealedSamples, previous?.concealedSamples);
  const concealmentRate = Number.isFinite(totalSamplesDelta) && totalSamplesDelta > 0 && Number.isFinite(concealedSamplesDelta)
    ? concealedSamplesDelta / totalSamplesDelta
    : null;

  return {
    jitterMs: Number.isFinite(Number(current?.jitter)) ? Math.max(0, Number(current.jitter) * 1000) : null,
    packetsReceivedDelta: receivedDelta,
    packetsLostDelta: lostDelta,
    packetSampleCount,
    packetLossRate,
    concealedSamplesDelta,
    totalSamplesDelta,
    concealmentRate,
    rtpStallMs:
      Number.isFinite(currentProgress) && Number.isFinite(previousProgress) && !progressAdvanced
        ? Math.max(0, Number(now) - nextLastProgressAt)
        : 0,
    lastProgressAt: nextLastProgressAt
  };
}

export function fastFuseReason(metrics = {}, policy = DEVICE_HEALTH_POLICY) {
  if (metrics.active === false || metrics.muted) return null;
  const connectionState = String(metrics.connectionState || "").toLowerCase();
  if (["failed", "closed"].includes(connectionState)) {
    return fault("connection", "WEBRTC_FAILED", "WebRTC connection failed");
  }

  const contextState = String(metrics.audioContextState || "").toLowerCase();
  if (metrics.requiresAudioContext !== false && ["closed", "interrupted", "suspended"].includes(contextState)) {
    return fault("audio", "AUDIO_ENGINE_STOPPED", "Audio engine stopped");
  }
  if (metricAtLeast(metrics.rtpStallMs, policy.fastFuseRtpStallMs)) {
    return fault("connection", "RTP_STALLED", "RTP audio stopped advancing");
  }
  return null;
}

export function roomHealthContext(devices = [], policy = DEVICE_HEALTH_POLICY) {
  const active = devices.filter((device) =>
    device?.active && !device?.muted && Number.isFinite(Number(device?.syncErrorMs))
  );
  const values = active
    .filter((device) => device.role !== "capture")
    .map((device) => Number(device.syncErrorMs));
  const controllerValues = active
    .filter((device) => device.role === "capture")
    .map((device) => Number(device.syncErrorMs));
  const medianSyncErrorMs = values.length ? median(values) : null;
  const controllerSyncErrorMs = controllerValues.length ? median(controllerValues) : null;
  const sameDirectionCount = !Number.isFinite(medianSyncErrorMs) || medianSyncErrorMs === 0
    ? 0
    : values.filter((value) => Math.sign(value) === Math.sign(medianSyncErrorMs) && Math.abs(value) >= policy.commonTimelineShiftMs).length;
  const groupShift =
    values.length >= 2 &&
    Math.abs(medianSyncErrorMs) >= policy.commonTimelineShiftMs &&
    sameDirectionCount >= Math.ceil((values.length * 2) / 3);
  const commonTimelineShift = Boolean(
    groupShift &&
    Number.isFinite(controllerSyncErrorMs) &&
    Math.abs(controllerSyncErrorMs - medianSyncErrorMs) <= policy.commonTimelineAlignmentMs
  );
  return {
    medianSyncErrorMs,
    participantCount: values.length,
    commonTimelineShift,
    speakerTimelineShift: groupShift && !commonTimelineShift,
    controllerSyncErrorMs
  };
}

export function classifyDeviceHealth(metrics = {}, context = {}, policy = DEVICE_HEALTH_POLICY) {
  const active = Boolean(metrics.active);
  const muted = Boolean(metrics.muted);
  const connection = classifyConnection(metrics, active, policy);
  const audio = classifyAudio(metrics, active, muted, policy);
  const sync = classifySync(metrics, context, active, muted, policy);
  const layers = { connection, audio, sync };
  const highest = Object.entries(layers).reduce(
    (selected, [name, layer]) => SEVERITY[layer.state] > SEVERITY[selected.layer.state]
      ? { name, layer }
      : selected,
    { name: "connection", layer: connection }
  );
  const allQuiet = Object.values(layers).every((layer) => ["healthy", "inactive", "unknown"].includes(layer.state));
  const overall = allQuiet
    ? layer("healthy", muted ? "Stopped" : active ? "Healthy" : "Ready", muted ? "MANUALLY_STOPPED" : "HEALTHY")
    : { ...highest.layer };
  return {
    connection,
    audio,
    sync,
    overall: {
      ...overall,
      layer: allQuiet ? null : highest.name,
      action: suggestedAction(overall.reason)
    }
  };
}

export function summarizeRoomHealth(devices = [], context = {}) {
  if (context.speakerTimelineShift) {
    return {
      state: "warning",
      label: `Speaker playout shifted ${signedMs(context.medianSyncErrorMs)}`,
      reason: "SPEAKER_TIMELINE_SHIFT"
    };
  }
  if (context.commonTimelineShift) {
    return {
      state: "warning",
      label: `Common timeline shift ${signedMs(context.medianSyncErrorMs)}`,
      reason: "COMMON_TIMELINE_SHIFT"
    };
  }
  const ranked = devices
    .filter((device) => device?.diagnostic?.overall)
    .sort((left, right) => SEVERITY[right.diagnostic.overall.state] - SEVERITY[left.diagnostic.overall.state]);
  const firstIssue = ranked.find((device) => SEVERITY[device.diagnostic.overall.state] >= SEVERITY.warning);
  if (firstIssue) {
    return {
      state: firstIssue.diagnostic.overall.state,
      label: `${firstIssue.name}: ${firstIssue.diagnostic.overall.label}`,
      reason: firstIssue.diagnostic.overall.reason,
      deviceId: firstIssue.id
    };
  }
  const watching = ranked.find((device) => SEVERITY[device.diagnostic.overall.state] >= SEVERITY.watching);
  if (watching) {
    return {
      state: "watching",
      label: `${watching.name}: ${watching.diagnostic.overall.label}`,
      reason: watching.diagnostic.overall.reason,
      deviceId: watching.id
    };
  }
  return { state: "healthy", label: "Room healthy", reason: "HEALTHY" };
}

function classifyConnection(metrics, active, policy) {
  if (metrics.online === false) return layer("critical", "Offline", "CONTROL_OFFLINE");
  const state = String(metrics.connectionState || "connected").toLowerCase();
  if (["failed", "closed"].includes(state)) return layer("critical", "Failed", "WEBRTC_FAILED");
  if (active && metricAtLeast(metrics.telemetryAgeMs, policy.criticalTelemetryAgeMs)) {
    return layer("critical", "No telemetry", "TELEMETRY_STALE");
  }
  if (active && metricAtLeast(metrics.rtpStallMs, policy.fastFuseRtpStallMs)) {
    return layer("critical", "RTP stalled", "RTP_STALLED");
  }
  if (active && metricAtLeast(metrics.packetLossRate, policy.fastFusePacketLossRate)) {
    return layer("critical", `Loss ${percent(metrics.packetLossRate)}`, "PACKET_LOSS_BURST");
  }
  if (["disconnected", "connecting", "new"].includes(state) && active) {
    return layer("warning", titleCase(state), "WEBRTC_UNSTABLE");
  }
  if (active && metricAtLeast(metrics.telemetryAgeMs, policy.warningTelemetryAgeMs)) {
    return layer("warning", "Telemetry late", "TELEMETRY_LATE");
  }
  if (active && metricAtLeast(metrics.packetLossRate, policy.warningPacketLossRate)) {
    return layer("warning", `Loss ${percent(metrics.packetLossRate)}`, "PACKET_LOSS");
  }
  if (active && metricAtLeast(metrics.jitterMs, policy.warningJitterMs)) {
    return layer("warning", `Jitter ${Math.round(metrics.jitterMs)} ms`, "NETWORK_JITTER");
  }
  return layer("healthy", active ? "Connected" : "Online", "CONNECTION_HEALTHY");
}

function classifyAudio(metrics, active, muted, policy) {
  if (muted) return layer("inactive", "Stopped", "MANUALLY_STOPPED");
  if (metrics.role === "speaker" && !metrics.unlocked) return layer("critical", "Needs tap", "AUDIO_NEEDS_TAP");
  const contextState = String(metrics.audioContextState || "none").toLowerCase();
  if (active && ["closed", "interrupted", "suspended"].includes(contextState)) {
    return layer("critical", contextState === "suspended" ? "Needs tap" : "Stopped", "AUDIO_ENGINE_STOPPED");
  }
  const latencyChange = Math.abs(Number(metrics.outputLatencyDeltaMs));
  if (active && latencyChange >= policy.fastFuseOutputLatencyDeltaMs) {
    return layer("critical", `Jump ${signedMs(metrics.outputLatencyDeltaMs)}`, "OUTPUT_LATENCY_JUMP");
  }
  if (active && latencyChange >= policy.warningOutputLatencyDeltaMs) {
    return layer("warning", `Changing ${signedMs(metrics.outputLatencyDeltaMs)}`, "OUTPUT_LATENCY_CHANGING");
  }
  if (active && metrics.role === "speaker" && metrics.outputPath === "none") {
    return layer("measuring", "Preparing", "AUDIO_PREPARING");
  }
  if (contextState === "running") return layer("healthy", "Running", "AUDIO_HEALTHY");
  return layer(active ? "measuring" : "inactive", active ? "Preparing" : "Idle", "AUDIO_IDLE");
}

function classifySync(metrics, context, active, muted, policy) {
  if (!active || muted) return layer("inactive", muted ? "Stopped" : "Idle", "SYNC_IDLE");
  if (metrics.fastFuseReason) {
    const reason = typeof metrics.fastFuseReason === "string" ? metrics.fastFuseReason : metrics.fastFuseReason.code;
    return layer("critical", "Isolated", reason || "FAST_FUSE");
  }
  const timelineState = String(metrics.timelineState || "").toLowerCase();
  if (timelineState === "recovering") return layer("repairing", "Repairing", "SYNC_REPAIRING");
  if (["measuring", "locking", "armed"].includes(timelineState)) {
    return layer("measuring", titleCase(timelineState), "SYNC_MEASURING");
  }
  const syncErrorMs = finiteOrNull(metrics.syncErrorMs);
  if (syncErrorMs === null) return layer("measuring", "Measuring", "SYNC_MEASURING");
  if (metrics.role === "capture") {
    if (Math.abs(syncErrorMs) >= policy.warningSyncErrorMs) {
      return layer("warning", `Local ${signedMs(syncErrorMs)}`, "CONTROLLER_SYNC_DRIFT");
    }
    if (Math.abs(syncErrorMs) > policy.healthySyncErrorMs) {
      return layer("watching", `Watching ${signedMs(syncErrorMs)}`, "SYNC_WATCHING");
    }
    return layer("healthy", `Locked ${signedMs(syncErrorMs)}`, "SYNC_LOCKED");
  }
  if (context.speakerTimelineShift) {
    return layer("warning", `Group ${signedMs(syncErrorMs)}`, "SPEAKER_TIMELINE_SHIFT");
  }
  if (context.commonTimelineShift) {
    return layer("warning", `Common ${signedMs(syncErrorMs)}`, "COMMON_TIMELINE_SHIFT");
  }
  const useRoomMedian = Number(context.participantCount) >= 3 && Number.isFinite(Number(context.medianSyncErrorMs));
  const comparisonErrorMs = useRoomMedian ? syncErrorMs - Number(context.medianSyncErrorMs) : syncErrorMs;
  const rawSyncErrorMs = finiteOrNull(metrics.rawSyncErrorMs);
  if (rawSyncErrorMs !== null && Math.abs(rawSyncErrorMs) >= policy.fastFuseSyncErrorMs) {
    return layer("critical", `Jump ${signedMs(rawSyncErrorMs)}`, "SYNC_JUMP");
  }
  if (Math.abs(comparisonErrorMs) >= policy.outlierSyncErrorMs) {
    return layer("critical", `Outlier ${signedMs(comparisonErrorMs)}`, "SYNC_OUTLIER");
  }
  if (Math.abs(comparisonErrorMs) >= policy.warningSyncErrorMs) {
    return layer("warning", `Drifting ${signedMs(comparisonErrorMs)}`, "SYNC_DRIFT");
  }
  if (Math.abs(comparisonErrorMs) > policy.healthySyncErrorMs) {
    return layer("watching", `Watching ${signedMs(comparisonErrorMs)}`, "SYNC_WATCHING");
  }
  return layer("healthy", `Locked ${signedMs(comparisonErrorMs)}`, "SYNC_LOCKED");
}

function suggestedAction(reason) {
  if (["WEBRTC_FAILED", "RTP_STALLED", "CONTROL_OFFLINE", "TELEMETRY_STALE"].includes(reason)) {
    return "Reconnect transport";
  }
  if (reason === "TELEMETRY_LATE") return "Watch telemetry";
  if (["AUDIO_ENGINE_STOPPED", "AUDIO_NEEDS_TAP"].includes(reason)) return "Restore audio";
  if (["OUTPUT_LATENCY_JUMP", "OUTPUT_LATENCY_CHANGING"].includes(reason)) return "Remeasure output";
  if (reason === "CONTROLLER_SYNC_DRIFT") return "Adjust local delay";
  if (reason === "SPEAKER_TIMELINE_SHIFT") return "Relock room";
  if (["SYNC_JUMP", "SYNC_OUTLIER", "SYNC_DRIFT", "SYNC_REPAIRING"].includes(reason)) return "Relock silently";
  if (["PACKET_LOSS_BURST", "CONCEALMENT_BURST", "PACKET_LOSS", "NETWORK_JITTER"].includes(reason)) return "Watch network";
  if (reason === "COMMON_TIMELINE_SHIFT") return "Inspect Controller";
  return "None";
}

function layer(state, label, reason) {
  return { state, label, reason };
}

function fault(layerName, code, label) {
  return { layer: layerName, code, label };
}

function progressMetric(value) {
  const emitted = finiteOrNull(value?.jitterBufferEmittedCount);
  if (Number.isFinite(emitted)) return emitted;
  const bytes = finiteOrNull(value?.bytesReceived);
  return Number.isFinite(bytes) ? bytes : null;
}

function nonNegativeDelta(current, previous) {
  const next = finiteOrNull(current);
  const before = finiteOrNull(previous);
  if (!Number.isFinite(next) || !Number.isFinite(before)) return null;
  if (next < before) return null;
  return next - before;
}

function metricAtLeast(value, threshold) {
  const number = Number(value);
  return Number.isFinite(number) && number >= threshold;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percent(value) {
  return `${Math.round(Number(value || 0) * 1000) / 10}%`;
}

function signedMs(value) {
  const rounded = Math.round(Number(value || 0) * 10) / 10;
  return `${rounded >= 0 ? "+" : ""}${rounded} ms`;
}

function titleCase(value) {
  const text = String(value || "");
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "Unknown";
}
