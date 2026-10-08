import { type HealthResult, SttApiClient } from "../shared/api-client";
import { getConfig } from "../shared/config";
import type { ContentMessage } from "../shared/messages";
import { ALL_MATCHES, isCallPage } from "../shared/platform";
import { RecordingStorage } from "../shared/storage";
import type { RecordingState, SessionInfo, VadTimeline } from "../shared/types";
import { getErrorMessage } from "../shared/utils";

const PREFIX = "[Rechiv:sw]";

export class SessionController {
  private _state: RecordingState = "idle";
  private _sessionId: string | null = null;
  private _uploadToken: string | null = null;
  private _tabId: number | null = null;
  private _storage = new RecordingStorage();

  constructor(private _api: SttApiClient) {}

  get state() {
    return this._state;
  }

  get sessionId() {
    return this._sessionId;
  }

  get tabId() {
    return this._tabId;
  }

  get uploadToken() {
    return this._uploadToken;
  }

  get api() {
    return this._api;
  }

  async startRecording(callUrl: string, tabId?: number) {
    if (this._state === "recording" || this._state === "suspended")
      throw new Error("Уже есть активная запись");

    let health: HealthResult;
    try {
      health = await this._api.health();
    } catch {
      throw new Error("STT-сервис не запущен");
    }

    if (health.engine?.status === "error") {
      throw new Error(
        `Движок распознавания не запустился: ${health.engine.error ?? "проверьте зависимости Python"}`,
      );
    }

    const session = await this._api.createSession(callUrl);
    this._sessionId = session.sessionId;
    this._uploadToken = session.uploadToken ?? null;
    this._state = "recording";
    this._tabId = tabId ?? null;
    await this._storage.setActiveSession(
      session.sessionId,
      callUrl,
      session.uploadToken,
      this._tabId ?? undefined,
    );
    await this._updateBadge();
    return session.uploadToken
      ? { sessionId: session.sessionId, uploadToken: session.uploadToken }
      : { sessionId: session.sessionId };
  }

  async stopRecording(vadTimeline?: VadTimeline) {
    if (!this._sessionId) return;
    const finishedSessionId = this._sessionId;
    if (vadTimeline) {
      try {
        await this._api.uploadVadTimeline(finishedSessionId, vadTimeline);
      } catch (err) {
        // Атрибуция полезна, но не стоит потери уже распознанного текста.
        console.error(PREFIX, "VAD timeline upload failed, finishing without it:", err);
      }
    }
    await this._api.finishSession(finishedSessionId);
    this._state = "idle";
    await this._storage.clearActiveSession();
    await this._updateBadge();
    chrome.notifications.create(`processing-${finishedSessionId}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-default-128.png"),
      title: "Транскрипция запущена",
      message: "Сообщу, когда транскрипт будет готов.",
    });
    await watchUntilReady(this._storage, finishedSessionId);
    this._sessionId = null;
    this._uploadToken = null;
    this._tabId = null;
  }

  async onTabClosed(graceMs = TAB_CLOSE_GRACE_MS) {
    if (this._state !== "recording") return;
    const sessionId = this._sessionId;
    this._state = "suspended";
    await this._updateBadge();
    await delay(graceMs);
    // За паузу запись могли завершить вручную.
    if (this._state !== "suspended" || this._sessionId !== sessionId) return;
    await this._finishOrAskUser();
  }

  private async _finishOrAskUser() {
    try {
      await this.stopRecording();
    } catch (err) {
      console.error(PREFIX, "could not finish session after tab close:", err);
      chrome.notifications.create(`suspended-${this._sessionId}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon-suspended-128.png"),
        title: "Звонок завершён",
        message: "Не удалось запустить транскрибацию. Нажмите, чтобы повторить.",
        requireInteraction: true,
      });
    }
  }

  onWebrtcDetected(_url: string) {
    if (this._state === "idle") {
      this._state = "detecting";
      this._updateBadge();
      chrome.notifications.create("webrtc-detected", {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon-default-128.png"),
        title: "Обнаружен звонок",
        message: "Нажмите чтобы начать запись",
        requireInteraction: false,
      });
    }
  }

  async continueRecording(tabId: number) {
    this._state = "recording";
    this._tabId = tabId;
    await this._updateBadge();
  }

  async markProcessing() {
    this._state = "idle";
    await this._updateBadge();
    // storage очистит stopRecording() после загрузки чанков, иначе рестарт SW потеряет сессию.
  }

  async restoreFromStorage() {
    const active = await this._storage.getActiveSession();
    if (!active) return;

    this._sessionId = active.sessionId;
    this._uploadToken = active.uploadToken ?? null;

    // Вкладку могли закрыть, пока SW спал: onRemoved тогда потерялся.
    const tabId =
      active.tabId !== undefined ? await existingTabId(active.tabId) : (await findCallTab())?.id;
    if (tabId) {
      this._state = "recording";
      this._tabId = tabId;
      await this._updateBadge();
      return;
    }
    this._state = "suspended";
    await this._updateBadge();
    await this._finishOrAskUser();
  }

  private async _updateBadge() {
    const badges: Record<string, { text: string; color: string }> = {
      idle: { text: "", color: "#666" },
      detecting: { text: "?", color: "#FFA500" },
      recording: { text: "REC", color: "#FF0000" },
      suspended: { text: "⏸", color: "#FFA500" },
    };
    const badge = badges[this._state];
    await chrome.action.setBadgeText({ text: badge.text });
    await chrome.action.setBadgeBackgroundColor({ color: badge.color });
    const iconState =
      this._state === "recording"
        ? "recording"
        : this._state === "suspended"
          ? "suspended"
          : "default";
    try {
      await chrome.action.setIcon({
        path: {
          "16": chrome.runtime.getURL(`icons/icon-${iconState}-16.png`),
          "48": chrome.runtime.getURL(`icons/icon-${iconState}-48.png`),
          "128": chrome.runtime.getURL(`icons/icon-${iconState}-128.png`),
        },
      });
    } catch {
      // Иконки могут быть ещё недоступны.
    }
  }
}

