/**
 * ВРЕМЕННЫЙ МОДУЛЬ: диагностика раздачи аудиотреков площадки. Удалить вместе
 * с вызовами в interceptor.ts, когда атрибуция будет готова.
 *
 * В файл payload пишется без обрезки: однажды обрезка slotsConfig испортила весь замер.
 */

const PREFIX = "[Rechiv:diag]";
const CONSOLE_PAYLOAD = 300;
const RTP_SAMPLE_MS = 100;
const STATS_EVERY_SAMPLES = 10;
const MAX_RECORDS = 500_000;
/**
 * Сервер игнорирует просьбу об отдельных аудиослотах (замер 03.08), поэтому 0.
 * Ручка на случай смены протокола: `__rechivDiag.audioSlots(8)`.
 */
const DEFAULT_AUDIO_SLOTS = 0;

/**
 * Клиент просит 12 слотов, и vad приходит только по ним. Больше слотов — непроверенная
 * гипотеза, включается из консоли: `__rechivDiag.slots(30)`.
 */
const DEFAULT_SLOT_COUNT = 0;

/**
 * Сборочный флаг (`RECHIV_DIAG=1`), а не константа: диагностика пишет имена участников
 * в консоль и не должна попасть в обычную сборку. Под vitest не определён.
 */
declare const __RECHIV_DIAG__: boolean | undefined;

export const DIAGNOSTICS_ENABLED = typeof __RECHIV_DIAG__ === "undefined" ? true : __RECHIV_DIAG__;

type Record_ = { t: number; type: string; [key: string]: unknown };

const records: Record_[] = [];
const startedAt = Date.now();
let overflowed = false;
let sampler: ReturnType<typeof setInterval> | null = null;
let samplesTaken = 0;
const connections = new Set<RTCPeerConnection>();

/** Монотонное время: системные часы могут прыгнуть посреди созвона. */
function record(type: string, fields: Record<string, unknown>): void {
  if (records.length >= MAX_RECORDS) {
    if (!overflowed) {
      overflowed = true;
      console.warn(PREFIX, `достигнут предел в ${MAX_RECORDS} записей, дальше не пишем`);
    }
    return;
  }
  records.push({ t: Math.round(performance.now()), type, ...fields });
}

/** Пустые слоты SFU приходят с muted-треком: unmute показывает, когда в слот сел участник. */
export function logRemoteTrack(event: RTCTrackEvent): void {
  if (!DIAGNOSTICS_ENABLED || typeof event.track?.addEventListener !== "function") return;

  const track = event.track;
  const mid = event.transceiver?.mid ?? null;
  const info = {
    kind: track.kind,
    mid,
    trackId: track.id,
    streamIds: event.streams?.map((s) => s.id) ?? [],
    direction: event.transceiver?.direction,
    readyState: track.readyState,
    muted: track.muted,
    label: track.label,
  };
  console.log(PREFIX, "track", info);
  record("track", info);

  for (const kind of ["unmute", "mute", "ended"] as const) {
    track.addEventListener(kind, () => {
      console.log(PREFIX, `track ${kind}`, mid, track.id);
      record("trackState", { state: kind, mid, trackId: track.id });
    });
  }
}

export function watchDataChannels(pc: RTCPeerConnection): void {
  if (!DIAGNOSTICS_ENABLED || typeof pc.addEventListener !== "function") return;

  pc.addEventListener("datachannel", (event) => {
    console.log(PREFIX, "datachannel received", event.channel.label);
    watchDataChannel(event.channel);
  });
}

const watchedChannels = new WeakSet<RTCDataChannel>();

function watchDataChannel(channel: RTCDataChannel): void {
  if (watchedChannels.has(channel) || typeof channel?.addEventListener !== "function") return;
  watchedChannels.add(channel);
  console.log(PREFIX, "watching datachannel", channel.label);
  channel.addEventListener("message", (event) => {
    logPayload("dc", channel.label, "in", event.data);
  });
}

export function watchCreatedDataChannels(): void {
  const proto = globalThis.RTCDataChannel?.prototype;
  if (!DIAGNOSTICS_ENABLED || !proto) return;

  const originalSend = proto.send;

  proto.send = function (this: RTCDataChannel, ...args: unknown[]) {
    watchDataChannel(this);
    logPayload("dc", this.label, "out", args[0]);
    return Reflect.apply(originalSend, this, args);
  } as RTCDataChannel["send"];
}

