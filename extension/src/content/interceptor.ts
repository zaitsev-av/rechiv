import {
  logGetUserMedia,
  logRemoteSdp,
  logRemoteTrack,
  recordChunkAudio,
  recordLevel,
  watchAudioPipeline,
  watchCreatedDataChannels,
  watchDataChannels,
  watchPeerConnection,
  watchRpc,
  watchWebSockets,
} from "./platforms/diagnostics";
import { capabilitiesForHost, pickPageAdapter } from "./platforms/registry";
import { rootMeanSquare, SPEECH_LEVEL, SpeechGate } from "./speech-gate";

const MIME_TYPE = "audio/webm;codecs=opus";

const PREFIX = "[Rechiv:interceptor]";
const notify = (msg: { type: string; [key: string]: unknown }) => {
  console.log(PREFIX, msg.type, msg);
  window.postMessage(msg, location.origin);
};

const recorders = new Map<string, MediaRecorder>();
const chunkTimers = new Map<string, ReturnType<typeof setTimeout>>();
const activeParts = new Map<string, Blob[]>();
const activeStartedAt = new Map<string, number>();
const knownSpeakers = new Set<string>();
const streams = new Map<string, { stream: MediaStream; kind: "local" | "remote" }>();
let isCapturing = false;
let captureSessionId: string | null = null;
let captureSttUrl: string | null = null;
let captureUploadToken: string | null = null;
let captureStartTime = 0;
let captureStartPerf = 0;
let localMuted = false;
const LEVEL_POLL_MS = 100;
const LEVEL_LOG_MS = 2_000;
const gates = new Map<string, SpeechGate>();
const speechInChunk = new Map<string, boolean>();
const levelMeters = new Map<
  string,
  { analyser: AnalyserNode; buffer: Float32Array<ArrayBuffer> }
>();
const levelSinks = new Map<string, HTMLAudioElement>();
let audioContext: AudioContext | null = null;
/** Без timeslice ondataavailable срабатывает только на stop(). */
const CHUNK_TIMESLICE = 1_000;
/** Данные уже ушли beacon'ом — onstop не должен слать дубль. */
const beaconFlushed = new WeakSet<MediaRecorder>();
let speakerMapInterval: ReturnType<typeof setInterval> | null = null;
let vadInterval: ReturnType<typeof setInterval> | null = null;
let lastVadSnapshot: string | null = null;
const pageAdapter = pickPageAdapter(location.host);
const localFromSender = capabilitiesForHost(location.host).localAudio === "sender";
const peerConnections = new Set<RTCPeerConnection>();

export function installInterceptor(): void {
  watchWebSockets();
  watchRpc();
  watchCreatedDataChannels();
  watchAudioPipeline();
  // До interceptRTC: сигналинг площадки поднимается раньше, чем медиа.
  pageAdapter.install?.({ addRemoteStream });
  interceptRTC();
  interceptGetUserMedia();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (msg?.type === "RECHIV_START_CAPTURE") {
      captureSessionId = msg.sessionId ?? null;
      captureSttUrl = msg.sttServiceUrl ?? null;
      captureUploadToken = msg.uploadToken ?? null;
      startCapture();
    } else if (msg?.type === "RECHIV_STOP_CAPTURE") {
      stopCapture();
    }
  });

  // requestData() тут бесполезен: ondataavailable диспатчится отдельной задачей,
  // а страница уже уходит. Спасают накопленные timeslice-срезы.
  window.addEventListener("pagehide", () => {
    if (!isCapturing || !captureSessionId || !captureSttUrl) return;
    console.log(PREFIX, "pagehide, flushing via sendBeacon");

    for (const [speakerId, recorder] of recorders) {
      if (recorder.state === "inactive") continue;

      const parts = activeParts.get(speakerId);
      if (!parts || parts.length === 0) continue;
      if (speechInChunk.get(speakerId) === false) continue;

      const blob = new Blob(parts, { type: "audio/webm" });
      const form = new FormData();
      form.append("speakerId", speakerId);
      const startedAt = activeStartedAt.get(speakerId) ?? Date.now();
      form.append("timestamp", String(Math.max(0, (startedAt - captureStartTime) / 1000)));
      if (captureUploadToken) form.append("uploadToken", captureUploadToken);
      form.append("file", blob, `${speakerId}.webm`);

      const url = `${captureSttUrl}/sessions/${captureSessionId}/chunks`;
      if (navigator.sendBeacon(url, form)) beaconFlushed.add(recorder);
      console.log(PREFIX, "sendBeacon sent for", speakerId, "size:", blob.size);
    }

    const vadTimeline = pageAdapter.getVadTimeline?.();
    if (vadTimeline && captureUploadToken) {
      navigator.sendBeacon(
        `${captureSttUrl}/sessions/${captureSessionId}/vad`,
        JSON.stringify({ ...vadTimeline, uploadToken: captureUploadToken }),
      );
    }
  });
}

