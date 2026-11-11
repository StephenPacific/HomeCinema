import { masterToAudioContextTime } from "./live-clock.js";
const LEGACY_HEADER_BYTES = 20;

export function decodeLivePacket(data) {
  if (!(data instanceof ArrayBuffer) || data.byteLength < LEGACY_HEADER_BYTES) throw new Error("Incomplete live audio packet");
  const view = new DataView(data);
  const magic = view.getUint32(0, false);
  if (![0x48434131, 0x48434132].includes(magic)) throw new Error("Unsupported live audio packet");
  const protocol = magic === 0x48434132 ? 2 : 1;
  const headerBytes = protocol === 2 ? 48 : LEGACY_HEADER_BYTES;
  if (data.byteLength < headerBytes) throw new Error("Incomplete live audio header");
  const sampleRate = view.getUint32(4, true);
  const channels = view.getUint32(8, true);
  const frames = view.getUint32(12, true);
  const sequence = view.getUint32(16, true);
  if (sampleRate < 8000 || sampleRate > 192000 || ![1, 2].includes(channels)
      || frames < 1 || frames > sampleRate || data.byteLength !== headerBytes + frames * channels * 4) {
    throw new Error("Invalid live audio format");
  }
  let streamId = null, sourceFrame = null, captureMasterMs = null, presentationDelayMs = null;
  if (protocol === 2) {
    streamId = view.getUint32(20, true);
    sourceFrame = view.getUint32(24, true) + view.getUint32(28, true) * 0x100000000;
    captureMasterMs = view.getFloat64(32, true);
    presentationDelayMs = view.getFloat64(40, true);
    if (!Number.isSafeInteger(sourceFrame) || !Number.isSafeInteger(sourceFrame + frames)
        || !Number.isFinite(captureMasterMs) || captureMasterMs <= 0
        || !Number.isFinite(presentationDelayMs) || presentationDelayMs < 100 || presentationDelayMs > 1200) {
      throw new Error("Invalid common audio timeline");
    }
  }
  const samples = new Float32Array(frames * channels);
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = view.getFloat32(headerBytes + i * 4, true);
    samples[i] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
    peak = Math.max(peak, Math.abs(samples[i]));
  }
  return { sampleRate, channels, frames, sequence, samples, peak, protocol, streamId, sourceFrame, captureMasterMs, presentationDelayMs };
}

export class LiveAudioPlayer {
  constructor(context, { bufferMs = 500, autoPump = true, performanceNow = () => performance.now(), localTrimMs = 0, onSchedule = null } = {}) {
    this.context = context;
    this.output = context.createGain();
    this.output.gain.value = 0;
    this.output.connect(context.destination);
    this.bufferMs = Math.max(200, Math.min(1000, bufferMs));
    this.maxBufferMs = 1200;
    this.queue = [];
    this.queuedFrames = 0;
    this.sources = new Set();
    this.sampleRate = 0;
    this.channels = 0;
    this.lastSequence = null;
    this.nextTime = 0;
    this.started = false;
    this.underruns = 0;
    this.droppedFrames = 0;
    this.discontinuities = 0;
    this.inputPeak = 0;
    this.rate = 1;
    this.tailFade = false;
    this.closed = false;
    this.performanceNow = performanceNow;
    this.onSchedule = onSchedule;
    this.localTrimMs = Math.max(-200, Math.min(200, localTrimMs));
    this.clockMapping = null;
    this.clockMethod = "waiting-for-clock";
    this.protocol = 0;
    this.streamId = null;
    this.presentationDelayMs = null;
    this.lastSourceFrameEnd = null;
    this.lastScheduledSourceFrameEnd = null;
    this.timingErrorMs = null;
    this.lateDrops = 0;
    this.timer = autoPump ? setInterval(() => this.pump(), 25) : null;
  }

  push(data) {
    if (this.closed) return;
    const packet = decodeLivePacket(data);
    const changedFormat = this.sampleRate && (packet.sampleRate !== this.sampleRate || packet.channels !== this.channels);
    const missingPacket = this.lastSequence !== null && packet.sequence !== ((this.lastSequence + 1) >>> 0);
    const changedTimeline = this.protocol && (packet.protocol !== this.protocol || packet.streamId !== this.streamId
      || packet.presentationDelayMs !== this.presentationDelayMs);
    if (packet.protocol === 2 && !changedTimeline && !changedFormat && this.lastSourceFrameEnd !== null
        && packet.sourceFrame < this.lastSourceFrameEnd) {
      this.droppedFrames += packet.frames;
      return;
    }
    const sourceGap = packet.protocol === 2 && this.lastSourceFrameEnd !== null && packet.sourceFrame !== this.lastSourceFrameEnd;
    if (changedFormat || missingPacket || changedTimeline || sourceGap) {
      this.discontinuities += 1;
      this.reset();
    }
    this.protocol = packet.protocol;
    this.streamId = packet.streamId;
    this.presentationDelayMs = packet.presentationDelayMs;
    this.lastSourceFrameEnd = packet.protocol === 2 ? packet.sourceFrame + packet.frames : null;
    this.sampleRate = packet.sampleRate;
    this.channels = packet.channels;
    this.lastSequence = packet.sequence;
    this.queue.push({ ...packet, offset: 0 });
    this.queuedFrames += packet.frames;
    if (this.getStats().queueMs > this.maxBufferMs) {
      // Retain only the newest packet; accumulating old live audio is worse
      // than a short, explicit rebuffer after a stalled browser/network.
      this.reset();
      this.droppedFrames = Math.max(0, this.droppedFrames - packet.frames);
      this.queue.push({ ...packet, offset: 0 });
      this.queuedFrames = packet.frames;
      this.lastSequence = packet.sequence;
      this.lastSourceFrameEnd = packet.protocol === 2 ? packet.sourceFrame + packet.frames : null;
    }
    this.inputPeak = packet.peak;
    this.pump();
  }