/** SSRC/CSRC по аудиоприёмникам: сигналинг не говорит, кто звучит в слоте. */
export function watchPeerConnection(pc: RTCPeerConnection): void {
  if (!DIAGNOSTICS_ENABLED || typeof pc.getReceivers !== "function") return;

  connections.add(pc);
  pc.addEventListener?.("connectionstatechange", () => {
    record("pcState", { state: pc.connectionState });
    if (pc.connectionState === "closed") connections.delete(pc);
  });

  sampler ??= setInterval(sampleRtpSources, RTP_SAMPLE_MS);
}

const lastSenders = new WeakMap<RTCPeerConnection, string>();

function sampleSenders(pc: RTCPeerConnection): void {
  let senders: RTCRtpSender[];
  try {
    senders = pc.getSenders();
  } catch {
    return;
  }

  const state = senders
    .filter((sender) => sender.track?.kind !== "video")
    .map((sender) => ({
      trackId: sender.track?.id ?? null,
      enabled: sender.track?.enabled ?? null,
      muted: sender.track?.muted ?? null,
      readyState: sender.track?.readyState ?? null,
    }));

  const key = JSON.stringify(state);
  if (lastSenders.get(pc) === key) return;
  lastSenders.set(pc, key);
  record("senders", { senders: state });
}

export function logGetUserMedia(
  constraints: MediaStreamConstraints | undefined,
  stream: MediaStream,
): void {
  if (!DIAGNOSTICS_ENABLED) return;
  const tracks = stream.getAudioTracks().map((track) => ({
    trackId: track.id,
    label: track.label,
    settings: track.getSettings?.() ?? null,
  }));
  console.log(PREFIX, "getUserMedia", constraints, tracks);
  record("gum", { constraints: JSON.parse(JSON.stringify(constraints ?? null)), tracks });
  for (const track of stream.getAudioTracks()) {
    for (const kind of ["mute", "unmute", "ended"] as const) {
      track.addEventListener(kind, () => record("gumTrack", { state: kind, trackId: track.id }));
    }
  }
}

function sampleRtpSources(): void {
  const withStats = ++samplesTaken % STATS_EVERY_SAMPLES === 0;
  for (const pc of connections) {
    sampleSenders(pc);
    let receivers: RTCRtpReceiver[];
    try {
      receivers = pc.getReceivers();
    } catch {
      continue;
    }
    for (const receiver of receivers) {
      if (receiver.track?.kind !== "audio") continue;
      const mid = midOf(pc, receiver);
      if (withStats) void recordReceiverStats(receiver, mid);

      const sync = safeSources(() => receiver.getSynchronizationSources?.() ?? []);
      const contributing = safeSources(() => receiver.getContributingSources?.() ?? []);
      if (sync.length === 0 && contributing.length === 0) continue;

      record("rtp", {
        mid,
        // [ssrc, audioLevel]
        sync: sync.map((s) => [s.source, s.audioLevel ?? null]),
        ...(contributing.length > 0
          ? { csrc: contributing.map((s) => [s.source, s.audioLevel ?? null]) }
          : {}),
      });
    }
  }
}

/** Растут ли декодированные сэмплы: без них дорожка тихая, а источников нет. */
async function recordReceiverStats(receiver: RTCRtpReceiver, mid: string | null): Promise<void> {
  try {
    const report = await receiver.getStats();
    for (const stat of report.values()) {
      if (stat.type !== "inbound-rtp") continue;
      record("rxStats", {
        mid,
        transform: (receiver as { transform?: object | null }).transform?.constructor.name ?? null,
        trackMuted: receiver.track.muted,
        packetsReceived: stat.packetsReceived,
        totalSamplesReceived: stat.totalSamplesReceived,
        concealedSamples: stat.concealedSamples,
        audioLevel: stat.audioLevel,
        jitterBufferEmittedCount: stat.jitterBufferEmittedCount,
        playoutId: stat.playoutId,
      });
    }
  } catch {
    // Статистика приёмника доступна не везде.
  }
}

