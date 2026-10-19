import { keyValueStore } from "./key-value-store";

export interface Config {
  sttServiceUrl: string;
  llmUrl: string;
  llmModel: string;
  llmApiKey: string;
  theme: "light" | "dark";
  palette: "graphite" | "stone" | "amber";
}

export const DEFAULT_STT_URL = "http://localhost:9876";

// У LLM нет умолчаний: подставленный адрес выглядел бы готовой настройкой.
const DEFAULTS: Config = {
  sttServiceUrl: DEFAULT_STT_URL,
  llmUrl: "",
  llmModel: "",
  llmApiKey: "",
  theme: "light",
  palette: "graphite",
};

export function isLlmConfigured(config: Config): boolean {
  return Boolean(config.llmUrl && config.llmModel && config.llmApiKey);
}

export async function getConfig(): Promise<Config> {
  const stored = await keyValueStore.get<Partial<Config>>("config");
  return { ...DEFAULTS, ...stored };
}

export async function saveConfig(config: Partial<Config>): Promise<void> {
  const current = await getConfig();
  await keyValueStore.set("config", { ...current, ...config });
}

const FALLBACK_CONTEXT_WINDOW = 128000;

export interface ModelInfo {
  contextWindow: number;
  modelId: string;
}

export async function fetchModelInfo(
  llmUrl: string,
  llmModel: string,
  llmApiKey: string,
): Promise<ModelInfo> {
  const fallback: ModelInfo = { contextWindow: FALLBACK_CONTEXT_WINDOW, modelId: llmModel };
  try {
    const resp = await fetch(`${llmUrl}/models`, {
      signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${llmApiKey}` },
    });
    if (!resp.ok) return fallback;
    const data = await resp.json();
    const model = data.data?.find(
      (m: { id: string }) => m.id.toLowerCase() === llmModel.toLowerCase(),
    );
    if (!model) return fallback;
    return {
      contextWindow: model.max_model_len ?? FALLBACK_CONTEXT_WINDOW,
      modelId: model.id,
    };
  } catch {
    return fallback;
  }
}
