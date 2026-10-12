import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingStorage } from "../src/shared/storage";
import { chromeMock } from "./setup";

describe("RecordingStorage", () => {
  let storage: RecordingStorage;

  beforeEach(() => {
    storage = new RecordingStorage();
    chromeMock.storage.local.get.mockResolvedValue({});
    vi.mocked(chrome.storage.local.set).mockResolvedValue(undefined);
  });

  it("getActiveSession returns null when no session", async () => {
    const session = await storage.getActiveSession();
    expect(session).toBeNull();
  });

  it("setActiveSession stores session id", async () => {
    await storage.setActiveSession("abc123", "https://stream.wb.ru/room/test");
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      activeSession: { sessionId: "abc123", callUrl: "https://stream.wb.ru/room/test" },
    });
  });

  it("getActiveSession returns stored session", async () => {
    chromeMock.storage.local.get.mockResolvedValue({
      activeSession: { sessionId: "abc123", callUrl: "https://stream.wb.ru/room/test" },
    });
    const session = await storage.getActiveSession();
    expect(session?.sessionId).toBe("abc123");
  });

  it("clearActiveSession removes session", async () => {
    await storage.clearActiveSession();
    expect(chrome.storage.local.remove).toHaveBeenCalledWith("activeSession");
  });

  it("getChunkBuffer returns empty array by default", async () => {
    const buffer = await storage.getChunkBuffer();
    expect(buffer).toEqual([]);
  });

  it("drops legacy chunks without a session id", async () => {
    chromeMock.storage.local.get.mockResolvedValue({
      chunkBuffer: [
        { speakerId: "old", timestamp: 1, data: "old" },
        { sessionId: "s1", speakerId: "new", timestamp: 2, data: "new" },
      ],
    });
    expect(await storage.getChunkBuffer()).toEqual([
      { sessionId: "s1", speakerId: "new", timestamp: 2, data: "new" },
    ]);
  });
});
