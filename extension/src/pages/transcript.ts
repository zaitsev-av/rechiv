import { createPageSttApiClient, type SttApiClient } from "@shared/api-client";
import { DESKTOP_URL } from "@shared/config";
import { startInlineEdit } from "@shared/inline-edit";
import { setupScrollTop } from "@shared/scroll-top";
import { speakerInitials } from "@shared/speaker-initials";
import { applyDesktopTheme, watchThemeChanges } from "@shared/theme";
import type {
  LiveTranscriptResult,
  SummaryJob,
  SummaryResult,
  TranscriptResult,
} from "@shared/types";
import { formatDateTime, getErrorMessage, plural } from "@shared/utils";
import { createSummaryEditor, type SummaryCommand, type SummaryEditor } from "./summary-editor";

let apiClient: SttApiClient;
let transcript: TranscriptResult;
let sessionId: string;
let sessionTitle: string = "";
let summaryData: SummaryResult | null = null;
let summaryEditor: SummaryEditor | null = null;
let summaryEditing = false;
let summarySaving = false;
let summaryGenerating = false;
let summaryBaseline = "";
let transcriptIsFinal = false;
let llmConfigured = false;
let livePollTimer: ReturnType<typeof setInterval> | null = null;
let finalFeaturesInitialized = false;
const hiddenSpeakers = new Set<string>();
const speakerTones = new Map<string, number>();
const LIVE_POLL_INTERVAL_MS = 2000;
const SUMMARY_POLL_INTERVAL_MS = 2000;
let summaryJobTimer: ReturnType<typeof setInterval> | null = null;

async function init() {
  await applyDesktopTheme();
  apiClient = createPageSttApiClient(DESKTOP_URL);
  await refreshLlmConfigured();
  sessionId = new URLSearchParams(location.search).get("sessionId") ?? "";
  if (!sessionId) {
    document.getElementById("title")!.textContent = "Сессия не найдена";
    return;
  }

  sessionTitle = await loadSessionTitle();

  try {
    await refreshLiveTranscript();
  } catch {
    document.getElementById("title")!.textContent = "Подключаю live-транскрипт…";
    setLiveIndicator("reconnecting", "Переподключаюсь к локальному сервису");
  }
  if (!transcriptIsFinal) startLivePolling();
}

function updateSummaryButton(configured: boolean) {
  const tab = document.getElementById("tab-summary") as HTMLButtonElement;
  tab.disabled = !transcriptIsFinal;
  tab.classList.toggle("disabled", !transcriptIsFinal);
  tab.title = transcriptIsFinal ? "" : "Саммари станет доступно после завершения записи";
  let title = "";
  if (!transcriptIsFinal) title = "Саммари станет доступно после завершения записи";
  else if (!configured) title = "Укажите адрес, модель и токен LLM на странице настроек";
  for (const id of ["btn-summary", "btn-summary-empty", "btn-regenerate"]) {
    const btn = document.getElementById(id) as HTMLButtonElement;
    btn.disabled = summaryGenerating || title !== "";
    btn.title = title;
  }
}

/** Название живёт в сессии; из chrome.storage поднимаем только старые записи. */
async function loadSessionTitle(): Promise<string> {
  try {
    return (await apiClient.getSession(sessionId)).title ?? "";
  } catch {
    // Сервис недоступен.
    return "";
  }
}

async function refreshLiveTranscript() {
  let live: LiveTranscriptResult;
  try {
    live = await apiClient.getLiveTranscript(sessionId);
  } catch {
    const completed = await apiClient.getTranscript(sessionId);
    live = {
      ...completed,
      status: "completed",
      isFinal: true,
      processedChunks: completed.segments.length,
      totalChunks: completed.segments.length,
    };
  }

  const wasFinal = transcriptIsFinal;
  const shouldFollow =
    document.documentElement.scrollHeight - (window.scrollY + window.innerHeight) < 180;
  transcript = live;
  transcriptIsFinal = live.isFinal ?? true;
  render();
  updateLiveIndicator(live, transcriptIsFinal);
  updateSummaryButton(llmConfigured);

  if (shouldFollow && !transcriptIsFinal) {
    requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight }));
  }

  if (transcriptIsFinal) {
    stopLivePolling();
    if (!wasFinal || !finalFeaturesInitialized) {
      await initializeFinalFeatures();
    }
  }
}

