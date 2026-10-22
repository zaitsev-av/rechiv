import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkPendingSessions,
  rememberCallFrame,
  SessionController,
  sendToCallFrame,
} from "../src/background/service-worker";
import type { SttApiClient } from "../src/shared/api-client";
import { mockTab } from "./mocks";
import { chromeMock, sessionStore } from "./setup";
import { mockSession, mockSttApi } from "./stt-mocks";

const mockApi = {
  health: vi.fn<SttApiClient["health"]>(),
  createSession: vi.fn<SttApiClient["createSession"]>().mockResolvedValue(mockSession()),
  uploadVadTimeline: vi.fn<SttApiClient["uploadVadTimeline"]>().mockResolvedValue(undefined),
  finishSession: vi.fn<SttApiClient["finishSession"]>().mockResolvedValue({ status: "processing" }),
  getSession: vi
    .fn<SttApiClient["getSession"]>()
    .mockResolvedValue(mockSession({ status: "completed" })),
};

describe("SessionController", () => {
  let ctrl: SessionController;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.health.mockResolvedValue({ status: "ok", engine: { status: "ready" } });
    ctrl = new SessionController(mockSttApi(mockApi));
  });

  it("starts recording", async () => {
    const result = await ctrl.startRecording("https://stream.wb.ru/room/test");
    expect(mockApi.createSession).toHaveBeenCalledWith("https://stream.wb.ru/room/test");
    expect(result.sessionId).toBe("abc123");
    expect(ctrl.state).toBe("recording");
  });

  it("refuses when STT unavailable", async () => {
    mockApi.health.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(ctrl.startRecording("https://stream.wb.ru/room/test")).rejects.toThrow(
      "STT-сервис не запущен",
    );
  });

  it("refuses with the engine failure reason", async () => {
    mockApi.health.mockResolvedValueOnce({
      status: "ok",
      engine: { status: "error", error: "No module named 'torch'" },
    });
    await expect(ctrl.startRecording("https://stream.wb.ru/room/test")).rejects.toThrow(
      "No module named 'torch'",
    );
    expect(mockApi.createSession).not.toHaveBeenCalled();
  });

  it("starts while the engine is still warming up", async () => {
    mockApi.health.mockResolvedValueOnce({ status: "ok", engine: { status: "starting" } });
    await expect(ctrl.startRecording("https://stream.wb.ru/room/test")).resolves.toBeDefined();
  });

  it("stops recording", async () => {
    await ctrl.startRecording("https://stream.wb.ru/room/test");
    await ctrl.stopRecording();
    expect(mockApi.finishSession).toHaveBeenCalledWith("abc123");
    expect(ctrl.state).toBe("idle");
  });

  it("uploads VAD before finishing the session", async () => {
    await ctrl.startRecording("https://telemost.yandex.ru/j/test");
    const timeline = {
      micEvents: [],
      localParticipantId: "local-id",
      participants: [{ participantId: "remote-id", name: "Гость" }],
      events: [{ at: 1, active: ["remote-id"] }],
    };

    await ctrl.stopRecording(timeline);

    expect(mockApi.uploadVadTimeline).toHaveBeenCalledWith("abc123", timeline);
    expect(mockApi.uploadVadTimeline.mock.invocationCallOrder[0]).toBeLessThan(
      mockApi.finishSession.mock.invocationCallOrder[0],
    );
  });

  it("finishes the session even when VAD upload fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockApi.uploadVadTimeline.mockRejectedValueOnce(new Error("upload failed"));
    await ctrl.startRecording("https://telemost.yandex.ru/j/test");

    await expect(
      ctrl.stopRecording({ localParticipantId: "", participants: [], events: [], micEvents: [] }),
    ).resolves.toBeUndefined();

    expect(mockApi.finishSession).toHaveBeenCalledWith("abc123");
    expect(errorSpy).toHaveBeenCalled();
  });

  it("ставит сессию в очередь ожидания готовности", async () => {
    await ctrl.startRecording("https://stream.wb.ru/room/test");
    await ctrl.stopRecording();

    expect(chrome.storage.local.set).toHaveBeenCalledWith({ pendingSessions: ["abc123"] });
    expect(chrome.alarms.create).toHaveBeenCalledWith(
      "rechiv-transcript-ready",
      expect.objectContaining({ periodInMinutes: expect.any(Number) }),
    );
    const [notificationId, options] = chromeMock.notifications.create.mock.calls[0];
    expect(notificationId).toBe("processing-abc123");
    expect(options?.title).toBe("Транскрипция запущена");
  });

  it("завершает сессию, когда вкладку созвона закрыли", async () => {
    await ctrl.startRecording("https://stream.wb.ru/room/test");
    await ctrl.onTabClosed(0);
    expect(mockApi.finishSession).toHaveBeenCalledWith("abc123");
    expect(ctrl.state).toBe("idle");
  });

  it("даёт хвосту догрузиться, прежде чем завершить сессию", async () => {
    vi.useFakeTimers();
    try {
      await ctrl.startRecording("https://stream.wb.ru/room/test");
      const closing = ctrl.onTabClosed(3_000);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(ctrl.state).toBe("suspended");
      expect(mockApi.finishSession).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      await closing;
      expect(mockApi.finishSession).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("не завершает сессию дважды, если её остановили за время паузы", async () => {
    vi.useFakeTimers();
    try {
      await ctrl.startRecording("https://stream.wb.ru/room/test");
      const closing = ctrl.onTabClosed(3_000);
      await ctrl.stopRecording();
      await vi.advanceTimersByTimeAsync(3_000);
      await closing;
      expect(mockApi.finishSession).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("просит завершить вручную, если приложение не ответило", async () => {
    await ctrl.startRecording("https://stream.wb.ru/room/test");
    mockApi.finishSession.mockRejectedValueOnce(new Error("STT-сервис не запущен"));
    await ctrl.onTabClosed(0);
    expect(ctrl.state).toBe("suspended");
    expect(chrome.notifications.create).toHaveBeenCalledWith(
      "suspended-abc123",
      expect.objectContaining({ requireInteraction: true }),
    );
  });

  it("запоминает вкладку записи, чтобы пережить перезапуск воркера", async () => {
    await ctrl.startRecording("https://stream.wb.ru/room/test", 7);
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      activeSession: { sessionId: "abc123", callUrl: "https://stream.wb.ru/room/test", tabId: 7 },
    });
  });

  it("завершает сессию, если вкладку закрыли, пока воркер спал", async () => {
    chromeMock.storage.local.get.mockResolvedValueOnce({
      activeSession: { sessionId: "abc123", callUrl: "https://stream.wb.ru/room/test", tabId: 7 },
    });
    await ctrl.restoreFromStorage();
    expect(mockApi.finishSession).toHaveBeenCalledWith("abc123");
    expect(ctrl.state).toBe("idle");
  });

  it("продолжает запись после сна воркера, если вкладка жива", async () => {
    chromeMock.storage.local.get.mockResolvedValueOnce({
      activeSession: { sessionId: "abc123", callUrl: "https://stream.wb.ru/room/test", tabId: 7 },
    });
    chromeMock.tabs.get.mockResolvedValueOnce(mockTab({ id: 7 }));
    await ctrl.restoreFromStorage();
    expect(mockApi.finishSession).not.toHaveBeenCalled();
    expect(ctrl.state).toBe("recording");
    expect(ctrl.tabId).toBe(7);
  });

  it("refuses second recording", async () => {
    await ctrl.startRecording("https://stream.wb.ru/room/test");
    await expect(ctrl.startRecording("https://stream.wb.ru/room/other")).rejects.toThrow(
      "активная",
    );
  });
});

describe("checkPendingSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("уведомляет и снимает сессию с ожидания, когда транскрипт готов", async () => {
    chromeMock.storage.local.get.mockResolvedValue({ pendingSessions: ["abc123"] });
    const api = {
      getSession: vi
        .fn<SttApiClient["getSession"]>()
        .mockResolvedValue(mockSession({ status: "completed" })),
    };

    await checkPendingSessions(mockSttApi(api));

    const [notificationId, options] = chromeMock.notifications.create.mock.calls[0];
    expect(notificationId).toBe("transcript-ready-abc123");
    expect(options?.title).toBe("Транскрипт готов");
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ pendingSessions: [] });
    expect(chrome.alarms.clear).toHaveBeenCalledWith("rechiv-transcript-ready");
  });

  it("сообщает про ошибки распознавания", async () => {
    chromeMock.storage.local.get.mockResolvedValue({ pendingSessions: ["abc123"] });
    const api = {
      getSession: vi.fn<SttApiClient["getSession"]>().mockResolvedValue(
        mockSession({
          sessionId: "abc123",
          status: "error",
          error: "Не удалось распознать фрагментов: 2",
        }),
      ),
    };

    await checkPendingSessions(mockSttApi(api));

    const [, options] = chromeMock.notifications.create.mock.calls[0];
    expect(options?.title).toContain("с ошибками");
    expect(options?.message).toContain("2");
  });

  it("ждёт автообработку desktop и сообщает её результат", async () => {
    chromeMock.storage.local.get.mockResolvedValue({ pendingSessions: ["abc123"] });
    const getSession = vi
      .fn<SttApiClient["getSession"]>()
      .mockResolvedValueOnce(
        mockSession({ status: "completed", autoProcessing: { pending: true } }),
      )
      .mockResolvedValueOnce(
        mockSession({ status: "completed", autoProcessing: { summaryReady: true } }),
      );

    await checkPendingSessions(mockSttApi({ getSession }));
    expect(chrome.notifications.create).not.toHaveBeenCalled();

    await checkPendingSessions(mockSttApi({ getSession }));
    const [, options] = chromeMock.notifications.create.mock.calls[0];
    expect(options?.title).toBe("Транскрипт и саммари готовы");
  });

  it("сообщает, что саммари не получилось", async () => {
    chromeMock.storage.local.get.mockResolvedValue({ pendingSessions: ["abc123"] });
    const api = {
      getSession: vi
        .fn<SttApiClient["getSession"]>()
        .mockResolvedValue(
          mockSession({ status: "completed", autoProcessing: { summaryFailed: true } }),
        ),
    };

    await checkPendingSessions(mockSttApi(api));

    const [, options] = chromeMock.notifications.create.mock.calls[0];
    expect(options?.message).toContain("Саммари не получилось");
  });

  it("продолжает ждать, пока идёт обработка", async () => {
    chromeMock.storage.local.get.mockResolvedValue({ pendingSessions: ["abc123"] });
    const api = {
      getSession: vi
        .fn<SttApiClient["getSession"]>()
        .mockResolvedValue(mockSession({ status: "processing" })),
    };

    await checkPendingSessions(mockSttApi(api));

    expect(chrome.notifications.create).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ pendingSessions: ["abc123"] });
    expect(chrome.alarms.clear).not.toHaveBeenCalled();
  });

  it("не теряет сессию, если сервис недоступен", async () => {
    chromeMock.storage.local.get.mockResolvedValue({ pendingSessions: ["abc123"] });
    const api = {
      getSession: vi.fn<SttApiClient["getSession"]>().mockRejectedValue(new Error("ECONNREFUSED")),
    };

    await checkPendingSessions(mockSttApi(api));

    expect(chrome.storage.local.set).toHaveBeenCalledWith({ pendingSessions: ["abc123"] });
  });
});

