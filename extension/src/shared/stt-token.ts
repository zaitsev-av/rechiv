import { extensionVersionHeaders } from "./extension-version";
import { keyValueStore } from "./key-value-store";

const TOKEN_STORAGE_KEY = "stt.api.token";

export async function getCachedSttToken(): Promise<string | null> {
  return (await keyValueStore.get<string>(TOKEN_STORAGE_KEY)) ?? null;
}

export async function cacheSttToken(token: string): Promise<void> {
  await keyValueStore.set(TOKEN_STORAGE_KEY, token);
}

export async function clearCachedSttToken(): Promise<void> {
  await keyValueStore.remove(TOKEN_STORAGE_KEY);
}

export async function ensureSttToken(sttUrl: string): Promise<string> {
  const cached = await getCachedSttToken();
  if (cached) return cached;
  const response = await fetch(`${sttUrl}/auth/token`, { headers: extensionVersionHeaders() });
  if (!response.ok) throw new Error(`Bootstrap STT token failed: ${response.status}`);
  const data = (await response.json()) as { token: string };
  if (!data.token) throw new Error("STT-сервис вернул пустой токен");
  await cacheSttToken(data.token);
  return data.token;
}
