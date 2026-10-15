import { cleanParticipantName } from "../names";
import type { PageAdapter, PageAdapterHost } from "../types";
import { EncodedAudioTap } from "./encoded-audio";
import {
  type CollectionsUpdate,
  decodeCollectionsMessage,
  decodeRpcResponse,
  type MeetAudioSource,
  requestDeviceId,
} from "./protocol";
import { watchMeetRpc } from "./rpc";

const PREFIX = "[Rechiv:meet]";
const SAMPLE_MS = 100;
/** getContributingSources помнит источники 10 с: без отсечки замолчавший участник остаётся в дорожке. */
const SOURCE_FRESH_MS = 500;
const SAMPLES_KEPT_MS = 10 * 60_000;
/** Ниже этой доли фрагмент смешанный: ложное имя хуже безымянного. */
const DOMINANT_SHARE = 0.6;
/** Ответы с записями устройств: уже бывшие в звонке, своё устройство и вошедшие позже. */
const DEVICE_METHODS = new Set([
  "MeetingSpaceService/SyncMeetingSpaceCollections",
  "MeetingDeviceService/UpdateMeetingDevice",
  "MeetingDeviceService/CreateMeetingDevice",
]);
const SELF_METHOD = "MeetingDeviceService/UpdateMeetingDevice";
const ENCODED_STREAM_PREFIX = "remote-meet-";

type Sample = { at: number; csrc: number; level: number };

export class GoogleMeetPageAdapter implements PageAdapter {
  readonly id = "google-meet";

  private readonly peerConnections = new Set<RTCPeerConnection>();
  private readonly midByStream = new Map<string, string>();
  private readonly sources = new Map<number, MeetAudioSource>();
  private readonly names = new Map<string, string>();
  /** Первым UpdateMeetingDevice клиент регистрирует себя; чужие устройства он трогает позже. */
  private selfDeviceId: string | null = null;
  private readonly samples = new Map<string, Sample[]>();
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private host: PageAdapterHost | null = null;
  private readonly encoded = new EncodedAudioTap((csrc, stream) =>
    this.host?.addRemoteStream(`${ENCODED_STREAM_PREFIX}${csrc}`, stream),
  );

  install(host?: PageAdapterHost): void {
    this.host = host ?? null;
    this.encoded.install();
    watchMeetRpc({
      request: (method, body) => {
        if (method === SELF_METHOD) this.selfDeviceId ??= requestDeviceId(body);
      },
      response: (method, body) => {
        if (DEVICE_METHODS.has(method)) this.apply(decodeRpcResponse(body));
      },
    });
  }

  notePeerConnection(pc: RTCPeerConnection): void {
    this.peerConnections.add(pc);
    pc.addEventListener("datachannel", (event: RTCDataChannelEvent) => {
      if (event.channel.label === "collections") this.watchCollections(event.channel);
    });
  }

  ownsRemoteTrack(trackId: string): boolean {
    return this.encoded.ownsTrack(trackId);
  }

  noteRemoteTrack(streamId: string, mid: string | null): void {
    if (mid) this.midByStream.set(streamId, mid);
  }

  startVadCapture(): void {
    this.encoded.active = true;
    this.samples.clear();
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    this.sampleTimer = setInterval(() => this.sampleSources(), SAMPLE_MS);
  }

  attributeChunk(
    start: number,
    end: number,
    speakerId: string,
  ): { participantId: string; name: string } | null {
    const csrc = speakerId.startsWith(ENCODED_STREAM_PREFIX)
      ? Number(speakerId.slice(ENCODED_STREAM_PREFIX.length))
      : this.sampledSource(speakerId, start, end);
    const deviceId = csrc === null ? undefined : this.sources.get(csrc)?.deviceId;
    if (!deviceId) return null;

    const name = this.names.get(deviceId);
    return name ? { participantId: `meet-device-${deviceId}`, name } : null;
  }

  getSpeakerMap(): Record<string, string> | null {
    const localName = this.selfDeviceId && this.names.get(this.selfDeviceId);
    return localName ? { local: localName } : null;
  }

  isLocalMuted(): boolean {
    return false;
  }

  syncMuteSubscription(): void {
    // Свой мьют — enabled = false на отправляемом треке: тишину отсеет SpeechGate.
  }

  teardown(): void {
    this.encoded.active = false;
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    this.sampleTimer = null;
  }

  private watchCollections(channel: RTCDataChannel): void {
    console.log(PREFIX, "watching collections channel");
    channel.addEventListener("message", (event: MessageEvent) => {
      void this.readCollections(event.data);
    });
  }

  private async readCollections(data: unknown): Promise<void> {
    try {
      const buffer =
        data instanceof Blob ? await data.arrayBuffer() : data instanceof ArrayBuffer ? data : null;
      if (!buffer) return;
      this.apply(await decodeCollectionsMessage(buffer));
    } catch (err) {
      console.warn(PREFIX, "collections message not decoded:", err);
    }
  }

  private apply(update: CollectionsUpdate): void {
    for (const source of update.sources) this.sources.set(source.csrc, source);
    for (const device of update.devices) {
      const name = cleanParticipantName(device.name);
      if (name) this.names.set(device.deviceId, name);
    }
  }

  private sampleSources(): void {
    const now = performance.now();
    for (const pc of this.peerConnections) {
      if (pc.connectionState === "closed") {
        this.peerConnections.delete(pc);
        continue;
      }

      for (const transceiver of pc.getTransceivers?.() ?? []) {
        const { mid, receiver } = transceiver;
        if (!mid || receiver.track?.kind !== "audio") continue;
        const latest = receiver.getSynchronizationSources?.()[0]?.timestamp;
        if (latest === undefined) continue;

        const list = this.samples.get(mid) ?? [];
        for (const source of receiver.getContributingSources?.() ?? []) {
          if (latest - source.timestamp > SOURCE_FRESH_MS) continue;
          list.push({ at: now, csrc: source.source, level: source.audioLevel ?? 0 });
        }
        while (list.length > 0 && now - list[0].at > SAMPLES_KEPT_MS) list.shift();
        this.samples.set(mid, list);
      }
    }
  }

  private sampledSource(speakerId: string, start: number, end: number): number | null {
    const mid = this.midByStream.get(speakerId.replace(/^remote-/, ""));
    return mid ? this.dominantSource(this.samples.get(mid) ?? [], start, end) : null;
  }

  private dominantSource(samples: Sample[], start: number, end: number): number | null {
    const levels = new Map<number, number>();
    const counts = new Map<number, number>();
    for (const sample of samples) {
      if (sample.at < start || sample.at > end || !this.sources.has(sample.csrc)) continue;
      levels.set(sample.csrc, (levels.get(sample.csrc) ?? 0) + sample.level);
      counts.set(sample.csrc, (counts.get(sample.csrc) ?? 0) + 1);
    }
    // Уровня нет, если Meet не прислал его: тогда решает число пакетов.
    const weights = [...levels.values()].some((level) => level > 0) ? levels : counts;
    let total = 0;
    let best: number | null = null;

    for (const [csrc, weight] of weights) {
      total += weight;
      if (best === null || weight > (weights.get(best) ?? 0)) best = csrc;
    }
    if (best === null || total === 0) return null;

    return (weights.get(best) ?? 0) / total >= DOMINANT_SHARE ? best : null;
  }
}
