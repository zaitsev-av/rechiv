import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveTranscriptResult, TranscriptResult } from "../src/shared/types";

const mockTranscript: TranscriptResult = {
  sessionId: "test-1",
  date: "2026-03-15",
  callUrl: "https://stream.wb.ru/room/1",
  recordingStarted: "2026-03-15T14:30:00Z",
  duration: "5:00",
  participants: [
    { speakerId: "alice", name: "Alice" },
    { speakerId: "bob", name: "<img src=x onerror=alert(1)>" },
  ],
  segments: [
    { speakerId: "local", speaker: "Alice", start: "00:01", end: "00:05", text: "Привет" },
    {
      speakerId: "remote-123",
      speaker: "<script>alert(1)</script>",
      start: "00:06",
      end: "00:10",
      text: "Ответ",
    },
  ],
};

async function loadTranscriptModule(
  apiResponse: TranscriptResult | LiveTranscriptResult = mockTranscript,
) {
  document.body.innerHTML = `
    <h1 id="title"></h1>
    <p id="info"></p>
    <div id="live-indicator" class="live-indicator hidden">
      <span id="live-indicator-text"></span>
    </div>
    <div class="tabs">
      <button class="tab active" data-tab="transcript">Транскрипт</button>
      <button class="tab disabled" data-tab="summary" id="tab-summary" disabled>Саммари</button>
    </div>
    <div id="panel-transcript" class="tab-panel">
      <div id="filters"></div>
      <div id="segments"></div>
    </div>
    <div id="panel-summary" class="tab-panel hidden">
      <div id="summary-content"></div>
    </div>
    <div id="banner" class="banner hidden">
      <span id="banner-text"></span>
      <button id="banner-close"></button>
    </div>
    <button id="btn-top" class="scroll-top"></button>
    <footer id="footer-transcript">
      <button id="btn-summary" disabled></button>
      <button id="btn-download"></button>
      <button id="btn-copy"></button>
    </footer>
    <footer id="footer-summary" class="hidden">
      <button id="btn-copy-summary"></button>
      <button id="btn-regenerate"></button>
    </footer>
  `;
  Object.defineProperty(window, "location", {
    value: { search: "?sessionId=test-1", href: "", origin: "https://stream.wb.ru" },
    writable: true,
    configurable: true,
  });
  vi.mocked(chrome.storage.local.get).mockImplementation(async (key) => {
    if (key === "config") return { config: { sttServiceUrl: "http://localhost:9876" } };
    if (key === "sessionTitles") return {};
    return {};
  });
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(apiResponse),
  });
  vi.resetModules();
  await import("../src/pages/transcript");
  await new Promise((r) => setTimeout(r, 50));
}

describe("transcript page (module integration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders segments without XSS from malicious speaker names", async () => {
    await loadTranscriptModule();
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("#filters img")).toBeNull();
    const speakers = document.querySelectorAll(".segment-speaker");
    expect(speakers.length).toBe(2);
    expect(speakers[1].textContent).toBe("<script>alert(1)</script>");
  });

  it("renders filter checkboxes for each participant", async () => {
    await loadTranscriptModule();
    const checkboxes = document.querySelectorAll("#filters input[type=checkbox]");
    expect(checkboxes.length).toBe(3); // 2 спикера + "Все"
  });

  it("renders segment text via textContent (not innerHTML)", async () => {
    await loadTranscriptModule();
    const texts = document.querySelectorAll(".segment-text");
    expect(texts.length).toBe(2);
    expect(texts[0].textContent).toBe("Привет");
  });

  it("не даёт править текст реплики", async () => {
    await loadTranscriptModule();
    const text = document.querySelector<HTMLElement>(".segment-text")!;
    text.click();
    expect(text.isContentEditable).toBe(false);
  });

  it("правит название встречи от видимого значения и не оставляет его пустым", async () => {
    await loadTranscriptModule();
    const title = document.getElementById("title")!;
    expect(title.textContent).toBe("Звонок 2026-03-15");

    title.click();
    expect(title.textContent).toBe("Звонок 2026-03-15");

    title.dispatchEvent(new Event("blur"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(title.textContent).toBe("Звонок 2026-03-15");
  });

  it("возвращает страницу наверх по кнопке", async () => {
    await loadTranscriptModule();
    const scrollTo = vi.fn();
    Object.defineProperty(window, "scrollTo", { value: scrollTo, configurable: true });

    document.getElementById("btn-top")!.click();

    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
  });

  it("participant filter label shows name as text, not HTML", async () => {
    await loadTranscriptModule();
    const labels = document.querySelectorAll("#filters label");
    const maliciousLabel = Array.from(labels).find(
      (l) => l.textContent === "<img src=x onerror=alert(1)>",
    );
    expect(maliciousLabel).toBeDefined();
  });

  it("renders an updating, read-only transcript while recording", async () => {
    const liveTranscript: LiveTranscriptResult = {
      ...mockTranscript,
      status: "recording",
      isFinal: false,
      processedChunks: 1,
      totalChunks: 2,
    };

    await loadTranscriptModule(liveTranscript);

    const indicator = document.getElementById("live-indicator")!;
    expect(indicator.classList.contains("hidden")).toBe(false);
    expect(indicator.textContent).toContain("2 реплики");
    expect(document.querySelectorAll(".segment.live-segment")).toHaveLength(2);

    const text = document.querySelector<HTMLElement>(".segment-text")!;
    text.click();
    expect(text.classList.contains("editing")).toBe(false);
    expect((document.getElementById("btn-summary") as HTMLButtonElement).disabled).toBe(true);

    window.dispatchEvent(new Event("beforeunload"));
  });

  it("переименовывает участника и обновляет транскрипт", async () => {
    await loadTranscriptModule();
    const requests = vi.mocked(globalThis.fetch);
    requests.mockClear();

    const speakerEl = document.querySelector<HTMLElement>(".segment-speaker")!;
    speakerEl.click();
    expect(speakerEl.classList.contains("editing")).toBe(true);
    speakerEl.textContent = "  Вера Лапина  ";
    speakerEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 20));

    const [speakersUrl, speakersInit] = requests.mock.calls.find(([url]) =>
      String(url).endsWith("/speakers"),
    )!;
    expect(String(speakersUrl)).toContain("/sessions/test-1/speakers");
    expect(JSON.parse(String(speakersInit?.body))).toEqual({
      speakerId: "local",
      name: "Вера Лапина",
    });

    expect(document.querySelector(".segment-speaker")?.textContent).toBe("Вера Лапина");
    // Имя подставляется сервером по speakerId, транскрипт не переписываем.
    expect(
      requests.mock.calls.some(
        ([url, init]) => String(url).endsWith("/transcript") && init?.method === "PUT",
      ),
    ).toBe(false);
  });

  it("показывает баннер, когда имя сохранить не удалось", async () => {
    await loadTranscriptModule();
    vi.mocked(globalThis.fetch).mockResolvedValue({ ok: false, status: 500 } as Response);

    const speakerEl = document.querySelector<HTMLElement>(".segment-speaker")!;
    speakerEl.click();
    speakerEl.textContent = "Анна";
    speakerEl.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 20));

    const banner = document.getElementById("banner")!;
    expect(banner.classList.contains("hidden")).toBe(false);
    expect(banner.textContent).toContain("Не удалось сохранить имя");
  });
});
