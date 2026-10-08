import { beforeEach, describe, expect, it, vi } from "vitest";

describe("service worker message handler", () => {
  let messageHandler: (
    msg: Record<string, unknown>,
    sender: chrome.runtime.MessageSender,
    sendResponse: (resp: unknown) => void,
  ) => boolean;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    vi.mocked(chrome.storage.local.get).mockImplementation(async (key) => {
      if (key === "config") return { config: { sttServiceUrl: "http://localhost:9876" } };
      return {};
    });

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
      if (typeof url === "string" && url.includes("/health")) {
        return { ok: true, json: () => Promise.resolve({ status: "ok" }) };
      }
      if (
        typeof url === "string" &&
        url.includes("/sessions") &&
        opts?.method === "POST" &&
        url.includes("/chunks")
      ) {
        return { ok: true, json: () => Promise.resolve({ status: "ok", chunkIndex: 0 }) };
      }
      if (typeof url === "string" && url.includes("/live")) {
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              sessionId: "test-123",
              status: "recording",
              isFinal: false,
              processedChunks: 1,
              totalChunks: 1,
              duration: "00:00:42",
              participants: [],
              segments: [{ speakerId: "local", speaker: "Анна", text: "Проверка" }],
            }),
        };
      }
      if (typeof url === "string" && url.includes("/finish")) {
        return { ok: true, json: () => Promise.resolve({ status: "processing" }) };
      }
      if (typeof url === "string" && url.includes("/sessions") && opts?.method === "POST") {
        return {
          ok: true,
          json: () => Promise.resolve({ sessionId: "test-123", status: "recording" }),
        };
      }
      return { ok: true, json: () => Promise.resolve({}) };
    });

    const listenerCapture = vi.fn();
    vi.mocked(chrome.runtime.onMessage).addListener = listenerCapture;

    (chrome.tabs as any).update = vi.fn().mockResolvedValue({});

    await import("../src/background/service-worker");
    await new Promise((r) => setTimeout(r, 50));

    messageHandler = listenerCapture.mock.calls[0]?.[0];
  });

  function sendMessage(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      messageHandler(msg, { tab: { id: 1 } } as chrome.runtime.MessageSender, resolve);
    });
  }

  it("getState returns state and sessionId", async () => {
    const resp = await sendMessage({ action: "getState" });
    expect(resp).toHaveProperty("state");
    expect(resp).toHaveProperty("sessionId");
  });

  it("webrtcDetected returns ok", async () => {
    const resp = await sendMessage({
      action: "webrtcDetected",
      url: "https://stream.wb.ru/room/1",
    });
    expect(resp).toEqual({ ok: true });
  });

  it("startRecording creates session and returns ok", async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, url: "https://stream.wb.ru/room/1" },
    ] as chrome.tabs.Tab[]);
    const resp = await sendMessage({
      action: "startRecording",
      callUrl: "https://stream.wb.ru/room/1",
    });
    expect(resp).toHaveProperty("ok", true);
    expect(resp).toHaveProperty("sessionId");
  });

  it("stopRecording returns ok", async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 1, url: "https://stream.wb.ru/room/1" },
    ] as chrome.tabs.Tab[]);
    await sendMessage({ action: "startRecording", callUrl: "https://stream.wb.ru/room/1" });
    const resp = await sendMessage({ action: "stopRecording" });
    expect(resp).toEqual({ ok: true, sessionId: "test-123" });
  });

  it("uploadChunk decodes base64 and uploads", async () => {
    const resp = await sendMessage({
      action: "uploadChunk",
      sessionId: "test-123",
      speakerId: "speaker1",
      timestamp: 1000,
      data: btoa("test audio"),
    });
    expect(resp).toEqual({ ok: true });
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it("shows the live transcript as an overlay inside the call tab", async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([
      { id: 17, url: "https://stream.wb.ru/room/1" },
    ] as chrome.tabs.Tab[]);

    const resp = await sendMessage({
      action: "showLiveTranscript",
      sessionId: "test-123",
    });

    expect(resp).toEqual({ ok: true });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      17,
      { action: "showLiveOverlay", sessionId: "test-123" },
      { frameId: 0 },
    );
  });

  it("reports an error when the call tab cannot be found for the live overlay", async () => {
    vi.mocked(chrome.tabs.query).mockResolvedValue([]);

    const resp = await sendMessage({
      action: "showLiveTranscript",
      sessionId: "test-123",
    });

    expect(resp).toEqual({
      ok: false,
      error: "Вкладка звонка не найдена",
    });
  });

  it("opens the full transcript from an overlay action", async () => {
    const resp = await sendMessage({
      action: "openTranscript",
      sessionId: "test-123",
    });

    expect(resp).toEqual({ ok: true });
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: "chrome-extension://mock-id/pages/transcript.html?sessionId=test-123",
    });
  });

  it("relays live transcript reads through the service worker", async () => {
    const resp = await sendMessage({
      action: "getLiveTranscript",
      sessionId: "test-123",
    });

    expect(resp).toMatchObject({
      ok: true,
      live: {
        sessionId: "test-123",
        duration: "00:00:42",
        processedChunks: 1,
      },
    });
  });

  it("persists an identified speaker name through the service worker", async () => {
    const resp = await sendMessage({
      action: "speakerIdentified",
      sessionId: "test-123",
      speakerId: "local",
      name: "Олег Ветров",
    });

    expect(resp).toEqual({ ok: true });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:9876/sessions/test-123/speakers",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ speakerId: "local", name: "Олег Ветров" }),
      }),
    );
  });

  it("unknown action returns ok", async () => {
    const resp = await sendMessage({ action: "someUnknownAction" });
    expect(resp).toEqual({ ok: true });
  });

  it("returns error when startRecording fails", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("connection refused"),
    );
    const resp = await sendMessage({
      action: "startRecording",
      callUrl: "https://stream.wb.ru/room/1",
    });
    expect(resp).toHaveProperty("ok", false);
    expect(resp).toHaveProperty("error");
  });
});