async function findCallTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ url: ALL_MATCHES });
  return tabs[0];
}

async function existingTabId(tabId: number): Promise<number | undefined> {
  try {
    return (await chrome.tabs.get(tabId)).id;
  } catch {
    return undefined;
  }
}

const TAB_CLOSE_GRACE_MS = 3_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Фрейм звонка: Телемост держит звонок в /private-join/, а команда без frameId ушла бы
 * и в оболочку, которая сразу закрыла бы сессию пустым финишем. Храним в storage.session:
 * память SW стирается при засыпании.
 */
const CALL_FRAMES_KEY = "callFrames";

async function readCallFrames(): Promise<Record<string, number>> {
  try {
    const stored = await chrome.storage.session.get(CALL_FRAMES_KEY);
    return (stored?.[CALL_FRAMES_KEY] as Record<string, number> | undefined) ?? {};
  } catch {
    return {};
  }
}

export async function rememberCallFrame(sender: chrome.runtime.MessageSender): Promise<void> {
  const tabId = sender.tab?.id;
  if (typeof tabId !== "number" || typeof sender.frameId !== "number") return;
  const frames = await readCallFrames();
  if (frames[tabId] === sender.frameId) return;
  frames[tabId] = sender.frameId;
  await chrome.storage.session.set({ [CALL_FRAMES_KEY]: frames });
  console.log(PREFIX, "call frame for tab", tabId, "is", sender.frameId, sender.url);
}

async function forgetCallFrame(tabId: number): Promise<void> {
  const frames = await readCallFrames();
  if (!(tabId in frames)) return;
  delete frames[tabId];
  await chrome.storage.session.set({ [CALL_FRAMES_KEY]: frames });
}

export async function sendToCallFrame<T = unknown>(tabId: number, message: unknown): Promise<T> {
  const frames = await readCallFrames();
  return chrome.tabs.sendMessage(tabId, message, { frameId: frames[tabId] ?? 0 });
}

const READY_ALARM = "rechiv-transcript-ready";

export async function watchUntilReady(storage: RecordingStorage, sessionId: string): Promise<void> {
  const pending = await storage.getPendingSessions();
  if (!pending.includes(sessionId)) {
    await storage.setPendingSessions([...pending, sessionId]);
  }
  chrome.alarms.create(READY_ALARM, { periodInMinutes: 0.5 });
}

/** Через alarm: service worker засыпает. */
export async function checkPendingSessions(api: SttApiClient): Promise<void> {
  const storage = new RecordingStorage();
  const pending = await storage.getPendingSessions();
  if (pending.length === 0) {
    await chrome.alarms.clear(READY_ALARM);
    return;
  }

  const stillWaiting: string[] = [];
  for (const sessionId of pending) {
    try {
      const session = await api.getSession(sessionId);
      if (session.status === "completed" || session.status === "error") {
        notifyTranscriptReady(session);
      } else {
        stillWaiting.push(sessionId);
      }
    } catch {
      stillWaiting.push(sessionId);
    }
  }

  await storage.setPendingSessions(stillWaiting);
  if (stillWaiting.length === 0) await chrome.alarms.clear(READY_ALARM);
}

