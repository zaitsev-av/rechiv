import type { CallCommand, CallPollResult, CallPresence, SttApiClient } from "../shared/api-client";

const PREFIX = "[Rechiv:channel]";
const WAIT_SECONDS = 20;
const REQUEST_TIMEOUT_MS = (WAIT_SECONDS + 10) * 1000;
const RETRY_MS = 5_000;
/** Desktop без ожидания (старая версия, остановка) иначе получил бы бесконечный поток запросов. */
const MIN_POLL_MS = 1_000;

export interface CallChannelDeps {
  api: () => SttApiClient;
  /** null — вкладки созвона нет, канал закрывается. */
  describe: () => Promise<CallPresence | null>;
  onCommand: (command: CallCommand, auto: boolean) => Promise<void>;
  delay?: (ms: number) => Promise<void>;
}

/**
 * Канал вкладка ⇄ desktop: пока открыт созвон, держим долгий запрос к desktop,
 * сообщаем состояние и получаем команды трея. Desktop не может обратиться к расширению сам.
 */
export class CallChannel {
  private _running: Promise<void> | null = null;
  private _abort: AbortController | null = null;
  private _dirty = false;
  private _reported = false;

  constructor(private _deps: CallChannelDeps) {}

  get running(): boolean {
    return this._running !== null;
  }

  /** Запускает цикл, если он ещё не идёт. Безопасно вызывать часто. */
  ensure(): Promise<void> {
    if (!this._running) {
      this._running = this._loop().finally(() => {
        this._running = null;
      });
    }
    return this._running;
  }

  /** Состояние изменилось: прерываем ожидание, чтобы desktop узнал сразу. */
  refresh(): void {
    this._dirty = true;
    this._abort?.abort();
    void this.ensure();
  }

  private async _loop(): Promise<void> {
    const wait = this._deps.delay ?? delay;
    for (;;) {
      this._dirty = false;
      const call = await this._deps.describe();
      if (this._dirty) continue;
      if (!call) {
        if (this._reported) {
          this._reported = false;
          try {
            await this._deps.api().pollCalls(null, 0);
          } catch {
            // Desktop сам забудет созвон без опроса.
          }
        }
        if (!this._dirty) return;
        continue;
      }
      this._reported = true;
      const abort = new AbortController();
      this._abort = abort;
      let result: CallPollResult = {};
      const startedAt = Date.now();
      try {
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
        result = await this._deps.api().pollCalls(call, WAIT_SECONDS, signal);
      } catch (err) {
        if (abort.signal.aborted) continue;
        console.warn(PREFIX, "desktop is unreachable, retrying:", err);
        await wait(RETRY_MS);
        continue;
      } finally {
        this._abort = null;
      }
      if (result.command) {
        try {
          await this._deps.onCommand(result.command, result.auto === true);
        } catch (err) {
          console.error(PREFIX, `command ${result.command} failed:`, err);
        }
      } else if (Date.now() - startedAt < MIN_POLL_MS && !this._dirty) {
        await wait(MIN_POLL_MS);
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
