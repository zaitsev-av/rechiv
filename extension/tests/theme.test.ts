import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPalette, applySavedTheme, applyTheme, watchThemeChanges } from "../src/shared/theme";
import { readCachedPalette, readCachedTheme } from "../src/shared/theme-cache";
import { chromeMock } from "./setup";

function pretendExtensionPage(protocol: string) {
  Object.defineProperty(window, "location", {
    value: { ...window.location, protocol },
    writable: true,
    configurable: true,
  });
}

describe("application theme", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.palette;
    chromeMock.storage.local.get.mockResolvedValue({});
    localStorage.clear();
  });

  afterEach(() => {
    pretendExtensionPage("http:");
  });

  it("applies a dark theme to the requested root", () => {
    const target = document.createElement("div");

    applyTheme("dark", target);

    expect(target.dataset.theme).toBe("dark");
  });

  it("uses the saved theme and keeps light as the legacy default", async () => {
    await applySavedTheme();
    expect(document.documentElement.dataset.theme).toBe("light");

    chromeMock.storage.local.get.mockResolvedValue({
      config: { theme: "dark" },
    });
    await applySavedTheme();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  // Без синхронного кеша страница мигала светлой при каждом переходе.
  it("кеширует тему для мгновенного чтения на страницах расширения", () => {
    pretendExtensionPage("chrome-extension:");

    applyTheme("dark");

    expect(readCachedTheme()).toBe("dark");
  });

  it("не трогает localStorage сайта созвона", () => {
    pretendExtensionPage("chrome-extension:");
    applyTheme("dark");
    pretendExtensionPage("https:");

    applyTheme("light", document.createElement("div"));

    expect(readCachedTheme()).toBeNull();
    pretendExtensionPage("chrome-extension:");
    expect(readCachedTheme()).toBe("dark");
  });

  it("updates an open interface when the config changes", () => {
    const target = document.createElement("div");
    const stopWatching = watchThemeChanges(target);
    const listener = vi.mocked(chrome.storage.onChanged.addListener).mock.calls.at(-1)?.[0];

    listener?.(
      {
        config: {
          oldValue: { theme: "light" },
          newValue: { theme: "dark" },
        },
      },
      "local",
    );

    expect(target.dataset.theme).toBe("dark");
    stopWatching();
    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalledWith(listener);
  });

  it("по умолчанию — палитра «Тихий графит», сохранённая применяется", async () => {
    await applySavedTheme();
    expect(document.documentElement.dataset.palette).toBe("graphite");

    chromeMock.storage.local.get.mockResolvedValue({ config: { palette: "stone" } });
    await applySavedTheme();
    expect(document.documentElement.dataset.palette).toBe("stone");
  });

  it("неизвестную палитру из хранилища заменяет на графит", async () => {
    chromeMock.storage.local.get.mockResolvedValue({ config: { palette: "purple" } });

    await applySavedTheme();

    expect(document.documentElement.dataset.palette).toBe("graphite");
  });

  it("кеширует палитру отдельно от темы", () => {
    pretendExtensionPage("chrome-extension:");

    applyTheme("dark");
    applyPalette("amber");

    expect(readCachedTheme()).toBe("dark");
    expect(readCachedPalette()).toBe("amber");
  });

  it("переключает палитру в открытом окне, а мусор пропускает", () => {
    const target = document.createElement("div");
    const stopWatching = watchThemeChanges(target);
    const listener = vi.mocked(chrome.storage.onChanged.addListener).mock.calls.at(-1)?.[0];

    listener?.({ config: { newValue: { palette: "stone" } } }, "local");
    expect(target.dataset.palette).toBe("stone");

    listener?.({ config: { newValue: { palette: "purple" } } }, "local");
    expect(target.dataset.palette).toBe("stone");
    stopWatching();
  });
});
