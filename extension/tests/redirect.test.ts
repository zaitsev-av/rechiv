import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopPageUrl } from "../src/pages/redirect";
import { chromeMock } from "./setup";

describe("desktopPageUrl", () => {
  it.each([
    ["/pages/history.html", "", "http://rechiv.localhost:9876/"],
    [
      "/pages/transcript.html",
      "?sessionId=abc",
      "http://rechiv.localhost:9876/transcript.html?sessionId=abc",
    ],
    ["/pages/settings.html", "", "http://rechiv.localhost:9876/settings.html"],
    ["/pages/unknown.html", "", "http://rechiv.localhost:9876/"],
  ])("%s%s ведёт на страницу desktop", (path, search, expected) => {
    expect(desktopPageUrl(path, search)).toBe(expected);
  });
});

describe("страница-переадресация", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function load(fetchImpl: () => Promise<Response>) {
    document.body.innerHTML = `
      <main id="offline" hidden><button id="btn-retry"></button></main>
    `;
    chromeMock.storage.local.get.mockImplementation(async (key) =>
      key === "config" ? { config: {} } : {},
    );
    const replace = vi.fn();
    vi.stubGlobal("location", {
      pathname: "/pages/transcript.html",
      search: "?sessionId=s1",
      protocol: "chrome-extension:",
      replace,
    });
    globalThis.fetch = vi.fn(fetchImpl) as typeof fetch;
    vi.resetModules();
    await import("../src/pages/redirect");
    await vi.advanceTimersByTimeAsync(0);
    return replace;
  }

  it("сразу уходит на desktop, если он запущен", async () => {
    vi.useFakeTimers();
    const replace = await load(async () => Response.json({ status: "ok" }));

    expect(replace).toHaveBeenCalledWith(
      "http://rechiv.localhost:9876/transcript.html?sessionId=s1",
    );
    expect(document.getElementById("offline")!.hidden).toBe(true);
  });

  it("без desktop подсказывает запустить Rechiv и уходит, когда он появится", async () => {
    vi.useFakeTimers();
    let up = false;
    const replace = await load(async () => {
      if (!up) throw new TypeError("Failed to fetch");
      return Response.json({ status: "ok" });
    });

    expect(document.getElementById("offline")!.hidden).toBe(false);
    expect(replace).not.toHaveBeenCalled();

    up = true;
    await vi.advanceTimersByTimeAsync(3000);
    expect(replace).toHaveBeenCalledOnce();
  });
});
