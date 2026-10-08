import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkLlmAccess,
  chunkSegments,
  estimateTokens,
  generateSummary,
  SYSTEM_PROMPT_MAIN,
  SYSTEM_PROMPT_MAP,
} from "../src/shared/llm-client";
import type { TranscriptResult } from "../src/shared/types";

describe("промпты саммари", () => {
  it("не требуют роль для каждого участника", () => {
    expect(SYSTEM_PROMPT_MAIN).not.toContain("роль/должность");
    expect(SYSTEM_PROMPT_MAIN).toContain("только если он назвал её сам");
  });

  it("не дают отождествлять безымянный поток", () => {
    expect(SYSTEM_PROMPT_MAIN).toContain("«Спикер N»");
  });

  it("сохраняют названную роль на шаге map", () => {
    expect(SYSTEM_PROMPT_MAP).toContain("сохрани роль рядом");
  });
});

describe("estimateTokens", () => {
  it("считает 1 токен на 3 символа", () => {
    expect(estimateTokens("абв")).toBe(1);
    expect(estimateTokens("абвгде")).toBe(2);
    expect(estimateTokens("а")).toBe(1); // ceil(1/3)
  });

  it("пустая строка = 0 токенов", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("chunkSegments", () => {
  const segments = [
    { speaker: "Иван", start: "00:00:00", end: "00:00:10", text: "А".repeat(300) },
    { speaker: "Мария", start: "00:00:10", end: "00:00:20", text: "Б".repeat(300) },
    { speaker: "Иван", start: "00:00:20", end: "00:00:30", text: "В".repeat(300) },
  ];

  it("возвращает один чанк если всё влезает", () => {
    const chunks = chunkSegments(segments, 999999);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(3);
  });

  it("разбивает на несколько чанков по бюджету", () => {
    const chunks = chunkSegments(segments, 200);
    expect(chunks.length).toBeGreaterThan(1);
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    expect(total).toBe(3);
  });

  it("кладёт минимум 1 сегмент в чанк даже если он больше бюджета", () => {
    const chunks = chunkSegments(segments, 1);
    expect(chunks).toHaveLength(3);
  });
});

describe("generateSummary", () => {
  const transcript: TranscriptResult = {
    sessionId: "test-123",
    date: "2026-03-31",
    callUrl: "https://stream.wb.ru/room/1",
    recordingStarted: "2026-03-31T10:00:00",
    duration: "00:01:00",
    participants: [{ speakerId: "local", name: "Иван" }],
    segments: [{ speaker: "Иван", start: "00:00:00", end: "00:00:05", text: "Привет" }],
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("делает один запрос если транскрипт влезает в контекст", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "# Саммари" } }],
        }),
        { status: 200 },
      ),
    );

    const result = await generateSummary(transcript, {
      llmUrl: "https://llm.test/v1",
      llmModel: "test-model",
      llmApiKey: "test-key",
      contextWindow: 128000,
    });

    expect(result.content).toBe("# Саммари");
    expect(result.chunked).toBe(false);
    expect(result.model).toBe("test-model");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://llm.test/v1/chat/completions");
    const body = JSON.parse(opts!.body as string);
    expect(body.model).toBe("test-model");
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toBe(SYSTEM_PROMPT_MAIN);
  });

  it("делает map-reduce если транскрипт не влезает", async () => {
    const longTranscript: TranscriptResult = {
      ...transcript,
      segments: Array.from({ length: 50 }, (_, i) => ({
        speaker: "Иван",
        start: `00:${String(i).padStart(2, "0")}:00`,
        end: `00:${String(i).padStart(2, "0")}:30`,
        text: "Обсуждаем очень важный вопрос ".repeat(50),
      })),
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "# Частичное саммари" } }],
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await generateSummary(longTranscript, {
      llmUrl: "https://llm.test/v1",
      llmModel: "test-model",
      llmApiKey: "test-key",
      contextWindow: 1000,
    });

    expect(result.chunked).toBe(true);
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("выбрасывает ошибку при 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Unauthorized", { status: 401 }));

    await expect(
      generateSummary(transcript, {
        llmUrl: "https://llm.test/v1",
        llmModel: "test-model",
        llmApiKey: "bad-key",
        contextWindow: 128000,
      }),
    ).rejects.toThrow("Неверный API-токен");
  });

  it("выбрасывает ошибку при 429", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Too Many Requests", { status: 429 }),
    );

    await expect(
      generateSummary(transcript, {
        llmUrl: "https://llm.test/v1",
        llmModel: "test-model",
        llmApiKey: "key",
        contextWindow: 128000,
      }),
    ).rejects.toThrow("Слишком много запросов");
  });

  it("выбрасывает ошибку при сетевой ошибке", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      generateSummary(transcript, {
        llmUrl: "https://llm.test/v1",
        llmModel: "test-model",
        llmApiKey: "key",
        contextWindow: 128000,
      }),
    ).rejects.toThrow("Не удалось подключиться к LLM");
  });
});

describe("checkLlmAccess", () => {
  const config = { llmUrl: "https://example.test/v1", llmModel: "m", llmApiKey: "t" };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("различает отказ в доступе", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));

    expect(await checkLlmAccess(config)).toEqual({
      state: "error",
      detail: "Токен не принят: сервис вернул отказ в доступе",
    });
  });

  it("сообщает, что адрес недоступен", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));

    expect((await checkLlmAccess(config)).state).toBe("error");
  });

  it("предупреждает, когда модели нет в списке", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "another" }] }), { status: 200 }),
    );

    const result = await checkLlmAccess(config);

    expect(result.state).toBe("warning");
    expect(result.detail).toContain("\u00abm\u00bb");
  });

  it("подтверждает доступную модель", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "M" }] }), { status: 200 }),
    );

    expect(await checkLlmAccess(config)).toEqual({
      state: "ok",
      detail:
        "\u041c\u043e\u0434\u0435\u043b\u044c \u00abM\u00bb \u0434\u043e\u0441\u0442\u0443\u043f\u043d\u0430",
    });
  });
});
