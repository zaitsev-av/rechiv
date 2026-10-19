import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoProcessingKey } from "../src/background/auto-processing";
import { checkPendingSessions } from "../src/background/service-worker";
import * as llm from "../src/shared/llm-client";
import type { Folder, SummaryResult, TranscriptResult } from "../src/shared/types";
import { chromeMock } from "./setup";
import { mockSession, mockSttApi } from "./stt-mocks";

const transcript: TranscriptResult = {
  sessionId: "abc123",
  callUrl: "",
  date: "2026-10-15",
  recordingStarted: "2026-10-15T10:00:00Z",
  duration: "00:01:00",
  participants: [],
  segments: [],
};
const summary: SummaryResult = {
  content: "План релиза продукта",
  createdAt: "2026-10-15",
  model: "model",
  chunked: false,
};
let stored: Record<string, unknown>;
let folder: Folder;
let session: ReturnType<typeof mockSession>;
let saved: SummaryResult | null;
let api: ReturnType<typeof mockSttApi>;

beforeEach(() => {
  vi.clearAllMocks();
  stored = {
    pendingSessions: ["abc123"],
    config: { llmUrl: "https://llm.test", llmModel: "model", llmApiKey: "key" },
  };
  chromeMock.storage.local.get.mockImplementation(async (key) =>
    typeof key === "string" ? { [key]: stored[key] } : stored,
  );
  chromeMock.storage.local.set.mockImplementation(async (items) => {
    Object.assign(stored, structuredClone(items));
  });
  chromeMock.storage.local.remove.mockImplementation(async (key: string) => {
    delete stored[key];
  });
  folder = {
    id: "daily",
    name: "Daily",
    color: 0,
    rules: [],
    settings: { autoSummary: true, titleTemplate: "Дейли — {topic}" },
  };
  session = mockSession({ status: "completed", folderId: "daily", titleAuto: true });
  saved = null;
  api = mockSttApi({
    getSession: vi.fn(async () => session),
    listFolders: vi.fn(async () => [folder]),
    getSummary: vi.fn(async () => saved),
    getTranscript: vi.fn(async () => transcript),
    putSummary: vi.fn(async (_id, value) => {
      saved = value;
    }),
    putTopic: vi.fn(async () => session),
  });
  vi.spyOn(llm, "generateConfiguredSummary").mockResolvedValue(summary);
  vi.spyOn(llm, "prepareLlmConfig").mockResolvedValue({
    llmUrl: "https://llm.test",
    llmApiKey: "key",
    llmModel: "model",
    contextWindow: 128000,
  });
  vi.spyOn(llm, "generateTopic").mockResolvedValue("План релиза продукта");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});
const notification = () => chromeMock.notifications.create.mock.calls.at(-1)?.[1];

