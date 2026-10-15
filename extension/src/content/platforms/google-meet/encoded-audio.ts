/** Служебный CSRC Meet: сопровождает пакеты и не указывает на участника. */
const SERVICE_CSRC = 42;
const FRAME_US = 20_000;
const DECODER_CONFIG: AudioDecoderConfig = {
  codec: "opus",
  sampleRate: 48_000,
  numberOfChannels: 1,
};
const RTP_RATE = 48_000;
const RTP_FRAME = 960;
/** Кадры приходят до джиттер-буфера: запас покрывает разброс задержки сети. */
const PLAYOUT_LEAD_S = 0.15;
/** Отставание больше этого — копится задержка, начинаем заново. */
const MAX_BACKLOG_S = 1;
/** Столько опоздавших кадров подряд значат, что выросла задержка сети, а не один кадр задержался. */
const LATE_FRAMES_TO_RESYNC = 5;
/** Пакеты DTX: в паузе Opus шлёт 1–2 байта, которые декодируются в щелчок на фоне тишины. */
const DTX_MAX_BYTES = 2;

export type EncodedStreams = { readable: ReadableStream; writable: WritableStream };

type EncodedAudioFrame = {
  data: ArrayBuffer;
  getMetadata(): { contributingSources?: number[]; rtpTimestamp?: number };
};

export interface EncodedAudioDeps {
  createDecoder(init: AudioDecoderInit): AudioDecoder;
  createContext(): AudioContext;
}

const browserDeps: EncodedAudioDeps = {
  createDecoder: (init) => new AudioDecoder(init),
  createContext: () => new AudioContext({ sampleRate: DECODER_CONFIG.sampleRate }),
};

type Placed = { author: number; rtp: number };

/**
 * Новый аудиостек Meet забирает кадры через createEncodedStreams и декодирует их сам,
 * поэтому дорожки приёмников молчат. Ответвляем кадры и собираем поток на каждого автора.
 */
export class EncodedAudioTap {
  /** Без записи не декодируем: поток автора создаётся, но остаётся тихим. */
  active = false;
  private readonly tappedTracks = new Set<string>();
  private readonly outputs = new Map<number, MediaStreamAudioDestinationNode>();
  private context: AudioContext | null = null;

  constructor(
    private readonly onStream: (csrc: number, stream: MediaStream) => void,
    private readonly deps: EncodedAudioDeps = browserDeps,
  ) {}

  install(): void {
    const proto = globalThis.RTCRtpReceiver?.prototype as
      | (RTCRtpReceiver & { createEncodedStreams?: () => EncodedStreams })
      | undefined;
    const original = proto?.createEncodedStreams;
    if (!proto || typeof original !== "function" || typeof AudioDecoder !== "function") return;

    const tap = this;
    proto.createEncodedStreams = function (this: RTCRtpReceiver) {
      const streams = original.call(this);
      return this.track?.kind === "audio" ? tap.tap(this.track.id, streams) : streams;
    };
  }

  ownsTrack(trackId: string): boolean {
    return this.tappedTracks.has(trackId);
  }

  tap(trackId: string, streams: EncodedStreams): EncodedStreams {
    try {
      const [page, ours] = streams.readable.tee();
      this.tappedTracks.add(trackId);
      void this.read(ours);
      return { readable: page, writable: streams.writable };
    } catch (err) {
      console.warn("[Rechiv:meet] encoded audio not tapped:", err);
      return streams;
    }
  }

