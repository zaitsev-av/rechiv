import { createPageSttApiClient, type LlmSettingsInput } from "@shared/api-client";
import { saveAppearance } from "@shared/appearance";
import {
  bindAppearanceControls,
  readAppearanceControls,
  setAppearanceControls,
} from "@shared/appearance-controls";
import { DESKTOP_URL } from "@shared/config";
import { applyAppearance, applyDesktopTheme, watchThemeChanges } from "@shared/theme";
import { getErrorMessage } from "@shared/utils";

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

const llmUrlInput = $<HTMLInputElement>("#input-llm-url");
const llmModelInput = $<HTMLInputElement>("#input-llm-model");
const llmKeyInput = $<HTMLInputElement>("#input-llm-api-key");
const llmFields = [llmUrlInput, llmModelInput, llmKeyInput];
const form = $<HTMLFormElement>("#settings-form");
const saveStatus = $("#save-status");
const llmStatus = $("#llm-status");
const checkLlmButton = $<HTMLButtonElement>("#btn-check-llm");
const toggleKeyButton = $<HTMLButtonElement>("#btn-toggle-key");
const health = $("#health");
const healthTitle = $("#health-title");
const healthDetail = $("#health-detail");
const api = createPageSttApiClient(DESKTOP_URL);

type Tone = "ok" | "warning" | "error" | "";

function setHealth(
  state: "checking" | "ready" | "warning" | "down",
  title: string,
  detail: string,
) {
  health.className = `health ${state}`;
  healthTitle.textContent = title;
  healthDetail.textContent = detail;
}

async function checkHealth(): Promise<void> {
  setHealth("checking", "Проверяю локальное приложение", DESKTOP_URL);

  try {
    const engine = (await createPageSttApiClient(DESKTOP_URL).health()).engine;
    if (engine?.status === "error") {
      setHealth(
        "warning",
        "Приложение отвечает, движок не запустился",
        engine.error ?? "Проверьте зависимости Python в service/.venv",
      );
      return;
    }
    if (engine?.status === "starting") {
      setHealth(
        "warning",
        "Приложение отвечает, движок загружается",
        "Модель распознавания загружается в память — это несколько секунд.",
      );
      return;
    }
    setHealth("ready", "Приложение готово к записи", `Отвечает на ${DESKTOP_URL}`);
  } catch (error) {
    setHealth(
      "down",
      "Приложение не отвечает",
      `${DESKTOP_URL} — запустите Rechiv командой task run. ${getErrorMessage(error)}`,
    );
  }
}

function setStatus(el: HTMLElement, text: string, tone: Tone = ""): void {
  el.className = `${el.classList[0]} ${tone}`.trim();
  el.textContent = text;
}

function markInvalid(fields: HTMLInputElement[]): void {
  for (const input of llmFields) input.classList.toggle("invalid", fields.includes(input));
  fields[0]?.focus();
}

/** Три поля LLM — все или ни одного: половина выглядела бы рабочей настройкой. */
function emptyLlmFields(): HTMLInputElement[] {
  return llmFields.filter((input) => input.value.trim() === "");
}

function llmInput(): LlmSettingsInput {
  return {
    url: llmUrlInput.value.trim(),
    model: llmModelInput.value.trim(),
    apiKey: llmKeyInput.value.trim(),
  };
}

function incompleteLlmFields(): HTMLInputElement[] {
  const empty = emptyLlmFields();
  return empty.length === llmFields.length ? [] : empty;
}

async function load(): Promise<void> {
  const config = await applyDesktopTheme();
  setAppearanceControls(form, config);
  try {
    const llm = await api.getLlmSettings();
    llmUrlInput.value = llm.url;
    llmModelInput.value = llm.model;
    llmKeyInput.value = llm.apiKey;
  } catch (error) {
    setStatus(llmStatus, `Настройки LLM недоступны: ${getErrorMessage(error)}`, "error");
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const missing = incompleteLlmFields();
  if (missing.length > 0) {
    markInvalid(missing);
    setStatus(saveStatus, "Заполните адрес, модель и токен — или очистите все три.", "error");
    return;
  }
  markInvalid([]);

  try {
    await api.putLlmSettings(llmInput());
    applyAppearance(readAppearanceControls(form));
    setStatus(saveStatus, "Сохранено", "ok");
  } catch (error) {
    setStatus(saveStatus, `Не удалось сохранить: ${getErrorMessage(error)}`, "error");
  }
});

// Проверяем поля, а не сохранённое: токен проверяют до сохранения.
checkLlmButton.addEventListener("click", async () => {
  const missing = emptyLlmFields();
  if (missing.length > 0) {
    markInvalid(missing);
    setStatus(llmStatus, "Для проверки нужны адрес, модель и токен.", "error");
    return;
  }
  markInvalid([]);

  checkLlmButton.disabled = true;
  setStatus(llmStatus, "Проверяю…");
  try {
    const result = await api.checkLlm(llmInput());
    setStatus(llmStatus, result.detail, result.state);
  } catch (error) {
    setStatus(llmStatus, getErrorMessage(error), "error");
  } finally {
    checkLlmButton.disabled = false;
  }
});

toggleKeyButton.addEventListener("click", () => {
  const revealed = llmKeyInput.type === "text";
  llmKeyInput.type = revealed ? "password" : "text";
  toggleKeyButton.textContent = revealed ? "Показать" : "Скрыть";
  toggleKeyButton.setAttribute("aria-pressed", String(!revealed));
});

bindAppearanceControls(form, (patch) => void saveAppearance(patch));

$("#btn-recheck").addEventListener("click", () => void checkHealth());

watchThemeChanges();
void load().then(() => checkHealth());