// vi.clearAllMocks() стирает вызов регистрации, поэтому ссылку берём сразу.
const messageHandler = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)?.[0] as (
  msg: unknown,
  sender: unknown,
  respond: (r: unknown) => void,
) => boolean;

describe("показ панели живого транскрипта", () => {
  async function showLive(): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      messageHandler({ action: "showLiveTranscript", sessionId: "s-1" }, {}, (response) =>
        resolve(response as { ok: boolean; error?: string }),
      );
    });
  }

  beforeEach(() => {
    chromeMock.tabs.query.mockResolvedValue([mockTab({ id: 7 })]);
    vi.mocked(chrome.tabs.sendMessage).mockReset();
  });

  it("открывает панель во вкладке созвона", async () => {
    vi.mocked(chrome.tabs.sendMessage).mockResolvedValue(undefined as never);

    await expect(showLive()).resolves.toEqual({ ok: true });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      { action: "showLiveOverlay", sessionId: "s-1" },
      { frameId: 0 },
    );
  });

  // После переустановки в открытой вкладке нет content script: нужно обновить страницу.
  it("подсказывает обновить страницу, когда во вкладке нет слушателя", async () => {
    vi.mocked(chrome.tabs.sendMessage).mockRejectedValue(
      new Error("Could not establish connection. Receiving end does not exist."),
    );

    const response = await showLive();
    expect(response.ok).toBe(false);
    expect(response.error).toContain("Обновите страницу созвона");
    expect(response.error).not.toContain("Receiving end");
  });

  it("сообщает, когда вкладки созвона нет вовсе", async () => {
    chromeMock.tabs.query.mockResolvedValue([]);

    const response = await showLive();
    expect(response.ok).toBe(false);
    expect(response.error).toContain("Вкладка звонка не найдена");
  });
});