  setBufferMs(value) {
    const next = Math.max(200, Math.min(1000, value));
    if (next !== this.bufferMs) {
      this.bufferMs = next;
      if (this.protocol !== 2) this.reset();
    }
  }

  setClockMapping(mapping) {
    if (!mapping || !Number.isFinite(mapping.masterOffsetMs) || typeof mapping.clockId !== "string") {
      this.clockMapping = null;
      if (this.protocol === 2) this.reset();
      return;
    }
    if (this.clockMapping && this.clockMapping.clockId !== mapping.clockId) this.reset();
    else if (this.clockMapping && Math.abs(this.clockMapping.masterOffsetMs - mapping.masterOffsetMs) > 25) this.reset({ keepQueue: true });
    this.clockMapping = { ...mapping };
    this.pump();
  }

  setLocalTrimMs(value) {
    if (!Number.isFinite(value)) return;
    this.localTrimMs = Math.max(-200, Math.min(200, value));
    this.pump();
  }

  fadeAndStop() {
    const now = this.context.currentTime;
    this.output.gain.cancelScheduledValues(now);
    this.output.gain.setValueAtTime(this.output.gain.value, now);
    this.output.gain.linearRampToValueAtTime(0, now + 0.012);
    for (const source of this.sources) {
      try { source.stop(now + 0.015); } catch {}
    }
    this.sources.clear();
  }

  reset({ countUnderrun = false, keepQueue = false } = {}) {
    if (countUnderrun && this.started) this.underruns += 1;
    this.fadeAndStop();
    this.started = false;
    this.tailFade = false;
    this.nextTime = 0;
    this.lastSequence = null;
    this.lastSourceFrameEnd = null;
    this.lastScheduledSourceFrameEnd = null;
    this.inputPeak = 0;
    if (!keepQueue) {
      this.droppedFrames += this.queuedFrames;
      this.queuedFrames = 0;
      this.queue = [];
    }
  }

  pump() {
    if (this.closed || !this.sampleRate) return;
    if (this.context.state !== "running") {
      if (this.started) this.reset();
      return;
    }
    const now = this.context.currentTime;
    const segmentFrames = Math.max(1, Math.round(this.sampleRate * 0.1));
    if (this.protocol === 2) {
      this.pumpCommonTimeline();
      this.forecastTailFade(segmentFrames, now);
      return;
    }
    if (this.started && this.nextTime < now + 0.008) {
      this.reset({ countUnderrun: true, keepQueue: true });
    }
    if (!this.started) {
      if (this.queuedFrames < Math.ceil(this.sampleRate * this.bufferMs / 1000)) return;
      this.started = true;
      this.nextTime = now + 0.04;
      this.output.gain.cancelScheduledValues(now);
      this.output.gain.setValueAtTime(0, this.nextTime);
      this.output.gain.linearRampToValueAtTime(1, this.nextTime + 0.015);
    }
    if (this.tailFade && this.queuedFrames >= segmentFrames) {
      this.output.gain.cancelScheduledValues(now);
      this.output.gain.setValueAtTime(this.output.gain.value, now);
      this.output.gain.linearRampToValueAtTime(1, now + 0.01);
      this.tailFade = false;
    }
    while (this.nextTime < now + 0.15 && this.queuedFrames >= segmentFrames) {
      const buffer = this.takeBuffer(segmentFrames);
      const errorMs = this.getStats().queueMs + 100 - this.bufferMs;
      this.rate = Math.max(0.997, Math.min(1.003, 1 + errorMs * 0.00001));
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = this.rate;
      source.connect(this.output);
      source.onended = () => {
        this.sources.delete(source);
        try { source.disconnect(); } catch {}
      };
      this.sources.add(source);
      source.start(this.nextTime);
      this.nextTime += buffer.duration / this.rate;
    }
    this.forecastTailFade(segmentFrames, now);
  }

  takeBuffer(frameCount) {
    const buffer = this.context.createBuffer(this.channels, frameCount, this.sampleRate);
    const output = Array.from({ length: this.channels }, (_, channel) => buffer.getChannelData(channel));
    let written = 0;
    while (written < frameCount) {
      const head = this.queue[0];
      const count = Math.min(frameCount - written, head.frames - head.offset);
      for (let channel = 0; channel < this.channels; channel += 1) {
        for (let frame = 0; frame < count; frame += 1) output[channel][written + frame] = head.samples[(head.offset + frame) * this.channels + channel];
      }
      head.offset += count;
      this.queuedFrames -= count;
      written += count;
      if (head.offset === head.frames) this.queue.shift();
    }
    return buffer;
  }