function interceptRTC(): void {
  // biome-ignore lint/suspicious/noExplicitAny: globalThis не типизирован для RTCPeerConnection
  const OriginalRTC = (globalThis as any).RTCPeerConnection;
  if (!OriginalRTC) return;

  // Proxy, а не функция-обёртка: сохраняет статические методы (generateCertificate) и instanceof.
  // biome-ignore lint/suspicious/noExplicitAny: globalThis не типизирован для RTCPeerConnection
  (globalThis as any).RTCPeerConnection = new Proxy(OriginalRTC, {
    construct(target, args, newTarget) {
      const pc = Reflect.construct(target, args, newTarget);
      instrumentPeerConnection(pc);
      return pc;
    },
  });
}

function instrumentPeerConnection(pc: RTCPeerConnection): void {
  notify({ type: "RECHIV_WEBRTC_DETECTED" });
  peerConnections.add(pc);
  pageAdapter.notePeerConnection?.(pc);
  watchDataChannels(pc);
  watchPeerConnection(pc);

  pc.addEventListener("track", (event: RTCTrackEvent) => {
    logRemoteTrack(event);
    const stream = event.streams?.[0];
    if (stream && event.track?.kind === "audio") {
      console.log(PREFIX, "remote track detected, stream:", stream.id);
      pageAdapter.noteRemoteTrack?.(stream.id, event.transceiver?.mid ?? null);
      if (pageAdapter.ownsRemoteTrack?.(event.track.id)) return;
      addRemoteStream(`remote-${stream.id}`, stream);
    }
  });

  // Добавление трека вызывает negotiationneeded: так находим микрофон, если getUserMedia прошёл мимо.
  pc.addEventListener("negotiationneeded", () => noteLocalSenders(pc));

  let lastRemoteSdp: string | undefined;
  pc.addEventListener("signalingstatechange", () => {
    const sdp = pc.remoteDescription?.sdp;
    if (sdp && sdp !== lastRemoteSdp) {
      lastRemoteSdp = sdp;
      logRemoteSdp(sdp);
    }
  });

  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "closed") peerConnections.delete(pc);
    notify({ type: "RECHIV_CONNECTION_STATE", state: pc.connectionState });
  });
}

function addRemoteStream(id: string, stream: MediaStream): void {
  streams.set(id, { stream, kind: "remote" });
  notify({ type: "RECHIV_TRACK_ADDED", streamId: id, kind: "remote" });
  if (isCapturing) startRecordingStream(id, stream);
}

function noteLocalSenders(pc: RTCPeerConnection): void {
  if (typeof MediaStream !== "function") return;
  const current = streams.get("local");
  if (current && !localFromSender) return;
  const track = pc.getSenders?.().find((sender) => sender.track?.kind === "audio")?.track;
  if (!track || current?.stream.getAudioTracks()[0] === track) return;
  // В режиме sender без клона: клон не наследует enabled, а мьют на Meet — это enabled = false.
  // Иначе клон: при остановке записи трек останавливаем, а исходный принадлежит странице.
  const stream = new MediaStream([localFromSender ? track : track.clone()]);
  console.log(PREFIX, "local audio sender, stream:", stream.id);
  setLocalStream(stream);
}

function refreshLocalSenders(): void {
  if (!localFromSender) return;
  for (const pc of peerConnections) noteLocalSenders(pc);
}

