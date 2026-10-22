import { isPalette, syncDesktopAppearance } from "./appearance";
import { type Config, getConfig } from "./config";
import { keyValueStore } from "./key-value-store";
import { cacheAppearance } from "./theme-cache";

export { isPalette, PALETTES } from "./appearance";

export type AppTheme = Config["theme"];
export type AppPalette = Config["palette"];

type ThemeTarget = HTMLElement;

export function applyTheme(theme: AppTheme, target: ThemeTarget = document.documentElement): void {
  target.dataset.theme = theme;
  cacheAppearance({ theme });
}

export function applyPalette(
  palette: AppPalette,
  target: ThemeTarget = document.documentElement,
): void {
  target.dataset.palette = palette;
  cacheAppearance({ palette });
}

export function applyAppearance(
  config: Pick<Config, "theme" | "palette">,
  target: ThemeTarget = document.documentElement,
): void {
  applyTheme(config.theme, target);
  applyPalette(isPalette(config.palette) ? config.palette : "graphite", target);
}

export async function applySavedTheme(
  target: ThemeTarget = document.documentElement,
): Promise<Config> {
  const config = await getConfig();
  applyAppearance(config, target);
  return config;
}

export async function applyDesktopTheme(
  target: ThemeTarget = document.documentElement,
): Promise<Config> {
  await applySavedTheme(target);
  const config = await syncDesktopAppearance();
  applyAppearance(config, target);
  return config;
}

export function watchThemeChanges(target: ThemeTarget = document.documentElement): () => void {
  return keyValueStore.subscribe<Partial<Config>>("config", ({ newValue: config }) => {
    if (config?.theme === "light" || config?.theme === "dark") {
      applyTheme(config.theme, target);
    }
    if (isPalette(config?.palette)) applyPalette(config.palette, target);
  });
}
