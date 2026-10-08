import {
  logRemoteSdp,
  logRemoteTrack,
  watchDataChannel,
  watchDataChannels,
  watchPeerConnection,
  watchWebSockets,
} from "./platforms/diagnostics";
import { pickPageAdapter } from "./platforms/page";
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
const pageAdapter = pickPageAdapter(location.host);

export function installInterceptor(): void {
  watchWebSockets();
  // До interceptRTC: сигналинг площадки поднимается раньше, чем медиа.
  pageAdapter.install?.();
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
  });
}

function interceptRTC(): void {
  // biome-ignore lint/suspicious/noExplicitAny: globalThis не типизирован для RTCPeerConnection
  const OriginalRTC = (globalThis as any).RTCPeerConnection;
  if (!OriginalRTC) return;

  // biome-ignore lint/suspicious/noExplicitAny: globalThis не типизирован, args untyped
  // biome-ignore lint/complexity/useArrowFunction: function нужна для поддержки вызова через new
  (globalThis as any).RTCPeerConnection = function (...args: any[]) {
    const pc = new OriginalRTC(...args);
    notify({ type: "RECHIV_WEBRTC_DETECTED" });
    watchDataChannels(pc);
    watchPeerConnection(pc);

    if (typeof pc.createDataChannel === "function") {
      const origCreateDataChannel = pc.createDataChannel.bind(pc);
      pc.createDataChannel = (label: string, init?: RTCDataChannelInit) => {
        const channel = origCreateDataChannel(label, init);
        watchDataChannel(channel);
        return channel;
      };
    }

    if (typeof pc.setRemoteDescription === "function") {
      const origSetRemoteDescription = pc.setRemoteDescription.bind(pc);
      pc.setRemoteDescription = (description: RTCSessionDescriptionInit) => {
        logRemoteSdp(description?.sdp);
        return origSetRemoteDescription(description);
      };
    }

    pc.addEventListener("track", (event: RTCTrackEvent) => {
      logRemoteTrack(event);
      const stream = event.streams?.[0];
      if (stream && event.track?.kind === "audio") {
        const id = `remote-${stream.id}`;
        console.log(PREFIX, "remote track detected, stream:", stream.id);
        pageAdapter.noteRemoteTrack?.(stream.id, event.transceiver?.mid ?? null);
        streams.set(id, { stream, kind: "remote" });
        notify({ type: "RECHIV_TRACK_ADDED", streamId: id, kind: "remote" });
        if (isCapturing) startRecordingStream(id, stream);
      }
    });

    const origAddTrack = pc.addTrack.bind(pc);
    pc.addTrack = (track: MediaStreamTrack, stream: MediaStream, ...rest: MediaStream[]) => {
      if (track?.kind === "audio" && stream) {
        console.log(PREFIX, "addTrack local audio, stream:", stream.id);
        if (!streams.has("local")) {
          streams.set("local", { stream, kind: "local" });
          notify({ type: "RECHIV_TRACK_ADDED", streamId: "local", kind: "local" });
          if (isCapturing) startRecordingStream("local", stream);
        }
      }
      return origAddTrack(track, stream, ...rest);
    };

    const origAddTransceiver = pc.addTransceiver.bind(pc);
    pc.addTransceiver = (trackOrKind: MediaStreamTrack | string, init?: RTCRtpTransceiverInit) => {
      const result = origAddTransceiver(trackOrKind, init);
      if (
        (typeof trackOrKind !== "string" && trackOrKind?.kind === "audio") ||
        trackOrKind === "audio"
      ) {
        console.log(PREFIX, "addTransceiver audio detected");
      }
      return result;
    };

    pc.addEventListener("connectionstatechange", () => {
      notify({ type: "RECHIV_CONNECTION_STATE", state: pc.connectionState });
    });

    return pc;
  };

  // biome-ignore lint/suspicious/noExplicitAny: globalThis не типизирован для RTCPeerConnection
  (globalThis as any).RTCPeerConnection.prototype = OriginalRTC.prototype;
}

function interceptGetUserMedia(): void {
  const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  navigator.mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
    const stream = await origGetUserMedia(constraints);

    if (constraints?.audio) {
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length > 0) {
        const id = "local";
        console.log(
          PREFIX,
          "getUserMedia captured audio, stream:",
          stream.id,
          "tracks:",
          audioTracks.length,
        );

        // LiveKit заново вызывает getUserMedia при вкл/выкл микрофона.
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
        if (prevEntry) {
          for (const t of prevEntry.stream.getAudioTracks()) t.stop();
        }

        detachLevelMeter(id);

        // Клон LiveKit не останавливает при мьюте.
        const recordingStream = new MediaStream(audioTracks.map((t) => t.clone()));
        streams.set(id, { stream: recordingStream, kind: "local" });
        if (!knownSpeakers.has(id)) {
          knownSpeakers.add(id);
          notify({ type: "RECHIV_TRACK_ADDED", streamId: id, kind: "local" });
        }

        // Мьют проверяет recordChunk.
        if (isCapturing) {
          startRecordingStream(id, recordingStream);
        }
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
  localMuted = pageAdapter.isLocalMuted();
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
  if (localEntry) {
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
  // Часы записи монотонные, а границы фрагмента приходят из Date.now().
  const toCaptureClock = (value: number) => captureStartPerf + (value - captureStartTime);
  return pageAdapter.attributeChunk?.(toCaptureClock(startedAt), toCaptureClock(endedAt)) ?? null;
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