function startLivePolling() {
  if (livePollTimer !== null) return;
  livePollTimer = setInterval(() => {
    void refreshLiveTranscript().catch(() => {
      setLiveIndicator("reconnecting", "Связь потеряна · переподключаюсь");
    });
  }, LIVE_POLL_INTERVAL_MS);
}

function stopLivePolling() {
  if (livePollTimer === null) return;
  clearInterval(livePollTimer);
  livePollTimer = null;
}

async function initializeFinalFeatures() {
  if (finalFeaturesInitialized) return;
  finalFeaturesInitialized = true;
  await loadSummary();
  try {
    const job = (await apiClient.getSession(sessionId)).summaryJob;
    if (job?.running) {
      setSummaryGenerating(true);
      watchSummaryJob();
    } else if (job?.error && !summaryData) {
      showBanner(`Саммари не получилось: ${job.error}`);
    }
  } catch {
    // Сервис недоступен.
  }
}

function updateLiveIndicator(live: LiveTranscriptResult, isFinal: boolean) {
  if (isFinal) {
    document.getElementById("live-indicator")?.classList.add("hidden");
    return;
  }

  // Во время записи знаменатель растёт, проценты бессмысленны.
  if (live.status === "processing") {
    const percent =
      live.totalChunks > 0 ? Math.round((live.processedChunks / live.totalChunks) * 100) : 0;
    setLiveIndicator("processing", `Завершаю обработку · ${percent}%`);
    return;
  }

  const replicas = live.segments.length;
  setLiveIndicator(
    "recording",
    replicas > 0
      ? `Live · ${replicas} ${plural(replicas, "реплика", "реплики", "реплик")}`
      : "Live · жду речь",
  );
}

function setLiveIndicator(state: "recording" | "processing" | "reconnecting", text: string) {
  const indicator = document.getElementById("live-indicator");
  const label = document.getElementById("live-indicator-text");
  if (!indicator || !label) return;
  indicator.classList.remove("hidden", "processing", "reconnecting");
  if (state !== "recording") indicator.classList.add(state);
  label.textContent = text;
}

async function loadSummary() {
  try {
    summaryData = await apiClient.getSummary(sessionId);
  } catch {
    // Саммари ещё нет.
  }
  renderSummary();
}

/** Пустое состояние, ход генерации и отметка на вкладке — из summaryData и summaryGenerating. */
function renderSummaryState() {
  const hasSummary = summaryData !== null;
  document.getElementById("summary-empty")!.classList.toggle("hidden", hasSummary);
  document.getElementById("summary-content")!.classList.toggle("hidden", !hasSummary);
  document.getElementById("summary-generating")!.classList.toggle("hidden", !summaryGenerating);
  document.getElementById("summary-empty-text")!.textContent = summaryGenerating
    ? "Генерируется. Со страницы можно уйти — Rechiv доделает и сохранит."
    : "LLM соберёт итоги, решения и задачи по транскрипту. Со страницы можно уйти — Rechiv доделает сам.";
  document.getElementById("btn-summary")!.classList.toggle("hidden", hasSummary);

  const mark = document.getElementById("tab-summary-mark")!;
  mark.replaceChildren();
  mark.classList.toggle("hidden", hasSummary && !summaryGenerating);
  if (summaryGenerating) {
    const spinner = document.createElement("span");
    spinner.className = "tab-mark-spinner";
    mark.title = "Генерируется";
    mark.append(spinner);
  } else if (!hasSummary) {
    const empty = document.createElement("span");
    empty.className = "tab-mark-empty";
    empty.textContent = "нет";
    mark.title = "";
    mark.append(empty);
  }
}

