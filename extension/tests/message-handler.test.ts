import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockResponse, mockTab } from "./mocks";
import { chromeMock } from "./setup";

describe("service worker message handler", () => {
  let messageHandler: Parameters<typeof chrome.runtime.onMessage.addListener>[0];

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    chromeMock.storage.local.get.mockImplementation(async (key) => {
      if (key === "config") return { config: {} };
      return {};
    });

    globalThis.fetch = vi.fn<typeof fetch>().mockImplementation(async (url, opts) => {
      if (typeof url === "string" && url.includes("/health")) {
        return mockResponse({ status: "ok" });
      }
      if (
        typeof url === "string" &&
        url.includes("/sessions") &&
        opts?.method === "POST" &&
        url.includes("/chunks")
      ) {
        return mockResponse({ status: "ok", chunkIndex: 0 });
      }
      if (typeof url === "string" && url.includes("/live")) {
        return mockResponse({
          sessionId: "test-123",
          status: "recording",
          isFinal: false,
          processedChunks: 1,
          totalChunks: 1,
          duration: "00:00:42",
          participants: [],
          segments: [{ speakerId: "local", speaker: "Анна", text: "Проверка" }],
        });
      }
      if (typeof url === "string" && url.includes("/finish")) {
        return mockResponse({ status: "processing" });
      }
      if (typeof url === "string" && url.includes("/sessions") && opts?.method === "POST") {
        return mockResponse({ sessionId: "test-123", status: "recording" });
      }
      return mockResponse({});
    });

    const listenerCapture = vi.fn<typeof chrome.runtime.onMessage.addListener>();
    vi.mocked(chrome.runtime.onMessage).addListener = listenerCapture;

    chromeMock.tabs.update.mockResolvedValue(mockTab());

    await import("../src/background/service-worker");
    await new Promise((r) => setTimeout(r, 50));

    messageHandler = listenerCapture.mock.calls[0][0];
  });

  function sendMessage(msg: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve) => {
      messageHandler(msg, { tab: mockTab({ id: 1 }) }, resolve);
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
    chromeMock.tabs.query.mockResolvedValue([
      mockTab({ id: 1, url: "https://stream.wb.ru/room/1" }),
    ]);
    const resp = await sendMessage({
      action: "startRecording",
      callUrl: "https://stream.wb.ru/room/1",
    });
    expect(resp).toHaveProperty("ok", true);
    expect(resp).toHaveProperty("sessionId");
  });

  it("stopRecording returns ok", async () => {
    chromeMock.tabs.query.mockResolvedValue([
      mockTab({ id: 1, url: "https://stream.wb.ru/room/1" }),
    ]);
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
    chromeMock.tabs.query.mockResolvedValue([
      mockTab({ id: 17, url: "https://stream.wb.ru/room/1" }),
    ]);

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
    chromeMock.tabs.query.mockResolvedValue([]);

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
      "http://rechiv.localhost:9876/sessions/test-123/speakers",
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
