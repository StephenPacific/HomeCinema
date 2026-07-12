import { Copy, Pause, Play, Radio, RefreshCw, RotateCw, Square, Upload, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { configurePlaybackAudioSession, readAudioSession } from "./audioSession.js";
import {
  captureRtcSnapshot,
  DEVICE_HEALTH_POLICY,
  fastFuseReason,
  rtcWindowMetrics
} from "./deviceHealth.js";
import {
  expectedLivePositionSeconds,
  LIVE_SYNC_POLICY,
  liveDriftCorrection,
  liveStartLocalMs,
  setWebRtcJitterBufferTarget,
  shouldStartLiveBuffer,
  WEBRTC_SYNC_POLICY,
  webRtcPlayoutDelaySample
} from "./liveSync.js";
import { createQrMatrix } from "./qr.js";
import { speakerJoinAddressCandidates } from "./networkAddresses.js";
import {
  fixedPostDelayMs,
  fixedTimelineErrorMs,
  nextFixedTimelineGuard,
  nextPostDelayCorrection,
  roomCorrectionPlan,
  roomGuardError,
  ROOM_SYNC_ENGINE_VERSION,
  ROOM_SYNC_POLICY
} from "./roomSync.js";
import { isLoopbackHost, resolvePageRole } from "./pageRole.js";
import { controllerAudioHealth } from "./controllerMetrics.js";

const EMPTY_STATE = {
  track: null,
  layers: [],
  live: null,
  roomVolume: 1,
  playing: false,
  position: 0,
  startedAt: null,
  currentPosition: 0,
  leadMs: 3000
};

const zones = [
  ["front-left", "FL"],
  ["front-right", "FR"],
  ["center", "C"],
  ["rear-left", "RL"],
  ["rear-right", "RR"]
];

const zoneNames = {
  "front-left": "Front Left",
  "front-right": "Front Right",
  center: "Center",
  "rear-left": "Rear Left",
  "rear-right": "Rear Right"
};

export default function App() {
  const roleState = useMemo(
    () => resolvePageRole({ search: location.search, hostname: location.hostname }),
    []
  );
  const isPlayerView = roleState === "speaker";
  const [connected, setConnected] = useState(false);
  const [serverState, setServerState] = useState(EMPTY_STATE);
  const [peers, setPeers] = useState([]);
  const [roomDiagnosticState, setRoomDiagnosticState] = useState(null);
  const [incidentLogState, setIncidentLogState] = useState([]);
  const [joinOptions, setJoinOptions] = useState([]);
  const [selectedJoinUrl, setSelectedJoinUrl] = useState("");
  const [controllerMonitorOpen, setControllerMonitorOpen] = useState(true);
  const [deviceNameState, setDeviceNameState] = useState(currentDeviceName);
  const [selectedLayerIdState, setSelectedLayerIdState] = useState(() => localStorage.getItem("selectedLayerId"));
  const [selectedZoneState, setSelectedZoneState] = useState(() => localStorage.getItem("selectedZone") || "front-left");
  const [deviceOffsetState, setDeviceOffsetState] = useState(() => Number(localStorage.getItem("deviceOffsetMs") || 0));
  const [serverOffsetState, setServerOffsetState] = useState(0);
  const [latencyState, setLatencyState] = useState(0);
  const [leadState, setLeadState] = useState(3000);
  const [readyStatus, setReadyStatus] = useState("Locked");
  const [audioReadyState, setAudioReadyState] = useState(false);
  const [audioLoading, setAudioLoading] = useState(false);
  const [unlockedState, setUnlockedState] = useState(false);
  const [remoteMutedState, setRemoteMutedState] = useState(false);
  const [audioContextState, setAudioContextState] = useState("none");
  const [audioSessionInfoState, setAudioSessionInfoState] = useState(readAudioSession);
  const [playbackEngineState, setPlaybackEngineState] = useState("Web Audio");
  const [audioIssueState, setAudioIssueState] = useState("");
  const [webAudioTestState, setWebAudioTestState] = useState("Not tested");
  const [driftState, setDriftState] = useState(null);
  const [correctionCountState, setCorrectionCountState] = useState(0);
  const [lastCorrectionState, setLastCorrectionState] = useState("--");
  const [lastStartDelayState, setLastStartDelayState] = useState(null);
  const [outputLatencyState, setOutputLatencyState] = useState(null);
  const [rtcJitterState, setRtcJitterState] = useState(null);
  const [rtcPlayoutDelayState, setRtcPlayoutDelayState] = useState(null);
  const [rtcPostDelayState, setRtcPostDelayState] = useState(null);
  const [rtcPacketsLostState, setRtcPacketsLostState] = useState(0);
  const [rtcConcealedState, setRtcConcealedState] = useState(0);
  const [liveOutputPathState, setLiveOutputPathState] = useState("Idle");
  const [durationState, setDurationState] = useState(0);
  const [positionState, setPositionState] = useState(0);
  const [countdownState, setCountdownState] = useState(null);
  const [uploadText, setUploadText] = useState("Choose stems");
  const deviceInfo = useMemo(detectDeviceInfo, []);

  const socketRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const statusTimerRef = useRef(null);
  const clientIdRef = useRef(null);
  const stateRef = useRef(EMPTY_STATE);
  const roleRef = useRef(roleState);
  const deviceNameRef = useRef(deviceNameState);
  const selectedLayerIdRef = useRef(selectedLayerIdState);
  const selectedZoneRef = useRef(selectedZoneState);
  const deviceOffsetRef = useRef(deviceOffsetState);
  const serverOffsetRef = useRef(serverOffsetState);
  const latencyRef = useRef(latencyState);
  const outputLatencyRef = useRef(0);
  const syncErrorRef = useRef(null);
  const rtcPlayoutDelayRef = useRef(null);
  const rtcPostDelayRef = useRef(0);
  const clockSamplesRef = useRef([]);
  const unlockedRef = useRef(unlockedState);
  const readyStatusRef = useRef(readyStatus);
  const remoteMutedRef = useRef(false);
  const outputVolumeRef = useRef(1);
  const audioReadyRef = useRef(audioReadyState);
  const audioContextRef = useRef(null);
  const audioSessionInfoRef = useRef(audioSessionInfoState);
  const gainRef = useRef(null);
  const liveMediaSourceNodeRef = useRef(null);
  const liveStreamSourceNodeRef = useRef(null);
  const liveDelayRef = useRef(null);
  const liveGainRef = useRef(null);
  const liveOutputModeRef = useRef("none");
  const liveElementVolumeTimerRef = useRef(null);
  const rtcBytesReceivedRef = useRef(0);
  const rtcEmittedCountRef = useRef(0);
  const rtcAudioLevelRef = useRef(null);
  const rtcJitterRef = useRef(null);
  const rtcPacketsReceivedRef = useRef(0);
  const rtcPacketsLostRef = useRef(0);
  const rtcConcealedRef = useRef(0);
  const rtcTotalSamplesRef = useRef(0);
  const rtcPacketLossRateRef = useRef(null);
  const rtcConcealmentRateRef = useRef(null);
  const rtcRtpStallRef = useRef(0);
  const rtcConnectionStateRef = useRef("idle");
  const rawSyncErrorRef = useRef(null);
  const outputLatencyDeltaRef = useRef(0);
  const fastFuseReasonRef = useRef("");
  const audioBufferRef = useRef(null);
  const sourceRef = useRef(null);
  const activeSourcesRef = useRef(new Set());
  const mediaAudioRef = useRef(null);
  const liveAudioRef = useRef(null);
  const liveSessionRef = useRef(null);
  const flushLiveQueueRef = useRef(() => {});
  const appendLiveChunkRef = useRef(() => {});
  const mediaPlaybackTimerRef = useRef(null);
  const playbackEngineRef = useRef("web-audio");
  const lastMediaCorrectionRef = useRef(0);
  const correctionCountRef = useRef(0);
  const silentAudioUrlRef = useRef(null);
  const beepAudioUrlRef = useRef(null);
  const localPlaybackRef = useRef(null);
  const currentLayerIdRef = useRef(null);
  const currentLayerVersionRef = useRef(null);
  const loadingLayerKeyRef = useRef(null);
  const unlockingRef = useRef(false);
  const shuttingDownRef = useRef(false);
  const seekingRef = useRef(false);
  const pendingSeekRef = useRef(0);
  const handleMessageRef = useRef(null);
  const deviceCommandRef = useRef(null);

  const layers = serverState.layers || [];
  const selectedLayer = layerById(layers, selectedLayerIdState) || layers[0] || null;
  const liveActive = Boolean(serverState.live?.id);
  const speakerPeers = peers.filter((peer) => peer.role === "speaker");
  const capturePeer = peers.find((peer) => peer.role === "capture") || null;
  const monitoredPeers = [capturePeer, ...speakerPeers].filter(Boolean);
  const controllerMetrics = capturePeer?.controllerAudioMetrics || null;
  const controllerOutputHealth = controllerAudioHealth(controllerMetrics);
  const speakerCount = speakerPeers.length;
  const activeSpeakerCount = speakerPeers.filter((peer) => peer.ready && !peer.muted).length;
  const stoppedSpeakerCount = speakerPeers.filter((peer) => peer.muted).length;
  const issueSpeakerCount = speakerPeers.filter((peer) =>
    ["failed", "needs-action"].includes(peer.health) ||
    ["warning", "critical", "repairing"].includes(peer.diagnostic?.overall?.state)
  ).length;
  const retryableSpeakerCount = speakerPeers.filter((peer) => peer.health === "failed").length;
  const allSpeakersMuted = speakerCount > 0 && stoppedSpeakerCount === speakerCount;
  const livePhase = serverState.live?.phase || (liveActive ? "playing" : "idle");
  const livePlaying = livePhase === "playing";
  const stableSpeakerCount = Number(serverState.live?.stableSpeakers || 0);
  const requiredSpeakerCount = Number(serverState.live?.requiredSpeakers || 0);
  const roomTargetMs = Number(serverState.live?.roomTargetMs || 0);
  const roomVolume = clamp(Number(serverState.roomVolume ?? 1), 0, 1);
  const livePhaseProgress = clamp(Number(serverState.live?.phaseProgress || 0), 0, 100);
  const livePhaseSampleCount = Number(serverState.live?.phaseSampleCount || 0);
  const livePhaseSampleTarget = Number(serverState.live?.phaseSampleTarget || ROOM_SYNC_POLICY.sampleWindow);
  const livePhaseElapsedMs = Number(serverState.live?.phaseElapsedMs || 0);
  const livePhaseTimeoutMs = Number(serverState.live?.phaseTimeoutMs || 0);
  const livePhaseBlocked = Boolean(serverState.live?.phaseBlocked);
  const liveLockAttempt = Number(serverState.live?.lockAttempt || 0);
  const maximumLiveLockAttempts = Number(serverState.live?.maximumLockAttempts || ROOM_SYNC_POLICY.maximumLockAttempts);
  const livePhaseLabel = {
    measuring: "Measuring",
    locking: "Locking",
    armed: "Armed",
    playing: "Playing"
  }[livePhase] || "Active";
  const trackLabel = liveActive
    ? serverState.live.name
    : layers.length > 1
      ? `${layers.length} stems`
      : serverState.track?.name || "No track loaded";
  const syncLabel = liveActive
    ? serverState.live.transport === "webrtc"
      ? livePhase === "measuring"
        ? `WebRTC / Opus - measuring ${stableSpeakerCount}/${requiredSpeakerCount}`
        : livePhase === "locking"
          ? `Locking fixed timeline - ${roomTargetMs || "--"} ms`
          : `Fixed room timeline - ${roomTargetMs || serverState.live.bufferMs || 120} ms`
      : `Live tab audio - ${serverState.live.mimeType}`
    : buildSyncLabel({
        layers,
        selectedLayer,
        state: serverState,
        audioReady: audioReadyState,
        audioLoading,
        countdown: countdownState
      });

  useEffect(() => {
    document.body.classList.toggle("player-view", isPlayerView);
    return () => document.body.classList.remove("player-view");
  }, [isPlayerView]);

  useEffect(() => {
    document.body.dataset.role = roleState;
  }, [roleState]);

  const applyPlaybackAudioSession = useCallback(() => {
    const nextInfo = configurePlaybackAudioSession();
    audioSessionInfoRef.current = nextInfo;
    setAudioSessionInfoState(nextInfo);
    return nextInfo;
  }, []);

  const send = useCallback((message) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(message));
    }
  }, []);

  const reportStatusNow = useCallback(() => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return;
    const state = stateRef.current;
    const layer = layerById(state.layers || [], selectedLayerIdRef.current) || state.layers?.[0] || null;
    const liveAudio = liveAudioRef.current;
    const liveSession = liveSessionRef.current;
    const audioContextState = audioContextRef.current?.state || "none";
    const liveOutputMode = liveOutputModeRef.current;
    const speakerNeedsTap = Boolean(
      roleRef.current === "speaker" &&
      liveSession?.phase === "playing" &&
      rtcBytesReceivedRef.current > 0 &&
      (
        (liveOutputMode.endsWith("source") && audioContextState !== "running") ||
        (liveOutputMode === "none" && ["suspended", "interrupted", "closed"].includes(audioContextState))
      )
    );
    const health = speakerNeedsTap ? "needs-action" : deriveDeviceHealth({
      role: roleRef.current,
      status: readyStatusRef.current,
      muted: remoteMutedRef.current,
      unlocked: unlockedRef.current,
      live: Boolean(state.live?.id),
      hasLayer: Boolean(layer),
      audioReady: audioReadyRef.current
    });
    outputLatencyRef.current = Math.round(estimateOutputLatencySeconds(audioContextRef.current) * 1000);
    const timelineState = !liveSession
      ? "idle"
      : liveSession.timelineGuard?.quarantined || liveSession.rejoining
        ? "recovering"
        : liveSession.audible
          ? "locked"
          : liveSession.phase || "measuring";
    send({
      type: "identify",
      role: roleRef.current,
      name: deviceNameRef.current,
      deviceKey: currentDeviceKey(),
      layerId: selectedLayerIdRef.current,
      zone: selectedZoneRef.current,
      ready: roleRef.current === "controller" || health === "ready",
      unlocked: roleRef.current === "controller" || (!speakerNeedsTap && unlockedRef.current),
      muted: remoteMutedRef.current,
      health,
      status: speakerNeedsTap ? "Tap Enable speaker on this device" : readyStatusRef.current,
      syncErrorMs: syncErrorRef.current,
      playoutDelayMs: rtcPlayoutDelayRef.current,
      postDelayMs: rtcPostDelayRef.current,
      latencyMs: Math.round(latencyRef.current || 0),
      outputLatencyMs: outputLatencyRef.current,
      deviceOffsetMs: deviceOffsetRef.current,
      audioContextState,
      audioSessionType: audioSessionInfoRef.current.type,
      audioSessionState: audioSessionInfoRef.current.state,
      outputPath: liveOutputModeRef.current,
      livePaused: Boolean(liveAudio?.paused),
      liveMuted: Boolean(liveAudio?.muted),
      liveReadyState: Number(liveAudio?.readyState || 0),
      rtcBytesReceived: rtcBytesReceivedRef.current,
      rtcEmittedCount: rtcEmittedCountRef.current,
      rtcAudioLevel: rtcAudioLevelRef.current,
      rtcJitterMs: rtcJitterRef.current,
      rtcPacketsReceived: rtcPacketsReceivedRef.current,
      rtcPacketsLost: rtcPacketsLostRef.current,
      rtcConcealedSamples: rtcConcealedRef.current,
      rtcTotalSamplesReceived: rtcTotalSamplesRef.current,
      rtcPacketLossRate: rtcPacketLossRateRef.current,
      rtcConcealmentRate: rtcConcealmentRateRef.current,
      rtcRtpStallMs: rtcRtpStallRef.current,
      rtcConnectionState: rtcConnectionStateRef.current,
      rawSyncErrorMs: rawSyncErrorRef.current,
      outputLatencyDeltaMs: outputLatencyDeltaRef.current,
      fastFuseReason: fastFuseReasonRef.current,
      timelineState,
      syncEngineVersion: ROOM_SYNC_ENGINE_VERSION
    });
  }, [send]);

  const reportStatusSoon = useCallback(() => {
    clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(reportStatusNow, 120);
  }, [reportStatusNow]);

  useEffect(() => {
    if (!isPlayerView) return undefined;
    const audioSession = globalThis.navigator?.audioSession;
    const updateAudioSession = () => {
      applyPlaybackAudioSession();
      reportStatusSoon();
    };

    updateAudioSession();
    audioSession?.addEventListener?.("statechange", updateAudioSession);
    return () => audioSession?.removeEventListener?.("statechange", updateAudioSession);
  }, [applyPlaybackAudioSession, isPlayerView, reportStatusSoon]);

  useEffect(() => {
    readyStatusRef.current = readyStatus;
    reportStatusSoon();
  }, [readyStatus, reportStatusSoon]);

  const setSelectedLayerId = useCallback(
    (layerId) => {
      selectedLayerIdRef.current = layerId;
      setSelectedLayerIdState(layerId);
      if (layerId) localStorage.setItem("selectedLayerId", layerId);
      else localStorage.removeItem("selectedLayerId");
      reportStatusSoon();
    },
    [reportStatusSoon]
  );

  const ensureSelectedLayer = useCallback(
    (nextState) => {
      const nextLayers = nextState?.layers || [];
      if (!nextLayers.length) {
        if (selectedLayerIdRef.current) setSelectedLayerId(null);
        return null;
      }
      const existing = nextLayers.find((layer) => layer.id === selectedLayerIdRef.current);
      if (existing) return existing;
      setSelectedLayerId(nextLayers[0].id);
      return nextLayers[0];
    },
    [setSelectedLayerId]
  );

  const ensureLiveAudioOutput = useCallback((audioContext, liveAudio) => {
    if (!audioContext || !liveAudio) return null;
    if (liveGainRef.current && liveDelayRef.current) {
      liveOutputModeRef.current = "media-element-source";
      setLiveOutputPathState("Web Audio media output");
      return liveGainRef.current;
    }

    try {
      liveAudio.muted = false;
      liveAudio.volume = 1;
      const source = audioContext.createMediaElementSource(liveAudio);
      const delay = audioContext.createDelay(1.1);
      const gain = audioContext.createGain();
      delay.delayTime.value = 0;
      gain.gain.value = 0;
      source.connect(delay).connect(gain).connect(audioContext.destination);
      liveMediaSourceNodeRef.current = source;
      liveDelayRef.current = delay;
      liveGainRef.current = gain;
      liveOutputModeRef.current = "media-element-source";
      setLiveOutputPathState("Web Audio media output");
      return gain;
    } catch {
      return null;
    }
  }, []);

  const ensureLiveStreamOutput = useCallback((audioContext, stream) => {
    if (!audioContext || !stream || typeof audioContext.createMediaStreamSource !== "function") return null;
    if (liveStreamSourceNodeRef.current && liveDelayRef.current && liveGainRef.current) return liveGainRef.current;

    try {
      const source = audioContext.createMediaStreamSource(stream);
      const delay = audioContext.createDelay(1.1);
      const gain = audioContext.createGain();
      delay.delayTime.value = 0;
      gain.gain.value = 0;
      source.connect(delay).connect(gain).connect(audioContext.destination);
      liveStreamSourceNodeRef.current = source;
      liveDelayRef.current = delay;
      liveGainRef.current = gain;
      liveOutputModeRef.current = "webrtc-stream-source";
      setLiveOutputPathState("WebRTC through Web Audio");
      return gain;
    } catch {
      return null;
    }
  }, []);

  const setLivePostDelay = useCallback((delayMs, session = liveSessionRef.current) => {
    const audioContext = audioContextRef.current;
    const delay = liveDelayRef.current;
    if (!audioContext || !delay) return null;
    const nextDelayMs = clamp(Number(delayMs) || 0, 0, 1000);
    const now = audioContext.currentTime;
    delay.delayTime.cancelScheduledValues(now);
    delay.delayTime.setValueAtTime(nextDelayMs / 1000, now);
    rtcPostDelayRef.current = Math.round(nextDelayMs);
    setRtcPostDelayState(rtcPostDelayRef.current);
    if (session) session.postDelayMs = nextDelayMs;
    return nextDelayMs;
  }, []);

  const rampLivePostDelay = useCallback((delayMs, durationSeconds, session = liveSessionRef.current) => {
    const audioContext = audioContextRef.current;
    const delay = liveDelayRef.current;
    if (!audioContext || !delay) return null;
    const nextDelayMs = clamp(Number(delayMs) || 0, 0, 1000);
    const duration = clamp(Number(durationSeconds) || 0, 0, 4);
    const now = audioContext.currentTime;
    const parameter = delay.delayTime;
    if (typeof parameter.cancelAndHoldAtTime === "function") {
      parameter.cancelAndHoldAtTime(now);
    } else {
      const currentValue = parameter.value;
      parameter.cancelScheduledValues(now);
      parameter.setValueAtTime(currentValue, now);
    }
    if (duration <= 0) parameter.setValueAtTime(nextDelayMs / 1000, now);
    else parameter.linearRampToValueAtTime(nextDelayMs / 1000, now + duration);
    rtcPostDelayRef.current = Math.round(nextDelayMs);
    setRtcPostDelayState(rtcPostDelayRef.current);
    if (session) session.postDelayMs = nextDelayMs;
    return nextDelayMs;
  }, []);

  const releaseLiveStreamOutput = useCallback(() => {
    if (!liveStreamSourceNodeRef.current) return;
    try {
      liveStreamSourceNodeRef.current.disconnect();
      liveDelayRef.current?.disconnect();
      liveGainRef.current?.disconnect();
    } catch {}
    liveStreamSourceNodeRef.current = null;
    liveDelayRef.current = null;
    liveGainRef.current = null;
  }, []);

  const rampLiveOutput = useCallback((target, durationSeconds = 0.025) => {
    const nextTarget = clamp(Number(target) || 0, 0, 1);
    const audioContext = audioContextRef.current;
    const gain = liveGainRef.current;
    clearInterval(liveElementVolumeTimerRef.current);
    liveElementVolumeTimerRef.current = null;
    if (!audioContext || !gain) {
      const liveAudio = liveAudioRef.current;
      if (!liveAudio) return;
      const durationMs = Math.max(0, Number(durationSeconds) || 0) * 1000;
      if (durationMs <= 0) {
        liveAudio.volume = nextTarget;
        liveAudio.muted = nextTarget <= 0.001;
        return;
      }

      const initialVolume = liveAudio.muted ? 0 : clamp(Number(liveAudio.volume) || 0, 0, 1);
      const startedAt = Date.now();
      if (nextTarget > 0.001) liveAudio.muted = false;
      liveElementVolumeTimerRef.current = setInterval(() => {
        const progress = clamp((Date.now() - startedAt) / durationMs, 0, 1);
        liveAudio.volume = initialVolume + (nextTarget - initialVolume) * progress;
        if (progress < 1) return;
        clearInterval(liveElementVolumeTimerRef.current);
        liveElementVolumeTimerRef.current = null;
        liveAudio.volume = nextTarget;
        liveAudio.muted = nextTarget <= 0.001;
      }, 20);
      return;
    }

    const now = audioContext.currentTime;
    const parameter = gain.gain;
    if (typeof parameter.cancelAndHoldAtTime === "function") {
      parameter.cancelAndHoldAtTime(now);
    } else {
      const currentValue = parameter.value;
      parameter.cancelScheduledValues(now);
      parameter.setValueAtTime(currentValue, now);
    }
    if (durationSeconds <= 0) parameter.setValueAtTime(nextTarget, now);
    else parameter.linearRampToValueAtTime(nextTarget, now + durationSeconds);
  }, []);

  const restoreLiveOutput = useCallback(
    (durationSeconds = 0.025) => {
      rampLiveOutput(remoteMutedRef.current ? 0 : outputVolumeRef.current, durationSeconds);
    },
    [rampLiveOutput]
  );

  const scheduleLiveOutputAt = useCallback((targetEpochMs, fadeSeconds = ROOM_SYNC_POLICY.startFadeSeconds) => {
    const audioContext = audioContextRef.current;
    const gain = liveGainRef.current;
    const liveAudio = liveAudioRef.current;
    clearInterval(liveElementVolumeTimerRef.current);
    liveElementVolumeTimerRef.current = null;
    if (!audioContext || !gain) {
      if (!liveAudio) return null;
      liveAudio.muted = true;
      liveAudio.volume = 0;
      return setTimeout(() => {
        const muted = remoteMutedRef.current;
        if (muted) {
          rampLiveOutput(0, 0);
          return;
        }
        liveAudio.muted = false;
        liveAudio.volume = 0;
        if (liveAudio.paused) {
          const playPromise = liveAudio.play();
          if (playPromise?.catch) playPromise.catch(() => {});
        }
        rampLiveOutput(outputVolumeRef.current, fadeSeconds);
      }, Math.max(0, targetEpochMs - Date.now()));
    }

    const now = audioContext.currentTime;
    const startAt = Math.max(now, contextTimeForAudibleEpoch(audioContext, targetEpochMs));
    const parameter = gain.gain;
    parameter.cancelScheduledValues(now);
    parameter.setValueAtTime(0, now);
    parameter.setValueAtTime(0, startAt);
    parameter.linearRampToValueAtTime(remoteMutedRef.current ? 0 : outputVolumeRef.current, startAt + fadeSeconds);
    return null;
  }, [rampLiveOutput]);

  const quarantineWebRtcOutput = useCallback(
    (session, status = "Recovering synchronization", fadeSeconds = ROOM_SYNC_POLICY.quarantineFadeSeconds) => {
      if (!session || session.closed) return;
      clearTimeout(session.volumeTimer);
      clearTimeout(session.joinTimer);
      clearTimeout(session.fadeTimer);
      clearInterval(session.countdownTimer);
      session.volumeTimer = null;
      session.joinTimer = null;
      session.countdownTimer = null;
      session.startScheduled = false;
      session.audible = false;
      session.rejoining = false;
      session.timelineGuard = {
        quarantined: true,
        violationCount: session.timelineGuard?.violationCount || 0,
        recoveryCount: 0
      };
      rampLiveOutput(0, fadeSeconds);
      setReadyStatus(status);
      reportStatusSoon();
    },
    [rampLiveOutput, reportStatusSoon]
  );

  const scheduleWebRtcOutputAt = useCallback(
    (session, targetLocalMs, label = "WebRTC starts", fadeSeconds = ROOM_SYNC_POLICY.startFadeSeconds) => {
      if (!session || session.closed || !session.outputReady || session.startScheduled) return false;
      if (!Number.isFinite(targetLocalMs) || targetLocalMs <= Date.now() + 80) return false;

      const outputFadeSeconds = clamp(Number(fadeSeconds) || 0, 0.02, 2);
      clearTimeout(session.volumeTimer);
      clearTimeout(session.joinTimer);
      clearTimeout(session.fadeTimer);
      clearInterval(session.countdownTimer);
      session.startScheduled = true;
      session.unmuteAtLocalMs = targetLocalMs;
      session.outputFadeSeconds = outputFadeSeconds;
      session.volumeTimer = scheduleLiveOutputAt(targetLocalMs, outputFadeSeconds);

      const updateCountdown = () => {
        if (liveSessionRef.current !== session || session.closed) return;
        const remainingMs = targetLocalMs - Date.now();
        if (remainingMs > 0) {
          setReadyStatus(
            remoteMutedRef.current
              ? "Stopped by controller"
              : `${label} in ${Math.max(1, Math.ceil(remainingMs / 1000))}`
          );
          return;
        }
        if (!session.startScheduled) return;

        clearInterval(session.countdownTimer);
        session.countdownTimer = null;
        clearTimeout(session.joinTimer);
        session.joinTimer = null;
        session.startScheduled = false;
        const usesContextOutput = liveOutputModeRef.current.endsWith("source");
        const outputBlocked = usesContextOutput
          ? audioContextRef.current?.state !== "running"
          : Boolean(liveAudioRef.current?.paused);
        if (!remoteMutedRef.current && outputBlocked) {
          unlockedRef.current = false;
          setUnlockedState(false);
          setReadyStatus("Tap to resume audio");
        } else {
          session.audible = !remoteMutedRef.current;
          if (session.rejoining && !remoteMutedRef.current) {
            setReadyStatus("Fading into synchronized playback");
            clearTimeout(session.fadeTimer);
            session.fadeTimer = setTimeout(() => {
              if (liveSessionRef.current !== session || session.closed) return;
              session.fadeTimer = null;
              session.rejoining = false;
              setReadyStatus(remoteMutedRef.current ? "Stopped by controller" : "Receiving WebRTC audio");
              reportStatusSoon();
            }, outputFadeSeconds * 1000);
          } else {
            session.rejoining = false;
            setReadyStatus(remoteMutedRef.current ? "Stopped by controller" : "Receiving WebRTC audio");
          }
        }
        reportStatusSoon();
      };

      updateCountdown();
      session.countdownTimer = setInterval(updateCountdown, 200);
      session.joinTimer = setTimeout(updateCountdown, Math.max(0, targetLocalMs - Date.now()) + 80);
      return true;
    },
    [reportStatusSoon, scheduleLiveOutputAt]
  );

  const lockWebRtcPostDelay = useCallback(
    (session) => {
      if (
        !session ||
        session.closed ||
        !["locking", "armed", "playing"].includes(session.phase) ||
        session.postDelayLocked ||
        !Number.isFinite(session.roomTargetMs) ||
        !Number.isFinite(session.measuredJitterDelayMs)
      ) return false;
      if (session.runtimeRelock && Date.now() < Number(session.relockDelayReadyAt || 0)) return false;

      const postDelayMs = fixedPostDelayMs({
        roomTargetMs: session.roomTargetMs,
        playoutDelayMs: session.measuredJitterDelayMs,
        outputLatencyMs: outputLatencyRef.current,
        deviceOffsetMs: deviceOffsetRef.current
      });
      if (!Number.isFinite(postDelayMs) || setLivePostDelay(postDelayMs, session) === null) return false;
      session.postDelayLocked = true;
      setLastCorrectionState(`Fixed compensation ${Math.round(postDelayMs)} ms`);
      reportStatusSoon();
      return true;
    },
    [reportStatusSoon, setLivePostDelay]
  );

  const updateWebRtcTimeline = useCallback(
    (live) => {
      const session = liveSessionRef.current;
      if (!session || session.closed || session.transport !== "webrtc" || session.id !== live?.id) return;
      const phase = live.phase || (Number.isFinite(Number(live.playAt)) ? "armed" : "measuring");
      const previousPhase = session.phase;
      const nextLockAttempt = Number(live.lockAttempt || 0);
      if (phase === "locking" && nextLockAttempt !== Number(session.lockAttempt || 0)) {
        session.lockAttempt = nextLockAttempt;
        session.postDelayLocked = false;
      }
      session.phase = phase;
      if (
        phase === "locking" &&
        !session.runtimeRelock &&
        session.timelineLocked &&
        (live.runtimeRelock || previousPhase === "playing")
      ) {
        session.runtimeRelock = true;
        session.relockDelayReadyAt = Date.now() + ROOM_SYNC_POLICY.quarantineFadeSeconds * 1000;
      }
      const playAt = Number(live.playAt);
      session.playAtServerMs = Number.isFinite(playAt) && playAt > 0 ? playAt : null;

      const roomTarget = Number(live.roomTargetMs);
      if (Number.isFinite(roomTarget) && roomTarget > 0) {
        session.roomTargetMs = roomTarget;
      }

      if (phase === "measuring" && !session.postDelayLocked) setLivePostDelay(0, session);
      if (phase === "locking" && !session.runtimeRelock) lockWebRtcPostDelay(session);

      if (session.outputReady && liveOutputModeRef.current === "html-media-element") {
        rampLiveOutput(0, 0);
        setReadyStatus("Fixed timeline unavailable");
        reportStatusSoon();
        return;
      }

      if (phase === "measuring" || phase === "locking") {
        if (phase === "locking" && session.runtimeRelock) {
          if (!session.timelineGuard?.quarantined) {
            quarantineWebRtcOutput(session, "Room timing shifted; relocking");
          }
        } else {
          rampLiveOutput(0, 0);
        }
        setReadyStatus(
          session.outputReady
            ? phase === "locking"
              ? session.runtimeRelock ? "Room timing shifted; relocking" : "Locking fixed room timeline"
              : "Measuring room timing"
            : "Connecting WebRTC audio"
        );
        reportStatusSoon();
        return;
      }

      if (session.runtimeRelock && ["armed", "playing"].includes(phase)) {
        const participants = Array.isArray(live.participantIds) ? live.participantIds : [];
        session.initialParticipant = participants.length ? participants.includes(clientIdRef.current) : true;
        session.timelineGuard = {
          quarantined: !session.initialParticipant,
          violationCount: 0,
          recoveryCount: 0
        };
        session.runtimeRelock = false;
        session.relockDelayReadyAt = null;
        session.rejoining = false;
        session.audible = false;
        session.startScheduled = false;
        session.fastFuseReason = null;
        fastFuseReasonRef.current = "";
        session.nextStartFadeSeconds = ROOM_SYNC_POLICY.rejoinFadeSeconds;
      }

      if (!session.timelineLocked) {
        const participants = Array.isArray(live.participantIds) ? live.participantIds : [];
        session.initialParticipant = participants.length ? participants.includes(clientIdRef.current) : true;
        session.timelineLocked = true;
        session.timelineGuard = {
          quarantined: !session.initialParticipant,
          violationCount: 0,
          recoveryCount: 0
        };
        if (!session.initialParticipant) {
          rampLiveOutput(0, 0);
          setReadyStatus("Synchronizing before join");
          reportStatusSoon();
          return;
        }
      }

      if (!session.initialParticipant || session.timelineGuard?.quarantined) return;
      if (session.audible || session.startScheduled || !session.outputReady) return;
      const targetLocalMs = session.playAtServerMs - serverOffsetRef.current;
      const startFadeSeconds = session.nextStartFadeSeconds || ROOM_SYNC_POLICY.startFadeSeconds;
      session.nextStartFadeSeconds = null;
      if (!scheduleWebRtcOutputAt(session, targetLocalMs, "WebRTC starts", startFadeSeconds)) {
        quarantineWebRtcOutput(session, "Missed start; synchronizing before join");
      }
    },
    [lockWebRtcPostDelay, quarantineWebRtcOutput, rampLiveOutput, reportStatusSoon, scheduleWebRtcOutputAt, setLivePostDelay]
  );

  const stopLocalSource = useCallback(() => {
    clearTimeout(mediaPlaybackTimerRef.current);
    mediaPlaybackTimerRef.current = null;
    const mediaAudio = mediaAudioRef.current;
    if (mediaAudio) {
      try {
        mediaAudio.pause();
        mediaAudio.playbackRate = 1;
      } catch {}
    }
    if (gainRef.current) {
      try {
        gainRef.current.gain.cancelScheduledValues(0);
        gainRef.current.gain.value = 0;
      } catch {}
    }
    for (const source of activeSourcesRef.current) {
      try {
        source.onended = null;
        source.stop();
        source.disconnect();
      } catch {}
    }
    activeSourcesRef.current.clear();
    sourceRef.current = null;
    localPlaybackRef.current = null;
  }, []);

  const stopLivePlayback = useCallback(() => {
    const session = liveSessionRef.current;
    if (session) {
      session.closed = true;
      clearTimeout(session.startTimer);
      clearTimeout(session.bufferTimer);
      clearTimeout(session.pauseTimer);
      clearTimeout(session.seekTimer);
      clearTimeout(session.joinTimer);
      clearTimeout(session.volumeTimer);
      clearTimeout(session.disconnectTimer);
      clearTimeout(session.fadeTimer);
      clearInterval(session.countdownTimer);
      clearInterval(session.statsTimer);
      try {
        session.peerConnection?.close();
      } catch {}
      try {
        if (session.mediaSource?.readyState === "open") session.mediaSource.endOfStream();
      } catch {}
      if (session.url) URL.revokeObjectURL(session.url);
    }
    clearInterval(liveElementVolumeTimerRef.current);
    liveElementVolumeTimerRef.current = null;
    liveSessionRef.current = null;
    syncErrorRef.current = null;
    rtcPlayoutDelayRef.current = null;
    setLivePostDelay(0, null);
    rtcPostDelayRef.current = 0;
    rtcBytesReceivedRef.current = 0;
    rtcEmittedCountRef.current = 0;
    rtcAudioLevelRef.current = null;
    rtcJitterRef.current = null;
    rtcPacketsReceivedRef.current = 0;
    rtcPacketsLostRef.current = 0;
    rtcConcealedRef.current = 0;
    rtcTotalSamplesRef.current = 0;
    rtcPacketLossRateRef.current = null;
    rtcConcealmentRateRef.current = null;
    rtcRtpStallRef.current = 0;
    rtcConnectionStateRef.current = "idle";
    rawSyncErrorRef.current = null;
    outputLatencyDeltaRef.current = 0;
    fastFuseReasonRef.current = "";
    setDriftState(null);
    setRtcJitterState(null);
    setRtcPlayoutDelayState(null);
    setRtcPostDelayState(null);
    setRtcPacketsLostState(0);
    setRtcConcealedState(0);

    const liveAudio = liveAudioRef.current;
    if (liveAudio) {
      try {
        rampLiveOutput(0, 0);
        liveAudio.pause();
        liveAudio.playbackRate = 1;
        liveAudio.srcObject = null;
        liveAudio.removeAttribute("src");
        liveAudio.load();
      } catch {}
    }
    releaseLiveStreamOutput();
    liveOutputModeRef.current = "none";
    setLiveOutputPathState("Idle");
  }, [rampLiveOutput, releaseLiveStreamOutput, setLivePostDelay]);

  const startWebRtcPlayback = useCallback(
    (live) => {
      if (!live?.id || !unlockedRef.current) return;
      if (liveSessionRef.current?.id === live.id && liveSessionRef.current?.transport === "webrtc") return;
      if (!globalThis.RTCPeerConnection) {
        setReadyStatus("WebRTC unsupported");
        setAudioIssueState("This browser cannot receive WebRTC audio. Use a current Chrome or Edge release.");
        return;
      }

      stopLocalSource();
      stopLivePlayback();
      const liveAudio = liveAudioRef.current;
      if (!liveAudio) return;
      configureMediaElement(liveAudio);
      rampLiveOutput(0, 0);
      try {
        liveAudio.pause();
        liveAudio.srcObject = null;
        liveAudio.removeAttribute("src");
        liveAudio.load();
      } catch {}

      liveSessionRef.current = {
        id: live.id,
        transport: "webrtc",
        phase: live.phase || "measuring",
        bufferMs: clamp(Number(live.bufferMs || 120), 60, 1000),
        roomTargetMs:
          Number.isFinite(Number(live.roomTargetMs)) && Number(live.roomTargetMs) > 0
            ? Number(live.roomTargetMs)
            : null,
        playAtServerMs: Number.isFinite(Number(live.playAt)) && Number(live.playAt) > 0 ? Number(live.playAt) : null,
        joinDelayMs: clamp(Number(live.joinDelayMs || 3000), 550, 6000),
        peerConnection: null,
        remotePeerId: null,
        pendingRemoteCandidates: [],
        pendingLocalCandidates: [],
        localDescriptionSent: false,
        postDelayMs: 0,
        postDelayLocked: false,
        lockAttempt: Number(live.lockAttempt || 0),
        measuredJitterDelayMs: null,
        lastInboundStats: null,
        lastRtpProgressAt: Date.now(),
        lastOutputLatencyMs: null,
        fastFuseReason: null,
        unmuteAtLocalMs: null,
        joinTimer: null,
        volumeTimer: null,
        disconnectTimer: null,
        fadeTimer: null,
        countdownTimer: null,
        statsTimer: null,
        statsPending: false,
        lastPostCorrectionAt: 0,
        outputFadeSeconds: ROOM_SYNC_POLICY.startFadeSeconds,
        nextStartFadeSeconds: null,
        relockDelayReadyAt: null,
        outputReady: false,
        timelineLocked: false,
        initialParticipant: false,
        timelineGuard: null,
        startScheduled: false,
        audible: false,
        rejoining: false,
        closed: false
      };
      audioReadyRef.current = false;
      setAudioReadyState(false);
      setPlaybackEngineState(deviceInfo.isIOS ? "WebRTC / HTML audio" : "WebRTC / Opus");
      setReadyStatus("Connecting WebRTC audio");
      setAudioIssueState("");
    },
    [deviceInfo.isIOS, rampLiveOutput, stopLivePlayback, stopLocalSource]
  );

  const flushLiveQueue = useCallback(() => {
    const session = liveSessionRef.current;
    if (!session || session.closed || !session.sourceBuffer || session.sourceBuffer.updating || !session.queue.length) return;
    try {
      session.sourceBuffer.appendBuffer(session.queue.shift());
    } catch (error) {
      setReadyStatus("Live stream error");
      setAudioIssueState(error?.message || "The live audio stream could not be decoded.");
    }
  }, []);
  flushLiveQueueRef.current = flushLiveQueue;

  const startLivePlayback = useCallback(
    (live) => {
      if (!live?.id || !unlockedRef.current) return;
      if (liveSessionRef.current?.id === live.id) return;
      if (live.transport === "webrtc") {
        startWebRtcPlayback(live);
        return;
      }
      if (!liveAudioRef.current || !window.MediaSource || !MediaSource.isTypeSupported(live.mimeType)) {
        setReadyStatus("Live stream unsupported");
        setAudioIssueState("This browser cannot play the Chrome live audio format. Use Chrome or Edge for live tab audio.");
        return;
      }

      stopLocalSource();
      stopLivePlayback();

      const liveAudio = liveAudioRef.current;
      const mediaSource = new MediaSource();
      const playAtServerMs = Number(live.playAt || Number(live.startedAt || Date.now()) + 1800);
      const session = {
        id: live.id,
        playAtServerMs,
        mediaSource,
        sourceBuffer: null,
        queue: [],
        url: URL.createObjectURL(mediaSource),
        closed: false,
        timelineStarted: false,
        rebuffering: false,
        playRequested: false,
        startTimer: null,
        bufferTimer: null,
        pauseTimer: null,
        seekTimer: null,
        bufferingStartedAt: null,
        timelineOffsetSeconds: 0,
        lateJoin: false
      };
      liveSessionRef.current = session;
      configureMediaElement(liveAudio);
      liveAudio.src = session.url;
      liveAudio.load();

      mediaSource.addEventListener(
        "sourceopen",
        () => {
          if (liveSessionRef.current !== session || session.closed) return;
          try {
            const sourceBuffer = mediaSource.addSourceBuffer(live.mimeType);
            sourceBuffer.mode = "sequence";
            const requestPlayback = () => {
              if (session.playRequested) return;
              if (!liveAudio.paused) {
                if (session.rebuffering || session.pauseTimer) {
                  clearTimeout(session.pauseTimer);
                  session.pauseTimer = null;
                  session.rebuffering = false;
                  restoreLiveOutput();
                  setReadyStatus(remoteMutedRef.current ? "Stopped by controller" : session.lateJoin ? "Receiving live audio (late join)" : "Receiving live audio");
                }
                return;
              }
              session.playRequested = true;
              rampLiveOutput(0, 0);
              const playPromise = liveAudio.play();
              if (!playPromise?.then) {
                session.playRequested = false;
                session.rebuffering = false;
                restoreLiveOutput(0.04);
                setReadyStatus(remoteMutedRef.current ? "Stopped by controller" : session.lateJoin ? "Receiving live audio (late join)" : "Receiving live audio");
                return;
              }
              playPromise.then(
                () => {
                  if (liveSessionRef.current !== session || session.closed) return;
                  session.playRequested = false;
                  session.rebuffering = false;
                  restoreLiveOutput(0.04);
                  setReadyStatus(remoteMutedRef.current ? "Stopped by controller" : session.lateJoin ? "Receiving live audio (late join)" : "Receiving live audio");
                },
                (error) => {
                  if (liveSessionRef.current !== session || session.closed) return;
                  session.playRequested = false;
                  rampLiveOutput(0, 0);
                  setReadyStatus("Enable speaker again");
                  setAudioIssueState(error?.message || "The browser blocked live audio playback.");
                }
              );
            };

            const pauseForBuffer = () => {
              if (liveAudio.paused || session.pauseTimer) return;
              rampLiveOutput(0, 0.025);
              session.pauseTimer = setTimeout(() => {
                session.pauseTimer = null;
                if (liveSessionRef.current !== session || session.closed) return;
                if (!session.rebuffering) {
                  restoreLiveOutput();
                  return;
                }
                liveAudio.pause();
                liveAudio.playbackRate = 1;
              }, 30);
            };

            const expectedPositionNow = () => {
              const sharedPosition = expectedLivePositionSeconds({
                nowLocalMs: Date.now(),
                playAtServerMs: session.playAtServerMs,
                serverOffsetMs: serverOffsetRef.current,
                outputLatencyMs: outputLatencyRef.current,
                manualOffsetMs: deviceOffsetRef.current
              });
              return Math.max(0, sharedPosition - session.timelineOffsetSeconds);
            };

            const beginOnSharedTimeline = () => {
              session.startTimer = null;
              if (liveSessionRef.current !== session || session.closed || !liveAudio.buffered.length) return;
              const start = liveAudio.buffered.start(0);
              const end = liveAudio.buffered.end(liveAudio.buffered.length - 1);
              const expected = expectedPositionNow();
              if (expected > end - 0.04) {
                const localPosition = clamp(end - 0.65, start, Math.max(start, end - 0.04));
                session.timelineOffsetSeconds = Math.max(0, expected - localPosition);
                session.lateJoin = true;
                liveAudio.currentTime = localPosition;
                liveAudio.playbackRate = 1;
                correctionCountRef.current += 1;
                setCorrectionCountState(correctionCountRef.current);
                setLastCorrectionState("Late join alignment");
                requestPlayback();
                return;
              }
              liveAudio.currentTime = clamp(expected, start, Math.max(start, end - 0.04));
              liveAudio.playbackRate = 1;
              requestPlayback();
            };

            const scheduleSharedStart = () => {
              const targetLocalMs = liveStartLocalMs({
                playAtServerMs: session.playAtServerMs,
                serverOffsetMs: serverOffsetRef.current,
                outputLatencyMs: outputLatencyRef.current,
                manualOffsetMs: deviceOffsetRef.current
              });
              const waitMs = Math.max(0, targetLocalMs - Date.now());
              setLastStartDelayState(Math.round(waitMs));
              if (waitMs > 15) {
                setReadyStatus(`Synchronized start in ${Math.max(1, Math.ceil(waitMs / 1000))}`);
                session.startTimer = setTimeout(beginOnSharedTimeline, waitMs);
                return;
              }
              beginOnSharedTimeline();
            };

            const startWhenBuffered = () => {
              if (liveSessionRef.current !== session || session.closed || session.timelineStarted) return false;
              const buffered = liveAudio.buffered;
              if (!buffered.length) return false;
              const start = buffered.start(0);
              const end = buffered.end(buffered.length - 1);
              const totalBuffered = Math.max(0, end - start);
              if (!session.bufferingStartedAt) session.bufferingStartedAt = Date.now();
              const waitedMs = Date.now() - session.bufferingStartedAt;

              if (!shouldStartLiveBuffer(totalBuffered, waitedMs)) return false;
              session.timelineStarted = true;
              clearTimeout(session.bufferTimer);
              session.bufferTimer = null;
              if (totalBuffered < LIVE_SYNC_POLICY.startBufferSeconds) {
                setLastCorrectionState("Adaptive buffer start");
              }
              scheduleSharedStart();
              return true;
            };

            const seekSmoothlyToTimeline = () => {
              if (session.seekTimer) return;
              rampLiveOutput(0, 0.02);
              session.seekTimer = setTimeout(() => {
                session.seekTimer = null;
                if (liveSessionRef.current !== session || session.closed || !liveAudio.buffered.length) return;
                const start = liveAudio.buffered.start(0);
                const end = liveAudio.buffered.end(liveAudio.buffered.length - 1);
                liveAudio.currentTime = clamp(expectedPositionNow(), start, Math.max(start, end - 0.04));
                liveAudio.playbackRate = 1;
                correctionCountRef.current += 1;
                setCorrectionCountState(correctionCountRef.current);
                setLastCorrectionState("Live timeline seek");
                restoreLiveOutput(0.035);
              }, 24);
            };

            sourceBuffer.addEventListener("updateend", () => {
              if (liveSessionRef.current !== session || session.closed) return;
              const buffered = liveAudio.buffered;
              if (buffered.length) {
                const start = buffered.start(0);
                const end = buffered.end(buffered.length - 1);
                const totalBuffered = Math.max(0, end - start);

                if (!session.timelineStarted) {
                  if (!session.bufferingStartedAt) {
                    session.bufferingStartedAt = Date.now();
                    session.bufferTimer = setTimeout(
                      startWhenBuffered,
                      LIVE_SYNC_POLICY.maximumStartWaitMs + 20
                    );
                  }
                  if (!startWhenBuffered()) {
                    const progress = Math.min(
                      99,
                      Math.round((totalBuffered / LIVE_SYNC_POLICY.startBufferSeconds) * 100)
                    );
                    setReadyStatus(`Buffering live audio ${progress}%`);
                  }
                } else if (!session.startTimer && !session.playRequested) {
                  const expected = expectedPositionNow();
                  const expectedAvailable = expected >= start && expected <= end - 0.04;
                  const availableAhead = end - expected;

                  if (!expectedAvailable) {
                    session.rebuffering = true;
                    setReadyStatus("Waiting for shared timeline");
                    pauseForBuffer();
                  } else {
                    if (!session.rebuffering && availableAhead < LIVE_SYNC_POLICY.lowBufferSeconds) {
                      session.rebuffering = true;
                      setReadyStatus("Refilling live buffer");
                      pauseForBuffer();
                    }

                    if (session.rebuffering) {
                      if (availableAhead >= LIVE_SYNC_POLICY.recoverBufferSeconds) {
                        liveAudio.currentTime = expected;
                        liveAudio.playbackRate = 1;
                        requestPlayback();
                      }
                    } else {
                      const correction = liveDriftCorrection(liveAudio.currentTime, expected);
                      setDriftState(Math.round(correction.driftSeconds * 1000));
                      if (correction.shouldSeek && availableAhead >= LIVE_SYNC_POLICY.lowBufferSeconds) {
                        seekSmoothlyToTimeline();
                      } else {
                        liveAudio.playbackRate = correction.playbackRate;
                        setLastCorrectionState(
                          Math.abs(correction.driftSeconds) < 0.01
                            ? "Live clock locked"
                            : `Live rate ${correction.playbackRate.toFixed(3)}x`
                        );
                      }
                      requestPlayback();
                    }
                  }
                }
              }
              flushLiveQueueRef.current();
            });
            session.sourceBuffer = sourceBuffer;
            audioReadyRef.current = true;
            setAudioReadyState(true);
            setReadyStatus("Buffering live audio 0%");
            flushLiveQueueRef.current();
          } catch (error) {
            setReadyStatus("Live stream error");
            setAudioIssueState(error?.message || "Unable to create the live audio buffer.");
          }
        },
        { once: true }
      );
    },
    [rampLiveOutput, restoreLiveOutput, startWebRtcPlayback, stopLivePlayback, stopLocalSource]
  );

  const appendLiveChunk = useCallback((chunk) => {
    const session = liveSessionRef.current;
    if (!session || session.closed || !chunk?.byteLength) return;
    session.queue.push(chunk.slice(0));
    if (session.queue.length > 48) session.queue.splice(0, session.queue.length - 48);
    flushLiveQueueRef.current();
  }, []);
  appendLiveChunkRef.current = appendLiveChunk;

  const createWebRtcReceiver = useCallback(
    (session, remotePeerId) => {
      if (session.peerConnection) return session.peerConnection;
      const connection = new RTCPeerConnection({ iceServers: [] });
      session.peerConnection = connection;
      session.remotePeerId = remotePeerId;
      rtcConnectionStateRef.current = connection.connectionState || "new";

      connection.addEventListener("icecandidate", (event) => {
        if (!event.candidate || session.closed) return;
        const candidate = event.candidate.toJSON ? event.candidate.toJSON() : event.candidate;
        if (!session.localDescriptionSent) {
          session.pendingLocalCandidates.push(candidate);
          return;
        }
        send({ type: "webrtcSignal", targetId: session.remotePeerId, signal: { candidate } });
      });

      connection.addEventListener("track", async (event) => {
        if (liveSessionRef.current !== session || session.closed) return;
        session.receiver = event.receiver;
        session.jitterBufferTargetSupported = setWebRtcJitterBufferTarget(
          event.receiver,
          session.bufferMs || WEBRTC_SYNC_POLICY.receiverBufferTargetMs
        );

        const liveAudio = liveAudioRef.current;
        if (!liveAudio) return;
        const stream = event.streams[0] || new MediaStream([event.track]);
        let streamOutput = false;
        if (audioContextRef.current) {
          try {
            if (audioContextRef.current.state === "suspended") await audioContextRef.current.resume();
          } catch {}
          if (audioContextRef.current.state === "running") {
            if (deviceInfo.isIOS) {
              streamOutput = Boolean(ensureLiveStreamOutput(audioContextRef.current, stream));
            } else {
              ensureLiveAudioOutput(audioContextRef.current, liveAudio);
            }
          }
        }
        const directOutput = !liveGainRef.current;
        if (directOutput) {
          liveOutputModeRef.current = "html-media-element";
          setLiveOutputPathState("HTML audio fallback");
        }
        rampLiveOutput(0, 0);
        liveAudio.srcObject = stream;
        liveAudio.muted = streamOutput || directOutput;
        liveAudio.volume = streamOutput || directOutput ? 0 : 1;
        audioReadyRef.current = true;
        setAudioReadyState(true);
        setReadyStatus(
          directOutput
            ? "Fixed timeline unavailable"
            : session.phase === "measuring" ? "Measuring room timing" : "Preparing fixed timeline"
        );
        if (directOutput) {
          setAudioIssueState("This browser could not create a clocked Web Audio output path.");
        }
        reportStatusSoon();
        try {
          if (streamOutput) {
            const playPromise = liveAudio.play();
            if (playPromise?.catch) playPromise.catch(() => {});
          } else {
            await liveAudio.play();
          }
          if (liveSessionRef.current !== session || session.closed) return;
          session.outputReady = true;
          updateWebRtcTimeline(stateRef.current.live);
        } catch (error) {
          rampLiveOutput(0, 0);
          setReadyStatus("Enable speaker again");
          setAudioIssueState(error?.message || "The browser blocked WebRTC audio playback.");
        }
      });

      connection.addEventListener("connectionstatechange", () => {
        if (liveSessionRef.current !== session || session.closed) return;
        rtcConnectionStateRef.current = connection.connectionState || "unknown";
        reportStatusSoon();
        if (connection.connectionState === "connected") {
          clearTimeout(session.disconnectTimer);
          session.disconnectTimer = null;
          if (liveOutputModeRef.current === "html-media-element") {
            setReadyStatus("Fixed timeline unavailable");
          } else if (session.phase === "measuring" || session.phase === "locking") {
            setReadyStatus(
              session.outputReady
                ? session.phase === "locking" ? "Locking fixed room timeline" : "Measuring room timing"
                : "Connecting WebRTC audio"
            );
          } else if (session.timelineGuard?.quarantined) {
            setReadyStatus("Synchronizing before join");
          } else if (session.audible) {
            const usesContextOutput = liveOutputModeRef.current.endsWith("source");
            const outputBlocked = usesContextOutput
              ? audioContextRef.current?.state !== "running"
              : Boolean(liveAudioRef.current?.paused);
            if (!remoteMutedRef.current && outputBlocked) {
              unlockedRef.current = false;
              setUnlockedState(false);
              setReadyStatus("Tap to resume audio");
            } else {
              setReadyStatus(remoteMutedRef.current ? "Stopped by controller" : "Receiving WebRTC audio");
            }
          }
        } else if (connection.connectionState === "disconnected") {
          clearTimeout(session.disconnectTimer);
          setReadyStatus("WebRTC connection interrupted");
          session.disconnectTimer = setTimeout(() => {
            if (
              liveSessionRef.current === session &&
              !session.closed &&
              connection.connectionState === "disconnected"
            ) {
              session.fastFuseReason = "RTP_STALLED";
              fastFuseReasonRef.current = session.fastFuseReason;
              quarantineWebRtcOutput(session, "Isolated: connection interrupted", ROOM_SYNC_POLICY.fastFuseFadeSeconds);
            }
          }, DEVICE_HEALTH_POLICY.fastFuseRtpStallMs);
        } else if (connection.connectionState === "failed") {
          clearTimeout(session.disconnectTimer);
          session.disconnectTimer = null;
          session.fastFuseReason = "WEBRTC_FAILED";
          fastFuseReasonRef.current = session.fastFuseReason;
          quarantineWebRtcOutput(session, "Isolated: WebRTC connection failed", ROOM_SYNC_POLICY.fastFuseFadeSeconds);
          setAudioIssueState("The direct audio path could not be established on this network.");
        }
      });

      session.statsTimer = setInterval(async () => {
        if (liveSessionRef.current !== session || session.closed || session.statsPending) return;
        session.statsPending = true;
        try {
          const stats = await connection.getStats();
          if (liveSessionRef.current !== session || session.closed) return;
          for (const report of stats.values()) {
            const mediaKind = report.kind || report.mediaType;
            if (report.type !== "inbound-rtp" || mediaKind !== "audio") continue;
            const sampledAt = Date.now();
            const previousInboundStats = session.lastInboundStats;
            const currentInboundStats = captureRtcSnapshot(report);
            const healthWindow = rtcWindowMetrics(currentInboundStats, previousInboundStats, {
              now: sampledAt,
              lastProgressAt: session.lastRtpProgressAt
            });
            session.lastInboundStats = currentInboundStats;
            session.lastRtpProgressAt = healthWindow.lastProgressAt;

            rtcJitterRef.current = healthWindow.jitterMs;
            rtcPacketsReceivedRef.current = Math.max(0, Number(currentInboundStats.packetsReceived || 0));
            rtcPacketsLostRef.current = Math.max(0, Number(currentInboundStats.packetsLost || 0));
            rtcConcealedRef.current = Math.max(0, Number(currentInboundStats.concealedSamples || 0));
            rtcTotalSamplesRef.current = Math.max(0, Number(currentInboundStats.totalSamplesReceived || 0));
            rtcPacketLossRateRef.current = healthWindow.packetLossRate;
            rtcConcealmentRateRef.current = healthWindow.concealmentRate;
            rtcRtpStallRef.current = healthWindow.rtpStallMs;
            rtcBytesReceivedRef.current = Math.max(0, Number(currentInboundStats.bytesReceived || 0));
            rtcEmittedCountRef.current = Math.max(0, Number(currentInboundStats.jitterBufferEmittedCount || 0));
            setRtcJitterState(healthWindow.jitterMs === null ? null : Math.round(healthWindow.jitterMs));
            setRtcPacketsLostState(rtcPacketsLostRef.current);
            setRtcConcealedState(rtcConcealedRef.current);
            const audioLevel = Number(report.audioLevel);
            rtcAudioLevelRef.current = Number.isFinite(audioLevel) ? clamp(audioLevel, 0, 1) : null;

            const currentOutputLatencyMs = Math.round(estimateOutputLatencySeconds(audioContextRef.current) * 1000);
            outputLatencyDeltaRef.current = Number.isFinite(session.lastOutputLatencyMs)
              ? currentOutputLatencyMs - session.lastOutputLatencyMs
              : 0;
            session.lastOutputLatencyMs = currentOutputLatencyMs;
            outputLatencyRef.current = currentOutputLatencyMs;
            setOutputLatencyState(currentOutputLatencyMs);

            const fastFuseMetrics = {
              active: session.phase === "playing",
              muted: remoteMutedRef.current,
              connectionState: connection.connectionState,
              audioContextState: audioContextRef.current?.state || "none",
              requiresAudioContext: liveOutputModeRef.current.endsWith("source"),
              rtpStallMs: healthWindow.rtpStallMs,
              outputLatencyDeltaMs: outputLatencyDeltaRef.current,
              packetLossRate: healthWindow.packetLossRate,
              packetSampleCount: healthWindow.packetSampleCount,
              concealmentRate: healthWindow.concealmentRate,
              totalSamplesDelta: healthWindow.totalSamplesDelta
            };
            let fuse = fastFuseReason(fastFuseMetrics);
            if (fuse) {
              session.fastFuseReason = fuse.code;
              fastFuseReasonRef.current = fuse.code;
              if (!session.timelineGuard?.quarantined) {
                correctionCountRef.current += 1;
                setCorrectionCountState(correctionCountRef.current);
                setLastCorrectionState(`Fast Fuse: ${fuse.label}`);
                quarantineWebRtcOutput(session, `Isolated: ${fuse.label}`, ROOM_SYNC_POLICY.fastFuseFadeSeconds);
                reportStatusSoon();
                continue;
              }
            }

            const delaySample = webRtcPlayoutDelaySample(currentInboundStats, previousInboundStats);
            if (!delaySample || !Number.isFinite(delaySample.actualDelayMs)) {
              reportStatusSoon();
              continue;
            }

            const smoothing = WEBRTC_SYNC_POLICY.measurementSmoothing;
            session.measuredJitterDelayMs = Number.isFinite(session.measuredJitterDelayMs)
              ? session.measuredJitterDelayMs * (1 - smoothing) + delaySample.actualDelayMs * smoothing
              : delaySample.actualDelayMs;
            const measuredDelayMs = session.measuredJitterDelayMs;
            rtcPlayoutDelayRef.current = Math.round(measuredDelayMs);
            setRtcPlayoutDelayState(rtcPlayoutDelayRef.current);

            if (!Number.isFinite(session.roomTargetMs) || session.roomTargetMs <= 0) {
              syncErrorRef.current = null;
              setDriftState(null);
              setLastCorrectionState("Collecting stable samples");
              reportStatusSoon();
              continue;
            }

            if (!session.postDelayLocked && !lockWebRtcPostDelay(session)) {
              setLastCorrectionState("Waiting to fix local compensation");
              reportStatusSoon();
              continue;
            }

            const syncErrorMs = Math.round(fixedTimelineErrorMs({
              roomTargetMs: session.roomTargetMs,
              playoutDelayMs: measuredDelayMs,
              outputLatencyMs: outputLatencyRef.current,
              postDelayMs: session.postDelayMs,
              deviceOffsetMs: deviceOffsetRef.current
            }));
            const rawSyncErrorMs = Math.round(fixedTimelineErrorMs({
              roomTargetMs: session.roomTargetMs,
              playoutDelayMs: delaySample.actualDelayMs,
              outputLatencyMs: outputLatencyRef.current,
              postDelayMs: session.postDelayMs,
              deviceOffsetMs: deviceOffsetRef.current
            }));
            syncErrorRef.current = syncErrorMs;
            rawSyncErrorRef.current = rawSyncErrorMs;
            setDriftState(syncErrorMs);

            fuse = fastFuseReason({
              ...fastFuseMetrics,
              rawSyncErrorMs
            });
            if (fuse) {
              session.fastFuseReason = fuse.code;
              fastFuseReasonRef.current = fuse.code;
              if (!session.timelineGuard?.quarantined) {
                correctionCountRef.current += 1;
                setCorrectionCountState(correctionCountRef.current);
                setLastCorrectionState(`Fast Fuse: ${fuse.label}`);
                quarantineWebRtcOutput(session, `Isolated: ${fuse.label}`, ROOM_SYNC_POLICY.fastFuseFadeSeconds);
                reportStatusSoon();
                continue;
              }
            }

            if (session.rejoining && Math.abs(syncErrorMs) > ROOM_SYNC_POLICY.recoverySyncErrorMs) {
              setLastCorrectionState(`Rejoin canceled ${syncErrorMs >= 0 ? "+" : ""}${syncErrorMs} ms`);
              quarantineWebRtcOutput(session, "Timeline moved; extending recovery");
              reportStatusSoon();
              continue;
            }

            if (session.phase === "locking") {
              setLastCorrectionState(
                Math.abs(syncErrorMs) <= ROOM_SYNC_POLICY.recoverySyncErrorMs
                  ? "Fixed timeline locked"
                  : `Locking timeline ${syncErrorMs >= 0 ? "+" : ""}${syncErrorMs} ms`
              );
              reportStatusSoon();
              continue;
            }

            if (session.phase === "armed" || session.phase === "playing") {
              let postCorrection = null;
              let correctionApplied = false;
              let correctionBlocked = false;
              if (session.phase === "playing") {
                const silentRepair = Boolean(
                  session.timelineGuard?.quarantined ||
                  remoteMutedRef.current ||
                  !session.audible
                );
                const correctionNow = Date.now();
                const correctionPlan = roomCorrectionPlan({
                  silent: silentRepair,
                  now: correctionNow,
                  lastCorrectionAt: session.lastPostCorrectionAt
                });
                if (correctionPlan.due) {
                  session.lastPostCorrectionAt = correctionNow;
                  postCorrection = nextPostDelayCorrection({
                    currentPostDelayMs: session.postDelayMs,
                    syncErrorMs,
                    maximumStepMs: correctionPlan.maximumStepMs
                  });
                  correctionApplied = Math.abs(postCorrection?.adjustmentMs || 0) >= 0.05;
                  correctionBlocked =
                    Math.abs(syncErrorMs) > ROOM_SYNC_POLICY.recoverySyncErrorMs &&
                    !correctionApplied &&
                    Boolean(postCorrection?.saturated);
                  if (correctionApplied) {
                    if (silentRepair) {
                      setLivePostDelay(postCorrection.delayMs, session);
                    } else {
                      rampLivePostDelay(
                        postCorrection.delayMs,
                        ROOM_SYNC_POLICY.softCorrectionRampSeconds,
                        session
                      );
                    }
                    correctionCountRef.current += 1;
                    setCorrectionCountState(correctionCountRef.current);
                  }
                }
              }

              const guardErrorMs = roomGuardError({ smoothedErrorMs: syncErrorMs, rawErrorMs: rawSyncErrorMs });
              const recoveryGuardErrorMs = fuse && session.timelineGuard?.quarantined
                ? Math.max(ROOM_SYNC_POLICY.hardSyncErrorMs + 1, Math.abs(guardErrorMs))
                : guardErrorMs;
              const nextGuard = nextFixedTimelineGuard(session.timelineGuard, recoveryGuardErrorMs);
              session.timelineGuard = nextGuard;
              if (nextGuard.action === "quarantine") {
                correctionCountRef.current += 1;
                setCorrectionCountState(correctionCountRef.current);
                setLastCorrectionState(`Output isolated ${guardErrorMs >= 0 ? "+" : ""}${guardErrorMs} ms`);
                quarantineWebRtcOutput(session);
              } else if (nextGuard.action === "rejoin") {
                session.fastFuseReason = null;
                fastFuseReasonRef.current = "";
                session.initialParticipant = true;
                session.rejoining = true;
                const sharedStartLocalMs = session.playAtServerMs - serverOffsetRef.current;
                const rejoinAtLocalMs =
                  session.phase === "armed" && sharedStartLocalMs > Date.now() + 80
                    ? sharedStartLocalMs
                    : Date.now() + ROOM_SYNC_POLICY.rejoinLeadMs;
                setLastCorrectionState("Timeline stable; preparing fade in");
                if (!scheduleWebRtcOutputAt(
                  session,
                  rejoinAtLocalMs,
                  "Rejoining",
                  ROOM_SYNC_POLICY.rejoinFadeSeconds
                )) {
                  quarantineWebRtcOutput(session);
                }
              } else if (nextGuard.quarantined) {
                if (correctionApplied) {
                  const adjustment = Math.round(postCorrection.adjustmentMs * 10) / 10;
                  setLastCorrectionState(`Silent relock ${adjustment >= 0 ? "+" : ""}${adjustment} ms`);
                  setReadyStatus("Relocking synchronization");
                } else if (correctionBlocked) {
                  setLastCorrectionState(`No delay headroom ${syncErrorMs >= 0 ? "+" : ""}${syncErrorMs} ms`);
                  setReadyStatus("Room restart needed for this speaker");
                } else {
                  setLastCorrectionState(`Recovering ${syncErrorMs >= 0 ? "+" : ""}${syncErrorMs} ms`);
                  setReadyStatus("Recovering synchronization");
                }
              } else if (Math.abs(syncErrorMs) <= ROOM_SYNC_POLICY.recoverySyncErrorMs) {
                setLastCorrectionState("Fixed timeline locked");
              } else if (correctionApplied) {
                const adjustment = Math.round(postCorrection.adjustmentMs * 10) / 10;
                setLastCorrectionState(`Soft correction ${adjustment >= 0 ? "+" : ""}${adjustment} ms`);
              } else {
                setLastCorrectionState(`Watching drift ${syncErrorMs >= 0 ? "+" : ""}${syncErrorMs} ms`);
              }
            }
            reportStatusSoon();
          }
        } catch {} finally {
          session.statsPending = false;
        }
      }, ROOM_SYNC_POLICY.monitorIntervalMs);

      return connection;
    },
    [deviceInfo.isIOS, ensureLiveAudioOutput, ensureLiveStreamOutput, lockWebRtcPostDelay, quarantineWebRtcOutput, rampLiveOutput, rampLivePostDelay, reportStatusSoon, scheduleWebRtcOutputAt, send, setLivePostDelay, updateWebRtcTimeline]
  );

  const handleWebRtcSignal = useCallback(
    async (message) => {
      const session = liveSessionRef.current;
      if (!session || session.closed || session.transport !== "webrtc" || !message.signal) return;
      const remotePeerId = Number(message.fromId || 0);
      if (!remotePeerId) return;
      session.remotePeerId = remotePeerId;

      if (message.signal.candidate) {
        if (session.peerConnection?.remoteDescription) {
          await session.peerConnection.addIceCandidate(message.signal.candidate);
        } else {
          session.pendingRemoteCandidates.push(message.signal.candidate);
        }
        return;
      }

      if (message.signal.description?.type !== "offer") return;
      const connection = createWebRtcReceiver(session, remotePeerId);
      await connection.setRemoteDescription(message.signal.description);
      for (const candidate of session.pendingRemoteCandidates.splice(0)) {
        await connection.addIceCandidate(candidate);
      }
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      const description = connection.localDescription?.toJSON
        ? connection.localDescription.toJSON()
        : connection.localDescription;
      send({ type: "webrtcSignal", targetId: remotePeerId, signal: { description } });
      session.localDescriptionSent = true;
      for (const candidate of session.pendingLocalCandidates.splice(0)) {
        send({ type: "webrtcSignal", targetId: remotePeerId, signal: { candidate } });
      }
    },
    [createWebRtcReceiver, send]
  );

  const createAudioContext = useCallback(() => {
    if (roleRef.current === "speaker") applyPlaybackAudioSession();
    if (!audioContextRef.current) {
      const AudioApi = window.AudioContext || window.webkitAudioContext;
      if (!AudioApi) throw new Error("Web Audio is not supported on this browser");
      try {
        audioContextRef.current = new AudioApi({ latencyHint: "interactive" });
      } catch {
        audioContextRef.current = new AudioApi();
      }
      gainRef.current = audioContextRef.current.createGain();
      gainRef.current.gain.value = outputVolumeRef.current;
      gainRef.current.connect(audioContextRef.current.destination);
      setAudioContextState(audioContextRef.current.state || "unknown");
      audioContextRef.current.addEventListener?.("statechange", () => {
        const nextState = audioContextRef.current?.state || "closed";
        setAudioContextState(nextState);
        const outputLatencyMs = Math.round(estimateOutputLatencySeconds(audioContextRef.current) * 1000);
        outputLatencyRef.current = outputLatencyMs;
        setOutputLatencyState(outputLatencyMs);
        const contextCarriesLiveAudio = liveOutputModeRef.current.endsWith("source") && liveSessionRef.current;
        if (contextCarriesLiveAudio && nextState === "running") {
          const liveSession = liveSessionRef.current;
          unlockedRef.current = true;
          setUnlockedState(true);
          if (liveSession.audible && !liveSession.timelineGuard?.quarantined) {
            restoreLiveOutput(0.04);
            setReadyStatus(remoteMutedRef.current ? "Stopped by controller" : "Receiving WebRTC audio");
          } else {
            rampLiveOutput(0, 0);
            setReadyStatus(
              liveSession.phase === "locking"
                ? "Locking fixed room timeline"
                : liveSession.phase === "measuring"
                  ? "Measuring room timing"
                  : "Recovering synchronization"
            );
          }
          setAudioIssueState("");
        } else if (contextCarriesLiveAudio && document.visibilityState === "visible") {
          const liveSession = liveSessionRef.current;
          if (liveSession?.phase === "playing" && !liveSession.timelineGuard?.quarantined) {
            liveSession.fastFuseReason = "AUDIO_ENGINE_STOPPED";
            fastFuseReasonRef.current = liveSession.fastFuseReason;
            quarantineWebRtcOutput(
              liveSession,
              "Isolated: audio engine stopped",
              ROOM_SYNC_POLICY.fastFuseFadeSeconds
            );
          }
          unlockedRef.current = false;
          setUnlockedState(false);
          setReadyStatus("Tap to resume audio");
          setAudioIssueState("iPad paused its audio engine. Tap Enable speaker to resume it.");
        }
        reportStatusSoon();
      });
    }
    setAudioContextState(audioContextRef.current.state || "unknown");
    const outputLatencyMs = Math.round(estimateOutputLatencySeconds(audioContextRef.current) * 1000);
    outputLatencyRef.current = outputLatencyMs;
    setOutputLatencyState(outputLatencyMs);
    return audioContextRef.current;
  }, [applyPlaybackAudioSession, quarantineWebRtcOutput, rampLiveOutput, reportStatusSoon, restoreLiveOutput]);

  const ensureAudioContext = useCallback(async ({ resume = true } = {}) => {
    const audioContext = createAudioContext();
    if (resume && audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
    }
    setAudioContextState(audioContextRef.current.state || "unknown");
    return audioContextRef.current;
  }, [createAudioContext]);

  const prepareMediaElement = useCallback((layer) => {
    const mediaAudio = mediaAudioRef.current;
    if (!mediaAudio || !layer) return false;
    configureMediaElement(mediaAudio);
    const layerKey = `${layer.id}:${layer.version}`;
    const sourceUrl = mediaLayerUrl(layer);
    currentLayerIdRef.current = layer.id;
    currentLayerVersionRef.current = layer.version;
    if (mediaAudio.dataset.layerKey !== layerKey) {
      try {
        mediaAudio.pause();
      } catch {}
      mediaAudio.src = sourceUrl;
      mediaAudio.dataset.layerKey = layerKey;
      mediaAudio.load();
    }
    mediaAudio.onloadedmetadata = () => {
      if (mediaAudio.dataset.layerKey !== layerKey) return;
      if (Number.isFinite(mediaAudio.duration)) setDurationState(mediaAudio.duration);
      audioReadyRef.current = true;
      setAudioReadyState(true);
      setReadyStatus(unlockedRef.current ? "Ready" : "Locked");
      reportStatusSoon();
    };
    mediaAudio.onerror = () => {
      audioReadyRef.current = false;
      setAudioReadyState(false);
      setReadyStatus("Load failed");
      setAudioIssueState("Safari could not load this audio file.");
      reportStatusSoon();
    };
    audioReadyRef.current = true;
    setAudioReadyState(true);
    setReadyStatus(unlockedRef.current ? "Ready" : "Locked");
    return true;
  }, [reportStatusSoon]);

  const startLocalSource = useCallback(
    (delaySeconds, offsetSeconds) => {
      stopLocalSource();
      if (playbackEngineRef.current === "media-element") {
        const mediaAudio = mediaAudioRef.current;
        if (!mediaAudio) return;
        configureMediaElement(mediaAudio);
        const startAtMs = Date.now() + delaySeconds * 1000;
        const playMedia = () => {
          mediaPlaybackTimerRef.current = null;
          try {
            mediaAudio.muted = false;
            mediaAudio.volume = outputVolumeRef.current;
            mediaAudio.playbackRate = 1;
            mediaAudio.currentTime = Math.max(0, offsetSeconds);
          } catch {}
          const playPromise = mediaAudio.play();
          if (playPromise?.catch) {
            playPromise.catch((error) => {
              setReadyStatus("Enable speaker first");
              setAudioIssueState(error?.message || "Safari blocked media playback.");
            });
          }
        };

        if (delaySeconds > 0.04) {
          mediaPlaybackTimerRef.current = setTimeout(playMedia, delaySeconds * 1000);
        } else {
          playMedia();
        }
        localPlaybackRef.current = { mode: "media-element", startedAtMs: startAtMs, offset: offsetSeconds };
        return;
      }

      const audioContext = audioContextRef.current;
      const audioBuffer = audioBufferRef.current;
      if (!audioContext || !audioBuffer) return;
      if (gainRef.current) gainRef.current.gain.value = outputVolumeRef.current;

      const nextSource = audioContext.createBufferSource();
      nextSource.buffer = audioBuffer;
      nextSource.connect(gainRef.current);
      const contextStartedAt = audioContext.currentTime + delaySeconds;
      nextSource.start(contextStartedAt, offsetSeconds);
      sourceRef.current = nextSource;
      activeSourcesRef.current.add(nextSource);
      localPlaybackRef.current = { contextStartedAt, offset: offsetSeconds };
      nextSource.onended = () => {
        activeSourcesRef.current.delete(nextSource);
        if (sourceRef.current === nextSource) {
          sourceRef.current = null;
          localPlaybackRef.current = null;
        }
      };
    },
    [stopLocalSource]
  );

  const expectedPosition = useCallback(() => {
      const state = stateRef.current;
      const audioBuffer = audioBufferRef.current;
      const mediaAudio = mediaAudioRef.current;
      if (!state.playing || !state.startedAt) return state.position || 0;
      return clamp(
        state.position +
          Math.max(0, (Date.now() + serverOffsetRef.current - state.startedAt - deviceOffsetRef.current) / 1000),
        0,
        audioBuffer?.duration || mediaAudio?.duration || durationState || Number.MAX_SAFE_INTEGER
      );
  }, [durationState]);

  const currentLocalPosition = useCallback(() => {
    if (playbackEngineRef.current === "media-element") {
      return mediaAudioRef.current?.currentTime || stateRef.current?.position || 0;
    }
    const localPlayback = localPlaybackRef.current;
    const audioContext = audioContextRef.current;
    if (!localPlayback || !audioContext) return stateRef.current?.position || 0;
    return localPlayback.offset + Math.max(0, audibleAudioContextTime(audioContext) - localPlayback.contextStartedAt);
  }, []);

  const updateCountdown = useCallback((seconds) => {
    const safe = Math.max(0, Number(seconds) || 0);
    setCountdownState(safe > 0.05 ? Math.max(1, Math.ceil(safe)) : null);
  }, []);

  const scheduleFromState = useCallback(
    (force = false) => {
      const state = stateRef.current;
      const audioBuffer = audioBufferRef.current;
      const mediaAudio = mediaAudioRef.current;
      const mediaMode = playbackEngineRef.current === "media-element";
      if (!state?.playing || !state.startedAt || !unlockedRef.current) return;
      if (remoteMutedRef.current) {
        stopLocalSource();
        setReadyStatus("Stopped by controller");
        return;
      }
      if (!mediaMode && !audioBuffer) return;
      if (mediaMode && !mediaAudio) return;

      const expected = expectedPosition();
      if (!force && localPlaybackRef.current) {
        const drift = currentLocalPosition() - expected;
        const absoluteDrift = Math.abs(drift);
        if (mediaMode && mediaAudio) {
          if (!mediaAudio.paused && absoluteDrift < 1.15) {
            try {
              mediaAudio.playbackRate = clamp(1 - drift * 0.08, 0.96, 1.04);
            } catch {}
            return;
          }
          const now = Date.now();
          if (!mediaAudio.paused && now - lastMediaCorrectionRef.current < 4500) return;
          lastMediaCorrectionRef.current = now;
        } else if (absoluteDrift < 0.035) {
          return;
        }
      }

      const adjustedTargetLocalMs = state.startedAt - serverOffsetRef.current + deviceOffsetRef.current;
      const outputLatencySeconds = estimateOutputLatencySeconds(audioContextRef.current);
      setOutputLatencyState(Math.round(outputLatencySeconds * 1000));
      const delaySeconds = mediaMode
        ? Math.max(0, (adjustedTargetLocalMs - Date.now()) / 1000 - outputLatencySeconds)
        : Math.max(0, contextTimeForAudibleEpoch(audioContextRef.current, adjustedTargetLocalMs) - audioContextRef.current.currentTime);
      setLastStartDelayState(Math.round(delaySeconds * 1000));
      const offsetSeconds = clamp(
        state.position +
          Math.max(0, (Date.now() + serverOffsetRef.current - state.startedAt - deviceOffsetRef.current) / 1000),
        0,
        (audioBuffer?.duration || mediaAudio?.duration || durationState || Number.MAX_SAFE_INTEGER) - 0.02
      );

      if (localPlaybackRef.current) {
        correctionCountRef.current += 1;
        setCorrectionCountState(correctionCountRef.current);
        setLastCorrectionState(mediaMode ? "HTML audio seek" : "Web Audio restart");
      }

      startLocalSource(delaySeconds, offsetSeconds);
      updateCountdown(delaySeconds);
    },
    [currentLocalPosition, durationState, expectedPosition, startLocalSource, stopLocalSource, updateCountdown]
  );

  const loadAudio = useCallback(
    async (layer) => {
      if (!layer) return;
      if (!unlockedRef.current) {
        setReadyStatus("Locked");
        setAudioLoading(false);
        return;
      }
      if (playbackEngineRef.current === "media-element") {
        setAudioLoading(false);
        prepareMediaElement(layer);
        if (stateRef.current.playing) scheduleFromState(true);
        return;
      }
      const loadingKey = `${layer.id}:${layer.version}`;
      if (loadingLayerKeyRef.current === loadingKey) return;
      loadingLayerKeyRef.current = loadingKey;
      audioBufferRef.current = null;
      audioReadyRef.current = false;
      setAudioReadyState(false);
      setAudioLoading(true);
      setReadyStatus("Loading");

      try {
        const response = await fetch(`/audio?layer=${encodeURIComponent(layer.id)}&v=${layer.version}`, {
          cache: "no-store"
        });
        if (!response.ok) throw new Error("Audio download failed");
        const bytes = await response.arrayBuffer();
        await ensureAudioContext({ resume: false });
        const decoded = await decodeAudioBuffer(audioContextRef.current, bytes);
        if (selectedLayerIdRef.current !== layer.id) return;

        audioBufferRef.current = decoded;
        currentLayerIdRef.current = layer.id;
        currentLayerVersionRef.current = layer.version;
        audioReadyRef.current = true;
        setAudioReadyState(true);
        setDurationState(decoded.duration);
        setReadyStatus(unlockedRef.current ? "Ready" : "Locked");
        reportStatusSoon();
        if (stateRef.current.playing) scheduleFromState(true);
      } catch (error) {
        setAudioIssueState(error?.message || "Audio download or decode failed");
        setReadyStatus("Load failed");
        audioReadyRef.current = false;
        setAudioReadyState(false);
      } finally {
        loadingLayerKeyRef.current = null;
        setAudioLoading(false);
      }
    },
    [ensureAudioContext, prepareMediaElement, reportStatusSoon, scheduleFromState]
  );

  const applyState = useCallback(
    (nextState, immediate = false) => {
      stateRef.current = nextState || EMPTY_STATE;
      setServerState(stateRef.current);
      setLeadState(Number(stateRef.current.leadMs || 3000));
      if (!seekingRef.current) {
        setPositionState(Number(stateRef.current.currentPosition ?? stateRef.current.position ?? 0));
      }

      if (stateRef.current.live?.id) {
        stopLocalSource();
        setDurationState(0);
        setCountdownState(null);
        if (roleRef.current === "controller") {
          if (liveSessionRef.current) stopLivePlayback();
          const phase = stateRef.current.live.phase;
          setReadyStatus(
            phase === "measuring"
              ? `Measuring ${stateRef.current.live.stableSpeakers || 0}/${stateRef.current.live.requiredSpeakers || 0}`
              : phase === "locking"
                ? `Locking ${stateRef.current.live.stableSpeakers || 0}/${stateRef.current.live.requiredSpeakers || 0}`
                : phase === "armed"
                  ? "Room timeline armed"
                  : "Room playing"
          );
          return;
        }
        if (!unlockedRef.current) {
          setReadyStatus("Locked");
          return;
        }
        startLivePlayback(stateRef.current.live);
        updateWebRtcTimeline(stateRef.current.live);
        return;
      }

      if (liveSessionRef.current) stopLivePlayback();
      if (roleRef.current === "controller") {
        stopLocalSource();
        setReadyStatus("Room controller");
        return;
      }

      const layer = ensureSelectedLayer(stateRef.current);
      const mediaMode = playbackEngineRef.current === "media-element";
      if (!layer) {
        stopLocalSource();
        audioBufferRef.current = null;
        currentLayerIdRef.current = null;
        currentLayerVersionRef.current = null;
        audioReadyRef.current = false;
        setAudioReadyState(false);
        setDurationState(0);
        setCountdownState(null);
        return;
      }

      const selectedLayerChanged =
        layer.id !== currentLayerIdRef.current ||
        layer.version !== currentLayerVersionRef.current ||
        (!mediaMode && !audioBufferRef.current);
      if (selectedLayerChanged) {
        stopLocalSource();
        audioBufferRef.current = null;
        currentLayerIdRef.current = null;
        currentLayerVersionRef.current = null;
        audioReadyRef.current = false;
        setAudioReadyState(false);
        setDurationState(0);
      }

      if (!unlockedRef.current) {
        setReadyStatus("Locked");
        setCountdownState(null);
        return;
      }

      if (selectedLayerChanged) {
        loadAudio(layer);
        return;
      }

      if (stateRef.current.playing) {
        scheduleFromState(immediate);
      } else {
        stopLocalSource();
        setCountdownState(null);
        localPlaybackRef.current = null;
      }
    },
    [ensureSelectedLayer, loadAudio, scheduleFromState, startLivePlayback, stopLivePlayback, stopLocalSource, updateWebRtcTimeline]
  );

  useEffect(() => {
    applyState(stateRef.current, true);
    reportStatusSoon();
  }, [applyState, reportStatusSoon, roleState]);

  const receiveTimeSample = useCallback(
    (message) => {
      const now = Date.now();
      const rtt = now - message.clientSent;
      const midpoint = message.clientSent + rtt / 2;
      const offset = message.serverTime - midpoint;
      if (!Number.isFinite(offset) || !Number.isFinite(rtt) || rtt < 0 || rtt > 5000) return;

      const samples = [...clockSamplesRef.current, { offset, rtt, receivedAt: now }]
        .filter((sample) => now - sample.receivedAt < 60_000)
        .slice(-30);
      clockSamplesRef.current = samples;

      const ranked = [...samples].sort((left, right) => left.rtt - right.rtt);
      const selectedCount = Math.min(ranked.length, Math.max(1, Math.ceil(ranked.length / 4), ranked.length >= 4 ? 4 : 1));
      const selected = ranked.slice(0, selectedCount);
      const nextOffset = median(selected.map((sample) => sample.offset));
      const nextLatency = median(selected.map((sample) => sample.rtt));
      const previousOffset = serverOffsetRef.current;

      serverOffsetRef.current = nextOffset;
      latencyRef.current = nextLatency;
      setServerOffsetState(nextOffset);
      setLatencyState(nextLatency);
      reportStatusSoon();

      const state = stateRef.current;
      const beforeScheduledStart = state?.playing && state.startedAt && Date.now() + nextOffset < state.startedAt;
      if (beforeScheduledStart && selected.length >= 4 && Math.abs(nextOffset - previousOffset) >= 1.5) {
        scheduleFromState(true);
      }
    },
    [reportStatusSoon, scheduleFromState]
  );

  const calibrateClock = useCallback(
    (samples = 8) => {
      for (let i = 0; i < samples; i += 1) {
        setTimeout(() => send({ type: "time", clientSent: Date.now() }), i * 70);
      }
    },
    [send]
  );

  const handleMessage = useCallback(
    (message) => {
      if (message.type === "hello") {
        clientIdRef.current = message.id;
        applyState(message.state);
        setPeers(message.peers || []);
        setRoomDiagnosticState(message.roomDiagnostic || null);
        setIncidentLogState(message.incidents || []);
        reportStatusSoon();
        return;
      }
      if (message.type === "time") {
        receiveTimeSample(message);
        return;
      }
      if (message.type === "peers") {
        setPeers(message.peers || []);
        setRoomDiagnosticState(message.roomDiagnostic || null);
        setIncidentLogState(message.incidents || []);
        return;
      }
      if (message.type === "testTone") {
        playTestTone(message);
        return;
      }
      if (message.type === "webrtcSignal") {
        handleWebRtcSignal(message).catch((error) => {
          setReadyStatus("WebRTC signaling failed");
          setAudioIssueState(error?.message || "Could not establish the direct audio path.");
        });
        return;
      }
      if (message.type === "deviceCommand") {
        deviceCommandRef.current?.(message);
        return;
      }
      if (
        message.type === "track" ||
        message.type === "sync" ||
        message.type === "lead" ||
        message.type === "liveStart" ||
        message.type === "liveLock" ||
        message.type === "liveArm" ||
        message.type === "liveStop"
      ) {
        applyState(message.state);
        return;
      }
      if (["play", "pause", "stop", "seek"].includes(message.type)) {
        applyState(message.state, true);
      }
    },
    [applyState, handleWebRtcSignal, receiveTimeSample, reportStatusSoon]
  );

  handleMessageRef.current = handleMessage;

  const connect = useCallback(() => {
    shuttingDownRef.current = false;
    clearTimeout(reconnectTimerRef.current);
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}`);
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      setConnected(true);
      clockSamplesRef.current = [];
      reportStatusNow();
      calibrateClock(10);
    });
    socket.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) {
        appendLiveChunkRef.current?.(event.data);
        return;
      }
      try {
        handleMessageRef.current?.(JSON.parse(event.data));
      } catch {}
    });
    socket.addEventListener("close", () => {
      if (socketRef.current !== socket) return;
      setConnected(false);
      if (liveSessionRef.current) stopLivePlayback();
      if (stateRef.current?.playing || sourceRef.current || activeSourcesRef.current.size) {
        const position = expectedPosition();
        stopLocalSource();
        const nextState = {
          ...stateRef.current,
          playing: false,
          position,
          currentPosition: position,
          startedAt: null,
          updatedAt: Date.now()
        };
        stateRef.current = nextState;
        setServerState(nextState);
        setPositionState(position);
        setCountdownState(null);
      }
      if (!shuttingDownRef.current) reconnectTimerRef.current = setTimeout(connect, 900);
    });
    socket.addEventListener("error", () => {
      if (socketRef.current === socket) setConnected(false);
    });
  }, [calibrateClock, expectedPosition, reportStatusNow, stopLivePlayback, stopLocalSource]);

  const closeSocket = useCallback(() => {
    shuttingDownRef.current = true;
    clearTimeout(reconnectTimerRef.current);
    try {
      socketRef.current?.close(1000, "page unload");
    } catch {}
    stopLivePlayback();
  }, [stopLivePlayback]);

  useEffect(() => {
    connect();
    loadConfig().then(({ leadMs }) => setLeadState(leadMs || 3000));
    return () => closeSocket();
  }, [closeSocket, connect]);

  useEffect(() => {
    const sampleClock = () => send({ type: "time", clientSent: Date.now() });
    const timer = setInterval(sampleClock, 2000);
    const restoreForegroundSession = () => {
      if (document.visibilityState !== "visible") return;
      if (roleRef.current === "speaker") applyPlaybackAudioSession();
      shuttingDownRef.current = false;
      const socketState = socketRef.current?.readyState;
      if (socketState !== WebSocket.OPEN && socketState !== WebSocket.CONNECTING) connect();
      else calibrateClock(6);

      const hasLiveFrames = Boolean(liveSessionRef.current && rtcBytesReceivedRef.current > 0);
      const audioContextUnavailable = Boolean(
        audioContextRef.current &&
        audioContextRef.current.state !== "running" &&
        (liveOutputModeRef.current.endsWith("source") || liveOutputModeRef.current === "none")
      );
      if (hasLiveFrames && audioContextUnavailable) {
        unlockedRef.current = false;
        setUnlockedState(false);
        setReadyStatus("Tap to resume audio");
        setAudioIssueState("iPad paused its audio engine. Tap Enable speaker to resume it.");
        reportStatusSoon();
      }
    };
    document.addEventListener("visibilitychange", restoreForegroundSession);
    window.addEventListener("pageshow", restoreForegroundSession);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", restoreForegroundSession);
      window.removeEventListener("pageshow", restoreForegroundSession);
    };
  }, [applyPlaybackAudioSession, calibrateClock, connect, reportStatusSoon, send]);

  useEffect(() => {
    const onBeforeUnload = () => closeSocket();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [closeSocket]);

  useEffect(() => {
    const timer = setInterval(() => {
      const state = stateRef.current;
      if (!state || seekingRef.current) return;
      if (state.live?.id) return;
      const position = expectedPosition();
      setPositionState(position);
      const hasLocalPlayback =
        Boolean(localPlaybackRef.current) ||
        (playbackEngineRef.current === "media-element" && mediaAudioRef.current && !mediaAudioRef.current.paused);
      if (state.playing && hasLocalPlayback) {
        const nextDrift = Math.round((currentLocalPosition() - position) * 1000);
        setDriftState((previous) => (previous === null || Math.abs(previous - nextDrift) >= 10 ? nextDrift : previous));
      } else {
        setDriftState(null);
      }
      if (state.playing && (audioBufferRef.current || playbackEngineRef.current === "media-element")) {
        const remaining = (state.startedAt + deviceOffsetRef.current - (Date.now() + serverOffsetRef.current)) / 1000;
        updateCountdown(remaining);
      }
    }, 200);
    return () => clearInterval(timer);
  }, [currentLocalPosition, expectedPosition, updateCountdown]);

  useEffect(() => {
    stateRef.current = serverState;
  }, [serverState]);

  async function loadConfig() {
    const response = await fetch("/config", { cache: "no-store" });
    const config = await response.json();
    const advertised = Array.isArray(config.networkAddresses) && config.networkAddresses.length
      ? config.networkAddresses
      : (config.addresses || []).map((url, index) => ({
          url,
          interfaceName: `Network ${index + 1}`,
          recommended: index === 0
        }));
    const currentOrigin = location.origin;
    const candidates = speakerJoinAddressCandidates({
      advertised,
      currentOrigin,
      loopback: isLoopbackHost(location.hostname)
    });
    const options = candidates
      .map((candidate, index) => ({
        url: playerJoinUrl(candidate.url),
        label: candidate.interfaceName || `Network ${index + 1}`,
        recommended: Boolean(candidate.recommended),
        current: Boolean(candidate.current)
      }));
    setJoinOptions(options);
    const preferredUrl = options.find((option) => option.recommended)?.url || options[0]?.url || "";
    setSelectedJoinUrl((current) => options.some((option) => option.url === current) ? current : preferredUrl);
    return config;
  }

  function setDeviceName(nextName) {
    const clean = nextName.slice(0, 40);
    deviceNameRef.current = clean;
    setDeviceNameState(clean);
    if (clean.trim()) localStorage.setItem("deviceName", clean.trim());
    reportStatusSoon();
  }

  function selectZone(zone) {
    selectedZoneRef.current = zone;
    setSelectedZoneState(zone);
    localStorage.setItem("selectedZone", zone);
    reportStatusSoon();
  }

  function setDeviceOffset(value) {
    const nextOffset = clamp(Math.round(Number(value) || 0), -300, 300);
    const previousOffset = deviceOffsetRef.current;
    deviceOffsetRef.current = nextOffset;
    setDeviceOffsetState(nextOffset);
    localStorage.setItem("deviceOffsetMs", String(nextOffset));
    reportStatusSoon();
    const liveSession = liveSessionRef.current;
    if (liveSession?.transport === "webrtc" && liveSession.postDelayLocked) {
      setLivePostDelay(liveSession.postDelayMs + nextOffset - previousOffset, liveSession);
    }
    if (stateRef.current?.playing) scheduleFromState(true);
  }

  function setRemoteVolume(value) {
    const nextVolume = clamp(Number(value) || 0, 0, 1);
    outputVolumeRef.current = nextVolume;
    const liveSession = liveSessionRef.current;
    if (liveSession) {
      if (liveSession.startScheduled && liveSession.unmuteAtLocalMs > Date.now()) {
        clearTimeout(liveSession.volumeTimer);
        liveSession.volumeTimer = scheduleLiveOutputAt(
          liveSession.unmuteAtLocalMs,
          liveSession.outputFadeSeconds || ROOM_SYNC_POLICY.startFadeSeconds
        );
      } else if (liveSession.audible && !liveSession.timelineGuard?.quarantined) {
        rampLiveOutput(remoteMutedRef.current ? 0 : nextVolume, 0.06);
      }
      return;
    }

    const audioContext = audioContextRef.current;
    const gain = gainRef.current;
    if (audioContext && gain) {
      const now = audioContext.currentTime;
      const parameter = gain.gain;
      if (typeof parameter.cancelAndHoldAtTime === "function") {
        parameter.cancelAndHoldAtTime(now);
      } else {
        const currentValue = parameter.value;
        parameter.cancelScheduledValues(now);
        parameter.setValueAtTime(currentValue, now);
      }
      parameter.linearRampToValueAtTime(remoteMutedRef.current ? 0 : nextVolume, now + 0.06);
    }
    if (mediaAudioRef.current) mediaAudioRef.current.volume = remoteMutedRef.current ? 0 : nextVolume;
  }

  function setRemoteMuted(nextMuted) {
    const muted = Boolean(nextMuted);
    remoteMutedRef.current = muted;
    setRemoteMutedState(muted);

    if (muted) {
      rampLiveOutput(0, 0.03);
      stopLocalSource();
      setReadyStatus("Stopped by controller");
      reportStatusSoon();
      return;
    }

    const liveSession = liveSessionRef.current;
    if (liveSession) {
      if (liveSession.transport === "webrtc" && ["measuring", "locking"].includes(liveSession.phase)) {
        rampLiveOutput(0, 0);
        setReadyStatus(liveSession.phase === "locking" ? "Locking fixed room timeline" : "Measuring room timing");
        reportStatusSoon();
        return;
      }
      if (liveSession.transport === "webrtc" && liveSession.timelineGuard?.quarantined) {
        rampLiveOutput(0, 0);
        setReadyStatus("Recovering synchronization");
        reportStatusSoon();
        return;
      }
      const contextBlocked =
        liveOutputModeRef.current.endsWith("source") && audioContextRef.current?.state !== "running";
      const elementBlocked =
        liveOutputModeRef.current === "html-media-element" && Boolean(liveAudioRef.current?.paused);
      if (contextBlocked || elementBlocked) {
        unlockedRef.current = false;
        setUnlockedState(false);
        setReadyStatus("Tap to resume audio");
        setAudioIssueState("This device needs a local tap before audio can resume.");
        reportStatusSoon();
        return;
      }
      if (liveSession.unmuteAtLocalMs && liveSession.unmuteAtLocalMs > Date.now()) {
        clearTimeout(liveSession.volumeTimer);
        liveSession.volumeTimer = scheduleLiveOutputAt(
          liveSession.unmuteAtLocalMs,
          liveSession.outputFadeSeconds || ROOM_SYNC_POLICY.startFadeSeconds
        );
        setReadyStatus(`WebRTC starts in ${Math.max(1, Math.ceil((liveSession.unmuteAtLocalMs - Date.now()) / 1000))}`);
      } else {
        restoreLiveOutput(0.04);
        if (liveSession.transport === "webrtc") liveSession.audible = true;
        setReadyStatus(liveSession.transport === "webrtc" ? "Receiving WebRTC audio" : "Receiving live audio");
      }
    } else if (stateRef.current?.playing) {
      scheduleFromState(true);
    } else {
      setReadyStatus(audioReadyRef.current ? "Ready" : "No audio");
    }
    reportStatusSoon();
  }

  function handleDeviceCommand(message) {
    if (message.action === "mute") {
      setRemoteMuted(true);
      return;
    }
    if (message.action === "unmute") {
      setRemoteMuted(false);
      return;
    }
    if (message.action === "setOffset") {
      setDeviceOffset(message.value);
      return;
    }
    if (message.action === "setVolume") {
      setRemoteVolume(message.value);
      return;
    }
    if (message.action === "reconnect") {
      setReadyStatus("Reconnecting by controller");
      try {
        socketRef.current?.close(4001, "controller reconnect");
      } catch {}
    }
  }
  deviceCommandRef.current = handleDeviceCommand;

  function selectLayer(layerId) {
    const layer = layerById(stateRef.current.layers || [], layerId);
    if (!layer) return;
    setSelectedLayerId(layerId);
    stopLocalSource();
    audioBufferRef.current = null;
    currentLayerIdRef.current = null;
    currentLayerVersionRef.current = null;
    audioReadyRef.current = false;
    setAudioReadyState(false);
    loadAudio(layer);
  }

  async function unlockAudio() {
    if (unlockingRef.current) return;
    unlockingRef.current = true;
    setAudioIssueState("");
    setReadyStatus("Unlocking");
    applyPlaybackAudioSession();

    try {
      const liveAudio = liveAudioRef.current;
      const existingLiveSession = liveSessionRef.current;
      const hasActiveLiveStream = Boolean(existingLiveSession?.transport === "webrtc" && liveAudio?.srcObject);
      let liveAudioUnlockPromise = null;
      if (liveAudio) {
        configureMediaElement(liveAudio);
        if (hasActiveLiveStream) {
          const streamUsesWebAudio = liveOutputModeRef.current === "webrtc-stream-source";
          const mediaUsesWebAudio = liveOutputModeRef.current === "media-element-source";
          liveAudio.muted = streamUsesWebAudio || remoteMutedRef.current;
          liveAudio.volume = streamUsesWebAudio
            ? 0
            : mediaUsesWebAudio
              ? 1
              : remoteMutedRef.current ? 0 : outputVolumeRef.current;
        } else {
          if (!silentAudioUrlRef.current) silentAudioUrlRef.current = createSilentWavUrl();
          liveAudio.src = silentAudioUrlRef.current;
          liveAudio.muted = false;
          liveAudio.load();
        }
        try {
          liveAudioUnlockPromise = liveAudio.play();
        } catch {}
      }

      const live = stateRef.current.live;
      const layer = layerById(stateRef.current.layers || [], selectedLayerIdRef.current) || stateRef.current.layers?.[0];
      const audioContext = createAudioContext();
      let webAudioUnlocked = false;
      if (gainRef.current) gainRef.current.gain.value = outputVolumeRef.current;
      try {
        const primeDone = primeAudioHardware(audioContext, gainRef.current || audioContext.destination);
        if (audioContext.state !== "running") await withTimeout(audioContext.resume(), 450);
        await primeDone;
        if (audioContext.state !== "running") await withTimeout(audioContext.resume(), 450);
        await wait(60);
        setAudioContextState(audioContext.state || "unknown");
        webAudioUnlocked = audioContext.state === "running";
      } catch {
        setAudioContextState(audioContext.state || "unknown");
      }

      if (liveAudioUnlockPromise?.then) {
        try {
          await withTimeout(liveAudioUnlockPromise, 900);
        } catch {}
      }
      if (liveAudio && !hasActiveLiveStream) {
        try {
          liveAudio.pause();
          liveAudio.currentTime = 0;
        } catch {}
      }

      if (webAudioUnlocked) {
        playbackEngineRef.current = "web-audio";
        setPlaybackEngineState(live && deviceInfo.isIOS ? "WebRTC / HTML audio" : "Web Audio");
      } else {
        await unlockMediaElement(layer);
        playbackEngineRef.current = "media-element";
        setPlaybackEngineState("HTML audio");
        setAudioIssueState("Using iPad Safari fallback. AudioContext may stay suspended.");
      }

      unlockedRef.current = true;
      setUnlockedState(true);
      setReadyStatus(audioReadyRef.current ? "Ready" : "No audio");
      reportStatusSoon();

      if (live) {
        if (hasActiveLiveStream) {
          const liveSession = liveSessionRef.current;
          if (
            liveSession?.audible &&
            !liveSession.timelineGuard?.quarantined &&
            !["measuring", "locking"].includes(liveSession.phase)
          ) {
            restoreLiveOutput(0.04);
            setReadyStatus(remoteMutedRef.current ? "Stopped by controller" : "Receiving WebRTC audio");
          } else {
            rampLiveOutput(0, 0);
            setReadyStatus(
              liveSession?.phase === "locking"
                ? "Locking fixed room timeline"
                : liveSession?.phase === "measuring"
                  ? "Measuring room timing"
                  : "Recovering synchronization"
            );
          }
          reportStatusSoon();
          return;
        }
        if (liveSessionRef.current?.id === live.id) stopLivePlayback();
        startLivePlayback(live);
        return;
      }
      if (layer && !audioBufferRef.current) await loadAudio(layer);
      if (stateRef.current?.playing && (audioBufferRef.current || playbackEngineRef.current === "media-element")) {
        scheduleFromState(true);
      }
    } catch (error) {
      unlockedRef.current = false;
      setUnlockedState(false);
      setReadyStatus("Unlock failed");
      setAudioIssueState(error?.message || "Audio unlock failed");
      reportStatusSoon();
    } finally {
      unlockingRef.current = false;
    }
  }

  async function unlockMediaElement(layer) {
    const mediaAudio = mediaAudioRef.current;
    if (!mediaAudio) throw new Error("Media element is not ready. Refresh this player page.");
    configureMediaElement(mediaAudio);
    if (!silentAudioUrlRef.current) silentAudioUrlRef.current = createSilentWavUrl();
    mediaAudio.src = silentAudioUrlRef.current;
    mediaAudio.dataset.layerKey = "";
    mediaAudio.muted = false;
    mediaAudio.load();
    const playPromise = mediaAudio.play();
    if (playPromise?.then) await withTimeout(playPromise, 900);
    await wait(90);
    mediaAudio.pause();
    try {
      mediaAudio.currentTime = 0;
    } catch {}
    if (layer) prepareMediaElement(layer);
  }

  async function forceWebAudioTest() {
    setWebAudioTestState("Testing");
    setAudioIssueState("");

    try {
      const audioContext = createAudioContext();
      if (gainRef.current) gainRef.current.gain.value = outputVolumeRef.current;
      const primeDone = primeAudioHardware(audioContext, gainRef.current || audioContext.destination, 0.16, 0.18);
      if (audioContext.state !== "running") await withTimeout(audioContext.resume(), 1200);
      await primeDone;
      if (audioContext.state !== "running") await withTimeout(audioContext.resume(), 1200);
      await wait(100);
      setAudioContextState(audioContext.state || "unknown");

      if (audioContext.state !== "running") {
        throw new Error("AudioContext stayed suspended");
      }

      const layer = layerById(stateRef.current.layers || [], selectedLayerIdRef.current) || stateRef.current.layers?.[0];
      stopLocalSource();
      playbackEngineRef.current = "web-audio";
      setPlaybackEngineState("Web Audio");
      unlockedRef.current = true;
      setUnlockedState(true);
      audioBufferRef.current = null;
      currentLayerIdRef.current = null;
      currentLayerVersionRef.current = null;
      audioReadyRef.current = false;
      setAudioReadyState(false);
      setDurationState(0);
      setWebAudioTestState("Passed");
      setReadyStatus(layer ? "Loading" : "Ready");

      if (layer) await loadAudio(layer);
      if (stateRef.current?.playing && audioBufferRef.current) scheduleFromState(true);
    } catch (error) {
      setWebAudioTestState("Failed");
      setAudioContextState(audioContextRef.current?.state || "none");
      setAudioIssueState(error?.message || "Web Audio test failed");
      if (playbackEngineRef.current !== "web-audio") setReadyStatus(audioReadyRef.current ? "Ready" : "No audio");
    }
  }

  async function uploadSelectedFiles(filesLike) {
    const files = [...(filesLike || [])];
    if (!files.length) return;
    setUploadText(`Uploading 0/${files.length}`);
    stopLocalSource();
    audioBufferRef.current = null;
    currentLayerIdRef.current = null;
    currentLayerVersionRef.current = null;
    audioReadyRef.current = false;
    setAudioReadyState(false);

    const clearResponse = await fetch("/clear", { method: "POST" });
    if (!clearResponse.ok) {
      setUploadText("Upload failed");
      return;
    }

    let uploadedState = null;
    for (const [index, file] of files.entries()) {
      setUploadText(`Uploading ${index + 1}/${files.length}`);
      const response = await fetch("/upload", {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-File-Name": encodeURIComponent(file.name)
        },
        body: file
      });
      if (!response.ok) {
        setUploadText("Upload failed");
        return;
      }
      uploadedState = await response.json();
    }

    setUploadText(files.length > 1 ? "Replace stems" : "Replace track");
    if (uploadedState) applyState(uploadedState);
  }

  function togglePlay() {
    const state = stateRef.current;
    if (!state?.layers?.length) return;
    if (state.playing || sourceRef.current) {
      pausePlayback();
    } else {
      send({ type: "play", position: Number(positionState || state.position || 0) });
    }
  }

  function pausePlayback() {
    const state = stateRef.current;
    if (!state?.layers?.length) return;
    const position = expectedPosition();
    stopPlaybackLocally(position);
    send({ type: "pause" });
  }

  function stopPlayback() {
    stopPlaybackLocally(0);
    send({ type: "stop" });
  }

  function stopPlaybackLocally(position) {
    stopLocalSource();
    const mediaAudio = mediaAudioRef.current;
    if (mediaAudio && Number.isFinite(position)) {
      try {
        mediaAudio.currentTime = Math.max(0, position);
      } catch {}
    }
    setCountdownState(null);
    const nextState = {
      ...stateRef.current,
      playing: false,
      position,
      currentPosition: position,
      startedAt: null,
      updatedAt: Date.now()
    };
    stateRef.current = nextState;
    setServerState(nextState);
    setPositionState(position);
  }

  function restartPlayback() {
    if (!stateRef.current?.layers?.length) return;
    calibrateClock(10);
    seekingRef.current = false;
    pendingSeekRef.current = 0;
    stopPlaybackLocally(0);
    send({ type: "play", position: 0 });
  }

  function beginSeek() {
    seekingRef.current = true;
    pendingSeekRef.current = Number(positionState || 0);
  }

  function previewSeek(value) {
    const nextPosition = Number(value || 0);
    seekingRef.current = true;
    pendingSeekRef.current = nextPosition;
    setPositionState(nextPosition);
  }

  function commitSeek(value = pendingSeekRef.current) {
    if (!seekingRef.current) return;
    const requested = Number(value);
    const nextPosition = clamp(
      Number.isFinite(requested) ? requested : pendingSeekRef.current,
      0,
      durationState || Number.MAX_SAFE_INTEGER
    );
    seekingRef.current = false;
    pendingSeekRef.current = nextPosition;
    setPositionState(nextPosition);
    send({ type: "seek", position: nextPosition });
  }

  async function playTestTone(message = {}) {
    if (message.targetId && message.targetId !== clientIdRef.current) return;
    if (!unlockedRef.current) {
      setReadyStatus("Enable speaker first");
      return;
    }
    if (liveOutputModeRef.current.endsWith("source") && audioContextRef.current?.state !== "running") {
      unlockedRef.current = false;
      setUnlockedState(false);
      setReadyStatus("Tap to resume audio");
      setAudioIssueState("This device needs a local tap before audio can resume.");
      reportStatusSoon();
      return;
    }
    if (playbackEngineRef.current === "media-element" || audioContextRef.current?.state !== "running") {
      await playMediaTestTone();
      return;
    }
    await ensureAudioContext();
    if (gainRef.current) gainRef.current.gain.value = outputVolumeRef.current;
    const oscillator = audioContextRef.current.createOscillator();
    const toneGain = audioContextRef.current.createGain();
    const now = Date.now();
    const targetLocalMs = (message.toneAt || now + 120) - serverOffsetRef.current + deviceOffsetRef.current;
    const startAt = audioContextRef.current.currentTime + Math.max(0, (targetLocalMs - now) / 1000);
    const frequency =
      {
        "front-left": 520,
        "front-right": 620,
        center: 720,
        "rear-left": 430,
        "rear-right": 830
      }[selectedZoneRef.current] || 600;

    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    toneGain.gain.setValueAtTime(0.0001, startAt);
    toneGain.gain.exponentialRampToValueAtTime(0.28, startAt + 0.02);
    toneGain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.38);
    oscillator.connect(toneGain).connect(gainRef.current);
    oscillator.start(startAt);
    oscillator.stop(startAt + 0.42);
  }

  return (
    <>
      <div className="shell">
        <header className="app-header">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">HC</span>
            <div>
              <strong>Home Cinema</strong>
              <span>Adaptive LAN audio</span>
            </div>
          </div>
          <div className="header-actions">
            <div className="role-mode" aria-label={`Device role: ${roleState}`}>
              <Radio size={15} />
              <span>{roleState === "controller" ? "Controller" : "Speaker"}</span>
            </div>
            <div className={`connection ${connected ? "is-connected" : ""}`}>
              <span className="dot" />
              <span>{connected ? "Network ready" : "Reconnecting"}</span>
            </div>
          </div>
        </header>

        <main className="app">
          <section className="stage" aria-label="Synchronized playback console">
            <div className="stage-heading">
              <div>
                <p className="eyebrow">CURRENT SESSION</p>
              <h1>{liveActive ? "Live tab audio" : serverState.playing ? "Now playing" : "Ready when you are"}</h1>
              </div>
              <span className={`readiness ${audioReadyState ? "is-ready" : ""}`}>{readyStatus}</span>
            </div>

            <div className="playback-card playback-card-simple">
              <div className="track">
                <p className="track-kicker">{liveActive ? "LIVE TAB AUDIO" : layers.length > 1 ? "MULTI-STEM PLAYBACK" : "ACTIVE AUDIO"}</p>
                <p className="track-name">{trackLabel}</p>
                <p className="track-meta">{syncLabel}</p>
                <div className={`meter ${serverState.playing || livePlaying ? "playing" : ""}`} aria-hidden="true">
                  {Array.from({ length: 12 }, (_, index) => (
                    <span key={index} style={{ "--i": index }} />
                  ))}
                </div>
              </div>
            </div>

            <Countdown value={countdownState} />

            {roleState === "controller" && !liveActive && <div className="playback-controls">
              <div className="transport">
                <button className="icon-button" type="button" title="Stop" aria-label="Stop" onClick={stopPlayback}>
                  <Square />
                </button>
                <button className="primary-button" type="button" title="Play/Pause" aria-label="Play or pause" onClick={togglePlay}>
                  {serverState.playing ? <Pause /> : <Play />}
                </button>
                <button
                  className="icon-button"
                  type="button"
                  title="Restart from beginning"
                  aria-label="Restart playback from beginning"
                  onClick={restartPlayback}
                  disabled={!layers.length}
                >
                  <RotateCw />
                </button>
              </div>

              <div className="timeline">
                <span>{formatTime(positionState)}</span>
                <input
                  type="range"
                  min="0"
                  max={durationState || 100}
                  value={Math.min(positionState, durationState || 100)}
                  step="0.01"
                  aria-label="Playback position"
                  aria-valuetext={`${formatTime(positionState)} of ${formatTime(durationState)}`}
                  disabled={!durationState}
                  style={{ "--progress": `${durationState ? Math.min(100, (positionState / durationState) * 100) : 0}%` }}
                  onPointerDown={beginSeek}
                  onChange={(event) => previewSeek(event.target.value)}
                  onPointerUp={(event) => commitSeek(event.currentTarget.value)}
                  onPointerCancel={(event) => commitSeek(event.currentTarget.value)}
                  onTouchEnd={(event) => commitSeek(event.currentTarget.value)}
                  onKeyUp={(event) => {
                    if (["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
                      commitSeek(event.currentTarget.value);
                    }
                  }}
                  onBlur={(event) => commitSeek(event.currentTarget.value)}
                />
                <span>{formatTime(durationState)}</span>
              </div>
            </div>}
            {liveActive && roleState === "controller" && (
              <div className="controller-transport" aria-label="Live room controls">
                <button
                  className="room-control-button"
                  type="button"
                  disabled={!speakerCount}
                  onClick={() => send({ type: "roomCommand", action: allSpeakersMuted ? "resumeSpeakers" : "muteSpeakers" })}
                >
                  {allSpeakersMuted ? <Volume2 /> : <VolumeX />}
                  {allSpeakersMuted ? "Resume speakers" : "Stop speakers"}
                </button>
                <button className="room-control-button danger" type="button" onClick={() => send({ type: "stop" })}>
                  <Square /> End live capture
                </button>
              </div>
            )}
            {liveActive && roleState === "speaker" && (
              <div className={`live-source ${remoteMutedState || !livePlaying ? "is-stopped" : ""}`}>
                {remoteMutedState ? <VolumeX size={17} /> : <Radio size={17} />}
                <span>
                  {remoteMutedState
                    ? "Output stopped by the room controller."
                    : livePhase === "measuring"
                      ? "Measuring this speaker while output stays muted."
                      : livePhase === "locking"
                        ? "Locking this speaker to the fixed room timeline."
                        : readyStatus}
                </span>
              </div>
            )}

            {roleState === "speaker" ? <div className="sync-health" aria-label="Live synchronization health">
              <div className="sync-health-heading">
                <div>
                  <strong>Sync health</strong>
                  <span>Live measurements</span>
                </div>
              </div>
              <div className="sync-metrics">
                <div><span>Network RTT</span><strong>{latencyState ? `${Math.round(latencyState)} ms` : "Measuring"}</strong></div>
                <div><span>Clock offset</span><strong>{Math.round(serverOffsetState)} ms</strong></div>
                <div><span>Playback drift</span><strong>{driftState === null ? "-- ms" : `${driftState} ms`}</strong></div>
                <div className="manual-offset">
                  <span>Manual compensation</span>
                  <div>
                    <button type="button" aria-label="Decrease compensation by 10 milliseconds" onClick={() => setDeviceOffset(deviceOffsetState - 10)}>−</button>
                    <strong>{deviceOffsetState >= 0 ? "+" : ""}{deviceOffsetState} ms</strong>
                    <button type="button" aria-label="Increase compensation by 10 milliseconds" onClick={() => setDeviceOffset(deviceOffsetState + 10)}>+</button>
                  </div>
                </div>
              </div>
            </div> : <div className="room-overview" aria-label="Room status">
              <div><span>{livePlaying ? "Playing" : "Stable"}</span><strong>{livePlaying ? activeSpeakerCount : stableSpeakerCount}</strong></div>
              <div><span>Stopped</span><strong>{stoppedSpeakerCount}</strong></div>
              <div><span>Issues</span><strong>{issueSpeakerCount}</strong></div>
              <div><span>Joined</span><strong>{speakerCount}</strong></div>
            </div>}
          </section>

          <aside className="side">
            <section className="panel host-panel session-panel">
              <div className="panel-heading">
                <h2>{liveActive ? "Live capture" : "Audio"}</h2>
                <span className="panel-note">{liveActive ? livePhaseLabel : layers.length ? `${layers.length} loaded` : "Required"}</span>
              </div>
              {liveActive ? (
                <>
                  <div className="live-session-summary">
                    <div>
                      <span>Phase</span>
                      <strong>
                        {livePhaseBlocked
                          ? `${livePhaseLabel} blocked`
                          : livePhase === "locking"
                            ? `${livePhaseLabel} ${liveLockAttempt}/${maximumLiveLockAttempts}`
                            : livePhaseLabel}
                      </strong>
                    </div>
                    <div><span>Transport</span><strong>WebRTC / Opus</strong></div>
                    <div><span>{livePlaying ? "Active outputs" : "Stable speakers"}</span><strong>{livePlaying ? activeSpeakerCount : stableSpeakerCount} / {requiredSpeakerCount || speakerCount}</strong></div>
                    <div><span>Room target</span><strong>{roomTargetMs ? `${roomTargetMs} ms` : "Measuring"}</strong></div>
                    <div>
                      <span>Controller output</span>
                      <strong className={`metric-health ${controllerOutputHealth.tone}`}>{controllerOutputHealth.label}</strong>
                    </div>
                  </div>
                  <details
                    className="controller-monitor"
                    open={controllerMonitorOpen}
                    onToggle={(event) => setControllerMonitorOpen(event.currentTarget.open)}
                  >
                    <summary>
                      <span>Controller output telemetry</span>
                      <span>{controllerMetrics?.sampleRate ? `${Math.round(controllerMetrics.sampleRate)} Hz` : "Waiting"}</span>
                    </summary>
                    <div className="diagnostic-grid controller-diagnostic-grid">
                      <Stat label="AudioContext" value={controllerMetrics?.contextState || "--"} />
                      <Stat label="Total output" value={formatMetric(controllerMetrics?.totalOutputLatencyMs, "ms")} />
                      <Stat label="Base buffer" value={formatMetric(controllerMetrics?.baseLatencyMs, "ms")} />
                      <Stat label="Device output" value={formatMetric(controllerMetrics?.outputLatencyMs, "ms")} />
                      <Stat label="Change from start" value={formatSignedMetric(controllerMetrics?.latencyDeltaMs, "ms")} />
                      <Stat label="Window spread" value={formatMetric(controllerMetrics?.latencySpreadMs, "ms")} />
                      <Stat label="Estimated offset" value={formatSignedMetric(controllerMetrics?.estimatedTimelineErrorMs, "ms")} />
                      <Stat label="Audio clock skew" value={formatSignedMetric(controllerMetrics?.clockDriftPpm, "ppm")} />
                      <Stat label="Fixed local delay" value={formatMetric(controllerMetrics?.localDelayMs, "ms")} />
                      <Stat
                        label="Observation"
                        value={controllerMetrics ? `${Math.round(controllerMetrics.observationWindowMs / 1000)}s / ${controllerMetrics.sampleCount}` : "--"}
                      />
                    </div>
                  </details>
                  {!livePlaying && (
                    <div className={`phase-progress ${livePhaseBlocked ? "is-blocked" : ""}`}>
                      <div className="phase-progress-heading">
                        <span>
                          {livePhaseBlocked
                            ? "Measurement blocked"
                            : `${livePhaseSampleCount}/${livePhaseSampleTarget} timing samples`}
                        </span>
                        <strong>{Math.round(livePhaseProgress)}%</strong>
                      </div>
                      <div
                        className="phase-progress-track"
                        role="progressbar"
                        aria-label={`${livePhaseLabel} progress`}
                        aria-valuemin="0"
                        aria-valuemax="100"
                        aria-valuenow={Math.round(livePhaseProgress)}
                      >
                        <span style={{ width: `${livePhaseProgress}%` }} />
                      </div>
                      <span className="phase-progress-detail">
                        {livePhaseBlocked
                          ? "Check the speaker Inbound, Audio path, and AudioContext state."
                          : `${Math.ceil(livePhaseElapsedMs / 1000)}s elapsed · ${Math.max(0, Math.ceil((livePhaseTimeoutMs - livePhaseElapsedMs) / 1000))}s check window${livePhase === "locking" ? ` · attempt ${liveLockAttempt}/${maximumLiveLockAttempts}` : ""}`}
                      </span>
                      {livePhaseBlocked && livePhase === "locking" && (
                        <button className="text-button recovery-button phase-retry-button" type="button" onClick={() => send({ type: "roomCommand", action: "retryLock" })}>
                          <RefreshCw size={15} /> Retry lock
                        </button>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <label className="upload">
                    <input type="file" accept="audio/*" multiple onChange={(event) => uploadSelectedFiles(event.target.files)} />
                    <Upload />
                    <span>{uploadText}</span>
                  </label>
                  <div className="field-row">
                    <span>Start buffer</span>
                    <div className="segmented latency-modes" role="group" aria-label="Sync countdown">
                      {[3000, 4000, 5000].map((lead) => (
                        <button
                          key={lead}
                          className={Number(leadState) === lead ? "active" : ""}
                          type="button"
                          onClick={() => send({ type: "setLead", leadMs: lead })}
                        >
                          {lead / 1000}s
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </section>

            <details className="panel host-panel join-panel collapsible-panel" defaultOpen={speakerCount === 0}>
              <summary>
                <span>Add speakers</span>
                <span className="panel-note">{speakerCount} joined</span>
              </summary>
              <div className="collapsible-content">
                <div className="join-layout">
                  <div className="join-qr" aria-label="Player QR code">
                    {selectedJoinUrl ? <QrCode value={selectedJoinUrl} /> : "QR unavailable"}
                  </div>
                  <div className="join-instructions">
                    <strong>Scan on each device</strong>
                    <span>Open the link, then tap Enable speaker.</span>
                    {joinOptions.length > 1 ? (
                      <select
                        className="join-address-select"
                        aria-label="Speaker network address"
                        value={selectedJoinUrl}
                        onChange={(event) => setSelectedJoinUrl(event.target.value)}
                      >
                        {joinOptions.map((option) => (
                          <option key={option.url} value={option.url}>
                            {option.recommended ? "Recommended · " : option.current ? "Current · " : ""}{option.label} · {formatJoinAddress(option.url)}
                          </option>
                        ))}
                      </select>
                    ) : selectedJoinUrl ? (
                      <span className="join-address">{formatJoinAddress(selectedJoinUrl)}</span>
                    ) : null}
                    {selectedJoinUrl && (
                      <button className="copy-link" type="button" onClick={() => navigator.clipboard?.writeText(selectedJoinUrl)}>
                        <Copy size={16} /> Copy join link
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </details>

            <section className="panel players-panel host-panel">
              <div className="panel-heading">
                <div>
                  <h2>Speakers</h2>
                  <span className="panel-subtitle">
                    {liveActive && !livePlaying
                      ? `${stableSpeakerCount}/${requiredSpeakerCount || speakerCount} stable · ${livePhaseLabel}`
                      : `${activeSpeakerCount} playing · ${issueSpeakerCount} issues · ${stoppedSpeakerCount} stopped`}
                  </span>
                </div>
                <div className="speaker-panel-actions">
                  <button
                    className="text-button recovery-button"
                    type="button"
                    disabled={!retryableSpeakerCount}
                    onClick={() => send({ type: "roomCommand", action: "retryIssues" })}
                  >
                    <RefreshCw size={15} /> Retry failed
                  </button>
                  <button className="text-button" type="button" disabled={!speakerCount} onClick={() => send({ type: "testTone" })}>
                    <Radio size={15} /> Test all
                  </button>
                </div>
              </div>
              <div className="room-volume-row">
                {roomVolume > 0.001 ? <Volume2 size={17} /> : <VolumeX size={17} />}
                <label htmlFor="roomVolume">Room volume</label>
                <input
                  id="roomVolume"
                  type="range"
                  min="0"
                  max="100"
                  step="5"
                  value={Math.round(roomVolume * 100)}
                  aria-valuetext={`${Math.round(roomVolume * 100)} percent`}
                  onChange={(event) => send({ type: "roomCommand", action: "setVolume", value: Number(event.target.value) / 100 })}
                />
                <strong>{Math.round(roomVolume * 100)}%</strong>
              </div>
              <DeviceHealthMonitor
                devices={monitoredPeers}
                roomDiagnostic={roomDiagnosticState}
                incidents={incidentLogState}
              />
              <div className="peers">
                {!speakerPeers.length && <div className="empty-state">Waiting for speakers to join…</div>}
                {speakerPeers.map((peer) => (
                  <PeerCard
                    key={peer.id}
                    peer={peer}
                    layers={layers}
                    onTest={() => send({ type: "testTone", targetId: peer.id })}
                    onToggle={() => send({ type: "deviceCommand", targetId: peer.id, action: peer.muted ? "unmute" : "mute" })}
                    onReconnect={() => send({ type: "deviceCommand", targetId: peer.id, action: "reconnect" })}
                    onOffset={(value) => send({ type: "deviceCommand", targetId: peer.id, action: "setOffset", value })}
                    onVolume={(value) => send({ type: "deviceCommand", targetId: peer.id, action: "setVolume", value })}
                  />
                ))}
              </div>
            </section>

            {roleState === "speaker" && <>
            <section className="panel output-panel">
              <div className="panel-heading">
                <div>
                  <p className="step-label">THIS DEVICE</p>
                  <h2>Local output</h2>
                </div>
                <span className={`status ${audioReadyState ? "ready" : ""}`}>{readyStatus}</span>
              </div>

              <label className="field-label" htmlFor="deviceNameInput">Device name</label>
              <input
                id="deviceNameInput"
                className="device-name-input"
                type="text"
                maxLength="40"
                autoComplete="off"
                value={deviceNameState}
                onChange={(event) => setDeviceName(event.target.value)}
              />

              <div className="setting-block">
                <span className="field-label">Audio layer</span>
                <div className="layer-choices">
                  {!layers.length && <span className="empty-inline">No audio loaded</span>}
                  {layers.map((layer, index) => (
                    <button
                      key={layer.id}
                      className={`layer-button ${layer.id === selectedLayerIdState ? "active" : ""}`}
                      type="button"
                      onClick={() => selectLayer(layer.id)}
                    >
                      <strong>{layer.name}</strong>
                      <span className="badge">{index + 1}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="setting-block">
                <span className="field-label">Room position</span>
                <div className="zone-choices" role="group" aria-label="Sound field position">
                  {zones.map(([zone, label]) => (
                    <button
                      key={zone}
                      className={selectedZoneState === zone ? "active" : ""}
                      type="button"
                      title={zoneNames[zone]}
                      onClick={() => selectZone(zone)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <details className="panel advanced-panel">
              <summary>
                <span>Calibration & diagnostics</span>
                <span className="summary-value">{deviceOffsetState >= 0 ? "+" : ""}{deviceOffsetState} ms</span>
              </summary>
              <div className="advanced-content">
                <div className="diagnostic-grid">
                  <Stat label="Audio engine" value={playbackEngineState} />
                  <Stat label="AudioContext" value={audioContextState} />
                  <Stat label="Audio session" value={formatAudioSession(audioSessionInfoState)} />
                  <Stat label="Live output" value={liveOutputPathState} />
                  <Stat label="Output estimate" value={outputLatencyState === null ? "-- ms" : `${outputLatencyState} ms`} />
                  <Stat label="Browser" value={`${deviceInfo.browser} / ${deviceInfo.engine}`} />
                  <Stat label="Sync engine" value={`v${ROOM_SYNC_ENGINE_VERSION}`} />
                  <Stat label="Corrections" value={String(correctionCountState)} />
                  <Stat label="Last correction" value={lastCorrectionState} />
                  <Stat label="Start delay" value={lastStartDelayState === null ? "-- ms" : `${lastStartDelayState} ms`} />
                  <Stat label="WebRTC jitter" value={rtcJitterState === null ? "-- ms" : `${rtcJitterState} ms`} />
                  <Stat label="WebRTC playout" value={rtcPlayoutDelayState === null ? "-- ms" : `${rtcPlayoutDelayState} ms`} />
                  <Stat label="Fixed compensation" value={rtcPostDelayState === null ? "-- ms" : `${rtcPostDelayState} ms`} />
                  <Stat label="Packets lost" value={String(rtcPacketsLostState)} />
                  <Stat label="Concealed samples" value={String(rtcConcealedState)} />
                </div>

                <div className="calibration-row">
                  <span>Local timing offset</span>
                  <div className="calibration" aria-label="Local latency calibration">
                    <button type="button" onClick={() => setDeviceOffset(deviceOffsetState - 10)}>-10</button>
                    <button type="button" onClick={() => setDeviceOffset(0)}>Reset</button>
                    <button type="button" onClick={() => setDeviceOffset(deviceOffsetState + 10)}>+10</button>
                  </div>
                </div>

                <div className="advanced-actions">
                  <button className="mini-button" type="button" onClick={() => playTestTone({ toneAt: Date.now() + 80 })}>Speaker test</button>
                  <button className="mini-button" type="button" onClick={forceWebAudioTest}>Test Web Audio</button>
                </div>
                {audioIssueState && <p className="audio-issue">{audioIssueState}</p>}
              </div>
            </details>
            </>}
          </aside>
        </main>
      </div>

      {roleState === "speaker" && !unlockedState && (
        <div className="gesture">
          <div className="gesture-card">
            <span className="gesture-mark">HC</span>
            <div>
              <h2>Turn this device into a speaker</h2>
              <p>One tap unlocks audio. Keep this page open while listening.</p>
            </div>
            <button
              className="gesture-primary-button"
              type="button"
              onTouchStart={() => {
                unlockAudio();
              }}
              onPointerDown={() => {
                unlockAudio();
              }}
              onClick={unlockAudio}
            >
              <Volume2 />
              Enable speaker
            </button>
            <span className="gesture-status">Audio engine: {audioContextState}</span>
            {audioIssueState && <strong>{audioIssueState}</strong>}
          </div>
        </div>
      )}
      <audio ref={mediaAudioRef} className="fallback-audio" preload="auto" playsInline aria-hidden="true" />
      <audio ref={liveAudioRef} className="fallback-audio" preload="auto" playsInline aria-hidden="true" />
    </>
  );

  async function playMediaTestTone() {
    const mediaAudio = mediaAudioRef.current;
    if (!mediaAudio) return;
    configureMediaElement(mediaAudio);
    const layer = layerById(stateRef.current.layers || [], selectedLayerIdRef.current) || stateRef.current.layers?.[0];
    if (!beepAudioUrlRef.current) beepAudioUrlRef.current = createToneWavUrl(740, 0.34);
    try {
      mediaAudio.pause();
      mediaAudio.src = beepAudioUrlRef.current;
      mediaAudio.dataset.layerKey = "";
      mediaAudio.currentTime = 0;
      mediaAudio.muted = false;
      await mediaAudio.play();
      await wait(380);
      mediaAudio.pause();
      if (layer) prepareMediaElement(layer);
    } catch (error) {
      setReadyStatus("Test blocked");
      setAudioIssueState(error?.message || "Safari blocked the speaker test.");
      if (layer) prepareMediaElement(layer);
    }
  }
}

function Countdown({ value }) {
  if (!value) return null;
  return (
    <div key={value} className="countdown active tick" aria-live="polite">
      {value}
    </div>
  );
}

function QrCode({ value }) {
  const modules = useMemo(() => createQrMatrix(value), [value]);
  const quiet = 4;
  const viewSize = modules.length + quiet * 2;
  return (
    <svg viewBox={`0 0 ${viewSize} ${viewSize}`} role="img" aria-label="Player join QR code">
      <rect width={viewSize} height={viewSize} fill="#f8fbf4" />
      {modules.map((row, y) =>
        row.map((dark, x) =>
          dark ? <rect key={`${x}-${y}`} x={x + quiet} y={y + quiet} width="1" height="1" fill="#11160f" /> : null
        )
      )}
    </svg>
  );
}

function DeviceHealthMonitor({ devices, roomDiagnostic, incidents }) {
  const roomState = roomDiagnostic?.state || "healthy";
  const roomLabel = roomDiagnostic?.label || (devices.length ? "Collecting device health" : "Room ready");
  return (
    <section className="device-health-monitor" aria-label="Room device health">
      <div className={`device-health-summary ${roomState}`}>
        <div>
          <span>Room health</span>
          <strong>{roomLabel}</strong>
        </div>
        <span className="health-live-label">Live diagnosis</span>
      </div>

      <div className="device-health-table" role="table" aria-label="Connection, audio, and synchronization health">
        <div className="device-health-row device-health-header" role="row">
          <span role="columnheader">Device</span>
          <span role="columnheader">Connection</span>
          <span role="columnheader">Audio</span>
          <span role="columnheader">Sync</span>
          <span role="columnheader">Current action</span>
        </div>
        {!devices.length && <div className="device-health-empty">Waiting for device telemetry...</div>}
        {devices.map((device) => {
          const diagnostic = device.diagnostic;
          return (
            <div className="device-health-row" role="row" key={`${device.role}-${device.id}`}>
              <div className="device-health-name" role="cell">
                <strong>{device.role === "capture" ? "Controller output" : device.name}</strong>
                <span>{device.role === "capture" ? "Source computer" : zoneNames[device.zone] || "Speaker"}</span>
              </div>
              <HealthLayerCell layer={diagnostic?.connection} fallback="Online" />
              <HealthLayerCell layer={diagnostic?.audio} fallback="Waiting" />
              <HealthLayerCell layer={diagnostic?.sync} fallback="Idle" />
              <div className="device-health-action" role="cell">
                <strong>{diagnostic?.overall?.action || "Collecting"}</strong>
                <span>{diagnostic?.overall?.reason || device.status || "Waiting for telemetry"}</span>
              </div>
            </div>
          );
        })}
      </div>

      <details className="device-health-events">
        <summary>
          <span>Recent events</span>
          <span>{incidents.length}</span>
        </summary>
        <div className="device-health-event-list">
          {!incidents.length && <span className="device-health-no-events">No health incidents in this session.</span>}
          {incidents.slice(0, 8).map((incident) => (
            <div className={`device-health-event ${incident.state || "healthy"}`} key={incident.id}>
              <time>{formatIncidentTime(incident.at)}</time>
              <strong>{incident.deviceName === "Chrome tab capture" ? "Controller output" : incident.deviceName}</strong>
              <span>{incident.label}</span>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}

function HealthLayerCell({ layer, fallback }) {
  const state = layer?.state || "unknown";
  return (
    <div className={`device-health-layer ${state}`} role="cell" title={layer?.reason || layer?.label || fallback}>
      <span aria-hidden="true" />
      <strong>{layer?.label || fallback}</strong>
    </div>
  );
}

function formatIncidentTime(value) {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function PeerCard({ peer, layers, onTest, onToggle, onReconnect, onOffset, onVolume }) {
  const layer = layerById(layers, peer.layerId);
  const offset = Math.round(Number(peer.deviceOffsetMs) || 0);
  const volume = clamp(Number(peer.volume ?? 1), 0, 1);
  const health = peer.muted ? "stopped" : peer.health || (peer.ready ? "ready" : peer.unlocked ? "connecting" : "locked");
  const diagnosticState = peer.diagnostic?.overall?.state;
  const hasIssue = health === "failed" || diagnosticState === "critical";
  const needsTap = health === "locked" || health === "needs-action";
  const refreshRequired = /refresh speaker page/i.test(peer.status || "");
  const recovering = /recovering|relocking|synchronizing|missed start|room restart/i.test(peer.status || "");
  const measuring = /measuring|locking/i.test(peer.status || "");
  const status = {
    ready: "Playing",
    stopped: "Stopped",
    failed: "Retry needed",
    locked: "Needs tap",
    "needs-action": "Needs tap",
    connecting: "Connecting"
  }[health] || "Connecting";
  const diagnosticStatus = ["warning", "critical", "repairing"].includes(diagnosticState)
    ? peer.diagnostic.overall.label
    : null;
  const displayStatus = refreshRequired
    ? "Refresh"
    : diagnosticStatus
      ? diagnosticStatus
      : recovering
        ? "Recovering"
        : measuring
          ? "Measuring"
          : status;
  return (
    <div className={`peer-card ${peer.muted ? "is-muted" : ""} ${hasIssue ? "has-issue" : ""}`}>
      <div className="peer-head">
        <strong>{peer.name}</strong>
        <span className={`status ${health === "ready" ? "ready" : ""} ${hasIssue ? "failed" : ""} ${health === "connecting" ? "waiting" : ""}`}>{displayStatus}</span>
      </div>
      {(hasIssue || needsTap || health === "connecting") && <p className={`peer-status-detail ${hasIssue ? "failed" : ""}`}>{peer.status || status}</p>}
      <div className="peer-grid">
        <span>Source</span>
        <strong>{layer?.name || "Live room audio"}</strong>
        <span>Position</span>
        <strong>{zoneNames[peer.zone] || "Front Left"}</strong>
        <span>Latency</span>
        <strong>{peer.latencyMs ? `${Math.round(peer.latencyMs)} ms` : "--"}</strong>
        <span>Output</span>
        <strong>{peer.outputLatencyMs ? `${Math.round(peer.outputLatencyMs)} ms` : "--"}</strong>
        <span>Compensation</span>
        <strong>{Number.isFinite(peer.postDelayMs) ? `${Math.round(peer.postDelayMs)} ms` : "--"}</strong>
        <span>Audio path</span>
        <strong>{formatPeerOutput(peer)}</strong>
        <span>Audio session</span>
        <strong>{formatPeerAudioSession(peer)}</strong>
        <span>Inbound</span>
        <strong>{peer.rtcBytesReceived > 0 ? "Receiving frames" : "--"}</strong>
        <span>Timing</span>
        <strong>
          {peer.timelineState === "locked"
            ? "Locked"
            : peer.timelineState === "recovering"
              ? "Recovering"
              : peer.timingStable
                ? `Stable${Number.isFinite(peer.timingSpreadMs) ? ` ±${Math.round(peer.timingSpreadMs)} ms` : ""}`
                : "Measuring"}
        </strong>
        <span>Sync</span>
        <strong>{Number.isFinite(peer.syncErrorMs) ? `${peer.syncErrorMs >= 0 ? "+" : ""}${Math.round(peer.syncErrorMs)} ms` : "--"}</strong>
      </div>
      <div className="peer-offset-row">
        <span>Timing offset</span>
        <div className="peer-stepper" aria-label={`Timing offset for ${peer.name}`}>
          <button type="button" aria-label={`Advance ${peer.name} by 10 milliseconds`} onClick={() => onOffset(offset - 10)}>−</button>
          <strong>{offset >= 0 ? "+" : ""}{offset} ms</strong>
          <button type="button" aria-label={`Delay ${peer.name} by 10 milliseconds`} onClick={() => onOffset(offset + 10)}>+</button>
        </div>
      </div>
      <div className="peer-volume-row">
        {volume > 0.001 ? <Volume2 size={15} /> : <VolumeX size={15} />}
        <label htmlFor={`peer-volume-${peer.id}`}>Volume</label>
        <input
          id={`peer-volume-${peer.id}`}
          type="range"
          min="0"
          max="100"
          step="5"
          value={Math.round(volume * 100)}
          aria-label={`Volume for ${peer.name}`}
          aria-valuetext={`${Math.round(volume * 100)} percent`}
          onChange={(event) => onVolume(Number(event.target.value) / 100)}
        />
        <strong>{Math.round(volume * 100)}%</strong>
      </div>
      <div className="peer-actions">
        <button className={`peer-toggle ${peer.muted ? "resume" : ""}`} type="button" onClick={onToggle}>
          {peer.muted ? <Volume2 /> : <VolumeX />}
          {peer.muted ? "Resume output" : "Stop output"}
        </button>
        <button className="peer-icon-button" type="button" title="Test tone" aria-label={`Test ${peer.name}`} onClick={onTest}>
          <Radio />
        </button>
        <button
          className={`peer-reconnect ${hasIssue ? "is-primary" : ""}`}
          type="button"
          title={needsTap ? "This device needs a local tap" : "Reconnect"}
          aria-label={`Reconnect ${peer.name}`}
          disabled={needsTap}
          onClick={onReconnect}
        >
          <RefreshCw /> Reconnect
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatPeerOutput(peer) {
  const labels = {
    "webrtc-stream-source": "Web Audio",
    "media-element-source": "Web Audio media",
    "html-media-element": "HTML audio",
    none: "Idle"
  };
  const output = labels[peer.outputPath] || "Unknown";
  if (peer.outputPath?.endsWith("source")) {
    return `${output} / ${peer.audioContextState === "running" ? "running" : "paused"}`;
  }
  if (peer.outputPath === "html-media-element" && peer.livePaused) return `${output} / paused`;
  return output;
}

function formatAudioSession(info) {
  if (!info?.supported) return "Browser default";
  return `${info.type} / ${info.state}`;
}

function formatPeerAudioSession(peer) {
  if (!peer.audioSessionType || peer.audioSessionType === "unavailable") return "Browser default";
  return `${peer.audioSessionType} / ${peer.audioSessionState || "unknown"}`;
}

function buildSyncLabel({ layers, selectedLayer, state, audioReady, audioLoading, countdown }) {
  if (!layers.length) return "Choose one or more stems on the host";
  if (audioLoading) return "Caching audio";
  if (!audioReady) return "Preparing audio";
  if (countdown) return `Starting in ${countdown}`;
  return state.playing ? `Playing: ${selectedLayer?.name || "default stem"}` : `Paused: ${selectedLayer?.name || "default stem"}`;
}

function deriveDeviceHealth({ role, status, muted, unlocked, live, hasLayer, audioReady }) {
  if (role === "controller") return "ready";
  if (muted) return "stopped";
  if (!unlocked) return "locked";

  const normalizedStatus = String(status || "").toLowerCase();
  if (/failed|signaling failed|connection lost|timed out/.test(normalizedStatus)) return "failed";
  if (/enable speaker again|blocked|unsupported|unavailable/.test(normalizedStatus)) return "needs-action";
  if (live) return normalizedStatus.startsWith("receiving ") ? "ready" : "connecting";
  if (!hasLayer || audioReady) return "ready";
  return "connecting";
}

function playerJoinUrl(url) {
  const playerUrl = new URL(url, location.href);
  playerUrl.pathname = "/";
  playerUrl.searchParams.set("mode", "player");
  playerUrl.hash = "";
  return playerUrl.toString();
}

function formatJoinAddress(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function formatMetric(value, unit) {
  return Number.isFinite(value) ? `${Math.round(value * 10) / 10} ${unit}` : "--";
}

function formatSignedMetric(value, unit) {
  return Number.isFinite(value)
    ? `${value >= 0 ? "+" : ""}${Math.round(value * 10) / 10} ${unit}`
    : "Collecting";
}

function detectDeviceInfo() {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  const touchPoints = navigator.maxTouchPoints || 0;
  const isIPad = /iPad/i.test(ua) || (platform === "MacIntel" && touchPoints > 1);
  const isIPhone = /iPhone|iPod/i.test(ua);
  const isIOS = isIPad || isIPhone;
  const isAndroid = /Android/i.test(ua);
  const isMobile = isIOS || isAndroid || /Mobile/i.test(ua);
  const device = isIPad ? "iPad" : isIPhone ? "iPhone" : isAndroid ? "Android" : isMobile ? "Mobile" : "Desktop";

  let browser = "Unknown";
  if (/CriOS/i.test(ua)) browser = isIOS ? "Chrome iOS" : "Chrome";
  else if (/FxiOS/i.test(ua)) browser = "Firefox iOS";
  else if (/EdgiOS/i.test(ua)) browser = "Edge iOS";
  else if (/Edg/i.test(ua)) browser = "Edge";
  else if (/OPR|Opera/i.test(ua)) browser = "Opera";
  else if (/Firefox/i.test(ua)) browser = "Firefox";
  else if (/Chrome|Chromium/i.test(ua)) browser = "Chrome";
  else if (/Safari/i.test(ua)) browser = "Safari";

  let engine = "Unknown";
  if (isIOS || /Safari/i.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/i.test(ua)) engine = "WebKit";
  else if (/Firefox/i.test(ua)) engine = "Gecko";
  else if (/Chrome|Chromium|Edg|OPR|Opera/i.test(ua)) engine = "Blink";

  return {
    device,
    browser,
    engine,
    isIOS
  };
}

function currentDeviceName() {
  return localStorage.getItem("deviceName") || createDeviceName();
}

function createDeviceName() {
  const generated = `${navigator.platform || "Device"} ${Math.floor(Math.random() * 900 + 100)}`;
  localStorage.setItem("deviceName", generated);
  return generated;
}

function currentDeviceKey() {
  let key = localStorage.getItem("deviceKey");
  if (!key) {
    key = crypto.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem("deviceKey", key);
  }
  return key;
}

function layerById(layers, layerId) {
  return (layers || []).find((layer) => layer.id === layerId);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = Math.floor(safe % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function estimateOutputLatencySeconds(audioContext) {
  if (!audioContext) return 0;
  const baseLatency = Number(audioContext.baseLatency || 0);
  const outputLatency = Number(audioContext.outputLatency || 0);
  return Math.max(0, baseLatency + outputLatency);
}

function getUsableOutputTimestamp(audioContext) {
  if (!audioContext?.getOutputTimestamp) return null;
  try {
    const timestamp = audioContext.getOutputTimestamp();
    if (
      Number.isFinite(timestamp?.contextTime) &&
      Number.isFinite(timestamp?.performanceTime) &&
      timestamp.performanceTime > 0
    ) {
      return timestamp;
    }
  } catch {}
  return null;
}

function contextTimeForAudibleEpoch(audioContext, targetEpochMs) {
  if (!audioContext) return 0;
  const targetPerformanceMs = targetEpochMs - performance.timeOrigin;
  const timestamp = getUsableOutputTimestamp(audioContext);
  if (timestamp) {
    return timestamp.contextTime + (targetPerformanceMs - timestamp.performanceTime) / 1000;
  }

  const timeUntilTarget = (targetPerformanceMs - performance.now()) / 1000;
  return audioContext.currentTime + timeUntilTarget - estimateOutputLatencySeconds(audioContext);
}

function audibleAudioContextTime(audioContext) {
  const timestamp = getUsableOutputTimestamp(audioContext);
  if (timestamp) return timestamp.contextTime;
  return Math.max(0, audioContext.currentTime - estimateOutputLatencySeconds(audioContext));
}

function primeAudioHardware(audioContext, outputNode, durationSeconds = 0.06, gain = 0.0008) {
  return new Promise((resolve) => {
    const oscillator = audioContext.createOscillator();
    const primeGain = audioContext.createGain();
    const startedAt = audioContext.currentTime;
    const duration = Math.max(0.03, durationSeconds);
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      try {
        oscillator.disconnect();
        primeGain.disconnect();
      } catch {}
      resolve();
    };

    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    primeGain.gain.setValueAtTime(gain, startedAt);
    primeGain.gain.linearRampToValueAtTime(0.0001, startedAt + duration);
    oscillator.connect(primeGain).connect(outputNode || audioContext.destination);
    oscillator.onended = done;
    oscillator.start(startedAt);
    oscillator.stop(startedAt + duration);
    setTimeout(done, duration * 1000 + 100);
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms) {
  return Promise.race([promise, wait(ms)]);
}

function mediaLayerUrl(layer) {
  return `/audio?layer=${encodeURIComponent(layer.id)}&v=${layer.version}`;
}

function configureMediaElement(mediaAudio) {
  mediaAudio.preload = "auto";
  mediaAudio.playsInline = true;
  mediaAudio.setAttribute("playsinline", "");
  mediaAudio.setAttribute("webkit-playsinline", "");
}

function createSilentWavUrl() {
  return createToneWavUrl(0, 0.12, 0);
}

function createToneWavUrl(frequency = 740, durationSeconds = 0.32, gain = 0.35) {
  const sampleRate = 44100;
  const frameCount = Math.max(1, Math.floor(sampleRate * durationSeconds));
  const dataSize = frameCount * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);
  for (let index = 0; index < frameCount; index += 1) {
    const envelope = Math.min(1, index / 420, (frameCount - index) / 1200);
    const sample = frequency ? Math.sin((2 * Math.PI * frequency * index) / sampleRate) * gain * envelope : 0;
    view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, sample)) * 0x7fff, true);
  }
  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

function decodeAudioBuffer(audioContext, bytes) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (buffer) => {
      if (settled) return;
      settled = true;
      resolve(buffer);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    try {
      const result = audioContext.decodeAudioData(bytes.slice(0), finish, fail);
      if (result?.then) result.then(finish, fail);
    } catch (error) {
      fail(error);
    }
  });
}