function switchTab(tabName: string) {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", (tab as HTMLElement).dataset.tab === tabName);
  }
  for (const panel of ["transcript", "summary"]) {
    document.getElementById(`panel-${panel}`)!.classList.toggle("hidden", panel !== tabName);
  }
  document
    .getElementById("actions-transcript")!
    .classList.toggle("hidden", tabName !== "transcript");
}

function renderSummary() {
  renderSummaryState();
  if (!summaryData) return;
  if (!summaryEditor) {
    summaryEditor = createSummaryEditor(
      document.getElementById("summary-editor")!,
      updateSummaryEditing,
    );
    createSummaryToolbar();
  }
  summaryEditor.showMarkdown(summaryData.content);
  const edited = document.getElementById("summary-edited")!;
  edited.classList.toggle("hidden", !summaryData.editedAt);
  if (summaryData.editedAt) {
    const { date, time } = formatDateTime(new Date(summaryData.editedAt));
    edited.textContent = `изменено вручную · ${date} ${time}`;
  } else {
    edited.textContent = "";
  }
  const info: string[] = [];
  if (summaryData.model) info.push(summaryData.model);
  if (summaryData.createdAt) {
    const { date, time } = formatDateTime(new Date(summaryData.createdAt));
    info.push(`${date} ${time}`);
  }
  document.getElementById("summary-info")!.textContent = info.join(" · ");
  updateSummaryEditing();
}

function summaryHasChanges(): boolean {
  return summaryEditing && summaryEditor?.getMarkdown() !== summaryBaseline;
}

function updateSummaryEditing() {
  document.getElementById("summary-content")!.classList.toggle("editing", summaryEditing);
  document.getElementById("summary-toolbar")!.classList.toggle("hidden", !summaryEditing);
  for (const id of ["btn-regenerate", "btn-copy-summary", "btn-edit-summary"]) {
    document.getElementById(id)!.classList.toggle("hidden", summaryEditing);
  }
  (document.getElementById("btn-edit-summary") as HTMLButtonElement).disabled = summaryGenerating;
  for (const id of ["btn-save-summary", "btn-cancel-summary"]) {
    const btn = document.getElementById(id) as HTMLButtonElement;
    btn.classList.toggle("hidden", !summaryEditing);
    btn.disabled = summarySaving || (id === "btn-save-summary" && !summaryEditor?.hasText());
  }
  const save = document.getElementById("btn-save-summary")!;
  save.classList.toggle("btn-spinner", summarySaving);
  save.textContent = summarySaving ? "Сохранение…" : "Сохранить";
  for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-summary-command]")) {
    const command = btn.dataset.summaryCommand as SummaryCommand;
    btn.disabled = summarySaving;
    if (command !== "undo" && command !== "redo") {
      btn.setAttribute("aria-pressed", String(summaryEditor?.isActive(command) ?? false));
    }
  }
}

