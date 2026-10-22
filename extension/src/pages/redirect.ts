// Страницы живут в desktop: расширение только переадресует на них, сохраняя путь и параметры.

import { DESKTOP_URL } from "@shared/config";
import { applyDesktopTheme } from "@shared/theme";

const PAGES: Record<string, string> = {
  "history.html": "/",
  "transcript.html": "/transcript.html",
  "settings.html": "/settings.html",
};
const RETRY_MS = 3_000;

export function desktopPageUrl(pathname: string, search: string): string {
  const page = pathname.split("/").pop() ?? "";
  return new URL((PAGES[page] ?? "/") + search, DESKTOP_URL).toString();
}

async function desktopIsUp(): Promise<boolean> {
  try {
    const response = await fetch(`${DESKTOP_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function open(): Promise<void> {
  const target = desktopPageUrl(location.pathname, location.search);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = async () => {
    clearTimeout(timer);
    if (await desktopIsUp()) {
      location.replace(target);
      return;
    }
    document.getElementById("offline")!.hidden = false;
    timer = setTimeout(attempt, RETRY_MS);
  };
  document.getElementById("btn-retry")!.addEventListener("click", () => void attempt());
  await attempt();
}

if (document.getElementById("offline")) {
  void applyDesktopTheme().catch(() => undefined);
  void open();
}
