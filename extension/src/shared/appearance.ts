import { createPageSttApiClient } from "./api-client";
import { type Config, DESKTOP_URL, getConfig, saveConfig } from "./config";

export type Appearance = Pick<Config, "theme" | "palette">;
export const PALETTES: readonly Config["palette"][] = ["graphite", "stone", "amber"];

export function isPalette(value: unknown): value is Config["palette"] {
  return PALETTES.includes(value as Config["palette"]);
}

let revision = 0;
let localWrites = Promise.resolve();
let desktopWrites = Promise.resolve();

function writeLocally(write: () => Promise<void>): Promise<void> {
  const result = localWrites.then(write);
  localWrites = result.catch(() => undefined);
  return result;
}

export async function saveAppearance(patch: Partial<Appearance>): Promise<void> {
  revision++;
  let config: Config;
  await writeLocally(async () => {
    await saveConfig(patch);
    config = await getConfig();
  });
  // Сеть не задерживает следующий локальный выбор, PUT сохраняют порядок кликов.
  desktopWrites = desktopWrites.then(async () => {
    try {
      await createPageSttApiClient(DESKTOP_URL).putAppearance({
        theme: config.theme,
        palette: config.palette,
      });
    } catch {
      // Desktop недоступен — локальное оформление уже сохранено.
    }
  });
  await desktopWrites;
}

export async function syncDesktopAppearance(): Promise<Config> {
  const startedAt = revision;
  try {
    const api = createPageSttApiClient(DESKTOP_URL);
    const remote = await api.getAppearance();
    if (startedAt !== revision) return getConfig();
    if ((remote.theme === "light" || remote.theme === "dark") && isPalette(remote.palette)) {
      const appearance = { theme: remote.theme, palette: remote.palette };
      await writeLocally(async () => {
        if (startedAt !== revision) return;
        const current = await getConfig();
        if (current.theme !== appearance.theme || current.palette !== appearance.palette) {
          await saveConfig(appearance);
        }
      });
    }
  } catch {
    // Старый или выключенный desktop не мешает открыть страницу.
  }
  return getConfig();
}