function createSummaryToolbar() {
  const actions: [SummaryCommand, string, string][] = [
    ["bold", "Жирный (⌘B / Ctrl+B)", "M6 3h5a4 4 0 0 1 0 8H6z M6 11h6a4 4 0 0 1 0 8H6z"],
    ["italic", "Курсив (⌘I / Ctrl+I)", "M10 3h8 M6 19h8 M14 3 10 19"],
    ["heading2", "Заголовок 2", "M3 4v16 M12 4v16 M3 12h9 M16 13c0-4 6-4 6 0 0 2-6 4-6 7h6"],
    ["heading3", "Заголовок 3", "M3 4v16 M12 4v16 M3 12h9 M16 11c7-3 8 5 2 5 6 0 5 7-2 4"],
    ["bulletList", "Маркированный список", "M9 5h12 M9 12h12 M9 19h12 M3 5h1 M3 12h1 M3 19h1"],
    [
      "orderedList",
      "Нумерованный список",
      "M10 5h11 M10 12h11 M10 19h11 M3 3h1v6 M2 14c4-3 6 1 3 3l-3 3h5",
    ],
    ["undo", "Отменить (⌘Z / Ctrl+Z)", "M8 4 3 9l5 5 M3 9h11a6 6 0 0 1 0 12"],
    ["redo", "Повторить (⌘⇧Z / Ctrl+Shift+Z)", "m16 4 5 5-5 5 M21 9H10a6 6 0 0 0 0 12"],
  ];
  const toolbar = document.getElementById("summary-toolbar")!;
  for (const [command, label, path] of actions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.dataset.summaryCommand = command;
    const icon = pencilIcon();
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.querySelector("path")!.setAttribute("d", path);
    icon.querySelector("path")!.setAttribute("stroke-width", "2");
    btn.append(icon);
    btn.addEventListener("mousedown", (event) => event.preventDefault());
    btn.addEventListener("click", () => summaryEditor?.command(command));
    toolbar.append(btn);
  }
}

function startSummaryEditing() {
  if (!summaryEditor || !summaryData || summaryGenerating || summaryEditing) return;
  hideBanner();
  summaryEditor.setEditable(true);
  summaryBaseline = summaryEditor.getMarkdown();
  summaryEditing = true;
  updateSummaryEditing();
}

function finishSummaryEditing() {
  summaryEditing = false;
  summaryEditor?.setEditable(false);
  updateSummaryEditing();
}

function cancelSummaryEditing() {
  if (!summaryEditing || summarySaving || !summaryData) return;
  if (summaryHasChanges() && !confirm("Отменить правки?")) return;
  summaryEditor?.showMarkdown(summaryData.content);
  finishSummaryEditing();
}

async function saveSummaryEditing() {
  if (!summaryEditing || summarySaving || !summaryEditor?.hasText() || !summaryData) return;
  if (!summaryHasChanges()) {
    finishSummaryEditing();
    return;
  }
  const updated = {
    ...summaryData,
    content: summaryEditor.getMarkdown(),
    editedAt: new Date().toISOString(),
  };
  summarySaving = true;
  summaryEditor.setEditable(false);
  updateSummaryEditing();
  hideBanner();
  try {
    await apiClient.putSummary(sessionId, updated);
    summaryData = updated;
    finishSummaryEditing();
    renderSummary();
  } catch (err) {
    showBanner(`Не удалось сохранить саммари: ${getErrorMessage(err)}`);
    summaryEditor.setEditable(true);
  } finally {
    summarySaving = false;
    updateSummaryEditing();
  }
}

function renameSpeaker(el: HTMLElement, speakerId: string, currentName: string): Promise<void> {
  return startInlineEdit(
    el,
    currentName,
    async (name) => {
      await apiClient.updateSpeaker(sessionId, speakerId, name);

      // Сервер подставляет имя по speakerId при чтении, транскрипт не перезаписываем.
      for (const participant of transcript.participants) {
        if (participant.speakerId === speakerId) participant.name = name;
      }
      for (const segment of transcript.segments) {
        if (segment.speakerId === speakerId) segment.speaker = name;
      }
      render();
    },
    { onError: (err) => showBanner(`Не удалось сохранить имя: ${getErrorMessage(err)}`) },
  );
}

function showBanner(text: string, kind: "error" | "success" = "error"): void {
  const banner = document.getElementById("banner");
  const label = document.getElementById("banner-text");
  if (!banner || !label) return;
  label.textContent = text;
  banner.classList.remove("hidden", "success");
  if (kind === "success") banner.classList.add("success");
}

function hideBanner(): void {
  document.getElementById("banner")?.classList.add("hidden");
}

