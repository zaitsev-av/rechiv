export const RECHIV_EXTENSION_VERSION_HEADER = "X-Rechiv-Extension-Version";

export function extensionVersionHeaders(): Record<string, string> {
  // Этот же клиент собирается для веб-интерфейса демона, где Chrome API нет.
  if (typeof chrome === "undefined" || typeof chrome.runtime?.getManifest !== "function") return {};
  return { [RECHIV_EXTENSION_VERSION_HEADER]: chrome.runtime.getManifest().version };
}
