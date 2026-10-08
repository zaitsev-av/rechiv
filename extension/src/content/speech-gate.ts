export const SPEECH_LEVEL = 0.01;
/** Ровный сигнал без перепадов — шум, а не тихая речь: судим по громкости. */
export const STATIONARY_SPEECH_LEVEL = 0.03;
export const NOISE_FACTOR = 3;
/** Отсекает одиночный щелчок: иначе он закрывал бы фрагмент по паузе. */
export const MIN_SPEECH_MS = 400;
export const SILENCE_HOLD_MS = 350;
export const MIN_CHUNK_MS = 3_000;
/** GigaAM переключает режим после ~25 с. */
export const MAX_CHUNK_MS = 20_000;
export const LEVEL_WINDOW = 100;

export type CutReason = "pause" | "limit";

export interface SpeechGateOptions {
  /** Если не задан, порог подстраивается под шум. */
  speechLevel?: number;
  silenceHoldMs?: number;
  minChunkMs?: number;
  maxChunkMs?: number;
  minSpeechMs?: number;
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index];
}

export class SpeechGate {
  private readonly fixedLevel: number | undefined;
  private readonly silenceHoldMs: number;
  private readonly minChunkMs: number;
  private readonly maxChunkMs: number;
  private readonly minSpeechMs: number;

  private startedAt = 0;
  private speechMs = 0;
  private lastSpeechAt = 0;
  private lastPushAt = 0;
  /** Переживает reset: шумовой пол микрофона общий для фрагментов. */
  private readonly levels: number[] = [];

  constructor(options: SpeechGateOptions = {}) {
    this.fixedLevel = options.speechLevel;
    this.silenceHoldMs = options.silenceHoldMs ?? SILENCE_HOLD_MS;
    this.minChunkMs = options.minChunkMs ?? MIN_CHUNK_MS;
    this.maxChunkMs = options.maxChunkMs ?? MAX_CHUNK_MS;
    this.minSpeechMs = options.minSpeechMs ?? MIN_SPEECH_MS;
  }

  reset(now: number): void {
    this.startedAt = now;
    this.speechMs = 0;
    this.lastSpeechAt = 0;
    this.lastPushAt = now;
  }

  threshold(): number {
    if (this.fixedLevel !== undefined) return this.fixedLevel;
    if (this.levels.length < 10) return STATIONARY_SPEECH_LEVEL;

    const sorted = [...this.levels].sort((left, right) => left - right);
    const noiseFloor = percentile(sorted, 0.2);
    const peak = percentile(sorted, 0.95);
    if (peak < noiseFloor * 2) return STATIONARY_SPEECH_LEVEL;
    return Math.max(noiseFloor * NOISE_FACTOR, SPEECH_LEVEL);
  }

  push(level: number, now: number): void {
    this.levels.push(level);
    if (this.levels.length > LEVEL_WINDOW) this.levels.shift();

    const step = this.lastPushAt > 0 ? Math.max(0, now - this.lastPushAt) : 0;
    this.lastPushAt = now;

    if (level >= this.threshold()) {
      this.speechMs += step;
      this.lastSpeechAt = now;
    }
  }

  get hadSpeech(): boolean {
    return this.speechMs >= this.minSpeechMs;
  }

  get speechDurationMs(): number {
    return this.speechMs;
  }

  cutReason(now: number): CutReason | null {
    const elapsed = now - this.startedAt;
    if (elapsed >= this.maxChunkMs) return "limit";
    if (!this.hadSpeech || elapsed < this.minChunkMs) return null;
    if (now - this.lastSpeechAt >= this.silenceHoldMs) return "pause";
    return null;
  }
}

export function rootMeanSquare(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let total = 0;
  for (const sample of samples) total += sample * sample;
  return Math.sqrt(total / samples.length);
}
