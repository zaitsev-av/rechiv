import type { VadTimeline } from "@shared/types";

export interface PageAdapter {
  readonly id: string;
  /** До соединений страницы: на открытый WebSocket подписаться уже нельзя. */
  install?(): void;
  noteRemoteTrack?(streamId: string, mid: string | null): void;
  /** Привязывает площадочный таймлайн к монотонным часам текущей записи. */
  startVadCapture?(startedAt: number): void;
  getVadTimeline?(): VadTimeline;
  /** Для площадок с комнатным миксом. null, если ответ неоднозначен: ложное имя хуже. */
  attributeChunk?(start: number, end: number): { participantId: string; name: string } | null;
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