describe("автообработка перед уведомлением", () => {
  it("сохраняет саммари и тему, затем уведомляет один раз", async () => {
    await checkPendingSessions(api);
    expect(llm.generateConfiguredSummary).toHaveBeenCalledWith(
      transcript,
      expect.objectContaining({ llmModel: "model" }),
    );
    expect(api.putSummary).toHaveBeenCalledWith("abc123", summary, true);
    expect(llm.generateTopic).toHaveBeenCalledWith(summary.content, expect.anything());
    expect(api.putTopic).toHaveBeenCalledWith("abc123", "План релиза продукта");
    expect(vi.mocked(api.putTopic).mock.invocationCallOrder[0]).toBeLessThan(
      chromeMock.notifications.create.mock.invocationCallOrder[0],
    );
    expect(notification()?.title).toBe("Транскрипт и саммари готовы");
    expect(stored.pendingSessions).toEqual([]);
    await checkPendingSessions(api);
    expect(chromeMock.notifications.create).toHaveBeenCalledOnce();
    expect(llm.generateConfiguredSummary).toHaveBeenCalledOnce();
  });
  it.each([
    "no LLM",
    "no folder",
    "missing folder",
    "no settings",
    "error",
  ])("пропускает LLM: %s", async (reason) => {
    if (reason === "no LLM") stored.config = {};
    if (reason === "no folder") session.folderId = "";
    if (reason === "missing folder") session.folderId = "missing";
    if (reason === "no settings") folder.settings = {};
    if (reason === "error") session.status = "error";
    await checkPendingSessions(api);
    expect(llm.generateConfiguredSummary).not.toHaveBeenCalled();
    expect(llm.generateTopic).not.toHaveBeenCalled();
    expect(stored.pendingSessions).toEqual([]);
    expect(chromeMock.notifications.create).toHaveBeenCalledOnce();
  });
  it("использует существующее саммари без перезаписи", async () => {
    saved = { ...summary, content: "Саммари пользователя", editedAt: "2026-10-16" };
    await checkPendingSessions(api);
    expect(llm.generateConfiguredSummary).not.toHaveBeenCalled();
    expect(api.putSummary).not.toHaveBeenCalled();
    expect(llm.generateTopic).toHaveBeenCalledWith("Саммари пользователя", expect.anything());
  });
  it("не затирает версию, сохранённую во время генерации", async () => {
    vi.mocked(api.putSummary).mockImplementation(async () => {
      saved = { ...summary, content: "Ручная версия" };
    });
    await checkPendingSessions(api);
    expect(api.putSummary).toHaveBeenCalledWith("abc123", summary, true);
    expect(llm.generateTopic).toHaveBeenCalledWith("Ручная версия", expect.anything());
  });
  it("получает только тему из транскрипта без настройки автосаммари", async () => {
    folder.settings!.autoSummary = false;
    await checkPendingSessions(api);
    expect(llm.generateConfiguredSummary).not.toHaveBeenCalled();
    expect(llm.generateTopic).toHaveBeenCalledWith(JSON.stringify(transcript), expect.anything());
    expect(notification()?.title).toBe("Транскрипт готов");
  });
  it.each([
    "no token",
    "manual title",
    "saved topic",
  ])("не запрашивает тему: %s", async (reason) => {
    if (reason === "no token") folder.settings!.titleTemplate = "{date}";
    if (reason === "manual title") session.titleAuto = false;
    if (reason === "saved topic") session.topic = "Сохранённая тема";
    await checkPendingSessions(api);
    expect(llm.generateTopic).not.toHaveBeenCalled();
    expect(api.putTopic).not.toHaveBeenCalled();
  });
  it("не сохраняет тему после ручного переименования во время запроса", async () => {
    vi.mocked(llm.generateTopic).mockImplementation(async () => {
      session.titleAuto = false;
      return "План релиза продукта";
    });
    await checkPendingSessions(api);
    expect(api.putTopic).not.toHaveBeenCalled();
  });
  it("ошибка LLM не оставляет ожидание и не повторяется", async () => {
    vi.mocked(llm.generateConfiguredSummary).mockRejectedValue(new Error("offline"));
    await checkPendingSessions(api);
    expect(notification()?.message).toContain("Саммари не получилось");
    expect(notification()?.message).toContain("вручную на странице транскрипта");
    expect(stored.pendingSessions).toEqual([]);
    await checkPendingSessions(api);
    expect(llm.generateConfiguredSummary).toHaveBeenCalledOnce();
  });
  it("ошибка темы не скрывает готовность саммари", async () => {
    vi.mocked(llm.generateTopic).mockRejectedValue(new Error("offline"));
    await checkPendingSessions(api);
    expect(notification()?.title).toBe("Транскрипт и саммари готовы");
    expect(notification()?.message).toContain("Не удалось определить тему");
    expect(stored.pendingSessions).toEqual([]);
  });
  it("ошибка чтения саммари не считается его отсутствием", async () => {
    vi.mocked(api.getSummary).mockRejectedValue(new Error("500"));
    await checkPendingSessions(api);
    expect(llm.generateConfiguredSummary).not.toHaveBeenCalled();
    expect(api.putSummary).not.toHaveBeenCalled();
    expect(notification()?.message).toContain("Саммари не получилось");
  });
  it("после перезапуска worker завершает начатую попытку без LLM", async () => {
    stored[autoProcessingKey("abc123")] = { summaryFailed: true, topicFailed: true };
    await checkPendingSessions(api);
    expect(llm.generateConfiguredSummary).not.toHaveBeenCalled();
    expect(llm.generateTopic).not.toHaveBeenCalled();
    expect(notification()?.message).toContain("Саммари не получилось");
    expect(stored.pendingSessions).toEqual([]);
  });
  it("совпавшие alarms не запускают две попытки и не теряют новые сессии", async () => {
    let finish!: (value: SummaryResult) => void;
    vi.mocked(llm.generateConfiguredSummary).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = checkPendingSessions(api);
    await vi.waitFor(() => expect(finish).toBeDefined());
    const second = checkPendingSessions(api);
    stored.pendingSessions = ["abc123", "new"];
    finish(summary);
    await Promise.all([first, second]);
    expect(llm.generateConfiguredSummary).toHaveBeenCalledOnce();
    expect(chromeMock.notifications.create).toHaveBeenCalledOnce();
    expect(stored.pendingSessions).toEqual(["new"]);
  });
});
