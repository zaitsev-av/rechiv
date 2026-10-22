import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppearanceSettings } from "../src/shared/api-client";
import { chromeMock } from "./setup";

let stored: Record<string, unknown>;
let remote: AppearanceSettings;
let puts: { value: AppearanceSettings; condition: string | undefined }[];
let urls: string[];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const locationAt = (url: string) => vi.stubGlobal("location", new URL(url));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  stored = { config: { theme: "dark", palette: "stone", llmModel: "keep-me" } };
  remote = { theme: "", palette: "" };
  puts = [];
  urls = [];
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.palette;
  locationAt("chrome-extension://rechiv/pages/settings.html");
  chromeMock.storage.local.get.mockImplementation(async () => ({ ...stored }));
  chromeMock.storage.local.set.mockImplementation(async (items) => {
    Object.assign(stored, items);
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/auth/token")) return json({ token: "appearance-token" });
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers?.Authorization !== "Bearer appearance-token") return json({}, 401);
      if (init?.method === "PUT") {
        const value = JSON.parse(String(init.body)) as AppearanceSettings;
        puts.push({ value, condition: headers["If-None-Match"] });
        remote = value;
      }
      return json(remote);
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("desktop appearance", () => {
  it("pulls desktop without sending it back", async () => {
    remote = { theme: "light", palette: "amber" };
    const { applyDesktopTheme } = await import("../src/shared/theme");
    await applyDesktopTheme();
    expect(document.documentElement.dataset).toMatchObject(remote);
    expect(stored.config).toMatchObject({ ...remote, llmModel: "keep-me" });
    expect(puts).toEqual([]);
  });
  it("serializes quick theme and palette changes, sends only appearance", async () => {
    const { saveAppearance } = await import("../src/shared/appearance");
    await Promise.all([saveAppearance({ theme: "light" }), saveAppearance({ palette: "amber" })]);
    expect(puts).toEqual([
      { value: { theme: "light", palette: "stone" }, condition: undefined },
      { value: { theme: "light", palette: "amber" }, condition: undefined },
    ]);
    expect(stored.config).toMatchObject({ ...remote, llmModel: "keep-me" });
  });
  it("keeps local changes when offline or PUT fails", async () => {
    const { saveAppearance, syncDesktopAppearance } = await import("../src/shared/appearance");
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    await saveAppearance({ palette: "amber" });
    expect(await syncDesktopAppearance()).toMatchObject({ theme: "dark", palette: "amber" });
    vi.mocked(fetch).mockResolvedValue(json({}, 500));
    await saveAppearance({ theme: "light" });
    expect(stored.config).toMatchObject({ theme: "light", palette: "amber" });
  });
  it("does not replace a user change with a late GET", async () => {
    const { SttApiClient } = await import("../src/shared/api-client");
    let finish!: (value: AppearanceSettings) => void;
    vi.spyOn(SttApiClient.prototype, "getAppearance").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { saveAppearance, syncDesktopAppearance } = await import("../src/shared/appearance");
    const pending = syncDesktopAppearance();
    await vi.waitFor(() => expect(finish).toBeDefined());
    await saveAppearance({ palette: "amber" });
    finish({ theme: "light", palette: "graphite" });
    expect(await pending).toMatchObject({ theme: "dark", palette: "amber" });
  });
  it("ignores malformed remote values", async () => {
    vi.mocked(fetch).mockResolvedValue(json({ theme: "system", palette: "purple" }));
    const { syncDesktopAppearance } = await import("../src/shared/appearance");
    expect(await syncDesktopAppearance()).toMatchObject({ theme: "dark", palette: "stone" });
    expect(puts).toEqual([]);
  });
});

describe("desktop web pages", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", undefined);
    locationAt("http://rechiv.localhost:9876/history.html");
    localStorage.setItem("config", JSON.stringify(stored.config));
  });
  it("loads same-origin desktop, caches and restores before rendering", async () => {
    remote = { theme: "dark", palette: "amber" };
    const { applyDesktopTheme } = await import("../src/shared/theme");
    await applyDesktopTheme();
    expect(document.documentElement.dataset).toMatchObject(remote);
    expect(JSON.parse(localStorage.getItem("config")!)).toMatchObject(remote);
    expect(urls).toContain("/auth/token");
    expect(urls.every((url) => url.startsWith("/"))).toBe(true);
    expect(localStorage.getItem("rechiv.theme")).toBe("dark");
    expect(localStorage.getItem("rechiv.palette")).toBe("amber");
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.palette;
    await import("../src/shared/theme-boot");
    expect(document.documentElement.dataset).toMatchObject(remote);
  });
  it("sends web changes and the next extension page pulls them", async () => {
    const { saveAppearance } = await import("../src/shared/appearance");
    await saveAppearance({ theme: "light", palette: "amber" });
    expect(remote).toEqual({ theme: "light", palette: "amber" });
    vi.stubGlobal("chrome", chromeMock);
    locationAt("chrome-extension://rechiv/pages/settings.html");
    vi.resetModules();
    const { applyDesktopTheme } = await import("../src/shared/theme");
    await applyDesktopTheme();
    expect(stored.config).toMatchObject(remote);
    expect(document.documentElement.dataset).toMatchObject(remote);
  });
  it.each([
    "http://rechiv.localhost:9876",
    "http://rechiv.localhost:9900",
  ])("caches on %s", async (url) => {
    locationAt(url);
    const { cacheAppearance, readCachedTheme } = await import("../src/shared/theme-cache");
    cacheAppearance({ theme: "dark" });
    expect(readCachedTheme()).toBe("dark");
  });
  it.each([
    "https://meet.google.com",
    "http://other:9876",
    "http://127.0.0.1:9876",
  ])("does not cache on %s", async (url) => {
    locationAt(url);
    const { cacheAppearance, readCachedTheme } = await import("../src/shared/theme-cache");
    cacheAppearance({ theme: "dark" });
    expect(readCachedTheme()).toBeNull();
    expect(localStorage.getItem("rechiv.theme")).toBeNull();
  });
});