describe("сигнал присутствия", () => {
  it("здоровается с приложением по просьбе страницы настройки", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));

    const response = await new Promise((resolve) => {
      messageHandler({ action: "announcePresence" }, {}, resolve);
    });

    expect(response).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/health"),
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Rechiv-Extension-Version": "0.4.1" }),
      }),
    );
  });

  it("молчит, когда приложение не запущено", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const response = await new Promise((resolve) => {
      messageHandler({ action: "announcePresence" }, {}, resolve);
    });

    expect(response).toEqual({ ok: true });
  });
});

/** Команда без frameId ушла бы и в оболочку, которая закрыла бы сессию пустым финишем. */
describe("адресация фрейма звонка", () => {
  const frame = (tabId: number, frameId: number) =>
    ({
      tab: mockTab({ id: tabId }),
      frameId,
      url: "https://telemost.yandex.ru/private-join/1",
    }) satisfies chrome.runtime.MessageSender;

  beforeEach(() => {
    vi.mocked(chrome.tabs.sendMessage).mockClear();
    for (const key of Object.keys(sessionStore)) delete sessionStore[key];
  });

  it("пока звонок не найден, адресует верхнее окно", async () => {
    await sendToCallFrame(101, { action: "startCapture" });

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      101,
      { action: "startCapture" },
      { frameId: 0 },
    );
  });

  it("шлёт команды во фрейм, где нашёлся звонок", async () => {
    await rememberCallFrame(frame(102, 7));

    await sendToCallFrame(102, { action: "stopCapture" });

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      102,
      { action: "stopCapture" },
      { frameId: 7 },
    );
  });

  // Воркер засыпает между входом в звонок и «Записью».
  it("помнит фрейм после перезапуска service worker", async () => {
    await rememberCallFrame(frame(106, 5));

    vi.resetModules();
    const restarted = await import("../src/background/service-worker");
    await restarted.sendToCallFrame(106, { action: "startCapture" });

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      106,
      { action: "startCapture" },
      { frameId: 5 },
    );
  });

  it("у каждой вкладки свой фрейм", async () => {
    await rememberCallFrame(frame(103, 4));
    await rememberCallFrame(frame(104, 9));

    await sendToCallFrame(103, { action: "startCapture" });

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      103,
      { action: "startCapture" },
      { frameId: 4 },
    );
  });

  it("не путается от сообщения без вкладки", async () => {
    await rememberCallFrame({ frameId: 3 } as never);

    await sendToCallFrame(105, { action: "startCapture" });

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      105,
      { action: "startCapture" },
      { frameId: 0 },
    );
  });
});

