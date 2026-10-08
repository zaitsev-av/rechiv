import type { VadTimeline } from "@shared/types";
import { cleanParticipantName } from "../names";
import type { PageAdapter } from "../types";

const PREFIX = "[Rechiv:telemost]";

/** Сигналинг Телемоста: wss://goloom.strm.yandex.net/join */
const SIGNALING_PATH = "/join";

/**
 * Телемост отдаёт удалённых участников одним аудиомиксом с постоянными SSRC/CSRC.
 * Поток получает имя, только когда удалённый участник один; разделение речи — по vad.
 */
export class TelemostPageAdapter implements PageAdapter {
  readonly id = "telemost";

  private _names = new Map<string, string>();
  /** Позиции из slotsConfig.slots; нулевая — всегда сам пользователь. */
  private _slotParticipants: (string | null)[] = [];
  private _streamByMid = new Map<string, string>();
  private _localParticipantId = "";
  private _vadEvents: { at: number; active: string[] }[] = [];
  private _lastActive: string[] | null = null;
  private _unmuted = new Set<string>();
  private _micEvents: { at: number; unmuted: string[] }[] = [];
  private _lastUnmuted: string[] | null = null;
  /** Из исходящих hello/updateMe; null — ещё неизвестно. */
  private _localMuted: boolean | null = null;
  private _onMuteChange: ((muted: boolean) => void) | null = null;
  private _captureStartedAt: number | null = null;
  private _installed = false;

  install(): void {
    if (this._installed) return;

    const OriginalWebSocket = globalThis.WebSocket;
    if (typeof OriginalWebSocket !== "function") return;
    this._installed = true;

    const adapter = this;
    class TelemostWebSocket extends OriginalWebSocket {
      private readonly _isSignaling: boolean;

      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this._isSignaling = isSignalingUrl(url);
        if (!this._isSignaling) return;
        this.addEventListener("message", (event: MessageEvent) => {
          adapter._handlePayload(event.data);
        });
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        // hello виден только в исходящих.
        if (this._isSignaling) adapter._handlePayload(data);
        super.send(data);
      }
    }

