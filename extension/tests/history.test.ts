import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../src/shared/types";
import { chromeMock } from "./setup";

const mockSessions: SessionInfo[] = [
  {
    sessionId: "s1",
    status: "completed",
    callUrl: "https://stream.wb.ru/room/1",
    createdAt: "2026-03-14T10:00:00Z",
    finishedAt: "2026-03-14T10:30:00Z",
    participants: [{ speakerId: "a", name: "Alice" }],
    chunksCount: 5,
  },
  {
    sessionId: "s2",
    status: "processing",
    callUrl: "https://stream.wb.ru/room/2",
    createdAt: "2026-03-15T14:00:00Z",
    finishedAt: null,
    participants: [
      { speakerId: "a", name: "<img src=x onerror=alert(1)>" },
      { speakerId: "b", name: "Bob" },
    ],
    chunksCount: 3,
  },
];

async function loadHistoryModule(sessions: SessionInfo[] = mockSessions) {
  document.body.innerHTML = '<div id="sessions"></div><button id="btn-top"></button>';
  chromeMock.storage.local.get.mockImplementation(async (key) => {
    if (key === "config") return { config: {} };
    if (key === "sessionTitles") return {};
    return {};
  });
  globalThis.fetch = vi.fn().mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => (url.endsWith("/folders") ? [] : sessions),
  }));
  vi.resetModules();
  await import("../src/pages/history");
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(50);
  else await new Promise((r) => setTimeout(r, 50));
}

function dragCard(card: Element, type: string) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: "uninitialized" },
  });
  card.dispatchEvent(event);
  return event;
}

describe("history page (module integration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    window.dispatchEvent(new Event("beforeunload"));
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not poll without recording or processing sessions", async () => {
    vi.useFakeTimers();
    await loadHistoryModule([{ ...mockSessions[0], status: "completed" }]);
    const requests = vi.mocked(fetch).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetch).toHaveBeenCalledTimes(requests);
    const card = document.querySelector<HTMLElement>(".session-card")!;
    dragCard(card, "dragstart");
    dragCard(card, "dragend");
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetch).toHaveBeenCalledTimes(requests);
  });

  it("pauses polling during dragging and resumes after dragend", async () => {
    vi.useFakeTimers();
    await loadHistoryModule();
    const card = document.querySelector<HTMLElement>(".session-card")!;
    expect(card.draggable).toBe(true);
    const requests = vi.mocked(fetch).mock.calls.length;
    dragCard(card, "dragstart");
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetch).toHaveBeenCalledTimes(requests);
    expect(document.querySelector(".session-card")).toBe(card);
    dragCard(card, "dragend");
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(requests + 2);
    expect(document.querySelector(".session-card")).not.toBe(card);
  });

  it.each([
    false,
    true,
  ])("does not replace cards when an in-flight poll settles (error: %s)", async (fail) => {
    vi.useFakeTimers();
    await loadHistoryModule();
    let finish!: (response: Response) => void;
    let reject!: (reason: Error) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve, rejectRequest) => {
          finish = resolve;
          reject = rejectRequest;
        }),
    );
    await vi.advanceTimersByTimeAsync(2000);
    const card = document.querySelector(".session-card")!;
    dragCard(card, "dragstart");
    if (fail) reject(new Error("offline"));
    else finish({ ok: true, json: async () => mockSessions } as Response);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector(".session-card")).toBe(card);
    dragCard(card, "dragend");
    await vi.advanceTimersByTimeAsync(2000);
    expect(document.querySelector(".session-card")).not.toBe(card);
  });

  it("pauses polling with a menu open and closes it when dragging starts", async () => {
    vi.useFakeTimers();
    await loadHistoryModule();
    const card = document.querySelector(".session-card")!;
    card.querySelector<HTMLButtonElement>(".session-more")!.click();
    const requests = vi.mocked(fetch).mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetch).toHaveBeenCalledTimes(requests);
    expect(document.querySelector(".folder-menu")).not.toBeNull();
    dragCard(card, "dragstart");
    expect(document.querySelector(".folder-menu")).toBeNull();
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetch).toHaveBeenCalledTimes(requests);
    dragCard(card, "dragend");
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(requests + 2);
  });

  it.each(["Enter", "Escape"])("disables dragging during title editing until %s", async (key) => {
    vi.useFakeTimers();
    await loadHistoryModule();
    const card = document.querySelector<HTMLElement>(".session-card")!;
    const title = card.querySelector<HTMLElement>(".session-title")!;
    title.click();
    expect(card.draggable).toBe(false);
    expect(title.contentEditable).toBe("true");
    title.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(card.draggable).toBe(false);
    expect(title.contentEditable).toBe("true");
    expect(dragCard(title, "dragstart").defaultPrevented).toBe(true);
    const requests = vi.mocked(fetch).mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetch).toHaveBeenCalledTimes(requests);
    expect(document.querySelector(".session-card")).toBe(card);
    title.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(card.draggable).toBe(true);
    expect(document.querySelector<HTMLElement>(".session-card")?.draggable).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(requests + 4);
  });

  it("с потоком событий desktop не опрашивает, а перечитывает список по событию", async () => {
    const sources: FakeEventSource[] = [];
    class FakeEventSource {
      listeners: Record<string, (() => void)[]> = {};
      constructor(public url: string) {
        sources.push(this);
      }
      addEventListener(type: string, listener: () => void) {
        this.listeners[type] = [...(this.listeners[type] ?? []), listener];
      }
      emit(type: string) {
        for (const listener of this.listeners[type] ?? []) listener();
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.useFakeTimers();
    await loadHistoryModule();
    expect(sources.map((source) => source.url)).toEqual(["/events"]);
    sources[0].emit("open");
    const requests = vi.mocked(fetch).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetch).toHaveBeenCalledTimes(requests);

    sources[0].emit("sessions");
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(requests);

    const afterEvent = vi.mocked(fetch).mock.calls.length;
    sources[0].emit("error");
    await vi.advanceTimersByTimeAsync(2000);
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(afterEvent);
    vi.unstubAllGlobals();
  });

  it("renders sessions sorted newest first", async () => {
    await loadHistoryModule();
    const cards = document.querySelectorAll(".segment.clickable");
    expect(cards.length).toBe(2);
    const times = document.querySelectorAll(".segment-time");
    expect(times[0].textContent).toContain("15.03.2026");
  });

  it("does not inject XSS from participant names", async () => {
    await loadHistoryModule();
    expect(document.querySelector("#sessions img")).toBeNull();
  });

  it("shows empty state when no sessions", async () => {
    await loadHistoryModule([]);
    expect(document.getElementById("sessions")!.textContent).toContain("Записей пока нет");
  });

  it("shows error message safely when API unavailable", async () => {
    document.body.innerHTML = '<div id="sessions"></div><button id="btn-top"></button>';
    chromeMock.storage.local.get.mockImplementation(async (key) => {
      if (key === "config") return { config: {} };
      return {};
    });
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("<script>alert(1)</script>"));
    vi.resetModules();
    await import("../src/pages/history");
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector("script")).toBeNull();
    expect(document.getElementById("sessions")!.textContent).toContain("STT-сервис недоступен");
  });

  it("each session card has an actions menu", async () => {
    await loadHistoryModule();
    const deleteButtons = document.querySelectorAll(".session-more");
    expect(deleteButtons.length).toBe(2);
  });
});
