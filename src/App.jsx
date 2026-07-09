import { Copy, Pause, Play, RotateCw, Square, Upload, Volume2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createQrMatrix } from "./qr.js";

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

  const layers = serverState.layers || [];
  const selectedLayer = layerById(layers, selectedLayerIdState) || layers[0] || null;
  const trackLabel = layers.length > 1 ? `${layers.length} stems` : serverState.track?.name || "No track loaded";
  const syncLabel = buildSyncLabel({
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

  const send = useCallback((message) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(message));
    }
  }, []);

  const reportStatusNow = useCallback(() => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return;
    const state = stateRef.current;
    const layer = layerById(state.layers || [], selectedLayerIdRef.current) || state.layers?.[0] || null;
    send({
      type: "identify",
      role: roleRef.current,
      name: deviceNameRef.current,
      deviceKey: currentDeviceKey(),
      layerId: selectedLayerIdRef.current,
      zone: selectedZoneRef.current,
      ready: Boolean(unlockedRef.current && (!layer || audioReadyRef.current)),
      unlocked: unlockedRef.current,
      latencyMs: Math.round(latencyRef.current || 0),
      deviceOffsetMs: deviceOffsetRef.current
    });
  }, [send]);

  const reportStatusSoon = useCallback(() => {
    clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(reportStatusNow, 120);
  }, [reportStatusNow]);

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
    return localPlayback.offset + Math.max(0, audioContext.currentTime - localPlayback.contextStartedAt);
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
      const delaySeconds = Math.max(0, (adjustedTargetLocalMs - Date.now()) / 1000);
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
    [currentLocalPosition, durationState, expectedPosition, startLocalSource, updateCountdown]
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
      if (message.type === "peers") {
        setPeers(message.peers || []);
        return;
      }
      if (message.type === "testTone") {
        playTestTone(message);
        return;
      }
      if (message.type === "track" || message.type === "sync" || message.type === "lead") {
        applyState(message.state);
        return;
      }
      if (["play", "pause", "stop", "seek"].includes(message.type)) {
        applyState(message.state, true);
      }
    },
    [applyState, receiveTimeSample, reportStatusSoon]
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
  }, [calibrateClock, expectedPosition, reportStatusNow, stopLocalSource]);

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
    const urls = (config.addresses.length ? config.addresses : [location.origin]).map(playerJoinUrl);
    setJoinUrls(urls);
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

  async function unlockAudio() {
    if (unlockingRef.current) return;
    unlockingRef.current = true;
    setAudioIssueState("");
    setReadyStatus("Unlocking");

    try {
      const layer = layerById(stateRef.current.layers || [], selectedLayerIdRef.current) || stateRef.current.layers?.[0];
      const audioContext = createAudioContext();
      let webAudioUnlocked = false;
      if (gainRef.current) gainRef.current.gain.value = 1;
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

      if (webAudioUnlocked) {
        playbackEngineRef.current = "web-audio";
        setPlaybackEngineState("Web Audio");
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
      if (gainRef.current) gainRef.current.gain.value = 1;
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
              {serverState.playing ? <Pause /> : <Play />}
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
        </section>

        <aside className="side">
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
        </aside>
      </main>

      {!unlockedState && (
        <div className="gesture">
          <div className="gesture-card">
            <button
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

function buildSyncLabel({ layers, selectedLayer, state, audioReady, audioLoading, countdown }) {
  if (!layers.length) return "Choose one or more stems on the host";
  if (audioLoading) return "Caching audio";
  if (!audioReady) return "Preparing audio";
  if (countdown) return `Starting in ${countdown}`;
  return state.playing ? `Playing: ${selectedLayer?.name || "default stem"}` : `Paused: ${selectedLayer?.name || "default stem"}`;
}

function playerJoinUrl(url) {
  const playerUrl = new URL(url, location.href);
  playerUrl.pathname = "/";
  playerUrl.searchParams.set("mode", "player");
  playerUrl.hash = "";
  return playerUrl.toString();
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
