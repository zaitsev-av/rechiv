import type { PageAdapter } from "../types";

/** Без адаптера: участники безымянны, мьют не отслеживается. */
export class GenericPageAdapter implements PageAdapter {
  readonly id = "generic";

  getSpeakerMap(): Record<string, string> | null {
    return null;
  }

  isLocalMuted(): boolean {
    return false;
  }

  syncMuteSubscription(): void {
    // Событий мьюта нет: тишину отсеет SpeechGate.
  }

  teardown(): void {
    // Подписок нет.
  }
}
