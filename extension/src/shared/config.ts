import { keyValueStore } from "./key-value-store";

export interface Config {
  theme: "light" | "dark";
  palette: "graphite" | "stone" | "amber";
}

/** Адрес приложения: *.localhost браузер сам ведёт на этот компьютер. */
export const DESKTOP_URL = "http://rechiv.localhost:9876";

const DEFAULTS: Config = {
  theme: "light",
  palette: "graphite",
};

export async function getConfig(): Promise<Config> {
  const stored = await keyValueStore.get<Partial<Config>>("config");
  return { ...DEFAULTS, ...stored };
}

export async function saveConfig(config: Partial<Config>): Promise<void> {
  const current = await getConfig();
  await keyValueStore.set("config", { ...current, ...config });
}