function notifyTranscriptReady(session: SessionInfo): void {
  const failed = session.status === "error";
  chrome.notifications.create(`transcript-ready-${session.sessionId}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon-default-128.png"),
    title: failed ? "Транскрипт готов, но с ошибками" : "Транскрипт готов",
    message: failed
      ? (session.error ?? "Часть фрагментов не распозналась")
      : "Нажмите, чтобы открыть",
    requireInteraction: true,
  });
}

let controller: SessionController;

async function bootstrap() {
  const config = await getConfig();
  const api = new SttApiClient(config.sttServiceUrl);
  controller = new SessionController(api);
  void api.isAvailable();
  await controller.restoreFromStorage();
}

// Alarm может разбудить worker раньше bootstrap, поэтому клиент создаём заново.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== READY_ALARM) return;
  void (async () => {
    const config = await getConfig();
    await checkPendingSessions(new SttApiClient(config.sttServiceUrl));
  })();
});

chrome.runtime.onMessage.addListener((msg: ContentMessage, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.action) {
        case "getState":
          sendResponse({ state: controller.state, sessionId: controller.sessionId });
          break;
        case "announcePresence":
          // Важен сам запрос: по нему приложение узнаёт версию расширения.
          await controller.api.isAvailable();
          sendResponse({ ok: true });
          break;
        case "startRecording": {
          const callTab = await findCallTab();
          console.log(PREFIX, "startRecording, callTab:", callTab?.id, callTab?.url);
          const result = await controller.startRecording(msg.callUrl, callTab?.id);
          console.log(PREFIX, "session created:", result.sessionId);
          if (callTab?.id) {
            try {
              await sendToCallFrame(callTab.id, {
                action: "startCapture",
                sessionId: result.sessionId,
                ...(result.uploadToken ? { uploadToken: result.uploadToken } : {}),
              });
              console.log(PREFIX, "startCapture sent to tab", callTab.id);
            } catch (err) {
              console.error(PREFIX, "failed to send startCapture to tab:", err);
            }
          } else {
            console.warn(PREFIX, "no call tab found!");
          }
          sendResponse({ ok: true, sessionId: result.sessionId });
          break;
        }
        case "stopRecording": {
          const stoppedSessionId = controller.sessionId;
          const stopTab = await findCallTab();
          await stopActiveRecording(stopTab?.id);
          sendResponse({ ok: true, sessionId: stoppedSessionId });
          break;
        }
        case "finishRecording":
          await controller.stopRecording();
          sendResponse({ ok: true });
          break;
        case "showLiveTranscript": {
          const callTab = await findCallTab();
          const candidates = [...new Set([controller.tabId, callTab?.id])].filter(
            (id): id is number => typeof id === "number",
          );
          if (candidates.length === 0) {
            throw new Error("Вкладка звонка не найдена");
          }
          let delivered = false;
          for (const tabId of candidates) {
            try {
              await sendToCallFrame(tabId, {
                action: "showLiveOverlay",
                sessionId: msg.sessionId,
              });
              delivered = true;
              break;
            } catch {
              // Слушателя нет — пробуем следующую вкладку.
            }
          }
          if (!delivered) {
            // После обновления расширения content script появится только после
            // перезагрузки вкладки; разрешения scripting нет.
            throw new Error("Обновите страницу созвона (F5) — расширение переустановлено");
          }
          sendResponse({ ok: true });
          break;
        }
        case "getLiveTranscript": {
          const live = await controller.api.getLiveTranscript(msg.sessionId);
          sendResponse({ ok: true, live });
          break;
        }
        case "openTranscript": {
          await chrome.tabs.create({
            url: chrome.runtime.getURL(
              `pages/transcript.html?sessionId=${encodeURIComponent(msg.sessionId)}`,
            ),
          });
          sendResponse({ ok: true });
          break;
        }
        case "continueRecording":
          if (sender.tab?.id) {
            await rememberCallFrame(sender);
            await controller.continueRecording(sender.tab.id);
            sendToCallFrame(sender.tab.id, {
              action: "startCapture",
              sessionId: controller.sessionId,
              ...(controller.uploadToken ? { uploadToken: controller.uploadToken } : {}),
            });
          }
          sendResponse({ ok: true });
          break;
        case "uploadChunk": {
          console.log(
            PREFIX,
            "uploadChunk",
            msg.speakerId,
            "ts:",
            msg.timestamp,
            "dataLen:",
            msg.data?.length,
          );
          try {
            const binary = atob(msg.data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            const blob = new Blob([bytes], { type: "audio/webm" });
            await controller.api.uploadChunk(
              msg.sessionId,
              msg.speakerId,
              msg.timestamp,
              blob,
              msg.attributedTo,
            );
            console.log(PREFIX, "chunk uploaded successfully");
            sendResponse({ ok: true });
          } catch (err: unknown) {
            console.error(PREFIX, "chunk upload failed:", getErrorMessage(err));
            sendResponse({ ok: false, error: getErrorMessage(err) });
          }
          break;
        }
        // Отдельно от финиша: вкладку могут закрыть до загрузки всех чанков.
        case "uploadVadTimeline": {
          try {
            await controller.api.uploadVadTimeline(msg.sessionId, msg.vadTimeline);
            sendResponse({ ok: true });
          } catch (err: unknown) {
            console.error(PREFIX, "VAD timeline upload failed:", getErrorMessage(err));
            sendResponse({ ok: false, error: getErrorMessage(err) });
          }
          break;
        }
        case "doFinishSession": {
          console.log(PREFIX, "doFinishSession, sessionId:", msg.sessionId);
          await controller.stopRecording(msg.vadTimeline);
          sendResponse({ ok: true });
          break;
        }
        case "connectionStateChanged":
          console.log(PREFIX, "connectionStateChanged:", msg.state);
          sendResponse({ ok: true });
          break;
        case "speakerIdentified":
          await controller.api.updateSpeaker(msg.sessionId, msg.speakerId, msg.name);
          sendResponse({ ok: true });
          break;
        // Только удалённый трек: микрофон оболочка открывает и при проверке устройств.
        case "trackAdded":
          if (msg.kind === "remote") await rememberCallFrame(sender);
          sendResponse({ ok: true });
          break;
        case "webrtcDetected":
          await rememberCallFrame(sender);
          controller.onWebrtcDetected(msg.url);
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: true });
      }
    } catch (err: unknown) {
      sendResponse({ ok: false, error: getErrorMessage(err) });
    }
  })();
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void forgetCallFrame(tabId);
  if (controller?.tabId === tabId) void controller.onTabClosed();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (
    controller?.tabId === tabId &&
    controller.state === "recording" &&
    changeInfo.url &&
    !isCallPage(changeInfo.url)
  ) {
    console.log(PREFIX, "call tab navigated away from the call:", changeInfo.url);
    // В SPA content script ещё жив и сам догрузит хвост.
    await stopActiveRecording(tabId);
  }
});

/** Штатная остановка: вкладка догружает хвост и сама присылает doFinishSession. */
async function stopActiveRecording(tabId: number | undefined): Promise<void> {
  let contentScriptAlive = false;
  if (tabId) {
    try {
      await sendToCallFrame(tabId, { action: "stopCapture" });
      contentScriptAlive = true;
    } catch {
      // Вкладка закрыта — финализируем сами.
    }
  }
  if (contentScriptAlive) {
    await controller.markProcessing();
    setTimeout(async () => {
      if (controller.sessionId) {
        console.warn(PREFIX, "doFinishSession timeout, finalizing directly");
        await controller.stopRecording();
      }
    }, 15_000);
  } else {
    await controller.stopRecording();
  }
  console.log(PREFIX, "stop handled, contentScriptAlive:", contentScriptAlive);
}

chrome.notifications.onClicked.addListener(async (notifId) => {
  if (notifId.startsWith("suspended-")) {
    await controller.stopRecording();
    return;
  }
  if (notifId === "webrtc-detected") {
    const tab = await findCallTab();
    if (tab?.id) {
      chrome.tabs.update(tab.id, { active: true });
      if (tab.url && controller.state === "detecting") {
        try {
          const result = await controller.startRecording(tab.url, tab.id);
          console.log(PREFIX, "recording started from notification:", result.sessionId);
          await sendToCallFrame(tab.id, {
            action: "startCapture",
            sessionId: result.sessionId,
            ...(result.uploadToken ? { uploadToken: result.uploadToken } : {}),
          });
        } catch (err) {
          console.error(PREFIX, "failed to start recording from notification:", err);
        }
      }
    }
  } else if (notifId.startsWith("transcript-ready-")) {
    const sid = notifId.replace("transcript-ready-", "");
    chrome.tabs.create({
      url: chrome.runtime.getURL(`pages/transcript.html?sessionId=${sid}`),
    });
  }
});

bootstrap();