/** Свой аудиоконвейер страницы: декодер и воспроизведение мимо WebRTC-дорожек. */
export function watchAudioPipeline(): void {
  if (!DIAGNOSTICS_ENABLED) return;

  watchConstructor("RTCRtpScriptTransform", (args) => ({ options: plain(args[1]) }));
  watchConstructor("AudioDecoder");
  watchConstructor("AudioContext", (args) => ({ options: plain(args[0]) }));
  watchConstructor("MediaStreamTrackGenerator", (args) => ({ options: plain(args[0]) }));

  const worklet = globalThis.AudioWorklet?.prototype;
  const originalAddModule = worklet?.addModule;
  if (worklet && typeof originalAddModule === "function") {
    worklet.addModule = function (this: AudioWorklet, url: string | URL, options?: WorkletOptions) {
      record("audioWorklet", { url: String(url).slice(0, 200) });
      return originalAddModule.call(this, url, options);
    };
  }
}

function watchConstructor(
  name: string,
  describe: (args: unknown[]) => Record<string, unknown> = () => ({}),
): void {
  const scope = globalThis as unknown as Record<string, unknown>;
  const original = scope[name];
  if (typeof original !== "function") return;

  scope[name] = new Proxy(original, {
    construct(target, args, newTarget) {
      record("ctor", { name, ...describe(args) });
      return Reflect.construct(target, args, newTarget);
    },
  });
}

function plain(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return String(value);
  }
}

/** Звук фрагмента целиком: по дампу можно проверить, что ушло в распознавание. */
export function recordChunkAudio(speakerId: string, timestamp: number, base64: string): void {
  if (DIAGNOSTICS_ENABLED) record("chunkAudio", { speakerId, timestamp, data: base64 });
}

export function recordLevel(speakerId: string, level: number | null, threshold: number): void {
  if (DIAGNOSTICS_ENABLED) record("level", { speakerId, level, threshold });
}

function safeSources<T>(read: () => T[]): T[] {
  try {
    return read();
  } catch {
    return [];
  }
}

function midOf(pc: RTCPeerConnection, receiver: RTCRtpReceiver): string | null {
  try {
    for (const transceiver of pc.getTransceivers()) {
      if (transceiver.receiver === receiver) return transceiver.mid;
    }
  } catch {
    // Трансиверы доступны не везде.
  }
  return null;
}

/** Патчим конструктор: на уже открытый сокет подписаться нельзя. */
export function watchWebSockets(): void {
  if (!DIAGNOSTICS_ENABLED) return;

  const OriginalWebSocket = globalThis.WebSocket;
  if (typeof OriginalWebSocket !== "function") return;

  class DiagnosticWebSocket extends OriginalWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const label = socketLabel(url);
      console.log(PREFIX, "websocket open", String(url));
      record("wsOpen", { url: String(url) });
      this.addEventListener("message", (event: MessageEvent) => {
        logPayload("ws", label, "in", event.data);
      });
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      const outgoing = typeof data === "string" ? patchSetSlots(data) : data;
      logPayload("ws", socketLabel(this.url), "out", outgoing);
      super.send(outgoing as string);
    }
  }

  globalThis.WebSocket = DiagnosticWebSocket;
  announce();
}

/** Meet ходит в сигналинг через gRPC-web поверх fetch/XHR, а не WebSocket. */
export function watchRpc(): void {
  if (!DIAGNOSTICS_ENABLED) return;

  const isRpc = (url: string) => url.includes("$rpc") || url.includes("/rpc/");

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === "function") {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (isRpc(url) && init?.body) logPayload("rpc", socketLabel(url), "out", init.body);
      const response = await originalFetch(input, init);
      if (isRpc(url)) {
        void response
          .clone()
          .arrayBuffer()
          .then((body) => logPayload("rpc", socketLabel(url), "in", body))
          .catch(() => undefined);
      }
      return response;
    };
  }

  const xhr = globalThis.XMLHttpRequest?.prototype;
  if (!xhr) return;
  const originalOpen = xhr.open;
  const originalSend = xhr.send;
  const urls = new WeakMap<XMLHttpRequest, string>();
  xhr.open = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest["open"]>) {
    urls.set(this, String(args[1]));
    return originalOpen.apply(this, args);
  } as XMLHttpRequest["open"];
  xhr.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const url = urls.get(this) ?? "";
    if (isRpc(url)) {
      if (body) logPayload("rpc", socketLabel(url), "out", body);
      this.addEventListener("load", () => {
        const data =
          this.responseType === "" || this.responseType === "text"
            ? this.responseText
            : this.response;
        logPayload("rpc", socketLabel(url), "in", data);
      });
    }

    return originalSend.call(this, body);
  };
}

