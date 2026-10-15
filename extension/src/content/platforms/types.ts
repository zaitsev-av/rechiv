import type { VadTimeline } from "@shared/types";

/** Что interceptor даёт адаптеру. */
export interface PageAdapterHost {
  /** Поток, который адаптер собрал сам: страница забрала звук дорожек себе. */
  addRemoteStream(speakerId: string, stream: MediaStream): void;
}

export interface PageAdapter {
  readonly id: string;
  /** До соединений страницы: на открытый WebSocket подписаться уже нельзя. */
  install?(host: PageAdapterHost): void;
  notePeerConnection?(pc: RTCPeerConnection): void;
  /** Дорожка молчит: её звук адаптер отдаёт своим потоком. */
  ownsRemoteTrack?(trackId: string): boolean;
  noteRemoteTrack?(streamId: string, mid: string | null): void;
  /** Привязывает площадочный таймлайн к монотонным часам текущей записи. */
  startVadCapture?(startedAt: number): void;
  getVadTimeline?(): VadTimeline;
  /** Для площадок, где поток не равен участнику. null, если ответ неоднозначен: ложное имя хуже. */
  attributeChunk?(
    start: number,
    end: number,
    speakerId: string,
  ): { participantId: string; name: string } | null;
  /** Надёжные привязки потоков: DOM fallback не должен их перезаписывать. */
  getSpeakerMap(): Record<string, string> | null;
  isLocalMuted(): boolean;
  syncMuteSubscription(onChange: (muted: boolean) => void): void;
  teardown(): void;
}

/** Адаптер площадки в isolated world: имена участников из DOM, fallback к PageAdapter. */
export interface DomAdapter {
  findParticipantName(streamId: string): string | null;
  getAllParticipantNames(): string[];
  getLocalParticipantName(): string | null;
}
