const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

// The browser side uses performance.now(), never its adjustable wall clock.
// Four timestamps remove server processing time from the RTT estimate; a
// low-RTT window limits (but cannot eliminate) asymmetric network uncertainty.
export class LiveClockSync {
  constructor() {
    this.samples = [];
    this.clockId = null;
    this.value = null;
    this.anchor = null;
  }

  record(reply, receivedClientMs) {
    const { clientSent, serverReceivedMs, serverSentMs, clockId } = reply;
    if (![clientSent, serverReceivedMs, serverSentMs, receivedClientMs].every(Number.isFinite)
        || typeof clockId !== "string" || !clockId || clockId.length > 128
        || receivedClientMs < clientSent || serverSentMs < serverReceivedMs) return false;
    const roundTripMs = receivedClientMs - clientSent - (serverSentMs - serverReceivedMs);
    if (roundTripMs < -0.5 || roundTripMs > 250) return false;
    if (clockId !== this.clockId) {
      this.samples = [];
      this.value = null;
      this.anchor = null;
      this.clockId = clockId;
    }
    const clientMid = (clientSent + receivedClientMs) / 2;
    const offset = ((serverReceivedMs - clientSent) + (serverSentMs - receivedClientMs)) / 2;
    this.samples.push({ clientMid, offset, roundTripMs: Math.max(0, roundTripMs) });
    this.samples = this.samples.filter((sample) => clientMid - sample.clientMid <= 15000).slice(-32);
    const best = [...this.samples].sort((a, b) => a.roundTripMs - b.roundTripMs || b.clientMid - a.clientMid)[0];
    let driftPpm = this.value?.driftPpm || 0;
    if (this.anchor && best.clientMid - this.anchor.clientMid >= 10000) {
      const observed = (best.offset - this.anchor.offset) / (best.clientMid - this.anchor.clientMid) * 1e6;
      driftPpm = clamp(driftPpm * 0.9 + clamp(observed, -100, 100) * 0.1, -100, 100);
      this.anchor = best;
    }
    if (!this.anchor) this.anchor = best;
    this.value = {
      masterOffsetMs: best.offset,
      referenceClientMs: best.clientMid,
      driftPpm,
      roundTripMs: best.roundTripMs,
      updatedClientMs: receivedClientMs,
      clockId
    };
    return true;
  }

  mapping() { return this.value ? { ...this.value } : null; }
}

export function masterToClientTime(masterMs, mapping) {
  const drift = (mapping.driftPpm || 0) / 1e6;
  return (masterMs - mapping.masterOffsetMs + drift * (mapping.referenceClientMs || 0)) / (1 + drift);
}

export function clientToMasterTime(clientMs, mapping) {
  return clientMs + mapping.masterOffsetMs + (mapping.driftPpm || 0) / 1e6 * (clientMs - (mapping.referenceClientMs || 0));
}

export function masterToAudioContextTime(context, targetMasterMs, mapping, nowPerformanceMs) {
  const targetPerformanceMs = masterToClientTime(targetMasterMs, mapping);
  try {
    const timestamp = context.getOutputTimestamp?.();
    if (timestamp && Number.isFinite(timestamp.contextTime) && Number.isFinite(timestamp.performanceTime)
        && timestamp.contextTime >= 0 && timestamp.performanceTime > 0
        && timestamp.contextTime <= context.currentTime + 0.1
        && nowPerformanceMs - timestamp.performanceTime >= -50
        && nowPerformanceMs - timestamp.performanceTime <= 2000) {
      // W3C: this pair already refers to output-device rendering. Subtracting
      // baseLatency/outputLatency here would compensate the same delay twice.
      return { contextTime: timestamp.contextTime + (targetPerformanceMs - timestamp.performanceTime) / 1000,
        targetPerformanceMs, method: "output-timestamp", estimatedOutputLatencyMs: null };
    }
  } catch {}
  const latency = [context.baseLatency, context.outputLatency]
    .reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0), 0);
  const estimated = Math.min(0.5, latency);
  return { contextTime: context.currentTime + (targetPerformanceMs - nowPerformanceMs) / 1000 - estimated,
    targetPerformanceMs, method: "latency-estimate", estimatedOutputLatencyMs: estimated * 1000 };
}