/** Подменяет audioSlotsCount и число слотов в исходящем setSlots. */
let desiredAudioSlots = DEFAULT_AUDIO_SLOTS;
let desiredSlotCount = DEFAULT_SLOT_COUNT;

type SetSlotsMessage = {
  setSlots?: {
    audioSlotsCount?: number;
    slots?: { width?: number; height?: number }[];
  };
};

function patchSetSlots(payload: string): string {
  const wanted = desiredAudioSlots > 0 || desiredSlotCount > 0;
  if (!wanted || !payload.includes('"setSlots"')) return payload;

  let message: SetSlotsMessage;
  try {
    message = JSON.parse(payload);
  } catch {
    return payload;
  }
  const setSlots = message?.setSlots;
  if (!setSlots || typeof setSlots !== "object") return payload;

  let changed = false;

  const originalAudio = setSlots.audioSlotsCount;
  if (desiredAudioSlots > 0 && originalAudio !== desiredAudioSlots) {
    setSlots.audioSlotsCount = desiredAudioSlots;
    record("setSlotsPatched", { from: originalAudio ?? null, to: desiredAudioSlots });
    console.log(PREFIX, `setSlots: audioSlotsCount ${originalAudio} → ${desiredAudioSlots}`);
    changed = true;
  }

  // Только дополняем хвост: первые слоты задают видимую сетку.
  const slots = setSlots.slots;
  if (desiredSlotCount > 0 && Array.isArray(slots) && slots.length < desiredSlotCount) {
    const from = slots.length;
    while (slots.length < desiredSlotCount) slots.push({ width: 0, height: 0 });
    record("slotCountPatched", { from, to: slots.length });
    console.log(PREFIX, `setSlots: слотов ${from} → ${slots.length}`);
    changed = true;
  }

  return changed ? JSON.stringify(message) : payload;
}

function socketLabel(url: string | URL): string {
  try {
    return new URL(String(url)).pathname;
  } catch {
    return String(url);
  }
}

function logPayload(channel: string, label: string, dir: "in" | "out", data: unknown): void {
  if (data instanceof Blob) {
    void data
      .arrayBuffer()
      .then((buffer) => logPayload(channel, label, dir, buffer))
      .catch(() => undefined);
    return;
  }

  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : null;

  if (bytes) {
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    // Текстовая версия теряет байты протобуфа и сжатых сообщений: для разбора нужен оригинал.
    emit(channel, label, dir, printable(decoded), bytes.byteLength, toBase64(bytes));
    return;
  }

  if (typeof data === "string") {
    emit(channel, label, dir, data, data.length);
    return;
  }
  emit(channel, label, dir, `<${typeof data}>`, 0);
}

function emit(
  channel: string,
  label: string,
  dir: "in" | "out",
  text: string,
  size: number,
  raw?: string,
): void {
  record(channel, { label, dir, size, payload: text, ...(raw ? { raw } : {}) });
  console.log(PREFIX, channel, dir, label, truncateForConsole(text));
}

export function logRemoteSdp(sdp: string | undefined): void {
  if (!DIAGNOSTICS_ENABLED || !sdp) return;

  const lines = sdp
    .split(/\r?\n/)
    .filter((line) => line.startsWith("m=") || /^a=(mid|msid|ssrc|extmap):/.test(line));
  console.log(PREFIX, `remote sdp\n${lines.join("\n")}`);
  record("sdp", { sdp });
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function printable(value: string): string {
  let result = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    result += code < 0x20 || code === 0x7f ? "·" : char;
  }
  return result.replace(/·+/g, "·");
}

function truncateForConsole(value: string): string {
  return value.length > CONSOLE_PAYLOAD ? `${value.slice(0, CONSOLE_PAYLOAD)}…` : value;
}

