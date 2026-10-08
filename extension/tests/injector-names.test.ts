import { beforeEach, describe, expect, it, vi } from "vitest";

// DomParser ходит в DOM страницы созвона — подменяем целиком.
const domParser = {
  findParticipantName: vi.fn<(id: string) => string | null>(),
  getAllParticipantNames: vi.fn<() => string[]>(),
  getLocalParticipantName: vi.fn<() => string | null>(),
};
vi.mock("../src/content/dom-parser", () => ({
  DomParser: vi.fn(() => domParser),
}));
vi.mock("../src/content/live-overlay", () => ({
  showLiveTranscriptOverlay: vi.fn(),
  destroyLiveTranscriptOverlay: vi.fn(),
  LIVE_OVERLAY_SELECTOR: "[data-rechiv-live]",
}));

function identified(): { speakerId: string; name: string }[] {
  return vi
    .mocked(chrome.runtime.sendMessage)
    .mock.calls.map(([m]) => m as { action?: string; speakerId: string; name: string })
    .filter((m) => m?.action === "speakerIdentified");
}

async function runInjector(host: string) {
  vi.resetModules();
  vi.clearAllMocks();
  // Только host: при чужом origin postMessage отвергнет сообщение.
  vi.stubGlobal("location", { ...window.location, host });
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ ok: true } as never);
  vi.mocked(chrome.storage.local.get).mockResolvedValue({});
  await import("../src/content/injector");
  await new Promise((r) => setTimeout(r, 0));

  for (const streamId of ["remote-a", "remote-b", "local"]) {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        data: {
          type: "RECHIV_TRACK_ADDED",
          streamId,
          kind: streamId === "local" ? "local" : "remote",
        },
      }),
    );
  }
  const handler = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)?.[0] as (
    m: unknown,
    s: unknown,
    r: (x: unknown) => void,
  ) => boolean;
  handler({ action: "startCapture", sessionId: "s-1" }, {}, () => undefined);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
  vi.advanceTimersByTime(5100);
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("имена потоков на площадке со смешанным аудио", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    domParser.findParticipantName.mockImplementation((id) => (id === "remote-a" ? "Лапин" : null));
    domParser.getAllParticipantNames.mockReturnValue(["Лапин"]);
    domParser.getLocalParticipantName.mockReturnValue("Олег Ветров");
  });

  // Иначе микс комнаты получает имя первого собеседника.
  it("не подписывает удалённые потоки на Телемосте", async () => {
    await runInjector("telemost.yandex.ru");
    const remote = identified().filter((m) => m.speakerId !== "local");
    expect(remote).toEqual([]);
  });

  it("своё имя при этом отдаёт: локальный микрофон — отдельная дорожка", async () => {
    await runInjector("telemost.yandex.ru");
    expect(identified()).toContainEqual(
      expect.objectContaining({ speakerId: "local", name: "Олег Ветров" }),
    );
  });

  it("на WB Stream удалённые потоки по-прежнему именуются: там аудио раздельное", async () => {
    domParser.findParticipantName.mockImplementation((id) => (id === "remote-a" ? "Борис" : null));
    await runInjector("stream.wb.ru");
    expect(identified()).toContainEqual(
      expect.objectContaining({ speakerId: "remote-a", name: "Борис" }),
    );
  });
});

/** Вкладку закрывают раньше, чем догрузится хвост чанков: таймлайн уходит сразу. */
describe("доставка VAD-таймлайна", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    domParser.findParticipantName.mockReturnValue(null);
    domParser.getAllParticipantNames.mockReturnValue([]);
    domParser.getLocalParticipantName.mockReturnValue(null);
  });

  function uploads() {
    return vi
      .mocked(chrome.runtime.sendMessage)
      .mock.calls.map(([m]) => m as { action?: string; sessionId?: string })
      .filter((m) => m?.action === "uploadVadTimeline");
  }

  it("отправляет таймлайн сразу, не дожидаясь финиша", async () => {
    await runInjector("telemost.yandex.ru");
    const timeline = {
      localParticipantId: "local-1",
      participants: [{ participantId: "p-1", name: "Глеб" }],
      events: [{ at: 0, active: ["p-1"] }],
      micEvents: [{ at: 0, unmuted: ["p-1"] }],
    };

    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        data: { type: "RECHIV_CAPTURE_STOPPED", vadTimeline: timeline },
      }),
    );
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // Слушатели window копятся между тестами файла: проверяем факт, а не число вызовов.
    expect(uploads()).toContainEqual({
      action: "uploadVadTimeline",
      sessionId: "s-1",
      vadTimeline: timeline,
    });
  });

  it("без таймлайна ничего не шлёт", async () => {
    await runInjector("telemost.yandex.ru");

    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        data: { type: "RECHIV_CAPTURE_STOPPED" },
      }),
    );
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(uploads()).toEqual([]);
  });
});
