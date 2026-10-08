import { keyValueStore } from "./key-value-store";

export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

export function formatDateTime(date: Date): { date: string; time: string } {
  return {
    date: date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }),
    time: date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
  };
}

export async function getLegacyTitles(): Promise<Record<string, string>> {
  return (await keyValueStore.get<Record<string, string>>("sessionTitles")) ?? {};
}

export async function dropLegacyTitle(sessionId: string): Promise<void> {
  const titles = await getLegacyTitles();
  if (!(sessionId in titles)) return;
  delete titles[sessionId];
  await keyValueStore.set("sessionTitles", titles);
}

export interface RetryOptions {
  attempts: number;
  delays: number[];
}

export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < opts.attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < opts.attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, opts.delays[i]));
      }
    }
  }
  throw lastError;
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
