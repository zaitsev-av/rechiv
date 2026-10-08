import { createPageSttApiClient, type SttApiClient } from "@shared/api-client";
import { getConfig } from "@shared/config";
import { startInlineEdit } from "@shared/inline-edit";
import { setupScrollTop } from "@shared/scroll-top";
import { applyAppearance, watchThemeChanges } from "@shared/theme";
import type { SessionInfo } from "@shared/types";
import { dropLegacyTitle, formatDateTime, getLegacyTitles, plural } from "@shared/utils";

let api: SttApiClient;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let editingTitle = false;
const REFRESH_INTERVAL_MS = 2000;

const STATUS_MAP: Record<string, string> = {
  recording: "Запись",
  suspended: "Приостановлена",
  processing: "Обработка",
  completed: "Готово",
  error: "Ошибка",
};

function formatDuration(createdAt: string, finishedAt: string | null): string {
  if (!finishedAt) return "—";
  const start = new Date(createdAt).getTime();
  const end = new Date(finishedAt).getTime();
  const sec = Math.round((end - start) / 1000);
  if (sec < 60) return `${sec} сек`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min} мин ${remSec ? `${remSec} сек` : ""}`.trim();
  const h = Math.floor(min / 60);
  const remMin = min % 60;
  return `${h} ч ${remMin ? `${remMin} мин` : ""}`.trim();
}

async function init() {
  const config = await getConfig();
  applyAppearance(config);
  api = createPageSttApiClient(config.sttServiceUrl);
  await renderSessions();
}

async function renderSessions() {
  if (editingTitle) return;
  const container = document.getElementById("sessions")!;
  const countBadge = document.getElementById("session-count");
  try {
    const sessions = await api.listSessions();
    const legacyTitles = await getLegacyTitles();
    await migrateLegacyTitles(sessions, legacyTitles);
    container.innerHTML = "";
    if (countBadge) {
      countBadge.textContent = `${sessions.length} ${plural(sessions.length, "запись", "записи", "записей")}`;
    }
    if (sessions.length === 0) {
      scheduleRefresh(false);
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const visual = document.createElement("span");
      visual.className = "empty-visual";
      const title = document.createElement("h3");
      title.textContent = "Записей пока нет";
      const description = document.createElement("p");
      description.textContent =
        "После первого созвона здесь появятся транскрипт, участники и готовое саммари.";
      empty.appendChild(visual);
      empty.appendChild(title);
      empty.appendChild(description);
      container.appendChild(empty);
      return;
    }
    sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    for (const s of sessions) {
      const div = document.createElement("div");
      div.className = "segment session-card clickable";

      const count = Array.isArray(s.participants)
        ? s.participants.length
        : Object.keys(s.participants ?? {}).length;
      const status = STATUS_MAP[s.status] ?? s.status;
      const duration = s.duration ?? formatDuration(s.createdAt, s.finishedAt);
      const title = s.title || legacyTitles[s.sessionId] || "";
      const dt = new Date(s.createdAt);
      const { date, time } = formatDateTime(dt);

      const timeEl = document.createElement("div");
      timeEl.className = "segment-time";
      timeEl.textContent = `${date}\n${time}`;

      const bodyEl = document.createElement("div");
      bodyEl.className = "segment-body";

      const titleRow = document.createElement("div");
      titleRow.className = "session-title-row";

      const speakerEl = document.createElement("div");
      speakerEl.className = "segment-speaker";
      const titleSpan = document.createElement("span");
      titleSpan.className = "session-title";
      titleSpan.title = "Нажми чтобы переименовать";
      titleSpan.textContent = title || "Без названия";
      speakerEl.appendChild(titleSpan);

      const statusEl = document.createElement("span");
      statusEl.className = `status-pill status-${s.status}`;
      statusEl.textContent =
        s.status === "processing" && s.progress !== undefined ? `${status} ${s.progress}%` : status;

      const textEl = document.createElement("div");
      textEl.className = "segment-text session-details";

      const peopleEl = document.createElement("span");
      peopleEl.className = "detail-item";
      peopleEl.textContent = `${count} ${plural(count, "участник", "участника", "участников")}`;

      const durationEl = document.createElement("span");
      durationEl.className = "detail-item";
      durationEl.textContent = duration;

      textEl.appendChild(peopleEl);
      textEl.appendChild(durationEl);

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "btn-delete";
      deleteBtn.title = "Удалить запись";
      deleteBtn.setAttribute("aria-label", "Удалить запись");
      deleteBtn.textContent = "\u00d7";

      titleRow.appendChild(speakerEl);
      titleRow.appendChild(statusEl);
      bodyEl.appendChild(titleRow);
      bodyEl.appendChild(textEl);

      if (s.status === "processing" && s.progress !== undefined) {
        const progressTrack = document.createElement("div");
        progressTrack.className = "progress-track";
        progressTrack.setAttribute("aria-label", `Обработано ${s.progress}%`);
        const progressValue = document.createElement("div");
        progressValue.className = "progress-value";
        progressValue.style.width = `${Math.min(100, Math.max(0, s.progress))}%`;
        progressTrack.appendChild(progressValue);
        bodyEl.appendChild(progressTrack);
      }

      if (s.status === "error" && s.error) {
        const errorEl = document.createElement("div");
        errorEl.className = "session-error";
        errorEl.textContent = s.error;
        bodyEl.appendChild(errorEl);
      }

      div.appendChild(timeEl);
      div.appendChild(bodyEl);
      div.appendChild(deleteBtn);

      div.addEventListener("click", () => {
        location.href = `transcript.html?sessionId=${s.sessionId}`;
      });

      titleSpan.addEventListener("click", async (e) => {
        e.stopPropagation();
        // Список обновляется по таймеру и снёс бы поле прямо во время правки.
        editingTitle = true;
        scheduleRefresh(false);
        await startInlineEdit(
          titleSpan,
          title,
          async (value) => {
            await api.updateTitle(s.sessionId, value);
          },
          {
            allowEmpty: true,
            onError: (err) => console.error("[History] Failed to save title:", err),
          },
        );
        editingTitle = false;
        await renderSessions();
      });

      deleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Удалить эту запись?")) return;
        await api.deleteSession(s.sessionId);
        await renderSessions();
      });

      container.appendChild(div);
    }
    scheduleRefresh(
      sessions.some((session) => session.status === "recording" || session.status === "processing"),
    );
  } catch (err) {
    console.error("[History] Failed to load sessions:", err);
    if (countBadge) countBadge.textContent = "Нет связи";
    container.innerHTML = "";
    const errorState = document.createElement("div");
    errorState.className = "error-state";
    const icon = document.createElement("span");
    icon.className = "error-icon";
    icon.textContent = "!";
    const title = document.createElement("h3");
    title.textContent = "Локальный сервис недоступен";
    const description = document.createElement("p");
    description.textContent = `STT-сервис недоступен: ${err instanceof Error ? err.message : String(err)}`;
    errorState.appendChild(icon);
    errorState.appendChild(title);
    errorState.appendChild(description);
    container.appendChild(errorState);
    scheduleRefresh(true);
  }
}

async function migrateLegacyTitles(
  sessions: SessionInfo[],
  legacyTitles: Record<string, string>,
): Promise<void> {
  for (const session of sessions) {
    const legacy = legacyTitles[session.sessionId];
    if (!legacy || session.title) continue;
    try {
      await api.updateTitle(session.sessionId, legacy);
      session.title = legacy;
      await dropLegacyTitle(session.sessionId);
    } catch {
      // Повторим при следующем открытии.
    }
  }
}

function scheduleRefresh(needed: boolean) {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (!needed || editingTitle || document.visibilityState === "hidden") return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void renderSessions();
  }, REFRESH_INTERVAL_MS);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void renderSessions();
  } else {
    scheduleRefresh(false);
  }
});

window.addEventListener("beforeunload", () => scheduleRefresh(false));

watchThemeChanges();
void init();

setupScrollTop(document.getElementById("btn-top")!);