  private async read(readable: ReadableStream): Promise<void> {
    const clock = new PlayoutClock();
    const decoder = new FrameDecoder(this.deps, (placed, audio) => this.play(placed, audio, clock));
    const reader = readable.getReader();
    let fallbackRtp = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        const frame = value as EncodedAudioFrame;
        const meta = frame.getMetadata();
        const author = authorOf(meta.contributingSources);
        if (author === null) continue;
        this.ensureOutput(author);
        fallbackRtp += RTP_FRAME;
        if (!this.active || frame.data.byteLength <= DTX_MAX_BYTES) continue;
        const rtp = meta.rtpTimestamp ?? fallbackRtp;
        decoder.decode({ author, rtp }, frame.data.slice(0));
      }
    } catch (err) {
      console.warn("[Rechiv:meet] encoded audio stopped:", err);
    } finally {
      decoder.close();
    }
  }

  private ensureOutput(csrc: number): void {
    if (this.outputs.has(csrc)) return;
    this.context ??= this.deps.createContext();
    const destination = this.context.createMediaStreamDestination();
    this.outputs.set(csrc, destination);
    this.onStream(csrc, destination.stream);
  }

  private play({ author, rtp }: Placed, audio: AudioData, clock: PlayoutClock): void {
    const destination = this.outputs.get(author);
    const context = this.context;
    if (!destination || !context) {
      audio.close();
      return;
    }
    if (context.state === "suspended") void context.resume().catch(() => undefined);

    const at = clock.place(rtp, context.currentTime);
    if (at === null) {
      audio.close();
      return;
    }
    const buffer = context.createBuffer(1, audio.numberOfFrames, audio.sampleRate);
    try {
      audio.copyTo(buffer.getChannelData(0), { planeIndex: 0, format: "f32-planar" });
    } finally {
      audio.close();
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);
    source.start(at);
  }
}

/**
 * Время воспроизведения кадра — по его RTP-метке: паузы сохраняют длину, переставленные
 * сетью кадры встают на место. Метки общие для дорожки, даже когда в ней сменился автор.
 */
export class PlayoutClock {
  private anchor: { rtp: number; at: number } | null = null;
  private lateInRow = 0;

  /** null — кадр опоздал, его место уже проиграно. */
  place(rtp: number, now: number): number | null {
    if (this.anchor) {
      const at = this.anchor.at + rtpDelta(rtp, this.anchor.rtp) / RTP_RATE;
      if (at >= now && at <= now + MAX_BACKLOG_S) {
        this.lateInRow = 0;
        return at;
      }
      const slightlyLate = at < now && at > now - MAX_BACKLOG_S;
      if (slightlyLate && ++this.lateInRow < LATE_FRAMES_TO_RESYNC) return null;
    }
    this.lateInRow = 0;
    this.anchor = { rtp, at: now + PLAYOUT_LEAD_S };
    return this.anchor.at;
  }
}

/** Разница RTP-меток с учётом переполнения 32 бит. */
function rtpDelta(rtp: number, base: number): number {
  const delta = (rtp - base) >>> 0;
  return delta > 0x7fff_ffff ? delta - 0x1_0000_0000 : delta;
}

export function authorOf(sources: number[] | undefined): number | null {
  return sources?.find((source) => source !== SERVICE_CSRC) ?? null;
}

/** Выход декодера идёт в порядке входа: автора и метку берём из очереди. */
class FrameDecoder {
  private decoder: AudioDecoder | null = null;
  private unavailable = false;
  private readonly placed: Placed[] = [];
  private timestamp = 0;

  constructor(
    private readonly deps: EncodedAudioDeps,
    private readonly onAudio: (placed: Placed, audio: AudioData) => void,
  ) {}

  decode(placed: Placed, data: ArrayBuffer): void {
    const decoder = this.decoder ?? (this.unavailable ? null : this.open());
    if (!decoder) return;
    this.placed.push(placed);
    this.timestamp += FRAME_US;
    try {
      decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: this.timestamp, data }));
    } catch {
      this.close();
    }
  }

  close(): void {
    const decoder = this.decoder;
    this.decoder = null;
    this.placed.length = 0;
    if (decoder && decoder.state !== "closed") decoder.close();
  }

  /** После ошибки WebCodecs закрывает декодер: сбойный кадр теряется, следующий откроет новый. */
  private open(): AudioDecoder | null {
    try {
      const decoder: AudioDecoder = this.deps.createDecoder({
        output: (audio) => {
          const placed = this.decoder === decoder ? this.placed.shift() : undefined;
          if (placed === undefined) audio.close();
          else this.onAudio(placed, audio);
        },
        error: () => {
          if (this.decoder === decoder) this.close();
        },
      });
      decoder.configure(DECODER_CONFIG);
      this.decoder = decoder;
      return decoder;
    } catch (err) {
      console.warn("[Rechiv:meet] opus decoder unavailable:", err);
      this.unavailable = true;
      return null;
    }
  }
}
