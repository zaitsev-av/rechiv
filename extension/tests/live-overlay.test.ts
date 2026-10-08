import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  destroyLiveTranscriptOverlay,
  LIVE_OVERLAY_SELECTOR,
  showLiveTranscriptOverlay,
} from "../src/content/live-overlay";
import type { LiveTranscriptResult } from "../src/shared/types";

const liveTranscript: LiveTranscriptResult = {
  sessionId: "session-live",
  status: "completed",
  isFinal: true,
  processedChunks: 2,
  totalChunks: 2,
  date: "2026-07-29",
  callUrl: "https://stream.wb.ru/room/live",
  recordingStarted: "2026-07-29T12:00:00Z",
  duration: "00:00:42",
  participants: [{ speakerId: "local", name: "Анна" }],
  segments: [
    {
      speakerId: "local",
      speaker: "<img src=x onerror=alert(1)>",
      start: "00:00:20",
      end: "00:00:40",
      text: "<script>alert(1)</script> Важная реплика",
    },
  ],
};

async function waitForPoll(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("live transcript overlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    destroyLiveTranscriptOverlay();
    vi.mocked(chrome.storage.local.get).mockResolvedValue({});
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (message) => {
      if (message?.action === "getLiveTranscript") {
        return { ok: true, live: liveTranscript };
      }
      return { ok: true };
    });
  });

  afterEach(() => {
    destroyLiveTranscriptOverlay();
  });

  it("renders safely inside the call page without opening a window", async () => {
    showLiveTranscriptOverlay("session-live");
    await waitForPoll();

    const host = document.querySelector<HTMLDivElement>(LIVE_OVERLAY_SELECTOR);
    const shadow = host?.shadowRoot;
    expect(host).not.toBeNull();
    expect(shadow?.querySelector("[data-role='duration']")?.textContent).toBe("00:00:42");
    expect(shadow?.querySelector("[data-role='status']")?.textContent).toBe("Готово");
    expect(shadow?.querySelector(".text")?.textContent).toContain("Важная реплика");
    expect(shadow?.querySelector("script")).toBeNull();
    expect(shadow?.querySelector(".feed img")).toBeNull();
  });

  it("reuses and expands the existing panel when Show live is clicked again", () => {
    const first = showLiveTranscriptOverlay("session-live");
    first.host.shadowRoot?.querySelector<HTMLButtonElement>("[data-role='collapse']")?.click();

    const second = showLiveTranscriptOverlay("session-live");

    expect(second).toBe(first);
    expect(document.querySelectorAll(LIVE_OVERLAY_SELECTOR)).toHaveLength(1);
    expect(second.host.classList.contains("is-collapsed")).toBe(false);
  });

  it("closes only the panel and leaves recording untouched", () => {
    const host = showLiveTranscriptOverlay("session-live").host;
    host.shadowRoot?.querySelector<HTMLButtonElement>("[data-role='close']")?.click();

    expect(document.querySelector(LIVE_OVERLAY_SELECTOR)).toBeNull();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "stopRecording" }),
    );
  });

  it("opens the full transcript through the service worker", () => {
    const host = showLiveTranscriptOverlay("session-live").host;
    host.shadowRoot?.querySelector<HTMLButtonElement>("[data-role='open-full']")?.click();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: "openTranscript",
      sessionId: "session-live",
    });
  });

  it("finishes the recording only after the second click", () => {
    const host = showLiveTranscriptOverlay("session-live").host;
    const finish = host.shadowRoot?.querySelector<HTMLButtonElement>("[data-role='finish']");

    finish?.click();
    expect(finish?.textContent?.trim()).toBe("Нажмите ещё раз");
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "stopRecording" }),
    );

    finish?.click();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: "stopRecording" });
  });

  it("hides the finish button once the session is no longer recording", async () => {
    const host = showLiveTranscriptOverlay("session-live").host;
    await waitForPoll();

    const finish = host.shadowRoot?.querySelector<HTMLButtonElement>("[data-role='finish']");
    expect(finish?.hidden).toBe(true);
  });
});

describe("предупреждение об именах на Телемосте", () => {
  const recording: LiveTranscriptResult = {
    ...liveTranscript,
    status: "recording",
    isFinal: false,
    participants: [
      { speakerId: "local", name: "Александр" },
      { speakerId: "remote-mix", name: "Спикер 1" },
    ],
  };

  function mockLive(live: LiveTranscriptResult): void {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (message) => {
      if (message?.action === "getLiveTranscript") return { ok: true, live };
      return { ok: true };
    });
  }

  async function notice(): Promise<HTMLElement | null | undefined> {
    destroyLiveTranscriptOverlay();
    showLiveTranscriptOverlay("session-live");
    await waitForPoll();
    const host = document.querySelector<HTMLElement>(LIVE_OVERLAY_SELECTOR);
    return host?.shadowRoot?.querySelector<HTMLElement>("[data-role='notice']");
  }

  beforeEach(() => {
    vi.stubGlobal("location", { ...window.location, host: "telemost.yandex.ru" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("показывает, что имена собеседников придут после обработки", async () => {
    mockLive(recording);
    const element = await notice();
    expect(element?.hidden).toBe(false);
    expect(element?.textContent).toContain("итоговом транскрипте");
  });

  it("молчит, когда собеседников нет: своё имя приходит сразу", async () => {
    mockLive({ ...recording, participants: [{ speakerId: "local", name: "Александр" }] });
    expect((await notice())?.hidden).toBe(true);
  });

  it("молчит после остановки записи: имена уже определены", async () => {
    mockLive({ ...recording, status: "processing" });
    expect((await notice())?.hidden).toBe(true);
  });
});

describe("предупреждение не показывается на площадках с раздельным аудио", () => {
  it("молчит на WB Stream: там имена известны сразу", async () => {
    vi.stubGlobal("location", { ...window.location, host: "stream.wb.ru" });
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (message) => {
      if (message?.action === "getLiveTranscript") {
        return {
          ok: true,
          live: {
            ...liveTranscript,
            status: "recording",
            isFinal: false,
            participants: [
              { speakerId: "local", name: "Анна" },
              { speakerId: "remote-1", name: "Борис" },
            ],
          },
        };
      }
      return { ok: true };
    });
    destroyLiveTranscriptOverlay();
    showLiveTranscriptOverlay("session-live");
    await waitForPoll();
    const host = document.querySelector<HTMLElement>(LIVE_OVERLAY_SELECTOR);
    expect(host?.shadowRoot?.querySelector<HTMLElement>("[data-role='notice']")?.hidden).toBe(true);
    vi.unstubAllGlobals();
  });
});