async function handleGenerateSummary() {
  if (summaryEditing || summaryGenerating || !transcriptIsFinal) return;
  if (
    summaryData?.editedAt &&
    !confirm("Саммари отредактировано вручную. Перегенерировать и потерять правки?")
  )
    return;
  setSummaryGenerating(true);
  try {
    await apiClient.generateSummary(sessionId);
    watchSummaryJob();
  } catch (err: unknown) {
    setSummaryGenerating(false);
    showBanner(getErrorMessage(err));
    await refreshLlmConfigured();
    updateSummaryButton(llmConfigured);
  }
}

function setSummaryGenerating(on: boolean) {
  summaryGenerating = on;
  updateSummaryEditing();
  for (const [id, idle] of [
    ["btn-summary", "Сделать саммари"],
    ["btn-summary-empty", "Сделать саммари"],
    ["btn-regenerate", "Перегенерировать"],
  ]) {
    const btn = document.getElementById(id) as HTMLButtonElement;
    btn.textContent = on ? "Генерация…" : idle;
    btn.classList.toggle("btn-spinner", on);
  }
  updateSummaryButton(llmConfigured);
  renderSummaryState();
}

/** Саммари делает desktop: со страницы можно уйти, при возврате она подхватит ход. */
function watchSummaryJob() {
  if (summaryJobTimer !== null) return;
  summaryJobTimer = setInterval(() => void checkSummaryJob(), SUMMARY_POLL_INTERVAL_MS);
  void checkSummaryJob();
}

async function checkSummaryJob() {
  let job: SummaryJob | undefined;
  try {
    job = (await apiClient.getSession(sessionId)).summaryJob;
  } catch {
    return;
  }
  if (job?.running) return;
  if (summaryJobTimer !== null) clearInterval(summaryJobTimer);
  summaryJobTimer = null;
  setSummaryGenerating(false);
  if (job?.error) {
    showBanner(`Саммари не получилось: ${job.error}`);
    return;
  }
  await loadSummary();
  if (summaryData) switchTab("summary");
}

async function refreshLlmConfigured(): Promise<void> {
  try {
    llmConfigured = (await apiClient.getLlmSettings()).configured;
  } catch {
    llmConfigured = false;
  }
}

function render() {
  if (!document.getElementById("panel-transcript")!.classList.contains("hidden")) {
    document.getElementById("actions-transcript")!.classList.remove("hidden");
  }
  const titleEl = document.getElementById("title")!;
  const displayTitle = sessionTitle || `Звонок ${transcript.date}`;
  // Во время записи render() зовётся каждые две секунды и стёр бы набранное.
  if (!titleEl.isContentEditable) titleEl.textContent = displayTitle;
  titleEl.style.cursor = "pointer";
  titleEl.title = "Нажми чтобы переименовать";
  titleEl.onclick = () => {
    void startInlineEdit(
      titleEl,
      displayTitle,
      async (value) => {
        await apiClient.updateTitle(sessionId, value);
        sessionTitle = value;
        render();
      },
      {
        allowEmpty: true,
        onError: (err) => showBanner(`Не удалось сохранить название: ${getErrorMessage(err)}`),
      },
    );
  };

  const n = transcript.participants.length;
  const dt = new Date(transcript.recordingStarted);
  const { date: dateStr, time: timeStr } = formatDateTime(dt);
  document.getElementById("info")!.textContent =
    `${dateStr} ${timeStr} · ${transcript.duration} · ${n} ${plural(n, "участник", "участника", "участников")}`;
  renderFilters();
  renderSegments();
}

function pencilIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M8.1 1.5 10.5 3.9 4.3 10.1 1.4 10.6 1.9 7.7z");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.2");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}

