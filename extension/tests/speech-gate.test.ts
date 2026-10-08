import { describe, expect, it } from "vitest";
import {
  MAX_CHUNK_MS,
  MIN_CHUNK_MS,
  MIN_SPEECH_MS,
  rootMeanSquare,
  SILENCE_HOLD_MS,
  SpeechGate,
  STATIONARY_SPEECH_LEVEL,
} from "../src/content/speech-gate";

const LOUD = STATIONARY_SPEECH_LEVEL * 5;
const QUIET = STATIONARY_SPEECH_LEVEL / 10;
/** Ровный шум громче абсолютного пола — типичный «молчащий» микрофон. */
const NOISE = STATIONARY_SPEECH_LEVEL / 2;

function feed(gate: SpeechGate, level: number, fromMs: number, durationMs: number): number {
  let now = fromMs;
  const until = fromMs + durationMs;
  while (now < until) {
    now += 100;
    gate.push(level, now);
  }
  return now;
}

describe("SpeechGate", () => {
  it("не считает речью тихий фрагмент", () => {
    const gate = new SpeechGate();
    gate.reset(0);
    const now = feed(gate, QUIET, 0, MAX_CHUNK_MS);

    expect(gate.hadSpeech).toBe(false);
    expect(gate.cutReason(now)).toBe("limit");
  });

  it("не считает речью ровный шум микрофона", () => {
    const gate = new SpeechGate();
    gate.reset(0);
    const now = feed(gate, NOISE, 0, MAX_CHUNK_MS);

    expect(gate.hadSpeech).toBe(false);
    expect(gate.cutReason(now)).toBe("limit");
  });

  it("одиночный всплеск не закрывает фрагмент по паузе", () => {
    const gate = new SpeechGate();
    gate.reset(0);
    // Щелчок клавиатуры или вздох: громко, но всего один замер.
    gate.push(LOUD, 100);
    const now = feed(gate, QUIET, 100, MIN_CHUNK_MS + SILENCE_HOLD_MS);

    expect(gate.hadSpeech).toBe(false);
    expect(gate.cutReason(now)).toBeNull();
  });

  it("закрывает фрагмент по паузе после речи", () => {
    const gate = new SpeechGate();
    gate.reset(0);
    let now = feed(gate, LOUD, 0, MIN_CHUNK_MS);
    expect(gate.cutReason(now)).toBeNull();

    now = feed(gate, QUIET, now, SILENCE_HOLD_MS + 100);

    expect(gate.hadSpeech).toBe(true);
    expect(gate.cutReason(now)).toBe("pause");
  });

  it("накапливает речь до минимальной длительности", () => {
    const gate = new SpeechGate();
    gate.reset(0);
    const now = feed(gate, LOUD, 0, MIN_SPEECH_MS - 100);

    expect(gate.hadSpeech).toBe(false);

    feed(gate, LOUD, now, 200);

    expect(gate.hadSpeech).toBe(true);
  });

  it("не режет фразу короче минимальной длины", () => {
    const gate = new SpeechGate();
    gate.reset(0);
    let now = feed(gate, LOUD, 0, 1_000);
    now = feed(gate, QUIET, now, SILENCE_HOLD_MS + 100);

    expect(gate.hadSpeech).toBe(true);
    expect(now).toBeLessThan(MIN_CHUNK_MS);
    expect(gate.cutReason(now)).toBeNull();
  });

  it("не режет непрерывную речь до потолка", () => {
    const gate = new SpeechGate();
    gate.reset(0);
    const now = feed(gate, LOUD, 0, MAX_CHUNK_MS - 1_000);

    expect(gate.cutReason(now)).toBeNull();
    expect(gate.cutReason(MAX_CHUNK_MS)).toBe("limit");
  });

  it("короткая пауза внутри фразы её не разрывает", () => {
    const gate = new SpeechGate();
    gate.reset(0);
    let now = feed(gate, LOUD, 0, MIN_CHUNK_MS);
    now = feed(gate, QUIET, now, SILENCE_HOLD_MS - 150);

    expect(gate.cutReason(now)).toBeNull();
  });

  it("reset начинает новый фрагмент", () => {
    const gate = new SpeechGate();
    gate.reset(0);
    const now = feed(gate, LOUD, 0, MIN_CHUNK_MS + 1_000);
    expect(gate.hadSpeech).toBe(true);

    gate.reset(now);

    expect(gate.hadSpeech).toBe(false);
    expect(gate.cutReason(now)).toBeNull();
  });

  it("подстраивает порог под шумный микрофон", () => {
    const gate = new SpeechGate();
    gate.reset(0);
    let now = feed(gate, NOISE, 0, 5_000);
    now = feed(gate, LOUD, now, 1_000);

    const threshold = gate.threshold();

    expect(threshold).toBeGreaterThan(NOISE);
    expect(threshold).toBeLessThan(LOUD);
  });

  it("уважает фиксированный порог", () => {
    const gate = new SpeechGate({ minChunkMs: 0, silenceHoldMs: 100, speechLevel: 0.5 });
    gate.reset(0);
    feed(gate, 0.4, 0, 1_000);
    expect(gate.hadSpeech).toBe(false);

    const now = feed(gate, 0.6, 1_000, MIN_SPEECH_MS + 100);

    expect(gate.hadSpeech).toBe(true);
    expect(gate.cutReason(now + SILENCE_HOLD_MS)).toBe("pause");
  });
});

describe("rootMeanSquare", () => {
  it("возвращает ноль на тишине и пустом буфере", () => {
    expect(rootMeanSquare(new Float32Array(0))).toBe(0);
    expect(rootMeanSquare(new Float32Array(128))).toBe(0);
  });

  it("растёт вместе с амплитудой", () => {
    const quiet = rootMeanSquare(new Float32Array(128).fill(0.01));
    const loud = rootMeanSquare(new Float32Array(128).fill(0.5));

    expect(quiet).toBeCloseTo(0.01, 5);
    expect(loud).toBeGreaterThan(quiet);
  });
});