describe("пробуждение service worker сообщением", () => {
  it("отвечает после bootstrap, а не падает на пустом controller", async () => {
    let releaseConfig!: () => void;
    const configLoaded = new Promise<void>((resolve) => {
      releaseConfig = resolve;
    });
    const originalGet = chromeMock.storage.local.get.getMockImplementation();
    chromeMock.storage.local.get.mockImplementation(async (key) => {
      if (key === "config") await configLoaded;
      return originalGet ? originalGet(key) : {};
    });

    vi.resetModules();
    await import("../src/background/service-worker");
    const handler = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)?.[0] as (
      msg: unknown,
      sender: unknown,
      respond: (r: unknown) => void,
    ) => boolean;
    const response = new Promise((resolve) => handler({ action: "getState" }, {}, resolve));
    releaseConfig();

    await expect(response).resolves.toMatchObject({ state: "idle" });
    if (originalGet) chromeMock.storage.local.get.mockImplementation(originalGet);
  });
});

describe("канал с desktop", () => {
  const callTab = mockTab({ id: 7, url: "https://telemost.yandex.ru/j/123", title: "Дейли" });

  beforeEach(() => {
    // Контроллер живёт в модуле: запись из прошлого теста не должна мешать следующему.
    vi.resetModules();
    for (const key of Object.keys(sessionStore)) delete sessionStore[key];
    vi.mocked(chrome.tabs.get).mockImplementation(async (id) => {
      if (id === 7) return callTab;
      throw new Error("No tab with id");
    });
  });

  it("описывает вкладку, где замечен звонок", async () => {
    const sw = await import("../src/background/service-worker");
    expect(await sw.describeCall()).toBeNull();

    await rememberCallFrame({ tab: callTab, frameId: 3 } as chrome.runtime.MessageSender);
    expect(await sw.describeCall()).toEqual({
      platform: "Яндекс Телемост",
      url: "https://telemost.yandex.ru/j/123",
      title: "Дейли",
      recording: false,
    });
  });

  it("команда start из трея начинает запись в кадре звонка", async () => {
    const sw = await import("../src/background/service-worker");
    await rememberCallFrame({ tab: callTab, frameId: 3 } as chrome.runtime.MessageSender);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/health"))
        return Response.json({ status: "ok", engine: { status: "ready" } });
      if (url.endsWith("/sessions")) return Response.json({ sessionId: "s1", uploadToken: "u1" });
      return new Response(null, { status: 404 });
    });

    await sw.handleCallCommand("start");

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      { action: "startCapture", sessionId: "s1", uploadToken: "u1" },
      { frameId: 3 },
    );
    expect(await sw.describeCall()).toMatchObject({ recording: true, sessionId: "s1" });
    expect(chrome.notifications.create).not.toHaveBeenCalledWith(
      "auto-recording",
      expect.anything(),
    );
  });

  it("помечает вход в созвон по звуку собеседника, а не по WebRTC", async () => {
    const sw = await import("../src/background/service-worker");
    const handler = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)?.[0] as (
      msg: unknown,
      sender: unknown,
      respond: (r: unknown) => void,
    ) => boolean;
    const send = (msg: unknown) =>
      new Promise((resolve) => handler(msg, { tab: callTab, frameId: 3 }, resolve));

    await send({ action: "webrtcDetected", url: callTab.url });
    expect(await sw.describeCall()).not.toHaveProperty("joined");
    await send({ action: "trackAdded", streamId: "a", kind: "local" });
    expect(await sw.describeCall()).not.toHaveProperty("joined");
    await send({ action: "trackAdded", streamId: "b", kind: "remote" });
    expect(await sw.describeCall()).toMatchObject({ joined: true });
  });

  it("автозапись предупреждает уведомлением, а live-панель открывается по папке", async () => {
    const sw = await import("../src/background/service-worker");
    await rememberCallFrame({ tab: callTab, frameId: 3 } as chrome.runtime.MessageSender);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/health"))
        return Response.json({ status: "ok", engine: { status: "ready" } });
      if (url.endsWith("/sessions")) return Response.json({ sessionId: "s2", livePanel: true });
      return new Response(null, { status: 404 });
    });

    await sw.handleCallCommand("start", true);

    expect(chrome.notifications.create).toHaveBeenCalledWith(
      "auto-recording",
      expect.objectContaining({ title: "Запись началась автоматически" }),
    );
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      { action: "showLiveOverlay", sessionId: "s2" },
      { frameId: 0 },
    );
  });
});

describe("вкладка не приняла начало захвата", () => {
  it("удаляет пустую сессию и просит обновить страницу", async () => {
    vi.resetModules();
    const callTab = mockTab({ id: 9, url: "https://telemost.yandex.ru/j/9" });
    vi.mocked(chrome.tabs.get).mockImplementation(async () => callTab);
    const sw = await import("../src/background/service-worker");
    await sw.rememberCallFrame({ tab: callTab, frameId: 2 } as chrome.runtime.MessageSender);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/health"))
        return Response.json({ status: "ok", engine: { status: "ready" } });
      if (url.endsWith("/sessions")) return Response.json({ sessionId: "dead" });
      return new Response(null, { status: 204 });
    });
    vi.mocked(chrome.tabs.sendMessage).mockRejectedValueOnce(
      new Error("Could not establish connection. Receiving end does not exist."),
    );

    await expect(sw.handleCallCommand("start")).rejects.toThrow("Обновите страницу созвона");

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/sessions\/dead$/),
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(await sw.describeCall()).toMatchObject({ recording: false });
    expect(await sw.describeCall()).not.toHaveProperty("stopping");
  });
});
