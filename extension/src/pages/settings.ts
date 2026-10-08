import { createPageSttApiClient } from "@shared/api-client";
import {
  bindAppearanceControls,
  readAppearanceControls,
  setAppearanceControls,
} from "@shared/appearance-controls";
import { DEFAULT_STT_URL, getConfig, saveConfig } from "@shared/config";
import { checkLlmAccess } from "@shared/llm-client";
import { ensureLlmPermission, LLM_PERMISSION_DENIED } from "@shared/llm-permission";
import { applyAppearance, applySavedTheme, watchThemeChanges } from "@shared/theme";
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
  setHealth("checking", "Проверяю локальное приложение", DEFAULT_STT_URL);

  try {
    const engine = (await createPageSttApiClient(DEFAULT_STT_URL).health()).engine;
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
    setHealth("ready", "Приложение готово к записи", `Отвечает на ${DEFAULT_STT_URL}`);
  } catch (error) {
    setHealth(
      "down",
      "Приложение не отвечает",
      `${DEFAULT_STT_URL} — запустите Rechiv командой task run. ${getErrorMessage(error)}`,
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

function incompleteLlmFields(): HTMLInputElement[] {
  const empty = emptyLlmFields();
  return empty.length === llmFields.length ? [] : empty;
}

async function load(): Promise<void> {
  const config = await getConfig();
  applyAppearance(config);
  llmUrlInput.value = config.llmUrl;
  llmModelInput.value = config.llmModel;
  llmKeyInput.value = config.llmApiKey;
  setAppearanceControls(form, config);
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

  const llmUrl = llmUrlInput.value.trim();
  if (llmUrl && !(await ensureLlmPermission(llmUrl))) {
    setStatus(saveStatus, LLM_PERMISSION_DENIED, "error");
    return;
  }

  try {
    await saveConfig({
      llmUrl: llmUrlInput.value.trim(),
      llmModel: llmModelInput.value.trim(),
      llmApiKey: llmKeyInput.value.trim(),
      ...readAppearanceControls(form),
    });
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

  if (!(await ensureLlmPermission(llmUrlInput.value.trim()))) {
    setStatus(llmStatus, LLM_PERMISSION_DENIED, "error");
    return;
  }
  checkLlmButton.disabled = true;
  setStatus(llmStatus, "Проверяю…");
  try {
    const result = await checkLlmAccess({
      llmUrl: llmUrlInput.value.trim(),
      llmModel: llmModelInput.value.trim(),
      llmApiKey: llmKeyInput.value.trim(),
    });
    setStatus(llmStatus, result.detail, result.state);
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

bindAppearanceControls(form);

$("#btn-recheck").addEventListener("click", () => void checkHealth());

watchThemeChanges();
void applySavedTheme();
void load().then(() => checkHealth());
