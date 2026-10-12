import { beforeEach, describe, expect, it, vi } from "vitest";
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
    if (key === "config") return { config: { sttServiceUrl: "http://localhost:9876" } };
    if (key === "sessionTitles") return {};
    return {};
  });
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(sessions),
  });
  vi.resetModules();
  await import("../src/pages/history");
  await new Promise((r) => setTimeout(r, 50));
}

describe("history page (module integration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      if (key === "config") return { config: { sttServiceUrl: "http://localhost:9876" } };
      return {};
    });
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("<script>alert(1)</script>"));
    vi.resetModules();
    await import("../src/pages/history");
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector("script")).toBeNull();
    expect(document.getElementById("sessions")!.textContent).toContain("STT-сервис недоступен");
  });

  it("each session card has a delete button", async () => {
    await loadHistoryModule();
    const deleteButtons = document.querySelectorAll(".btn-delete");
    expect(deleteButtons.length).toBe(2);
  });
});
