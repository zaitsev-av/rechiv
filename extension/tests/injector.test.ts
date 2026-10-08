import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingStorage } from "../src/shared/storage";
import { retry } from "../src/shared/utils";

describe("injector chunk upload behavior", () => {
  let storage: RecordingStorage;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = new RecordingStorage();
  });

  it("retries on ok:false and buffers after 3 failures", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: false, error: "server error" });
    let buffered = false;
    try {
      await retry(
        async () => {
          const resp = await sendMessage();
          if (resp && !resp.ok) throw new Error(resp.error);
          return resp;
        },
        { attempts: 3, delays: [10, 20, 30] },
      );
    } catch {
      buffered = true;
      await storage.addToChunkBuffer({
        sessionId: "session-1",
        speakerId: "test",
        timestamp: 0,
        data: "base64",
      });
    }
    expect(buffered).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(chrome.storage.local.set).toHaveBeenCalled();
  });

  it("succeeds on second attempt without buffering", async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValue({ ok: true });
    const result = await retry(
      async () => {
        const resp = await sendMessage();
        if (resp && !resp.ok) throw new Error(resp.error);
        return resp;
      },
      { attempts: 3, delays: [10, 20, 30] },
    );
    expect(result).toEqual({ ok: true });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("chunk buffer persists to chrome.storage", async () => {
    vi.mocked(chrome.storage.local.get).mockResolvedValue({ chunkBuffer: [] });
    await storage.addToChunkBuffer({
      sessionId: "session-1",
      speakerId: "sp1",
      timestamp: 100,
      data: "abc",
    });
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      chunkBuffer: [{ sessionId: "session-1", speakerId: "sp1", timestamp: 100, data: "abc" }],
    });
  });
});