    globalThis.WebSocket = TelemostWebSocket;
    console.log(PREFIX, "signaling interceptor installed");
  }

  noteRemoteTrack(streamId: string, mid: string | null): void {
    if (!mid?.startsWith("audio")) return;
    this._streamByMid.set(mid, streamId);
  }

  startVadCapture(startedAt: number): void {
    this._captureStartedAt = startedAt;
    // Снимок на старте: следующий slotsConfig придёт только на смене активности,
    // и без него первые реплики уходят в «неизвестного».
    this._vadEvents.push({ at: startedAt, active: [...(this._lastActive ?? [])] });
    this._micEvents.push({ at: startedAt, unmuted: this._remoteUnmuted() });
  }

  getVadTimeline(): VadTimeline {
    const startedAt = this._captureStartedAt;
    const events =
      startedAt === null
        ? []
        : this._vadEvents
            .filter((event) => event.at >= startedAt)
            .map((event) => ({
              at: (event.at - startedAt) / 1000,
              active: [...event.active],
            }));
    const micEvents =
      startedAt === null
        ? []
        : this._micEvents
            .filter((event) => event.at >= startedAt)
            .map((event) => ({
              at: (event.at - startedAt) / 1000,
              unmuted: [...event.unmuted],
            }));
    const participants = [...this._names]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([participantId, name]) => ({ participantId, name }));
    return { localParticipantId: this._localParticipantId, participants, events, micEvents };
  }

  /**
   * Правила как в desktop/internal/controller/vad.go, но строже: имя сразу видит человек.
   * Сначала единственный включённый микрофон, затем единственный активный по vad.
   */
  attributeChunk(start: number, end: number): { participantId: string; name: string } | null {
    if (end <= start) return null;

    const unmuted = this._unmutedDuring(start, end);
    const candidates = unmuted && [...new Set([...unmuted, ...this._heardWhileMuted(start, end)])];
    const participantId =
      candidates?.length === 1 ? candidates[0] : this._soleSpeakerDuring(start, end, candidates);
    if (!participantId) return null;

    const name = this._names.get(participantId);
    return name ? { participantId, name } : null;
  }

  /** null — сигнала о микрофонах нет вовсе. */
  private _unmutedDuring(start: number, end: number): string[] | null {
    if (this._micEvents.length === 0) return null;
    const result = new Set<string>();
    for (const [index, event] of this._micEvents.entries()) {
      if (event.at >= end) break;
      // Последнее событие до начала фрагмента тоже действует.
      const next = this._micEvents[index + 1];
      if (next && next.at <= start) continue;
      for (const participantId of event.unmuted) result.add(participantId);
    }
    return [...result];
  }

  /** heardWhileMuted из vad.go. */
  private _heardWhileMuted(start: number, end: number): string[] {
    const result = new Set<string>();
    const heard = new Set<string>();
    let previous: Set<string> | null = null;
    for (const [index, event] of this._vadEvents.entries()) {
      if (event.at >= end) break;
      const current = new Set(event.active);
      for (const participantId of heard) {
        if (!current.has(participantId)) heard.delete(participantId);
      }
      if (previous) {
        for (const participantId of current) {
          if (!previous.has(participantId) && this._mutedAt(participantId, event.at)) {
            heard.add(participantId);
          }
        }
      }
      previous = current;

      const next = this._vadEvents[index + 1];
      if (next && next.at <= start) continue;
      for (const participantId of heard) {
        if (participantId !== this._localParticipantId) result.add(participantId);
      }
    }
    return [...result];
  }

  private _mutedAt(participantId: string, at: number): boolean {
    let unmuted: string[] | null = null;
    for (const event of this._micEvents) {
      if (event.at > at) break;
      unmuted = event.unmuted;
    }
    return unmuted !== null && !unmuted.includes(participantId);
  }

  private _soleSpeakerDuring(start: number, end: number, allowed: string[] | null): string | null {
    const active = new Set<string>();
    for (const [index, event] of this._vadEvents.entries()) {
      if (event.at >= end) break;
      const next = this._vadEvents[index + 1];
      if (next && next.at <= start) continue;
      for (const participantId of event.active) {
        if (participantId === this._localParticipantId) continue;
        if (allowed && !allowed.includes(participantId)) continue;
        active.add(participantId);
      }
    }
    return active.size === 1 ? [...active][0] : null;
  }

  getSpeakerMap(): Record<string, string> | null {
    const result: Record<string, string> = {};

    // Своё имя известно из hello сразу, VAD-реестр узнает его только на остановке.
    const localName = this._names.get(this._localParticipantId);
    if (localName) result.local = localName;

    // Не по микрофонам: имя достаётся потоку на всю запись, и единственный
    // размьюченный в паузе подписал бы собой весь разговор.
    const slotIds = [...new Set(this._slotParticipants.filter((id) => id !== null))];
    if (slotIds.length === 1) {
      const name = this._names.get(slotIds[0]);
      if (name) {
        for (const streamId of new Set(this._streamByMid.values())) {
          result[`remote-${streamId}`] = name;
        }
      }
    }

    return Object.keys(result).length > 0 ? result : null;
  }

  /** Микрофон остаётся захваченным и при выключенной кнопке, шум даёт выдуманные реплики. */
  isLocalMuted(): boolean {
    return this._localMuted ?? false;
  }

  syncMuteSubscription(onChange: (muted: boolean) => void): void {
    this._onMuteChange = onChange;
  }

  teardown(): void {
    // Подписка живёт со страницей: состав меняется и между записями.
    this._onMuteChange = null;
  }

  private _handlePayload(data: unknown): void {
    if (data instanceof Blob) {
      void data
        .text()
        .then((text) => this._handleText(text))
        .catch(() => undefined);
      return;
    }
    if (typeof data === "string") this._handleText(data);
  }

  private _handleText(text: string): void {
    // biome-ignore lint/suspicious/noExplicitAny: сигналинг площадки не типизирован
    let message: any;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }

    const localParticipantId = message?.hello?.participantId;
    const localName = cleanParticipantName(message?.hello?.participantMeta?.name);
    if (typeof localParticipantId === "string") {
      this._localParticipantId = localParticipantId;
      if (localName) this._names.set(localParticipantId, localName);
    }

    const self = message?.hello ?? message?.updateMe;
    const sendAudio = self?.sendAudio ?? self?.participantMeta?.sendAudio;
    if (typeof sendAudio === "boolean") this._noteLocalMuted(!sendAudio);

    const description =
      message?.updateDescription?.description ?? message?.upsertDescription?.description;
    if (Array.isArray(description)) this._rememberNames(description);

    const slots = message?.slotsConfig?.slots;
    if (Array.isArray(slots)) this._rememberSlots(slots);

    if (typeof message?.notification?.payload === "string") {
      this._rememberPeers(message.notification.payload);
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: сигналинг площадки не типизирован
  private _rememberNames(description: any[]): void {
    for (const entry of description) {
      const id = entry?.id;
      if (typeof id !== "string") continue;
      const name = cleanParticipantName(entry?.meta?.name);
      if (name) this._names.set(id, name);

      // sendAudio бывает и в корне, и в meta.
      const sendAudio = entry?.sendAudio ?? entry?.meta?.sendAudio;
      if (typeof sendAudio !== "boolean") continue;
      if (sendAudio) this._unmuted.add(id);
      else this._unmuted.delete(id);
    }
    this._noteMicState();
  }

  private _noteLocalMuted(muted: boolean): void {
    if (muted === this._localMuted) return;
    this._localMuted = muted;
    this._onMuteChange?.(muted);
  }

  private _remoteUnmuted(): string[] {
    return [...this._unmuted].filter((id) => id !== this._localParticipantId).sort();
  }

  private _noteMicState(): void {
    const unmuted = this._remoteUnmuted();
    if (this._lastUnmuted && sameStrings(unmuted, this._lastUnmuted)) return;
    this._lastUnmuted = unmuted;
    this._micEvents.push({ at: performance.now(), unmuted });
  }

  /** Резервный источник имён: notification с payload peers_state. */
  private _rememberPeers(payload: string): void {
    try {
      const parsed = JSON.parse(payload);
      if (parsed?.type !== "peers_state") return;
      for (const peer of parsed?.payload?.peers ?? []) {
        const id = peer?.peer_id;
        const name = cleanParticipantName(peer?.state?.user_data?.display_name);
        if (typeof id === "string" && name && !this._names.has(id)) {
          this._names.set(id, name);
        }
      }
    } catch {
      // Payload не всегда JSON.
    }
  }

  /**
   * Слот бывает `participant` (вдвоём) и `participantVideoByMid` (группа).
   * Позиция — раскладка видеосетки, к аудио отношения не имеет.
   */
  // biome-ignore lint/suspicious/noExplicitAny: сигналинг площадки не типизирован
  private _rememberSlots(slots: any[]): void {
    this._slotParticipants = slots.map((slot) => {
      const id = slot?.participant?.participantId ?? slot?.participantVideoByMid?.participantId;
      return typeof id === "string" ? id : null;
    });

    // Тот же состав приходит и при перестройке сетки — это не граница VAD.
    const active = slots
      .filter((slot) => slot?.vad === true)
      .map((slot) => slot?.participant?.participantId ?? slot?.participantVideoByMid?.participantId)
      .filter((id): id is string => typeof id === "string")
      .sort();
    if (this._lastActive && sameStrings(active, this._lastActive)) return;
    this._lastActive = active;
    this._vadEvents.push({ at: performance.now(), active });
  }
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isSignalingUrl(url: string | URL): boolean {
  try {
    return new URL(String(url), location.href).pathname.endsWith(SIGNALING_PATH);
  } catch {
    return false;
  }
}
