import { createPageSttApiClient } from "@shared/api-client";
import { DESKTOP_URL } from "@shared/config";
import { PLATFORMS, platformForUrl } from "@shared/platform";
import { applyDesktopTheme, watchThemeChanges } from "@shared/theme";
import type { RecordingState } from "@shared/types";

const $ = (s: string) => document.querySelector<HTMLElement>(s)!;

const views: Record<string, HTMLElement> = {
  idle: $("#view-idle"),
  detecting: $("#view-detecting"),
  recording: $("#view-recording"),
  suspended: $("#view-suspended"),
};
let activeSessionId: string | null = null;
function showView(state: string) {
  for (const v of Object.values(views)) v.classList.add("hidden");
  if (state in views) views[state].classList.remove("hidden");
}

async function updateState() {
  try {
    const resp = await chrome.runtime.sendMessage({ action: "getState" });
    const state: RecordingState = resp.state ?? "idle";
    $("#status").classList.add("hidden");
    showView(state);
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const platform = platformForUrl(tabs[0]?.url);
    const platformNames = PLATFORMS.map((p) => p.name).join(", ");
    const startButton = $("#btn-start") as HTMLButtonElement;
    startButton.disabled = !platform;
    startButton.title = platform ? "" : `Нужна активная вкладка со встречей: ${platformNames}`;
    $("#start-microcopy").textContent = platform
      ? "Аудио и транскрипт остаются на этом компьютере"
      : `Откройте вкладку со встречей: ${platformNames}`;
    if (state === "recording" && resp.sessionId) {
      activeSessionId = resp.sessionId;
    } else {
      activeSessionId = null;
    }
  } catch (err) {
    $("#status").textContent =
      err instanceof Error ? err.message : "Не удалось связаться с расширением";
    $("#status").classList.remove("hidden");
    showView("idle");
    activeSessionId = null;
  }
}

$("#btn-start").addEventListener("click", async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tabs[0]?.url ?? "";
  const resp = await chrome.runtime.sendMessage({ action: "startRecording", callUrl: url });
  if (!resp.ok) {
    $("#status").textContent = `Ошибка: ${resp.error}`;
    $("#status").classList.remove("hidden");
    return;
  }
  updateState();
});

$("#btn-start-detected")?.addEventListener("click", async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tabs[0]?.url ?? "";
  await chrome.runtime.sendMessage({ action: "startRecording", callUrl: url });
  updateState();
});

$("#btn-stop").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ action: "stopRecording" });
  if (!response?.ok) {
    $("#status").textContent = `Ошибка завершения: ${response?.error ?? "неизвестная ошибка"}`;
    $("#status").classList.remove("hidden");
    return;
  }
  window.close();
});

$("#btn-finish")?.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ action: "finishRecording" });
  updateState();
});

// Страницы отдаёт desktop: адреса расширения переадресуют туда или подскажут запустить Rechiv.
function openPage(page: string) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`pages/${page}`) });
  window.close();
}

$("#link-history").addEventListener("click", (e) => {
  e.preventDefault();
  openPage("history.html");
});

$("#link-settings").addEventListener("click", (e) => {
  e.preventDefault();
  openPage("settings.html");
});

/** Без desktop запись не начнётся: говорим об этом сразу, а не после нажатия. */
async function checkDesktop() {
  try {
    await createPageSttApiClient(DESKTOP_URL).health();
  } catch {
    $("#status").textContent = "Приложение Rechiv не запущено — запустите его, чтобы записывать";
    $("#status").classList.remove("hidden");
  }
}

$("#btn-show-live").addEventListener("click", async () => {
  if (!activeSessionId) return;
  const response = await chrome.runtime.sendMessage({
    action: "showLiveTranscript",
    sessionId: activeSessionId,
  });
  if (!response?.ok) {
    $("#status").textContent =
      `Не удалось открыть live: ${response?.error ?? "неизвестная ошибка"}`;
    $("#status").classList.remove("hidden");
    return;
  }
  window.close();
});

watchThemeChanges();
void applyDesktopTheme();
// updateState прячет строку статуса, поэтому проверка desktop — после него.
void updateState().then(checkDesktop);
