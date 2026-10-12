import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheSttToken,
  clearCachedSttToken,
  ensureSttToken,
  getCachedSttToken,
} from "../src/shared/stt-token";
import { chromeMock } from "./setup";

const STORAGE_KEY = "stt.api.token";

describe("stt-token", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    chromeMock.storage.local.get.mockReset();
    vi.mocked(chrome.storage.local.set).mockReset();
    vi.mocked(chrome.storage.local.remove).mockReset();
  });

  it("returns a cached token", async () => {
    chromeMock.storage.local.get.mockResolvedValue({ [STORAGE_KEY]: "cached" });
    expect(await getCachedSttToken()).toBe("cached");
  });

  it("caches and clears a token", async () => {
    await cacheSttToken("token");
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ [STORAGE_KEY]: "token" });
    await clearCachedSttToken();
    expect(chrome.storage.local.remove).toHaveBeenCalledWith(STORAGE_KEY);
  });

  it("bootstraps a token from the Go application", async () => {
    chromeMock.storage.local.get.mockResolvedValue({});
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: "fresh" }),
    });
    vi.stubGlobal("fetch", fetchSpy);
    expect(await ensureSttToken("http://localhost:9876")).toBe("fresh");
    expect(fetchSpy).toHaveBeenCalledWith("http://localhost:9876/auth/token", {
      headers: { "X-Rechiv-Extension-Version": "0.4.1" },
    });
  });
});
