import type { AppPalette, AppTheme } from "./theme";

/** Копия из chrome.storage для синхронного чтения до первой отрисовки. */
const THEME_CACHE_KEY = "rechiv.theme";
const PALETTE_CACHE_KEY = "rechiv.palette";

/** На сайте созвона localStorage чужой. */
function isExtensionPage(): boolean {
  return location.protocol === "chrome-extension:";
}

function read(key: string): string | null {
  if (!isExtensionPage()) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function readCachedTheme(): AppTheme | null {
  const theme = read(THEME_CACHE_KEY);
  return theme === "dark" || theme === "light" ? theme : null;
}

export function readCachedPalette(): AppPalette | null {
  const palette = read(PALETTE_CACHE_KEY);
  return palette === "graphite" || palette === "stone" || palette === "amber" ? palette : null;
}

export function cacheAppearance(appearance: { theme?: AppTheme; palette?: AppPalette }): void {
  if (!isExtensionPage()) return;
  try {
    if (appearance.theme) localStorage.setItem(THEME_CACHE_KEY, appearance.theme);
    if (appearance.palette) localStorage.setItem(PALETTE_CACHE_KEY, appearance.palette);
  } catch {
    // Хранилище отключено — без кеша.
  }
}