function renderFilters() {
  const container = document.getElementById("filters")!;
  // Тот же случай, что и с названием: перерисовка убила бы правку имени участника.
  if (container.querySelector(".editing")) return;
  container.innerHTML = "";

  const allDiv = document.createElement("div");
  allDiv.className = "filter-item";
  const allInput = document.createElement("input");
  allInput.type = "checkbox";
  allInput.id = "filter-all";
  allInput.checked = hiddenSpeakers.size === 0;
  allInput.addEventListener("change", () => {
    const checked = allInput.checked;
    for (const cb of container.querySelectorAll<HTMLInputElement>(
      "input[id^='filter-']:not(#filter-all)",
    )) {
      cb.checked = checked;
    }
    if (checked) {
      hiddenSpeakers.clear();
    } else {
      for (const p of transcript.participants) {
        hiddenSpeakers.add(p.speakerId);
      }
    }
    updateVisibility();
  });
  const allLabel = document.createElement("label");
  allLabel.htmlFor = "filter-all";
  allLabel.textContent = "Все";
  allDiv.appendChild(allInput);
  allDiv.appendChild(allLabel);
  container.appendChild(allDiv);

  for (const p of transcript.participants) {
    const name = p.name ?? p.speakerId;
    const div = document.createElement("div");
    const tone = getSpeakerTone(p.speakerId);
    div.className = `filter-item speaker-tone-${tone}`;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `filter-${p.speakerId}`;
    input.checked = !hiddenSpeakers.has(p.speakerId);
    input.addEventListener("change", () => {
      if (input.checked) hiddenSpeakers.delete(p.speakerId);
      else hiddenSpeakers.add(p.speakerId);
      updateVisibility();
      syncAllCheckbox(container);
    });
    const label = document.createElement("label");
    label.htmlFor = `filter-${p.speakerId}`;
    label.textContent = name;
    label.dataset.initials = speakerInitials(name, p.speakerId);

    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "speaker-rename";
    rename.appendChild(pencilIcon());
    rename.title = "Переименовать участника";
    rename.setAttribute("aria-label", `Переименовать участника ${name}`);
    rename.addEventListener("click", () => void renameSpeaker(label, p.speakerId, name));

    div.appendChild(input);
    div.appendChild(label);
    div.appendChild(rename);
    container.appendChild(div);
  }
  syncAllCheckbox(container);
}

function syncAllCheckbox(container: HTMLElement) {
  const allCb = container.querySelector<HTMLInputElement>("#filter-all");
  if (!allCb) return;
  const speakers = container.querySelectorAll<HTMLInputElement>(
    "input[id^='filter-']:not(#filter-all)",
  );
  const allChecked = Array.from(speakers).every((cb) => cb.checked);
  const noneChecked = Array.from(speakers).every((cb) => !cb.checked);
  allCb.checked = allChecked;
  allCb.indeterminate = !allChecked && !noneChecked;
}

function renderSegments() {
  const container = document.getElementById("segments")!;
  container.innerHTML = "";
  if (transcript.segments.length === 0 && !transcriptIsFinal) {
    const waiting = document.createElement("div");
    waiting.className = "live-waiting";

    const wave = document.createElement("span");
    wave.className = "live-waiting-wave";
    wave.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 5; i++) wave.appendChild(document.createElement("i"));

    const title = document.createElement("strong");
    title.textContent = "Слушаю созвон";
    const description = document.createElement("p");
    description.textContent =
      "Первые реплики появятся после обработки первого аудиофрагмента — обычно примерно через 20 секунд.";

    waiting.appendChild(wave);
    waiting.appendChild(title);
    waiting.appendChild(description);
    container.appendChild(waiting);
    return;
  }

  for (let i = 0; i < transcript.segments.length; i++) {
    const seg = transcript.segments[i];
    const div = document.createElement("div");
    div.className =
      `segment speaker-tone-${getSpeakerTone(seg.speakerId)}` +
      `${seg.error ? " error" : ""}${transcriptIsFinal ? "" : " live-segment"}`;
    div.dataset.speakerId = seg.speakerId;

    const avatarEl = document.createElement("span");
    avatarEl.className = "segment-avatar";
    avatarEl.setAttribute("aria-hidden", "true");
    avatarEl.textContent = speakerInitials(seg.speaker, seg.speakerId);

    const speakerEl = document.createElement("span");
    speakerEl.className = "segment-speaker";
    speakerEl.textContent = seg.speaker;
    speakerEl.title = "Нажмите, чтобы переименовать участника";
    speakerEl.addEventListener(
      "click",
      () => void renameSpeaker(speakerEl, seg.speakerId, seg.speaker),
    );

    const timeEl = document.createElement("time");
    timeEl.className = "segment-time";
    timeEl.textContent = shortTime(seg.start);
    timeEl.title = `${seg.start} – ${seg.end}`;

    const headEl = document.createElement("div");
    headEl.className = "segment-head";
    headEl.append(speakerEl, timeEl);

    const textEl = document.createElement("div");
    textEl.className = "segment-text";
    textEl.textContent = seg.text || "Не удалось распознать фрагмент";

    div.append(avatarEl, headEl, textEl);
    container.appendChild(div);
  }
}