/** Повторный захват заменяет локальный поток: старый рекордер больше не нужен. */
function setLocalStream(stream: MediaStream): void {
  const id = "local";
  const prevRec = recorders.get(id);
  if (prevRec && prevRec.state !== "inactive") {
    console.log(PREFIX, "stopping previous local recorder");
    const prevTimer = chunkTimers.get(id);
    if (prevTimer) {
      clearInterval(prevTimer);
      chunkTimers.delete(id);
    }
    prevRec.stop();
    recorders.delete(id);
  }

  const prevEntry = streams.get(id);
  if (prevEntry && !localFromSender) {
    for (const t of prevEntry.stream.getAudioTracks()) t.stop();
  }

  detachLevelMeter(id);
  streams.set(id, { stream, kind: "local" });
  if (!knownSpeakers.has(id)) {
    knownSpeakers.add(id);
    notify({ type: "RECHIV_TRACK_ADDED", streamId: id, kind: "local" });
  }

  // Мьют проверяет recordChunk.
  if (isCapturing) startRecordingStream(id, stream);
}

function interceptGetUserMedia(): void {
  const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  navigator.mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
    const stream = await origGetUserMedia(constraints);
    logGetUserMedia(constraints, stream);

    // В режиме sender сырой микрофон не пишем: в нём эхо собеседников и речь при мьюте.
    if (constraints?.audio && !localFromSender) {
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length > 0) {
        console.log(
          PREFIX,
          "getUserMedia captured audio, stream:",
          stream.id,
          "tracks:",
          audioTracks.length,
        );

        setLocalStream(new MediaStream(audioTracks.map((t) => t.clone())));
      }
    }

    return stream;
  };
}

function startCapture(): void {
  isCapturing = true;
  captureStartTime = Date.now();
  captureStartPerf = performance.now();
  pageAdapter.startVadCapture?.(captureStartPerf);
  startVadUpdates();
  localMuted = pageAdapter.isLocalMuted();
  refreshLocalSenders();
  console.log(
    PREFIX,
    "startCapture, known streams:",
    streams.size,
    [...streams.keys()],
    "localMuted:",
    localMuted,
  );

  for (const [streamId, { stream }] of streams) {
    if (!recorders.has(streamId)) startRecordingStream(streamId, stream);
  }

  pageAdapter.syncMuteSubscription(handleMuteChange);
  startSpeakerMapping();
}

function stopCapture(): void {
  console.log(PREFIX, "stopCapture, active recorders:", recorders.size);
  isCapturing = false;
  stopVadUpdates();
  const vadTimeline = pageAdapter.getVadTimeline?.();
  notify({
    type: "RECHIV_CAPTURE_STOPPED",
    ...(vadTimeline ? { vadTimeline } : {}),
  });

  pageAdapter.teardown();
  stopSpeakerMapping();

  for (const [id, timer] of chunkTimers) {
    clearInterval(timer);
    chunkTimers.delete(id);
  }

  for (const [id, recorder] of recorders) {
    console.log(PREFIX, "stopping recorder", id, "state:", recorder.state);
    if (recorder.state !== "inactive") recorder.stop();
  }

  const localEntry = streams.get("local");
  // Отправляемый трек принадлежит странице: остановка оборвала бы звонок.
  if (localEntry && !localFromSender) {
    for (const t of localEntry.stream.getAudioTracks()) t.stop();
  }

  for (const speakerId of [...levelMeters.keys()]) detachLevelMeter(speakerId);
  gates.clear();
  speechInChunk.clear();
  if (audioContext) {
    void audioContext.close().catch(() => undefined);
    audioContext = null;
  }
}

function startVadUpdates(): void {
  stopVadUpdates();
  lastVadSnapshot = null;
  if (!pageAdapter.getVadTimeline) return;

  vadInterval = setInterval(() => {
    const vadTimeline = pageAdapter.getVadTimeline?.();
    if (!vadTimeline) return;
    const snapshot = JSON.stringify(vadTimeline);
    if (snapshot === lastVadSnapshot) return;
    lastVadSnapshot = snapshot;
    notify({ type: "RECHIV_VAD_TIMELINE", vadTimeline });
  }, 30_000);
}

function stopVadUpdates(): void {
  if (vadInterval !== null) {
    clearInterval(vadInterval);
    vadInterval = null;
  }
}

