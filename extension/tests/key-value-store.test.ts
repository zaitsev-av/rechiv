import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChromeKeyValueStore, LocalStorageKeyValueStore } from "../src/shared/key-value-store";
import { chromeMock } from "./setup";

describe("ChromeKeyValueStore", () => {
  const store = new ChromeKeyValueStore(chrome.storage.local, chrome.storage.onChanged);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads, writes and removes values through chrome.storage.local", async () => {
    chromeMock.storage.local.get.mockResolvedValue({ config: { theme: "dark" } });

    await expect(store.get("config")).resolves.toEqual({ theme: "dark" });
    await store.set("config", { theme: "light" });
    await store.remove("config");

    expect(chrome.storage.local.get).toHaveBeenCalledWith("config");
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ config: { theme: "light" } });
    expect(chrome.storage.local.remove).toHaveBeenCalledWith("config");
  });

  it("subscribes only to matching changes in local storage", () => {
    const listener = vi.fn();
    const unsubscribe = store.subscribe("config", listener);
    const storageListener = vi.mocked(chrome.storage.onChanged.addListener).mock.calls.at(-1)?.[0];

    storageListener?.({ config: { oldValue: 1, newValue: 2 } }, "sync");
    storageListener?.({ other: { oldValue: 1, newValue: 2 } }, "local");
    storageListener?.({ config: { oldValue: 1, newValue: 2 } }, "local");

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ oldValue: 1, newValue: 2 });

    unsubscribe();
    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalledWith(storageListener);
  });
});

describe("LocalStorageKeyValueStore", () => {
  const store = new LocalStorageKeyValueStore(localStorage, window);

  beforeEach(() => {
    localStorage.clear();
  });

  it("reads, writes and removes JSON values through localStorage", async () => {
    await expect(store.get("config")).resolves.toBeUndefined();

    await store.set("config", { theme: "dark" });
    expect(localStorage.getItem("config")).toBe('{"theme":"dark"}');
    await expect(store.get("config")).resolves.toEqual({ theme: "dark" });

    await store.remove("config");
    await expect(store.get("config")).resolves.toBeUndefined();
  });

  it("subscribes to matching localStorage events and can unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = store.subscribe("config", listener);
    const change = new StorageEvent("storage", {
      key: "config",
      oldValue: '{"theme":"light"}',
      newValue: '{"theme":"dark"}',
      storageArea: localStorage,
    });

    window.dispatchEvent(new StorageEvent("storage", { key: "other", storageArea: localStorage }));
    window.dispatchEvent(change);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      oldValue: { theme: "light" },
      newValue: { theme: "dark" },
    });

    unsubscribe();
    window.dispatchEvent(change);
    expect(listener).toHaveBeenCalledOnce();
  });
});