/** Без часов, пока созвон их не набрал: 00:01:05 → 01:05. */
function shortTime(value: string): string {
  return /^00:\d\d:\d\d$/.test(value) ? value.slice(3) : value;
}

function getSpeakerTone(speakerId: string): number {
  const existing = speakerTones.get(speakerId);
  if (existing !== undefined) return existing;
  const tone = speakerTones.size % 5;
  speakerTones.set(speakerId, tone);
  return tone;
}

function updateVisibility() {
  for (const seg of document.querySelectorAll(".segment")) {
    const speakerId = (seg as HTMLElement).dataset.speakerId ?? "";
    seg.classList.toggle("hidden", hiddenSpeakers.has(speakerId));
  }
}

document.getElementById("banner-close")?.addEventListener("click", hideBanner);

setupScrollTop(document.getElementById("btn-top")!);

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    const el = tab as HTMLButtonElement;
    if (el.disabled) return;
    switchTab(el.dataset.tab!);
  });
}

document.getElementById("btn-summary")!.addEventListener("click", () => {
  switchTab("summary");
  void handleGenerateSummary();
});

document
  .getElementById("btn-summary-empty")!
  .addEventListener("click", () => void handleGenerateSummary());

document.getElementById("summary-editor")!.addEventListener("dblclick", startSummaryEditing);

document
  .getElementById("btn-regenerate")!
  .addEventListener("click", () => void handleGenerateSummary());

document.getElementById("btn-copy-summary")!.addEventListener("click", () => {
  if (!summaryData) return;
  navigator.clipboard.writeText(summaryData.content);
  const btn = document.getElementById("btn-copy-summary")!;
  btn.textContent = "Скопировано";
  setTimeout(() => (btn.textContent = "Копировать"), 2000);
});

document.getElementById("btn-download")!.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(transcript, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `transcript-${transcript.date}-${sessionId}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById("btn-copy")!.addEventListener("click", () => {
  const text = transcript.segments
    .map((s) => `[${s.start} – ${s.end}] ${s.speaker}: ${s.text}`)
    .join("\n");
  navigator.clipboard.writeText(text);
  const btn = document.getElementById("btn-copy")!;
  btn.textContent = "Скопировано";
  setTimeout(() => (btn.textContent = "Копировать текст"), 2000);
});

document.getElementById("btn-edit-summary")!.addEventListener("click", startSummaryEditing);
document.getElementById("btn-cancel-summary")!.addEventListener("click", cancelSummaryEditing);
document
  .getElementById("btn-save-summary")!
  .addEventListener("click", () => void saveSummaryEditing());
document.addEventListener(
  "keydown",
  (event) => {
    if (summaryEditing && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      // Перехватываем раньше ProseMirror: Mod+Enter у StarterKit вставляет перенос.
      event.stopPropagation();
      void saveSummaryEditing();
    }
  },
  true,
);
window.addEventListener("beforeunload", (event) => {
  if (summaryHasChanges()) {
    event.preventDefault();
    event.returnValue = "";
  }
});
window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  stopLivePolling();
  summaryEditor?.destroy();
});

watchThemeChanges();
init();