function announce(): void {
  const api = {
    save(): number {
      const header = JSON.stringify({
        type: "meta",
        startedAtISO: new Date(startedAt).toISOString(),
        url: location.href,
        userAgent: navigator.userAgent,
        records: records.length,
        overflowed,
      });
      const body = records.map((entry) => JSON.stringify(entry)).join("\n");
      const blob = new Blob([`${header}\n${body}\n`], { type: "application/x-ndjson" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `rechiv-diag-${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}.ndjson`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
      return records.length;
    },
    stats(): Record<string, number> {
      const counts: Record<string, number> = {};
      for (const entry of records) counts[entry.type] = (counts[entry.type] ?? 0) + 1;
      return counts;
    },
    /** 0 — поведение обычного клиента. Применится к следующему setSlots. */
    audioSlots(count?: number): number {
      if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
        desiredAudioSlots = Math.floor(count);
        console.log(
          PREFIX,
          desiredAudioSlots === 0
            ? "подмена audioSlotsCount выключена"
            : `просим ${desiredAudioSlots} аудиослотов начиная со следующего setSlots`,
        );
      }
      return desiredAudioSlots;
    },
    /** Применится к следующему setSlots; вызвать его можно ресайзом окна. */
    slots(count?: number): number {
      if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
        desiredSlotCount = Math.floor(count);
        console.log(
          PREFIX,
          desiredSlotCount === 0
            ? "подмена числа слотов выключена"
            : `просим ${desiredSlotCount} слотов начиная со следующего setSlots`,
        );
      }
      return desiredSlotCount;
    },

    tiles(): Record<string, string> {
      const result: Record<string, string> = {};
      for (const entry of records) {
        if (entry.type === "tile") result[String(entry.id)] = String(entry.text);
      }
      return result;
    },

    vad(): { at: number; active: string[] }[] {
      const result: { at: number; active: string[] }[] = [];
      for (const entry of records) {
        if (entry.type !== "ws" || entry.dir !== "in") continue;
        const payload = entry.payload;
        if (typeof payload !== "string" || !payload.includes('"slotsConfig"')) continue;
        let message: {
          slotsConfig?: {
            slots?: {
              vad?: boolean;
              participant?: { participantId?: string };
              participantVideoByMid?: { participantId?: string };
            }[];
          };
        };
        try {
          message = JSON.parse(payload);
        } catch {
          continue;
        }
        const slots = message.slotsConfig?.slots;
        if (!Array.isArray(slots)) continue;
        const active = slots
          .filter((slot) => slot?.vad === true)
          .map(
            (slot) => slot.participant?.participantId ?? slot.participantVideoByMid?.participantId,
          )
          .filter((id): id is string => typeof id === "string");
        const previous = result.at(-1);
        if (previous && previous.active.join() === active.join()) continue;
        result.push({ at: entry.t as number, active });
      }
      return result;
    },

    audio(): Record<string, { samples: number; ssrc: number[] }> {
      const result: Record<string, { samples: number; ssrc: number[] }> = {};
      for (const entry of records) {
        if (entry.type !== "rtp") continue;
        const mid = String(entry.mid);
        result[mid] ??= { samples: 0, ssrc: [] };
        const slot = result[mid];
        slot.samples++;
        for (const [source] of (entry.sync ?? []) as [number, number | null][]) {
          if (!slot.ssrc.includes(source)) slot.ssrc.push(source);
        }
      }
      return result;
    },
    stop(): void {
      if (sampler) clearInterval(sampler);
      sampler = null;
      console.log(PREFIX, "опрос RTP остановлен, собранное сохраняется через save()");
    },
  };
  (globalThis as unknown as { __rechivDiag: typeof api }).__rechivDiag = api;

  console.log(
    `%c${PREFIX} диагностическая сборка активна`,
    "background:#b8860b;color:#fff;padding:2px 6px;border-radius:3px",
  );
  console.log(
    PREFIX,
    "ручки: __rechivDiag.slots(30) — просить больше слотов сетки; " +
      "__rechivDiag.audioSlots(8) — просить отдельные аудиослоты (сервер это уже игнорировал)",
  );
  console.log(
    PREFIX,
    "что видно: __rechivDiag.vad() и __rechivDiag.audio()   в конце: __rechivDiag.save()",
  );
}
