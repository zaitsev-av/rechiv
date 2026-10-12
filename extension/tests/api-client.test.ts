import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolvePageSttApiBaseUrl, SttApiClient } from "../src/shared/api-client";

describe("page STT API base URL", () => {
  it("uses relative paths on pages served by the desktop application", () => {
    expect(resolvePageSttApiBaseUrl("http://localhost:9876", "http:")).toBe("");
  });

  it("keeps the configured address inside the extension", () => {
    expect(resolvePageSttApiBaseUrl("http://localhost:9876", "chrome-extension:")).toBe(
      "http://localhost:9876",
    );
  });
});

describe("SttApiClient", () => {
  let client: SttApiClient;

  beforeEach(() => {
    client = new SttApiClient("http://localhost:9876");
    vi.restoreAllMocks();
  });

  it("health check returns status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
    );
    const result = await client.health();
    expect(result.status).toBe("ok");
    expect(fetch).toHaveBeenCalledWith("http://localhost:9876/health", {
      headers: { "X-Rechiv-Extension-Version": "0.4.1" },
    });
  });

  it("createSession sends callUrl", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ sessionId: "abc123", status: "recording" }), { status: 201 }),
      );
    const result = await client.createSession("https://stream.wb.ru/room/test");
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:9876/sessions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ callUrl: "https://stream.wb.ru/room/test" }),
        headers: expect.objectContaining({ "X-Rechiv-Extension-Version": "0.4.1" }),
      }),
    );
    expect(result.sessionId).toBe("abc123");
  });

  it("uploadChunk sends multipart form", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ status: "queued", chunkIndex: 0 }), { status: 202 }),
      );
    const blob = new Blob(["audio"], { type: "audio/webm" });
    await client.uploadChunk("abc123", "speaker-1", 0.0, blob);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:9876/sessions/abc123/chunks",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Rechiv-Extension-Version": "0.4.1" }),
      }),
    );
  });

  it("uploadChunk передаёт атрибуцию фрагмента", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ status: "queued", chunkIndex: 0 }), { status: 202 }),
      );
    const blob = new Blob(["audio"], { type: "audio/webm" });

    await client.uploadChunk("abc123", "remote-mix", 1.5, blob, "participant-a");

    const form = fetchSpy.mock.calls[0]?.[1]?.body as FormData;
    expect(form.get("attributedTo")).toBe("participant-a");
    expect(form.get("speakerId")).toBe("remote-mix");
  });

  it("uploadChunk не шлёт пустую атрибуцию", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ status: "queued", chunkIndex: 0 }), { status: 202 }),
      );
    const blob = new Blob(["audio"], { type: "audio/webm" });

    await client.uploadChunk("abc123", "remote-mix", 1.5, blob);

    const form = fetchSpy.mock.calls[0]?.[1]?.body as FormData;
    expect(form.has("attributedTo")).toBe(false);
  });

  it("isAvailable returns false when service is down", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const available = await client.isAvailable();
    expect(available).toBe(false);
  });

  it("finishSession sends POST", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "processing" }), { status: 202 }),
    );
    await client.finishSession("abc123");
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:9876/sessions/abc123/finish",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uploads the server VAD timeline", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ status: "stored" }), { status: 200 }));
    const timeline = {
      micEvents: [],
      localParticipantId: "local-id",
      participants: [{ participantId: "remote-id", name: "Гость" }],
      events: [{ at: 12.5, active: ["remote-id"] }],
    };

    await client.uploadVadTimeline("abc123", timeline);

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:9876/sessions/abc123/vad",
      expect.objectContaining({ method: "POST", body: JSON.stringify(timeline) }),
    );
  });

  it("getTranscript returns result", async () => {
    const transcript = { sessionId: "abc123", segments: [] };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(transcript), { status: 200 }),
    );
    const result = await client.getTranscript("abc123");
    expect(result.sessionId).toBe("abc123");
  });

  it("getLiveTranscript returns partial result", async () => {
    const live = {
      sessionId: "abc123",
      status: "recording",
      isFinal: false,
      processedChunks: 1,
      totalChunks: 2,
      segments: [{ text: "Уже распознано" }],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(live), { status: 200 }),
    );
    const result = await client.getLiveTranscript("abc123");
    expect(result.isFinal).toBe(false);
    expect(result.segments[0].text).toBe("Уже распознано");
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:9876/sessions/abc123/live",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });

  it("uses the desktop API token when health requires auth", async () => {
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      "stt.api.token": "desktop-token",
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "ok", authRequired: true }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    await client.health();
    await client.listSessions();

    expect(fetchSpy).toHaveBeenLastCalledWith(
      "http://localhost:9876/sessions",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer desktop-token" }),
      }),
    );
  });

  it("openExtensionsPage передаёт выбранный браузер", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ status: "opened" }), { status: 200 }));

    await client.openExtensionsPage("com.brave.Browser");

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:9876/onboarding/open-extensions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ bundleId: "com.brave.Browser" }),
      }),
    );
  });

  it("openExtensionsPage без браузера оставляет выбор приложению", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ status: "opened" }), { status: 200 }));

    await client.openExtensionsPage();

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:9876/onboarding/open-extensions",
      expect.objectContaining({ method: "POST", body: undefined }),
    );
  });

  it("действие онбординга поднимает текст ошибки сервера", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "Браузер Safari не поддерживает расширения Rechiv" }), {
        status: 422,
      }),
    );

    await expect(client.revealExtensionDir()).rejects.toThrow(
      "Браузер Safari не поддерживает расширения Rechiv",
    );
  });
});
