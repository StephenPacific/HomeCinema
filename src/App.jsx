import { Copy, Pause, Play, RotateCw, Square, Upload, Volume2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createQrMatrix } from "./qr.js";
import { localPlaybackTiming } from "./playback-timing.js";
import { LiveAudioPlayer } from "./live-audio.js";
import { LiveClockSync } from "./live-clock.js";

const EMPTY_STATE = {
  track: null,
  layers: [],
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
  const isPlayerView = useMemo(() => new URLSearchParams(location.search).get("mode") === "player", []);
  const [audioMode, setAudioMode] = useState(() => {
    const requested = new URLSearchParams(location.search).get("source");
    if (["live", "files"].includes(requested)) return requested;
    const previous = localStorage.getItem("audioMode");
    return ["live", "files"].includes(previous) ? previous : "live";
  });
  const [isHostMachine, setIsHostMachine] = useState(() => isLoopbackHost() ? true : null);
  const [liveStatus, setLiveStatus] = useState({ active: false, sourceConnected: false, reason: "Waiting for the Mac" });
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [liveAudioState, setLiveAudioState] = useState("off");
  const [liveIssue, setLiveIssue] = useState("");
  const [liveBufferMs, setLiveBufferMs] = useState(500);
  const [liveTrimMs, setLiveTrimMs] = useState(() => clamp(Number(localStorage.getItem("liveTrimMs")) || 0, -200, 200));
  const [liveStats, setLiveStats] = useState({ queueMs: 0, underruns: 0, droppedMs: 0, playing: false });
  const [nativeDevices, setNativeDevices] = useState({ outputs: [], inputs: [] });
  const [nativeOutputs, setNativeOutputs] = useState([]);
  const [nativeMicrophone, setNativeMicrophone] = useState("");
  const [nativeCalibrate, setNativeCalibrate] = useState(false);
  const [nativeBusy, setNativeBusy] = useState(false);
  const [nativeIssue, setNativeIssue] = useState("");
  const [nativeNotice, setNativeNotice] = useState("");
  const [connected, setConnected] = useState(false);
  const [serverState, setServerState] = useState(EMPTY_STATE);
  const [peers, setPeers] = useState([]);
  const [joinUrls, setJoinUrls] = useState([]);
  const [roleState, setRoleState] = useState(() =>
    isPlayerView ? "speaker" : localStorage.getItem("role") || "controller"
  );
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
  const [audioContextState, setAudioContextState] = useState("none");
  const [playbackEngineState, setPlaybackEngineState] = useState("Web Audio");
  const [audioIssueState, setAudioIssueState] = useState("");
  const [mediaNeedsGestureState, setMediaNeedsGestureState] = useState(false);
  const [webAudioTestState, setWebAudioTestState] = useState("Not tested");
  const [driftState, setDriftState] = useState(null);
  const [correctionCountState, setCorrectionCountState] = useState(0);
  const [lastCorrectionState, setLastCorrectionState] = useState("--");
  const [lastStartDelayState, setLastStartDelayState] = useState(null);
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
  const unlockedRef = useRef(unlockedState);
  const audioReadyRef = useRef(audioReadyState);
  const audioContextRef = useRef(null);
  const gainRef = useRef(null);
  const audioBufferRef = useRef(null);
  const bufferPeakRef = useRef(null);
  const sourceRef = useRef(null);
  const activeSourcesRef = useRef(new Set());
  const mediaAudioRef = useRef(null);
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
  const handleMessageRef = useRef(null);
  const audioModeRef = useRef(audioMode);
  const liveContextRef = useRef(null);
  const livePlayerRef = useRef(null);
  const liveSocketRef = useRef(null);
  const liveReconnectRef = useRef(null);
  const liveEnabledRef = useRef(false);
  const liveEpochRef = useRef(null);
  const liveStatusRef = useRef(liveStatus);
  const nativeActionEpochRef = useRef(0);
  const nativeActionPendingRef = useRef(false);
  const liveClockRef = useRef(null);
  if (!liveClockRef.current) liveClockRef.current = new LiveClockSync();
  const liveClockProbeTimersRef = useRef(new Set());

  const layers = serverState.layers || [];
  const selectedLayer = layerById(layers, selectedLayerIdState) || layers[0] || null;
  const trackLabel = layers.length > 1 ? `${layers.length} stems` : serverState.track?.name || "No track loaded";
  const nativeCanStop = Boolean(liveStatus.processRunning || liveStatus.sourceConnected || ["starting", "calibrating"].includes(liveStatus.phase));
  const hostCommonTimeline = isHostMachine === true && ["HCA2", 2].includes(liveStatus.protocol);
  const showCommonTimeline = hostCommonTimeline || ["common-timeline", "waiting-for-clock"].includes(liveStats.syncMode);
  const localTrackEnded = audioReadyState && Number.isFinite(durationState) && durationState > 0 && positionState >= durationState;
  const syncLabel = buildSyncLabel({
    layers,
    selectedLayer,
    state: serverState,
    audioReady: audioReadyState,
    audioLoading,
    countdown: countdownState,
    localTrackEnded
  });

  useEffect(() => {
    document.body.classList.toggle("player-view", isPlayerView);
    return () => document.body.classList.remove("player-view");
  }, [isPlayerView]);

  useEffect(() => {
    document.body.dataset.role = roleState;
  }, [roleState]);

  const send = useCallback((message) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(message));
    }
  }, []);

  const reportStatusNow = useCallback(() => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return;
    const state = stateRef.current;
    const layer = layerById(state.layers || [], selectedLayerIdRef.current) || state.layers?.[0] || null;
    const receivingLive = audioModeRef.current === "live";
    const currentLiveStats = livePlayerRef.current?.getStats();
    const session = audioSessionDiagnostics();
    send({
      type: "identify",
      role: roleRef.current,
      name: deviceNameRef.current,
      deviceKey: currentDeviceKey(),
      layerId: selectedLayerIdRef.current,
      zone: selectedZoneRef.current,
      ready: receivingLive ? Boolean(currentLiveStats?.playing) : Boolean(unlockedRef.current && (!layer || audioReadyRef.current)
        && (playbackEngineRef.current !== "web-audio" || audioContextRef.current?.state === "running")),
      unlocked: receivingLive ? liveEnabledRef.current : unlockedRef.current,
      latencyMs: Math.round(latencyRef.current || 0),
      deviceOffsetMs: deviceOffsetRef.current,
      audioDiagnostics: {
        engine: receivingLive ? "live-pcm" : playbackEngineRef.current,
        contextState: (receivingLive ? liveContextRef.current : audioContextRef.current)?.state ?? "none",
        contextTime: (receivingLive ? liveContextRef.current : audioContextRef.current)?.currentTime ?? null,
        bufferDuration: audioBufferRef.current?.duration ?? null,
        bufferFrames: audioBufferRef.current?.length ?? null,
        bufferSampleRate: audioBufferRef.current?.sampleRate ?? null,
        bufferPeak: audioBufferRef.current ? bufferPeakRef.current : null,
        sourceActive: receivingLive ? Boolean(currentLiveStats?.playing) : Boolean(sourceRef.current),
        gain: receivingLive ? livePlayerRef.current?.output.gain.value ?? null : gainRef.current?.gain.value ?? null,
        scheduledContextTime: localPlaybackRef.current?.contextStartedAt ?? null,
        scheduledOffset: localPlaybackRef.current?.offset ?? null,
        mediaPaused: mediaAudioRef.current?.paused ?? null,
        mediaTime: mediaAudioRef.current?.currentTime ?? null,
        liveQueueMs: currentLiveStats?.queueMs ?? null,
        liveUnderruns: currentLiveStats?.underruns ?? null,
        liveDroppedMs: currentLiveStats?.droppedMs ?? null,
        liveInputPeak: currentLiveStats?.inputPeak ?? null,
        sessionType: session.type,
        sessionState: session.state,
        syncMode: currentLiveStats?.syncMode ?? null,
        timingErrorMs: currentLiveStats?.timingErrorMs ?? null,
        lateDrops: currentLiveStats?.lateDrops ?? null,
        clockRTT: currentLiveStats?.clockRTT ?? null,
        targetDelay: currentLiveStats?.targetDelay ?? null,
        clockMethod: currentLiveStats?.clockMethod ?? null,
        liveTrimMs: currentLiveStats?.localTrimMs ?? null
      }
    });
  }, [send]);

  const reportStatusSoon = useCallback(() => {
    clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(reportStatusNow, 120);
  }, [reportStatusNow]);

  const calibrateLiveClock = useCallback((samples = 10) => {
    for (let index = 0; index < samples; index += 1) {
      const timer = setTimeout(() => {
        liveClockProbeTimersRef.current.delete(timer);
        send({ type: "liveTime", clientSent: performance.now() });
      }, index * 70);
      liveClockProbeTimersRef.current.add(timer);
    }
  }, [send]);

  useEffect(() => {
    if (!liveEnabled) return;
    calibrateLiveClock(10);
    const timer = setInterval(() => calibrateLiveClock(5), 10000);
    return () => clearInterval(timer);
  }, [liveEnabled, calibrateLiveClock]);

  const receiveLiveStatus = useCallback((status) => {
    if (!status || typeof status !== "object") return;
    // Receiver heartbeats contain relay fields only; keep native process
    // control state until a status update explicitly supplies those fields.
    liveStatusRef.current = { ...liveStatusRef.current, ...status };
    setLiveStatus((previous) => ({ ...previous, ...status }));
    if (status.sourceEpoch != null) {
      if (liveEpochRef.current !== null && liveEpochRef.current !== status.sourceEpoch) livePlayerRef.current?.reset();
      liveEpochRef.current = status.sourceEpoch;
    }
    if (status.active === false) {
      // A connected publisher may have stalled. Never retain old sound merely
      // because its HTTP connection is still open.
      livePlayerRef.current?.reset();
      if (livePlayerRef.current) setLiveStats(livePlayerRef.current.getStats());
      if (liveEnabledRef.current && liveContextRef.current?.state === "running") setLiveAudioState("waiting");
    }
  }, []);

  const connectLiveSocket = useCallback(() => {
    if (!liveEnabledRef.current || audioModeRef.current !== "live") return;
    clearTimeout(liveReconnectRef.current);
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/live/audio`);
    socket.binaryType = "arraybuffer";
    liveSocketRef.current = socket;
    socket.addEventListener("message", (event) => {
      if (liveSocketRef.current !== socket || !liveEnabledRef.current) return;
      try {
        if (typeof event.data === "string") {
          const message = JSON.parse(event.data);
          if (message.type === "liveStatus") receiveLiveStatus(message.live || message.status || message);
        } else {
          livePlayerRef.current?.push(event.data);
        }
      } catch {
        livePlayerRef.current?.reset();
        setLiveIssue("The audio stream was interrupted. Waiting for fresh audio.");
      }
    });
    socket.addEventListener("open", () => setLiveIssue(""));
    socket.addEventListener("close", () => {
      if (liveSocketRef.current !== socket) return;
      livePlayerRef.current?.reset();
      liveSocketRef.current = null;
      if (liveEnabledRef.current && audioModeRef.current === "live") {
        setLiveAudioState("buffering");
        setLiveIssue("Connection interrupted. Reconnecting…");
        liveReconnectRef.current = setTimeout(connectLiveSocket, 1000);
      }
    });
    socket.addEventListener("error", () => setLiveIssue("Could not reach the Mac. Check the Wi-Fi connection."));
  }, [receiveLiveStatus]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const epoch = nativeActionEpochRef.current;
      try {
        const response = await fetch("/live/status", { cache: "no-store" });
        if (response.ok) {
          const status = await response.json();
          if (active && !nativeActionPendingRef.current && epoch === nativeActionEpochRef.current) receiveLiveStatus(status);
        }
      } catch {}
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [receiveLiveStatus]);

  useEffect(() => {
    if (!liveEnabled) return;
    const timer = setInterval(() => {
      const stats = livePlayerRef.current?.getStats();
      if (stats) setLiveStats(stats);
      const state = liveContextRef.current?.state;
      setLiveAudioState(state !== "running" ? "paused" : stats?.playing ? "playing" : liveStatusRef.current.active ? "buffering" : "waiting");
    }, 500);
    return () => clearInterval(timer);
  }, [liveEnabled]);

  useEffect(() => {
    if (audioMode === "live" && isHostMachine === true) refreshNativeDevices();
  }, [audioMode, isHostMachine]);

  useEffect(() => () => {
    liveEnabledRef.current = false;
    clearTimeout(liveReconnectRef.current);
    liveSocketRef.current?.close();
    livePlayerRef.current?.close();
    liveContextRef.current?.close().catch(() => {});
    for (const timer of liveClockProbeTimersRef.current) clearTimeout(timer);
    liveClockProbeTimersRef.current.clear();
  }, []);

  const setRole = useCallback(
    (nextRole) => {
      roleRef.current = nextRole;
      setRoleState(nextRole);
      if (!isPlayerView) localStorage.setItem("role", nextRole);
      reportStatusSoon();
    },
    [isPlayerView, reportStatusSoon]
  );

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

  const createAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      const AudioApi = window.AudioContext || window.webkitAudioContext;
      if (!AudioApi) throw new Error("Web Audio is not supported on this browser");
      try {
        audioContextRef.current = new AudioApi({ latencyHint: "interactive" });
      } catch {
        audioContextRef.current = new AudioApi();
      }
      gainRef.current = audioContextRef.current.createGain();
      gainRef.current.gain.value = 1;
      gainRef.current.connect(audioContextRef.current.destination);
      setAudioContextState(audioContextRef.current.state || "unknown");
      audioContextRef.current.addEventListener?.("statechange", () => {
        setAudioContextState(audioContextRef.current?.state || "closed");
      });
    }
    setAudioContextState(audioContextRef.current.state || "unknown");
    return audioContextRef.current;
  }, []);

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
            mediaAudio.playbackRate = 1;
            mediaAudio.currentTime = Math.max(0, offsetSeconds);
          } catch {}
          const playPromise = mediaAudio.play();
          if (playPromise?.catch) {
            playPromise.catch((error) => {
              setMediaNeedsGestureState(true);
              setReadyStatus("Tap Resume audio");
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
      if (gainRef.current) gainRef.current.gain.value = 1;

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
      return localPlaybackTiming(stateRef.current, {
        serverOffsetMs: serverOffsetRef.current,
        deviceOffsetMs: deviceOffsetRef.current,
        durationSeconds: audioBufferRef.current?.duration || mediaAudioRef.current?.duration || durationState
      }).position;
  }, [durationState]);

  const currentLocalPosition = useCallback(() => {
    if (playbackEngineRef.current === "media-element") {
      return mediaAudioRef.current?.currentTime || stateRef.current?.position || 0;
    }
    const localPlayback = localPlaybackRef.current;
    const audioContext = audioContextRef.current;
    if (!localPlayback || !audioContext) return stateRef.current?.position || 0;
    return localPlayback.offset + Math.max(0, audioContext.currentTime - localPlayback.contextStartedAt);
  }, []);

  const updateCountdown = useCallback((seconds) => {
    const safe = Math.max(0, Number(seconds) || 0);
    setCountdownState(safe > 0.05 ? Math.max(1, Math.ceil(safe)) : null);
  }, []);

  const scheduleFromState = useCallback(
    (force = false) => {
      if (audioModeRef.current !== "files") return;
      const state = stateRef.current;
      const audioBuffer = audioBufferRef.current;
      const mediaAudio = mediaAudioRef.current;
      const mediaMode = playbackEngineRef.current === "media-element";
      if (!state?.playing || !state.startedAt || !unlockedRef.current) return;
      if (!mediaMode && !audioBuffer) return;
      if (mediaMode && !mediaAudio) return;

      const timing = localPlaybackTiming(state, {
        serverOffsetMs: serverOffsetRef.current,
        deviceOffsetMs: deviceOffsetRef.current,
        durationSeconds: audioBuffer?.duration || mediaAudio?.duration || durationState
      });
      if (timing.atEnd) {
        // Do not replay a clipped tail on every server sync, or stop longer
        // stems on other devices by changing the shared playback state.
        stopLocalSource();
        setPositionState(timing.position);
        setCountdownState(null);
        setReadyStatus("Track ended");
        return;
      }
      const expected = timing.position;
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
      const delaySeconds = Math.max(0, (adjustedTargetLocalMs - Date.now()) / 1000);
      setLastStartDelayState(Math.round(delaySeconds * 1000));
      const offsetSeconds = timing.rawPosition;

      if (localPlaybackRef.current) {
        correctionCountRef.current += 1;
        setCorrectionCountState(correctionCountRef.current);
        setLastCorrectionState(mediaMode ? "HTML audio seek" : "Web Audio restart");
      }

      startLocalSource(delaySeconds, offsetSeconds);
      setReadyStatus("Ready");
      updateCountdown(delaySeconds);
    },
    [currentLocalPosition, durationState, startLocalSource, stopLocalSource, updateCountdown]
  );

  const loadAudio = useCallback(
    async (layer) => {
      if (audioModeRef.current !== "files") return;
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

        bufferPeakRef.current = sampledAudioPeak(decoded);
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
      if (audioModeRef.current !== "files") {
        stopLocalSource();
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
    [ensureSelectedLayer, loadAudio, scheduleFromState, stopLocalSource]
  );

  const receiveTimeSample = useCallback(
    (message) => {
      const now = Date.now();
      const rtt = now - message.clientSent;
      const midpoint = message.clientSent + rtt / 2;
      const offset = message.serverTime - midpoint;
      if (!Number.isFinite(offset)) return;

      let nextOffset;
      let nextLatency;
      if (!latencyRef.current || rtt < latencyRef.current + 12) {
        nextOffset = offset;
        nextLatency = rtt;
      } else {
        nextOffset = serverOffsetRef.current * 0.85 + offset * 0.15;
        nextLatency = latencyRef.current * 0.85 + rtt * 0.15;
      }

      serverOffsetRef.current = nextOffset;
      latencyRef.current = nextLatency;
      setServerOffsetState(nextOffset);
      setLatencyState(nextLatency);
      reportStatusSoon();
    },
    [reportStatusSoon]
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
        reportStatusSoon();
        return;
      }
      if (message.type === "time") {
        receiveTimeSample(message);
        return;
      }
      if (message.type === "liveTime") {
        if (liveClockRef.current.record(message, performance.now())) {
          livePlayerRef.current?.setClockMapping(liveClockRef.current.mapping());
          reportStatusSoon();
        }
        return;
      }
      if (message.type === "peers") {
        setPeers(message.peers || []);
        return;
      }
      if (message.type === "testTone") {
        if (audioModeRef.current === "files") playTestTone(message);
        return;
      }
      if (message.type === "live") {
        receiveLiveStatus(message.live);
        return;
      }
      if (message.type === "track" || message.type === "sync" || message.type === "lead") {
        applyState(message.state);
        if (message.type === "sync") reportStatusSoon();
        return;
      }
      if (["play", "pause", "stop", "seek"].includes(message.type)) {
        applyState(message.state, true);
      }
    },
    [applyState, receiveTimeSample, receiveLiveStatus, reportStatusSoon]
  );

  handleMessageRef.current = handleMessage;

  const connect = useCallback(() => {
    shuttingDownRef.current = false;
    clearTimeout(reconnectTimerRef.current);
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}`);
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      setConnected(true);
      reportStatusNow();
      calibrateClock(10);
      calibrateLiveClock(10);
    });
    socket.addEventListener("message", (event) => {
      handleMessageRef.current?.(JSON.parse(event.data));
    });
    socket.addEventListener("close", () => {
      setConnected(false);
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
    socket.addEventListener("error", () => setConnected(false));
  }, [calibrateClock, calibrateLiveClock, expectedPosition, reportStatusNow, stopLocalSource]);

  const closeSocket = useCallback(() => {
    shuttingDownRef.current = true;
    clearTimeout(reconnectTimerRef.current);
    try {
      socketRef.current?.close(1000, "page unload");
    } catch {}
  }, []);

  useEffect(() => {
    connect();
    loadConfig().then(({ leadMs }) => setLeadState(leadMs || 3000));
    return () => closeSocket();
  }, [closeSocket, connect]);

  useEffect(() => {
    const onPageHide = () => closeSocket();
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onPageHide);
    };
  }, [closeSocket]);

  useEffect(() => {
    const timer = setInterval(() => {
      const state = stateRef.current;
      if (!state || seekingRef.current) return;
      const position = expectedPosition();
      const duration = mediaAudioRef.current?.duration;
      const mediaEnded = Number.isFinite(duration) && duration > 0 && position >= duration;
      setMediaNeedsGestureState(Boolean(
        state.playing && unlockedRef.current && playbackEngineRef.current === "media-element"
        && mediaAudioRef.current?.paused && !mediaPlaybackTimerRef.current && !mediaEnded
      ));
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
    const urls = (config.addresses.length ? config.addresses : [location.origin]).map((url) => playerJoinUrl(url, audioModeRef.current));
    setJoinUrls(urls);
    setIsHostMachine(Boolean(config.isHostMachine || isLoopbackHost()));
    return config;
  }

  function stopLiveAudio() {
    liveEnabledRef.current = false;
    setLiveEnabled(false);
    clearTimeout(liveReconnectRef.current);
    liveSocketRef.current?.close();
    liveSocketRef.current = null;
    livePlayerRef.current?.close();
    livePlayerRef.current = null;
    liveContextRef.current?.close().catch(() => {});
    liveContextRef.current = null;
    setLiveAudioState("off");
    setLiveIssue("");
    setLiveStats({ queueMs: 0, underruns: 0, droppedMs: 0, playing: false });
    reportStatusSoon();
  }

  function selectAudioMode(mode) {
    audioModeRef.current = mode;
    setAudioMode(mode);
    localStorage.setItem("audioMode", mode);
    setJoinUrls((urls) => urls.map((url) => playerJoinUrl(url, mode)));
    if (mode === "live") stopLocalSource();
    else {
      stopLiveAudio();
      applyState(stateRef.current, true);
    }
    reportStatusSoon();
  }

  async function enableLiveAudio() {
    if (isHostMachine !== false) return;
    setPlaybackAudioSession();
    stopLocalSource();
    setLiveIssue("");
    setLiveAudioState("starting");
    liveEnabledRef.current = true;
    setLiveEnabled(true);
    try {
      if (!liveContextRef.current || liveContextRef.current.state === "closed") {
        const AudioApi = window.AudioContext || window.webkitAudioContext;
        if (!AudioApi) throw new Error("This browser cannot play live audio. Open this page in Safari or Chrome.");
        liveContextRef.current = new AudioApi({ latencyHint: "playback" });
        livePlayerRef.current = new LiveAudioPlayer(liveContextRef.current, { bufferMs: liveBufferMs, localTrimMs: liveTrimMs });
        livePlayerRef.current.setClockMapping(liveClockRef.current.mapping());
      } else {
        livePlayerRef.current?.reset();
      }
      const context = liveContextRef.current;
      const prime = primeAudioHardware(context, context.destination, 0.04, 0.0001);
      const resumed = context.resume(); // Invoked synchronously by this device's click.
      await withTimeout(resumed, 1200);
      await prime;
      if (!liveEnabledRef.current || audioModeRef.current !== "live") return;
      if (context.state !== "running") throw new Error("Tap Resume live audio on this device to start its speaker.");
      if (!liveSocketRef.current || liveSocketRef.current.readyState > WebSocket.OPEN) connectLiveSocket();
      setLiveAudioState("buffering");
      reportStatusSoon();
    } catch (error) {
      setLiveAudioState("paused");
      setLiveIssue(error?.message || "Tap Resume live audio to start the speaker.");
    }
  }

  async function refreshNativeDevices() {
    if (isHostMachine !== true) return;
    setNativeIssue("");
    try {
      const response = await fetch("/live/devices", { cache: "no-store" });
      const devices = await response.json();
      if (!response.ok) throw new Error(devices.error || "Could not list the Mac's speakers.");
      setNativeDevices(devices);
      const available = new Set(devices.outputs.map((output) => output.uid));
      const defaults = devices.outputs.filter((output) => output.uid === "BuiltInSpeakerDevice"
        || String(output.transport).toLowerCase().includes("bluetooth")).map((output) => output.uid);
      if (!defaults.length && devices.outputs.length) defaults.push((devices.outputs.find((output) => output.isDefault) || devices.outputs[0]).uid);
      setNativeOutputs((current) => {
        const retained = current.filter((uid) => available.has(uid));
        return retained.length ? retained : defaults;
      });
      setNativeMicrophone((current) => devices.inputs.some((input) => input.uid === current) ? current
        : devices.recommendedMicrophoneUID || devices.inputs[0]?.uid || "");
    } catch (error) {
      setNativeIssue(error?.message || "Could not list the Mac's speakers.");
    }
  }

  function adjustLiveTrim(value) {
    const next = clamp(value, -200, 200);
    setLiveTrimMs(next);
    localStorage.setItem("liveTrimMs", String(next));
    livePlayerRef.current?.setLocalTrimMs(next);
    reportStatusSoon();
  }

  async function controlSystemAudio(action) {
    if (isHostMachine !== true || nativeBusy) return;
    const epoch = ++nativeActionEpochRef.current;
    nativeActionPendingRef.current = true;
    setNativeBusy(true);
    setNativeIssue("");
    setNativeNotice("");
    try {
      const response = await fetch(`/live/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "start" ? {
          outputs: nativeOutputs,
          ...(nativeMicrophone ? { microphoneUID: nativeMicrophone } : {}),
          calibrate: nativeCalibrate,
          syncDelayMs: 700,
          seconds: 7200
        } : {})
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Could not ${action} system audio.`);
      receiveLiveStatus(result.live || result.status || result);
      if (action === "stop") setNativeNotice("Sharing stopped. Music can still play in its original Mac app.");
    } catch (error) {
      setNativeIssue(error?.message || "Could not change system audio playback.");
    } finally {
      if (epoch === nativeActionEpochRef.current) {
        nativeActionPendingRef.current = false;
        setNativeBusy(false);
      }
    }
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
    deviceOffsetRef.current = nextOffset;
    setDeviceOffsetState(nextOffset);
    localStorage.setItem("deviceOffsetMs", String(nextOffset));
    reportStatusSoon();
    if (stateRef.current?.playing) scheduleFromState(true);
  }

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

  async function resumeWebAudioFromGesture(durationSeconds = 0.06, gain = 0.0008) {
    setPlaybackAudioSession();
    const audioContext = createAudioContext();
    if (gainRef.current) gainRef.current.gain.value = 1;
    const primeDone = primeAudioHardware(audioContext, gainRef.current || audioContext.destination, durationSeconds, gain);
    if (audioContext.state !== "running") await withTimeout(audioContext.resume(), 1200);
    await primeDone;
    if (audioContext.state !== "running") await withTimeout(audioContext.resume(), 1200);
    await wait(100);
    setAudioContextState(audioContext.state || "unknown");
    if (audioContext.state !== "running") throw new Error("Audio output did not start. Tap Enable speaker again.");
    return audioContext;
  }

  async function unlockAudio() {
    if (unlockingRef.current) return;
    unlockingRef.current = true;
    setAudioIssueState("");
    setReadyStatus("Unlocking");

    try {
      const layer = layerById(stateRef.current.layers || [], selectedLayerIdRef.current) || stateRef.current.layers?.[0];
      let webAudioUnlocked = false;
      try {
        await resumeWebAudioFromGesture();
        webAudioUnlocked = true;
      } catch {
        setAudioContextState(audioContextRef.current?.state || "unknown");
      }

      if (webAudioUnlocked) {
        playbackEngineRef.current = "web-audio";
        setPlaybackEngineState("Web Audio");
      } else {
        await unlockMediaElement(layer);
        playbackEngineRef.current = "media-element";
        setPlaybackEngineState("HTML audio");
        setAudioIssueState("Using an alternate audio path. If music is silent, tap Resume audio on this device.");
      }

      unlockedRef.current = true;
      setUnlockedState(true);
      setReadyStatus(audioReadyRef.current ? "Ready" : "No audio");
      reportStatusSoon();

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
      await resumeWebAudioFromGesture(0.16, 0.18);

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

  function resumeMediaAudioFromGesture() {
    const state = stateRef.current;
    const mediaAudio = mediaAudioRef.current;
    if (!state.playing || playbackEngineRef.current !== "media-element" || !mediaAudio) return;
    const layer = layerById(state.layers || [], selectedLayerIdRef.current) || state.layers?.[0];
    if (!layer) return;
    prepareMediaElement(layer);
    const timing = localPlaybackTiming(state, {
      serverOffsetMs: serverOffsetRef.current,
      deviceOffsetMs: deviceOffsetRef.current,
      durationSeconds: mediaAudio.duration || durationState
    });
    if (timing.atEnd) return;
    try {
      mediaAudio.muted = false;
      try { mediaAudio.currentTime = timing.rawPosition; } catch {}
      // Call play synchronously from this local click, before any awaits. A
      // remote transport command does not carry this browser's user gesture.
      const playPromise = mediaAudio.play();
      Promise.resolve(playPromise).then(() => {
        if (!stateRef.current.playing) {
          mediaAudio.pause();
          return;
        }
        setMediaNeedsGestureState(false);
        setReadyStatus("Ready");
        setAudioIssueState("");
        localPlaybackRef.current = { mode: "media-element", startedAtMs: Date.now(), offset: timing.rawPosition };
        reportStatusSoon();
      }).catch((error) => {
        setMediaNeedsGestureState(true);
        setReadyStatus("Tap Resume audio");
        setAudioIssueState(error?.message || "Audio did not start. Tap Resume audio again.");
      });
    } catch (error) {
      setMediaNeedsGestureState(true);
      setReadyStatus("Tap Resume audio");
      setAudioIssueState(error?.message || "Audio did not start. Tap Resume audio again.");
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
    const timing = localPlaybackTiming(state, {
      serverOffsetMs: serverOffsetRef.current,
      deviceOffsetMs: deviceOffsetRef.current,
      durationSeconds: audioBufferRef.current?.duration || mediaAudioRef.current?.duration || durationState
    });
    if (timing.atEnd) {
      send({ type: "play", position: 0 });
      return;
    }
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

  function resyncAll() {
    calibrateClock(10);
    if (stateRef.current?.playing) {
      send({ type: "resync" });
    } else {
      scheduleFromState(true);
    }
  }

  function commitSeek() {
    if (!seekingRef.current) return;
    seekingRef.current = false;
    send({ type: "seek", position: Number(positionState || 0) });
  }

  async function playTestTone(message = {}) {
    if (message.targetId && message.targetId !== clientIdRef.current) return;
    if (!unlockedRef.current) {
      setReadyStatus("Enable speaker first");
      return;
    }
    if (playbackEngineRef.current === "media-element" || audioContextRef.current?.state !== "running") {
      await playMediaTestTone();
      return;
    }
    await ensureAudioContext();
    if (gainRef.current) gainRef.current.gain.value = 1;
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
      <main className="app">
        <section className="stage" aria-label="Synchronized playback console">
          <div className="topbar">
            <div>
              <p className="eyebrow">LAN SYNC</p>
              <h1>Home Cinema</h1>
            </div>
            <div className="connection">
              <span className={`dot ${connected ? "connected" : ""}`} />
              <span>{connected ? "Connected" : "Reconnecting"}</span>
            </div>
          </div>

          <div className="segmented" role="group" aria-label="Audio source">
            <button className={audioMode === "live" ? "active" : ""} type="button" onClick={() => selectAudioMode("live")}>
              System audio
            </button>
            <button className={audioMode === "files" ? "active" : ""} type="button" onClick={() => selectAudioMode("files")}>
              Music files
            </button>
          </div>

          {audioMode === "live" ? (
            <section aria-label="Live system audio">
              <div className="player">
                <div className={`disc ${liveStats.playing ? "playing" : ""}`} aria-hidden="true"><div className="disc-core" /></div>
                <div className="track">
                  <p className="track-name">Mac system audio</p>
                  <p className="track-meta">{isHostMachine === true ? "Play music in any Mac app" : liveAudioState === "playing" ? "Playing live from your Mac" : liveAudioState === "paused"
                    ? "Tap Resume live audio on this device" : liveAudioState === "waiting" ? "Waiting for Mac audio"
                      : liveEnabled ? "Buffering — waiting for fresh audio" : "Listen to your Mac on this device"}</p>
                  <p>{liveStatus.active ? "The Mac is sending audio." : liveStatus.reason || "Waiting for the Mac to send audio."}</p>
                </div>
              </div>
              {isHostMachine === true ? (
                <div>
                  <p>This Mac plays through the speakers selected below. Open this page on your iPad to listen over Wi-Fi.</p>
                  <h2>Mac speakers</h2>
                  {nativeDevices.outputs.map((output) => (
                    <label key={output.uid} className="field-label" style={{ display: "block" }}>
                      <input type="checkbox" checked={nativeOutputs.includes(output.uid)} disabled={nativeBusy || liveStatus.processRunning} onChange={(event) => {
                        setNativeOutputs((current) => event.target.checked ? [...current, output.uid] : current.filter((uid) => uid !== output.uid));
                      }} /> {output.name}
                    </label>
                  ))}
                  <button className="mini-button" type="button" onClick={refreshNativeDevices} disabled={nativeBusy}>Refresh devices</button>
                  <label className="field-label" style={{ display: "block" }}>
                    <input type="checkbox" checked={nativeCalibrate} disabled={nativeBusy || liveStatus.processRunning} onChange={(event) => setNativeCalibrate(event.target.checked)} />
                    {" "}Calibrate speakers first (plays test tones)
                  </label>
                  {nativeCalibrate && (
                    <label className="field-label" style={{ display: "block" }}>
                      Microphone
                      <select aria-label="Calibration microphone" value={nativeMicrophone} disabled={nativeBusy || liveStatus.processRunning} onChange={(event) => setNativeMicrophone(event.target.value)}>
                        {nativeDevices.inputs.map((input) => <option key={input.uid} value={input.uid}>{input.name}</option>)}
                      </select>
                    </label>
                  )}
                  <p>{liveStatus.phase === "calibrating" ? "Calibrating speakers…" : liveStatus.active ? "Sending system audio to your devices."
                    : liveStatus.phase === "streaming" ? "Ready — play music in any Mac app."
                      : liveStatus.processRunning ? "Starting system audio…" : "Choose your speakers, then start system audio."}</p>
                  <p>Pause music in the Mac app. Stopping sharing disconnects every live listener.</p>
                  <button className="mini-button speaker-test" type="button" onClick={() => controlSystemAudio("start")} disabled={nativeBusy || !nativeOutputs.length || liveStatus.processRunning || liveStatus.sourceConnected || ["starting", "calibrating"].includes(liveStatus.phase)}>Start system audio</button>
                  <button className="mini-button speaker-test" type="button" onClick={() => controlSystemAudio("stop")} disabled={nativeBusy || !nativeCanStop}>Stop sharing to all devices</button>
                  {nativeNotice && !liveStatus.active && !liveStatus.processRunning && <p role="status">{nativeNotice}</p>}
                  {nativeIssue && <LiveError error={nativeIssue} />}
                  {liveStatus.error && <LiveError error={liveStatus.error} />}
                </div>
              ) : isHostMachine === null ? <p>Checking this device…</p> : (
                <div>
                  {(!liveEnabled || liveAudioState === "paused") && (
                    <button className="mini-button speaker-test" type="button" onClick={enableLiveAudio}>
                      {liveEnabled ? "Resume live audio" : "Enable live audio"}
                    </button>
                  )}
                  {liveEnabled && <button className="mini-button speaker-test" type="button" onClick={stopLiveAudio}>Stop live audio</button>}
                  <p>Play music in any app on the Mac. Keep this page open to listen.</p>
                  {liveStats.playing && <p>If silent, turn off Silent Mode and check this device's volume.</p>}
                </div>
              )}
              {liveIssue && <p className="audio-issue" role="status">{liveIssue}</p>}
            </section>
          ) : (
            <>
          <div className="player">
            <div className={`disc ${serverState.playing ? "playing" : ""}`} aria-hidden="true">
              <div className="disc-core" />
            </div>
            <div className="track">
              <p className="track-name">{trackLabel}</p>
              <p className="track-meta">{syncLabel}</p>
              <div className={`meter ${serverState.playing ? "playing" : ""}`} aria-hidden="true">
                {Array.from({ length: 8 }, (_, index) => (
                  <span key={index} style={{ "--i": index }} />
                ))}
              </div>
            </div>
          </div>

          <Countdown value={countdownState} />

          <div className="transport">
            <button className="icon-button" type="button" title="Stop" aria-label="Stop" onClick={stopPlayback}>
              <Square />
            </button>
            <button className="primary-button" type="button" title="Play/Pause" aria-label="Play or pause" onClick={togglePlay}>
              {serverState.playing && !localTrackEnded ? <Pause /> : <Play />}
            </button>
            <button className="icon-button" type="button" title="Resync" aria-label="Resync" onClick={resyncAll}>
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
              onPointerDown={() => {
                seekingRef.current = true;
              }}
              onChange={(event) => {
                seekingRef.current = true;
                setPositionState(Number(event.target.value));
              }}
              onPointerUp={commitSeek}
              onBlur={commitSeek}
            />
            <span>{formatTime(durationState)}</span>
          </div>
            </>
          )}
        </section>

        <aside className="side">
          {audioMode === "live" ? (
            <>
              <section className="panel">
                <h2>Live playback</h2>
                <Stat label="Speaker" value={isHostMachine === true ? (liveStatus.processRunning ? "Mac outputs" : "Off") : liveAudioState === "playing" ? "Playing" : liveAudioState === "paused" ? "Tap to resume" : liveAudioState === "waiting" ? "Waiting for Mac audio" : liveEnabled ? "Buffering" : "Off"} />
                {isHostMachine !== true && <>
                <Stat label="Buffered" value={`${liveStats.queueMs} ms`} />
                <Stat label="Interruptions" value={liveStats.underruns} />
                <Stat label="Skipped audio" value={`${liveStats.droppedMs} ms`} />
                </>}
                <Stat label="Timing" value={hostCommonTimeline || liveStats.syncMode === "common-timeline" ? "Shared timeline (estimated)"
                  : liveStats.syncMode === "waiting-for-clock" ? "Synchronizing clocks…"
                    : liveStats.syncMode === "legacy-buffer" ? "Legacy buffering" : "Waiting for stream"} />
                {showCommonTimeline && (
                  <>
                    <Stat label="Shared target" value={(liveStats.targetDelay ?? liveStatus.presentationDelayMs) == null ? "Waiting" : `${liveStats.targetDelay ?? liveStatus.presentationDelayMs} ms`} />
                    {isHostMachine !== true && <>
                    <Stat label="Clock round trip" value={liveStats.clockRTT == null ? "Waiting" : `${liveStats.clockRTT.toFixed(1)} ms`} />
                    <Stat label="Timing estimate" value={liveStats.timingErrorMs == null ? "Waiting" : `${liveStats.timingErrorMs > 0 ? "+" : ""}${liveStats.timingErrorMs.toFixed(2)} ms`} />
                    <Stat label="Late packets" value={liveStats.lateDrops || 0} />
                    </>}
                    <p>This is a software timing estimate. Speaker and room delay still need listening adjustment.</p>
                    {isHostMachine === false && (
                      <>
                        <Stat label="This device's adjustment" value={`${liveTrimMs > 0 ? "+" : ""}${liveTrimMs} ms`} />
                        <div className="segmented" role="group" aria-label="This device timing adjustment">
                          {[-10, -5].map((step) => <button key={step} type="button" onClick={() => adjustLiveTrim(liveTrimMs + step)} disabled={liveTrimMs <= -200}>{step} ms</button>)}
                          <button type="button" onClick={() => adjustLiveTrim(0)}>Reset</button>
                          {[5, 10].map((step) => <button key={step} type="button" onClick={() => adjustLiveTrim(liveTrimMs + step)} disabled={liveTrimMs >= 200}>+{step} ms</button>)}
                        </div>
                        <p>Negative plays this device earlier; positive plays it later. Small adjustments settle gradually.</p>
                      </>
                    )}
                  </>
                )}
                {(liveStats.syncMode === "legacy-buffer" || liveStatus.protocol === "HCA1") && <>
                <p>Legacy playback has no shared timing. Choose more buffering for unreliable Wi-Fi; it adds delay.</p>
                <div className="segmented" role="group" aria-label="Live buffering">
                  {[300, 500, 800].map((value) => (
                    <button key={value} type="button" className={liveBufferMs === value ? "active" : ""} onClick={() => {
                      setLiveBufferMs(value);
                      livePlayerRef.current?.setBufferMs(value);
                    }}>{value} ms</button>
                  ))}
                </div>
                </>}
              </section>
              <section className="panel join-panel">
                <h2>Listen on another device</h2>
                <div className="join-qr" aria-label="Live player QR code">
                  {joinUrls[0] ? <QrCode value={livePlayerUrl(joinUrls[0])} /> : "QR unavailable"}
                </div>
                <div className="addresses">
                  {joinUrls.map((url) => (
                    <div key={url} className="address-row">
                      <code>{livePlayerUrl(url)}</code>
                      <button className="copy" type="button" onClick={() => navigator.clipboard?.writeText(livePlayerUrl(url))}><Copy size={16} />Copy</button>
                    </div>
                  ))}
                </div>
              </section>
            </>
          ) : (
            <>
          <section className="panel host-panel">
            <div className="segmented" role="group" aria-label="Device role">
              <button className={roleState === "controller" ? "active" : ""} type="button" onClick={() => setRole("controller")}>
                Host
              </button>
              <button className={roleState === "speaker" ? "active" : ""} type="button" onClick={() => setRole("speaker")}>
                Player
              </button>
            </div>

            <label className="upload">
              <input type="file" accept="audio/*" multiple onChange={(event) => uploadSelectedFiles(event.target.files)} />
              <Upload />
              <span>{uploadText}</span>
            </label>

            <div className="segmented latency-modes" role="group" aria-label="Sync countdown">
              {[3000, 4000, 5000].map((lead) => (
                <button
                  key={lead}
                  className={Number(leadState) === lead ? "active" : ""}
                  type="button"
                  onClick={() => send({ type: "setLead", leadMs: lead })}
                >
                  {lead / 1000} sec
                </button>
              ))}
            </div>
          </section>

          <section className="panel device-panel">
            <h2>This Device</h2>
            <label className="field-label" htmlFor="deviceNameInput">
              Device name
            </label>
            <input
              id="deviceNameInput"
              className="device-name-input"
              type="text"
              maxLength="40"
              autoComplete="off"
              value={deviceNameState}
              onChange={(event) => setDeviceName(event.target.value)}
            />
          </section>

          <section className="panel">
            <h2>Local Stem</h2>
            <div className="layer-choices">
              {!layers.length && "No stems"}
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
          </section>

          <section className="panel">
            <h2>Sound Field</h2>
            <div className="zone-choices" role="group" aria-label="Sound field position">
              {zones.map(([zone, label]) => (
                <button
                  key={zone}
                  className={selectedZoneState === zone ? "active" : ""}
                  type="button"
                  onClick={() => selectZone(zone)}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>

          <section className="panel join-panel">
            <h2>Scan to Join</h2>
            <div className="join-qr" aria-label="Player QR code">
              {joinUrls[0] ? <QrCode value={joinUrls[0]} /> : "QR unavailable"}
            </div>
            <div className="addresses">
              {joinUrls.map((url) => (
                <div key={url} className="address-row">
                  <code>{url}</code>
                  <button className="copy" type="button" onClick={() => navigator.clipboard?.writeText(url)}>
                    <Copy size={16} />
                    Copy
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section className="panel players-panel">
            <div className="panel-heading">
              <h2>Players</h2>
              <button className="text-button" type="button" onClick={() => send({ type: "testTone" })}>
                Test
              </button>
            </div>
            <div className="peers">
              {!peers.length && "No players"}
              {peers.map((peer) => (
                <PeerCard key={peer.id} peer={peer} layers={layers} onTest={() => send({ type: "testTone", targetId: peer.id })} />
              ))}
            </div>
          </section>

          <section className="panel compact">
            <Stat label="Clock offset" value={`${Math.round(serverOffsetState)} ms`} />
            <Stat label="Round trip" value={latencyState ? `${Math.round(latencyState)} ms` : "-- ms"} />
            <Stat label="Countdown" value={`${Math.round(leadState)} ms`} />
            <Stat label="Local offset" value={`${deviceOffsetState} ms`} />
            <div className="calibration" aria-label="Local latency calibration">
              <button type="button" onClick={() => setDeviceOffset(deviceOffsetState - 10)}>
                -10
              </button>
              <button type="button" onClick={() => setDeviceOffset(0)}>
                0
              </button>
              <button type="button" onClick={() => setDeviceOffset(deviceOffsetState + 10)}>
                +10
              </button>
            </div>
            <button className="mini-button speaker-test" type="button" onClick={() => playTestTone({ toneAt: Date.now() + 80 })}>
              Speaker test
            </button>
            {serverState.playing && !localTrackEnded && mediaNeedsGestureState && playbackEngineState === "HTML audio" && (
              <button className="mini-button speaker-test" type="button" onClick={resumeMediaAudioFromGesture}>
                Resume audio
              </button>
            )}
            <Stat label="Engine" value={playbackEngineState} />
            <Stat label="Audio" value={audioContextState} />
            <Stat label="Status" value={readyStatus} />
            {audioIssueState && <p className="audio-issue">{audioIssueState}</p>}
          </section>

          <section className="panel diagnostics-panel compact">
            <h2>Device Diagnostics</h2>
            <Stat label="Device" value={deviceInfo.device} />
            <Stat label="Browser" value={deviceInfo.browser} />
            <Stat label="Browser engine" value={deviceInfo.engine} />
            <Stat label="iOS WebKit" value={deviceInfo.isIOS ? "Yes" : "No"} />
            <Stat label="Playback engine" value={playbackEngineState} />
            <Stat label="AudioContext" value={audioContextState} />
            <Stat label="Drift" value={driftState === null ? "-- ms" : `${driftState} ms`} />
            <Stat label="Hard resyncs" value={String(correctionCountState)} />
            <Stat label="Last correction" value={lastCorrectionState} />
            <Stat label="Start delay" value={lastStartDelayState === null ? "-- ms" : `${lastStartDelayState} ms`} />
            <Stat label="Web Audio test" value={webAudioTestState} />
            <button className="mini-button speaker-test" type="button" onClick={forceWebAudioTest}>
              Force Web Audio Test
            </button>
          </section>
            </>
          )}
        </aside>
      </main>

      {audioMode === "files" && !unlockedState && (
        <div className="gesture">
          <div className="gesture-card">
            <button
              type="button"
              onClick={unlockAudio}
            >
              <Volume2 />
              Enable speaker
            </button>
            <span>Audio: {audioContextState}</span>
            {audioIssueState && <strong>{audioIssueState}</strong>}
          </div>
        </div>
      )}
      <audio ref={mediaAudioRef} className="fallback-audio" preload="auto" playsInline aria-hidden="true" />
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

function PeerCard({ peer, layers, onTest }) {
  const layer = layerById(layers, peer.layerId);
  const status = peer.ready ? "Ready" : peer.unlocked ? "No audio" : "Locked";
  return (
    <div className="peer-card">
      <div className="peer-head">
        <strong>{peer.name}</strong>
        <span className={`status ${peer.ready ? "ready" : ""}`}>{status}</span>
      </div>
      <div className="peer-grid">
        <span>Stem</span>
        <strong>{layer?.name || (peer.role === "controller" ? "Host" : "None")}</strong>
        <span>Position</span>
        <strong>{zoneNames[peer.zone] || "Front Left"}</strong>
        <span>Offset</span>
        <strong>{Math.round(Number(peer.deviceOffsetMs) || 0)} ms</strong>
        <span>Latency</span>
        <strong>{peer.latencyMs ? `${Math.round(peer.latencyMs)} ms` : "--"}</strong>
      </div>
      <button className="mini-button" type="button" onClick={onTest}>
        Test tone
      </button>
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

function buildSyncLabel({ layers, selectedLayer, state, audioReady, audioLoading, countdown, localTrackEnded }) {
  if (!layers.length) return "Choose one or more stems on the host";
  if (audioLoading) return "Caching audio";
  if (!audioReady) return "Preparing audio";
  if (localTrackEnded) return `Ended: ${selectedLayer?.name || "default stem"}`;
  if (countdown) return `Starting in ${countdown}`;
  return state.playing ? `Playing: ${selectedLayer?.name || "default stem"}` : `Paused: ${selectedLayer?.name || "default stem"}`;
}

function playerJoinUrl(url, source = "live") {
  const playerUrl = new URL(url, location.href);
  playerUrl.pathname = "/";
  playerUrl.searchParams.set("mode", "player");
  playerUrl.searchParams.set("source", source);
  playerUrl.hash = "";
  return playerUrl.toString();
}

function livePlayerUrl(url) {
  const playerUrl = new URL(url, location.href);
  playerUrl.searchParams.set("source", "live");
  return playerUrl.toString();
}

function LiveError({ error }) {
  const full = String(error);
  const brief = full.split("\n").find((line) => line.trim())?.trim().slice(0, 240) || "System audio could not start.";
  return (
    <div className="audio-issue" role="status">
      <p>{brief}</p>
      {brief !== full && <details><summary>Details</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "12rem", overflow: "auto" }}>{full}</pre></details>}
    </div>
  );
}

function isLoopbackHost() {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(location.hostname);
}

function setPlaybackAudioSession() {
  // iOS otherwise treats Web Audio as ambient sound, which follows Silent Mode.
  // Request playback only when this device's user explicitly enables audio.
  try {
    if (navigator.audioSession && "type" in navigator.audioSession) navigator.audioSession.type = "playback";
  } catch {}
}

function audioSessionDiagnostics() {
  try {
    return { type: navigator.audioSession?.type || "unsupported", state: navigator.audioSession?.state || "unknown" };
  } catch {
    return { type: "unavailable", state: "unknown" };
  }
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

function sampledAudioPeak(buffer) {
  // Compute once per decode and send only an aggregate level, never samples.
  // Bound main-thread work for long uploads to roughly 65k reads per channel.
  const stride = Math.max(1, Math.ceil(buffer.length / 65536));
  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel);
    for (let frame = 0; frame < samples.length; frame += stride) {
      peak = Math.max(peak, Math.abs(samples[frame]));
    }
  }
  return peak;
}
