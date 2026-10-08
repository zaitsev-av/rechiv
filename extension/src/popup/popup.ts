import { createPageSttApiClient } from "@shared/api-client";
import { bindAppearanceControls, setAppearanceControls } from "@shared/appearance-controls";
import { DEFAULT_STT_URL, getConfig, isLlmConfigured, saveConfig } from "@shared/config";
import { PLATFORMS, platformForUrl } from "@shared/platform";
import { applySavedTheme, watchThemeChanges } from "@shared/theme";
import type { RecordingState } from "@shared/types";

const $ = (s: string) => document.querySelector<HTMLElement>(s)!;

const views: Record<string, HTMLElement> = {
  idle: $("#view-idle"),
  detecting: $("#view-detecting"),
  recording: $("#view-recording"),
  suspended: $("#view-suspended"),
  settings: $("#view-settings"),
};
let activeSessionId: string | null = null;
let settingsOpen = false;

function showView(state: string) {
  if (settingsOpen && state !== "settings") return;
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

// LLM настраивается только на странице: попап закрывается от клика мимо и потерял бы ввод.
function openPage(page: string) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`pages/${page}`) });
  window.close();
}

$("#link-history").addEventListener("click", (e) => {
  e.preventDefault();
  openPage("history.html");
});

const settingsView = $("#view-settings");

async function showSettings() {
  settingsOpen = true;
  $("#link-settings").classList.add("active");
  showView("settings");
  const config = await getConfig();
  setAppearanceControls(settingsView, config);
  const llmRow = $("#popup-llm");
  const configured = isLlmConfigured(config);
  llmRow.className = `settings-row ${configured ? "ready" : "invite"}`;
  $("#popup-llm-text").textContent = configured
    ? `Саммари: ${config.llmModel}`
    : "Подключите LLM для саммари встреч";
  void checkHealth();
}

async function checkHealth() {
  const row = $("#popup-health");
  const text = $("#popup-health-text");
  row.className = "settings-row checking";
  text.textContent = "Проверяю приложение…";
  try {
    const engine = (await createPageSttApiClient(DEFAULT_STT_URL).health()).engine;
    if (engine?.status === "starting") {
      row.className = "settings-row warning";
      text.textContent = "Приложение загружает модель";
    } else if (engine?.status === "error") {
      row.className = "settings-row warning";
      text.textContent = "Движок распознавания не запустился";
    } else {
      row.className = "settings-row ready";
      text.textContent = "Приложение готово к записи";
    }
  } catch {
    row.className = "settings-row down";
    text.textContent = "Приложение не запущено";
  }
}

function hideSettings() {
  settingsOpen = false;
  $("#link-settings").classList.remove("active");
  void updateState();
}

$("#link-settings").addEventListener("click", (e) => {
  e.preventDefault();
  if (settingsOpen) hideSettings();
  else void showSettings();
});

$("#btn-settings-back").addEventListener("click", hideSettings);

for (const id of ["#link-all-settings", "#popup-llm"]) {
  $(id).addEventListener("click", (e) => {
    e.preventDefault();
    openPage("settings.html");
  });
}

bindAppearanceControls(settingsView, (patch) => void saveConfig(patch));

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
void applySavedTheme();
void updateState();
