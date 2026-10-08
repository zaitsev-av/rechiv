import { type Config, getConfig } from "./config";
import { keyValueStore } from "./key-value-store";
import { cacheAppearance } from "./theme-cache";

export type AppTheme = Config["theme"];
export type AppPalette = Config["palette"];

export const PALETTES: readonly AppPalette[] = ["graphite", "stone", "amber"];

type ThemeTarget = HTMLElement;

export function isPalette(value: unknown): value is AppPalette {
  return PALETTES.includes(value as AppPalette);
}

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
): Promise<void> {
  applyAppearance(await getConfig(), target);
}

export function watchThemeChanges(target: ThemeTarget = document.documentElement): () => void {
  return keyValueStore.subscribe<Partial<Config>>("config", ({ newValue: config }) => {
    if (config?.theme === "light" || config?.theme === "dark") {
      applyTheme(config.theme, target);
    }
    if (isPalette(config?.palette)) applyPalette(config.palette, target);
  });
}
