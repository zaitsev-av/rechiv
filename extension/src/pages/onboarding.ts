import { createPageSttApiClient, type OnboardingState } from "@shared/api-client";
import { DESKTOP_URL } from "@shared/config";
import { applyDesktopTheme, watchThemeChanges } from "@shared/theme";
import { getErrorMessage } from "@shared/utils";

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

const status = $("#status");
const statusTitle = $("#status-title");
const statusDetail = $("#status-detail");
const steps = $("#steps");
const browserWarning = $("#browser-warning");
const browserWarningCopy = $("#browser-warning-copy");
const browserPick = $("#browser-pick");
const browserSelect = $<HTMLSelectElement>("#select-browser");
const extensionDir = $("#extension-dir");
const openExtensionsButton = $<HTMLButtonElement>("#btn-open-extensions");
const revealButton = $<HTMLButtonElement>("#btn-reveal");
const copyPathButton = $<HTMLButtonElement>("#btn-copy-path");
const recheckButton = $<HTMLButtonElement>("#btn-recheck");

// Установку расширения узнать можно только опросом.
const POLL_INTERVAL_MS = 2000;

const client = createPageSttApiClient(DESKTOP_URL);

let pollTimer: number | undefined;
let extensionPath = "";

type StatusTone = "checking" | "waiting" | "ready" | "warning" | "down";

function setStatus(tone: StatusTone, title: string, detail: string): void {
  status.className = `status ${tone}`;
  statusTitle.textContent = title;
  statusDetail.textContent = detail;
}

function setStepsVisible(visible: boolean): void {
  steps.hidden = !visible;
}

async function loadState(): Promise<void> {
  let state: OnboardingState;
  try {
    state = await client.getOnboardingState();
  } catch (error) {
    setStatus("down", "Приложение не отвечает", getErrorMessage(error));
    return;
  }
  renderBrowser(state);
  renderExtensionDir(state);
}

function renderBrowser(current: OnboardingState): void {
  const { browser, chromiumBrowsers } = current;
  browserSelect.replaceChildren(
    ...chromiumBrowsers.map((item) => new Option(item.name, item.bundleId)),
  );

  if (browser.supported) {
    browserWarning.hidden = true;
    if (browser.bundleId) browserSelect.value = browser.bundleId;
    openExtensionsButton.disabled = false;
    openExtensionsButton.textContent = `Открыть расширения в ${browser.name}`;
    return;
  }

  browserWarning.hidden = false;
  const known = browser.name ? `Сейчас по умолчанию — ${browser.name}. ` : "";
  if (chromiumBrowsers.length > 0) {
    browserWarningCopy.textContent = `${known}Расширение поставим в другой браузер — выберите, в какой.`;
    browserPick.hidden = false;
    openExtensionsButton.disabled = false;
    return;
  }
  browserWarningCopy.textContent = `${known}Подходящего браузера на этом компьютере не нашлось: установите Chrome, Edge, Brave или Vivaldi и вернитесь сюда.`;
  browserPick.hidden = true;
  openExtensionsButton.disabled = true;
}

function renderExtensionDir(current: OnboardingState): void {
  extensionPath = current.extensionDir;
  if (!current.extensionDir) {
    extensionDir.hidden = true;
    revealButton.disabled = true;
    copyPathButton.disabled = true;
    return;
  }
  extensionDir.hidden = false;
  extensionDir.textContent = current.extensionDir;
  revealButton.disabled = false;
  copyPathButton.disabled = false;
}

async function checkInstalled(): Promise<void> {
  let extension: NonNullable<Awaited<ReturnType<typeof client.health>>["extension"]>;
  try {
    const health = await client.health();
    if (!health.extension) {
      setStatus(
        "warning",
        "Приложение старой версии",
        "Обновите Rechiv, чтобы увидеть состояние расширения.",
      );
      return;
    }
    extension = health.extension;
  } catch (error) {
    setStatus(
      "down",
      "Приложение не отвечает",
      `${getErrorMessage(error)} — запустите Rechiv и обновите страницу.`,
    );
    return;
  }

  if (!extension.installed) {
    setStatus(
      "waiting",
      "Расширение ещё не подключилось",
      "Пройдите три шага ниже — статус обновится сам.",
    );
    setStepsVisible(true);
    return;
  }
  if (extension.outdated) {
    // Chrome держит старую сборку до перезагрузки расширения.
    setStatus(
      "warning",
      `Расширение устарело: ${extension.version}`,
      `Приложению нужна версия ${extension.expectedVersion}. Откройте страницу расширений и нажмите «Обновить» на карточке Rechiv.`,
    );
    setStepsVisible(false);
    return;
  }
  setStatus(
    "ready",
    "Расширение установлено",
    `Версия ${extension.version} — можно записывать созвоны.`,
  );
  setStepsVisible(false);
}

function startPolling(): void {
  window.clearInterval(pollTimer);
  pollTimer = window.setInterval(() => void checkInstalled(), POLL_INTERVAL_MS);
}

async function runAction(button: HTMLButtonElement, action: () => Promise<void>): Promise<void> {
  button.disabled = true;
  try {
    await action();
  } catch (error) {
    setStatus("warning", "Не получилось", getErrorMessage(error));
  } finally {
    button.disabled = false;
  }
}

openExtensionsButton.addEventListener("click", () => {
  // Пустая строка — браузер по умолчанию.
  const bundleId = browserPick.hidden ? "" : browserSelect.value;
  void runAction(openExtensionsButton, () => client.openExtensionsPage(bundleId || undefined));
});

revealButton.addEventListener("click", () => {
  void runAction(revealButton, () => client.revealExtensionDir());
});

// Диалог выбора папки не показывает «Библиотеку», зато принимает путь по ⌘⇧G.
copyPathButton.addEventListener("click", () => {
  void runAction(copyPathButton, async () => {
    await navigator.clipboard.writeText(extensionPath);
    copyPathButton.textContent = "Путь скопирован";
    window.setTimeout(() => {
      copyPathButton.textContent = "Скопировать путь";
    }, 2000);
  });
});

recheckButton.addEventListener("click", () => {
  void loadState().then(() => checkInstalled());
});

watchThemeChanges();
void applyDesktopTheme();
void loadState()
  .then(() => checkInstalled())
  .then(startPolling);