function stopLocalRecorder(): void {
  const rec = recorders.get("local");
  if (rec && rec.state !== "inactive") {
    const timer = chunkTimers.get("local");
    if (timer) {
      clearInterval(timer);
      chunkTimers.delete("local");
    }
    rec.stop();
  }
}

function sendChunk(
  speakerId: string,
  blob: Blob,
  timestamp: number,
  attribution: { participantId: string; name: string } | null,
): void {
  console.log(PREFIX, "sending chunk", speakerId, "size:", blob.size);
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = (reader.result as string).split(",")[1];
    recordChunkAudio(speakerId, timestamp, base64);
    notify({
      type: "RECHIV_CHUNK",
      speakerId,
      data: base64,
      timestamp,
      ...(attribution ? { attribution } : {}),
    });
  };
  reader.readAsDataURL(blob);
}

function attributeChunk(
  speakerId: string,
  startedAt: number,
  endedAt: number,
): { participantId: string; name: string } | null {
  if (speakerId === "local") return null;

  const toCaptureClock = (value: number) => captureStartPerf + (value - captureStartTime);
  return (
    pageAdapter.attributeChunk?.(toCaptureClock(startedAt), toCaptureClock(endedAt), speakerId) ??
    null
  );
}

function attachLevelMeter(speakerId: string, stream: MediaStream): void {
  if (levelMeters.has(speakerId)) return;
  try {
    audioContext ??= new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    audioContext.createMediaStreamSource(stream).connect(analyser);

    // Без привязки к элементу WebAudio не тянет удалённый поток.
    const sink = new Audio();
    sink.srcObject = stream;
    sink.muted = true;
    void sink.play().catch(() => undefined);
    levelSinks.set(speakerId, sink);

    levelMeters.set(speakerId, { analyser, buffer: new Float32Array(analyser.fftSize) });
  } catch (err) {
    console.warn(PREFIX, "level meter unavailable for", speakerId, err);
  }
}

function detachLevelMeter(speakerId: string): void {
  levelMeters.delete(speakerId);
  const sink = levelSinks.get(speakerId);
  if (sink) {
    sink.pause();
    sink.srcObject = null;
    levelSinks.delete(speakerId);
  }
}

const levelLoggedAt = new Map<string, number>();

function logLevel(speakerId: string, level: number | null, gate: SpeechGate): void {
  const now = Date.now();
  if ((levelLoggedAt.get(speakerId) ?? 0) + LEVEL_LOG_MS > now) return;
  levelLoggedAt.set(speakerId, now);
  recordLevel(speakerId, level, gate.threshold());
  console.log(
    PREFIX,
    "level",
    speakerId,
    level === null ? "измерителя нет" : level.toFixed(4),
    "threshold:",
    gate.threshold().toFixed(4),
    "speech:",
    `${gate.speechDurationMs}ms`,
  );
}

function measureLevel(speakerId: string): number | null {
  const meter = levelMeters.get(speakerId);
  if (!meter) return null;
  meter.analyser.getFloatTimeDomainData(meter.buffer);
  return rootMeanSquare(meter.buffer);
}