  forecastTailFade(segmentFrames, now) {
    if (this.started && this.queuedFrames < segmentFrames && this.nextTime > now + 0.02 && !this.tailFade) {
      // Forecast starvation while the final scheduled block still has time to
      // fade. Fresh packets cancel this fade before it becomes audible.
      this.output.gain.setValueAtTime(1, Math.max(now, this.nextTime - 0.015));
      this.output.gain.linearRampToValueAtTime(0, this.nextTime);
      this.tailFade = true;
    }
  }

  pumpCommonTimeline() {
    const now = this.context.currentTime;
    const performanceMs = this.performanceNow();
    if (!this.clockMapping || (Number.isFinite(this.clockMapping.updatedClientMs)
        && performanceMs - this.clockMapping.updatedClientMs > 45000)) {
      this.clockMethod = "waiting-for-clock";
      if (this.started) this.reset({ keepQueue: true });
      return;
    }
    const segmentFrames = Math.max(1, Math.round(this.sampleRate * 0.1));
    if (this.started && this.nextTime < now + 0.008) this.reset({ countUnderrun: true, keepQueue: true });
    while (this.queue.length) {
      const head = this.queue[0];
      const sourceFrame = head.sourceFrame + head.offset;
      const targetMasterMs = head.captureMasterMs + head.offset / this.sampleRate * 1000 + head.presentationDelayMs + this.localTrimMs;
      const mapped = masterToAudioContextTime(this.context, targetMasterMs, this.clockMapping, performanceMs);
      this.clockMethod = mapped.method;
      const desired = mapped.contextTime;
      if (desired < now + 0.02) {
        const dropped = head.frames - head.offset;
        this.queue.shift(); this.queuedFrames -= dropped; this.droppedFrames += dropped; this.lateDrops += 1;
        if (this.started) this.reset({ keepQueue: true });
        continue;
      }
      if (desired > now + 0.15 || this.queuedFrames < segmentFrames) return;
      let start = desired;
      if (this.started) {
        const errorMs = (this.nextTime - desired) * 1000;
        if (Math.abs(errorMs) > 40 || this.lastScheduledSourceFrameEnd !== sourceFrame) {
          this.reset({ keepQueue: true });
        } else start = this.nextTime;
      }
      const errorMs = (start - desired) * 1000;
      const rate = Math.max(0.997, Math.min(1.003, 1 + errorMs * 0.0001));
      if (start + segmentFrames / this.sampleRate / rate > now + 0.252) return;
      if (!this.started) {
        this.started = true;
        this.output.gain.cancelScheduledValues(now);
        this.output.gain.setValueAtTime(0, start);
        this.output.gain.linearRampToValueAtTime(1, start + 0.015);
      } else if (this.tailFade) {
        this.output.gain.cancelScheduledValues(now);
        this.output.gain.setValueAtTime(this.output.gain.value, now);
        this.output.gain.linearRampToValueAtTime(1, now + 0.01);
      }
      this.tailFade = false;
      this.timingErrorMs = errorMs;
      this.rate = rate;
      const buffer = this.takeBuffer(segmentFrames);
      const source = this.context.createBufferSource();
      source.buffer = buffer; source.playbackRate.value = rate; source.connect(this.output);
      source.onended = () => { this.sources.delete(source); try { source.disconnect(); } catch {} };
      this.sources.add(source);
      source.start(start);
      this.nextTime = start + buffer.duration / rate;
      this.lastScheduledSourceFrameEnd = sourceFrame + segmentFrames;
      this.onSchedule?.({ streamId: this.streamId, sourceFrame, startContextTime: start, desiredContextTime: desired, targetMasterMs, rate, clockMethod: mapped.method });
    }
  }

  getStats() {
    const scheduledMs = this.started ? Math.max(0, this.nextTime - this.context.currentTime) * 1000 : 0;
    return {
      queueMs: Math.round((this.sampleRate ? this.queuedFrames / this.sampleRate * 1000 : 0) + scheduledMs),
      underruns: this.underruns,
      droppedMs: this.sampleRate ? Math.round(this.droppedFrames / this.sampleRate * 1000) : 0,
      discontinuities: this.discontinuities,
      inputPeak: this.inputPeak,
      playing: this.started && this.context.state === "running" && scheduledMs > 0,
      rate: this.rate,
      syncMode: this.protocol === 2 ? (this.clockMethod === "waiting-for-clock" ? "waiting-for-clock" : "common-timeline") : this.protocol === 1 ? "legacy-buffer" : "waiting-for-stream",
      timingErrorMs: this.timingErrorMs === null ? null : Math.round(this.timingErrorMs * 100) / 100,
      lateDrops: this.lateDrops,
      clockRTT: this.clockMapping?.roundTripMs ?? null,
      targetDelay: this.presentationDelayMs,
      localTrimMs: this.localTrimMs,
      clockMethod: this.clockMethod
    };
  }

  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.reset();
  }
}
