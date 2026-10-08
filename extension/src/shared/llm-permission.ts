/**
 * Адрес LLM у каждого свой, поэтому доступ к нему запрашивается по ходу, а не в манифесте:
 * без разрешения Chrome режет запрос по CORS. Вызывать первым в обработчике клика —
 * request() работает только сразу после действия пользователя.
 */
export function ensureLlmPermission(llmUrl: string): Promise<boolean> {
  const permissions = globalThis.chrome?.permissions;
  if (!permissions) return Promise.resolve(true);
  let origin: string;
  try {
    origin = new URL(llmUrl).origin;
  } catch {
    return Promise.resolve(false);
  }
  return permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
}

export const LLM_PERMISSION_DENIED = "Нет доступа к адресу LLM: разрешите его в окне Chrome";