function startRecordingStream(speakerId: string, stream: MediaStream): void {
  const audioTracks = stream.getAudioTracks();
  console.log(PREFIX, "startRecordingStream", speakerId, "audioTracks:", audioTracks.length);
  if (recorders.has(speakerId)) return;
  if (audioTracks.length === 0) {
    console.warn(PREFIX, "no audio tracks, skipping", speakerId);
    return;
  }

  attachLevelMeter(speakerId, stream);
  const gate = new SpeechGate();
  gates.set(speakerId, gate);
  const mimeType = MediaRecorder.isTypeSupported(MIME_TYPE) ? MIME_TYPE : "audio/webm";

  function recordChunk() {
    if (!isCapturing) return;
    if (speakerId === "local" && localMuted) {
      console.log(PREFIX, "local is muted, skipping recordChunk");
      return;
    }
    const liveTracks = stream.getAudioTracks().filter((t) => t.readyState === "live");
    if (liveTracks.length === 0) {
      console.log(PREFIX, "tracks ended for", speakerId, "— not restarting");
      return;
    }
    const recorder = new MediaRecorder(stream, { mimeType });
    const recorderStartedAt = Date.now();
    const parts: Blob[] = [];
    activeParts.set(speakerId, parts);
    activeStartedAt.set(speakerId, recorderStartedAt);

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) parts.push(event.data);
    };

    gate.reset(recorderStartedAt);

    recorder.onstop = () => {
      const isActive = recorders.get(speakerId) === recorder;
      if (isActive) {
        recorders.delete(speakerId);
        activeStartedAt.delete(speakerId);
      }
      activeParts.delete(speakerId);
      // После beacon (pagehide в bfcache) повтор дал бы дубль.
      const alreadySent = beaconFlushed.has(recorder);
      if (parts.length > 0 && !alreadySent && speechInChunk.get(speakerId)) {
        const blob = new Blob(parts, { type: "audio/webm" });
        const timestamp = Math.max(0, (recorderStartedAt - captureStartTime) / 1000);
        const attribution = attributeChunk(speakerId, recorderStartedAt, Date.now());
        sendChunk(speakerId, blob, timestamp, attribution);
      } else if (parts.length > 0 && !alreadySent) {
        console.log(PREFIX, "no speech in chunk, dropping", speakerId);
      }
      if (isCapturing && isActive) recordChunk();
    };

    recorder.onerror = (e) => {
      console.error(PREFIX, "MediaRecorder error", speakerId, e);
    };

    // timeslice нужен, чтобы на pagehide уже был валидный WebM.
    recorder.start(CHUNK_TIMESLICE);
    recorders.set(speakerId, recorder);
    console.log(PREFIX, "MediaRecorder started", speakerId);

    // Таймер — страховка от бесконечного монолога; обычно режет пауза.
    const timer = setInterval(() => {
      const now = Date.now();
      const level = measureLevel(speakerId);

      // Нет измерителя — считаем, что речь есть: терять фрагмент хуже.
      gate.push(level ?? SPEECH_LEVEL, now);
      speechInChunk.set(speakerId, gate.hadSpeech);
      logLevel(speakerId, level, gate);

      const reason = gate.cutReason(now);
      if (!reason) return;

      clearInterval(timer);
      chunkTimers.delete(speakerId);
      if (recorder.state !== "inactive") {
        console.log(
          PREFIX,
          "closing chunk",
          speakerId,
          "reason:",
          reason,
          "speech:",
          `${gate.speechDurationMs}ms`,
        );
        recorder.stop();
      }
    }, LEVEL_POLL_MS);
    chunkTimers.set(speakerId, timer);
  }

  knownSpeakers.add(speakerId);
  recordChunk();
}

function startSpeakerMapping(): void {
  stopSpeakerMapping();
  extractAndSendSpeakerMap();
  speakerMapInterval = setInterval(extractAndSendSpeakerMap, 5000);
}

function stopSpeakerMapping(): void {
  if (speakerMapInterval) {
    clearInterval(speakerMapInterval);
    speakerMapInterval = null;
  }
}

function extractAndSendSpeakerMap(): void {
  const map = pageAdapter.getSpeakerMap();
  if (map) {
    notify({ type: "RECHIV_SPEAKER_MAP", map });
  }

  // Комната могла пересоздаться вместе с подпиской на мьют.
  if (isCapturing) pageAdapter.syncMuteSubscription(handleMuteChange);
  // replaceTrack при смене микрофона не вызывает negotiationneeded.
  if (isCapturing) refreshLocalSenders();
}

function handleMuteChange(muted: boolean): void {
  if (muted === localMuted) return;

  localMuted = muted;
  console.log(PREFIX, muted ? "mute" : "unmute", "detected via platform event");
  if (!isCapturing) return;

  if (muted) {
    stopLocalRecorder();
    return;
  }

  const entry = streams.get("local");
  if (!entry || recorders.has("local")) return;

  // На unmute старый стрим может быть мёртв: запись стартует из getUserMedia.
  const hasLive = entry.stream.getAudioTracks().some((t) => t.readyState === "live");
  if (hasLive) {
    startRecordingStream("local", entry.stream);
  } else {
    console.log(PREFIX, "no live tracks yet, waiting for getUserMedia");
  }
}

installInterceptor();
