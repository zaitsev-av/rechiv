import {
  type CallCommand,
  type CallPresence,
  type HealthResult,
  SttApiClient,
} from "../shared/api-client";
import { syncDesktopAppearance } from "../shared/appearance";
import { DESKTOP_URL } from "../shared/config";
import type { ContentMessage } from "../shared/messages";
import { ALL_MATCHES, isCallPage, platformForUrl } from "../shared/platform";
import { RecordingStorage } from "../shared/storage";
import type { RecordingState, SessionInfo, VadTimeline } from "../shared/types";
import { getErrorMessage } from "../shared/utils";
import { CallChannel } from "./call-channel";

const PREFIX = "[Rechiv:sw]";

export class SessionController {
  private _state: RecordingState = "idle";
  private _sessionId: string | null = null;
  private _uploadToken: string | null = null;
  private _tabId: number | null = null;
  private _storage = new RecordingStorage();
  /** Канал с desktop узнаёт о смене состояния сразу, а не при следующем опросе. */
  onStateChange?: () => void;

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
    return {
      sessionId: session.sessionId,
      ...(session.uploadToken ? { uploadToken: session.uploadToken } : {}),
      ...(session.livePanel ? { livePanel: true } : {}),
    };
  }

  /** Захват во вкладке не начался: пустую сессию не оставляем висеть в записи. */
  async abandonRecording() {
    const sessionId = this._sessionId;
    this._state = "idle";
    this._sessionId = null;
    this._uploadToken = null;
    this._tabId = null;
    await this._storage.clearActiveSession();
    await this._updateBadge();
    if (!sessionId) return;
    try {
      await this._api.deleteSession(sessionId);
    } catch (err) {
      console.error(PREFIX, "could not delete abandoned session:", err);
    }
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
    this.onStateChange?.();
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

const JOINED_TABS_KEY = "joinedTabs";

/** Вход привязан к встрече: другая ссылка в той же вкладке — новый созвон, параметры не важны. */
function meetingKey(url: string): string {
  try {
    const { origin, pathname } = new URL(url);
    return origin + pathname;
  } catch {
    return url;
  }
}

async function readJoined(): Promise<Record<number, string>> {
  try {
    const stored = await chrome.storage.session.get(JOINED_TABS_KEY);
    return (stored?.[JOINED_TABS_KEY] as Record<number, string> | undefined) ?? {};
  } catch {
    return {};
  }
}

async function markJoined(tabId: number, url: string): Promise<void> {
  const joined = await readJoined();
  const key = meetingKey(url);
  if (joined[tabId] === key) return;
  await chrome.storage.session.set({ [JOINED_TABS_KEY]: { ...joined, [tabId]: key } });
}

async function forgetJoined(tabId: number): Promise<void> {
  const joined = await readJoined();
  if (!(tabId in joined)) return;
  delete joined[tabId];
  await chrome.storage.session.set({ [JOINED_TABS_KEY]: joined });
}

async function forgetCallFrame(tabId: number): Promise<void> {
  await forgetJoined(tabId);
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

let pendingCheck: Promise<void> | undefined;

/** Через alarm: service worker засыпает. */
export async function checkPendingSessions(api: SttApiClient): Promise<void> {
  if (pendingCheck) return pendingCheck;
  pendingCheck = processPendingSessions(api);
  try {
    await pendingCheck;
  } finally {
    pendingCheck = undefined;
  }
}

async function processPendingSessions(api: SttApiClient): Promise<void> {
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
      // Саммари и тему делает desktop; уведомляем, когда он закончит.
      if (
        (session.status === "completed" && !session.autoProcessing?.pending) ||
        session.status === "error"
      ) {
        const current = await storage.getPendingSessions();
        await storage.setPendingSessions(current.filter((id) => id !== sessionId));
        notifyTranscriptReady(session);
      } else {
        stillWaiting.push(sessionId);
      }
    } catch {
      stillWaiting.push(sessionId);
    }
  }

  const added = (await storage.getPendingSessions()).filter((id) => !pending.includes(id));
  stillWaiting.push(...added);
  await storage.setPendingSessions(stillWaiting);
  if (stillWaiting.length === 0) await chrome.alarms.clear(READY_ALARM);
}

function notifyTranscriptReady(session: SessionInfo): void {
  const failed = session.status === "error";
  const result = session.autoProcessing ?? {};
  chrome.notifications.create(`transcript-ready-${session.sessionId}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon-default-128.png"),
    title: failed
      ? "Транскрипт готов, но с ошибками"
      : result.summaryReady
        ? "Транскрипт и саммари готовы"
        : "Транскрипт готов",
    message: failed
      ? (session.error ?? "Часть фрагментов не распозналась")
      : result.summaryFailed
        ? "Саммари не получилось. Его можно сделать вручную на странице транскрипта."
        : result.topicFailed
          ? "Не удалось определить тему созвона. Нажмите, чтобы открыть."
          : "Нажмите, чтобы открыть",
    requireInteraction: true,
  });
}

let controller: SessionController;

async function bootstrap() {
  const api = new SttApiClient(DESKTOP_URL);
  controller = new SessionController(api);
  controller.onStateChange = () => callChannel.refresh();
  void api.isAvailable();
  void syncDesktopAppearance();
  await controller.restoreFromStorage();
  void callChannel.ensure();
}

// Alarm может разбудить worker раньше bootstrap, поэтому клиент создаём заново.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== READY_ALARM) return;
  void (async () => {
    await checkPendingSessions(new SttApiClient(DESKTOP_URL));
  })();
});

chrome.runtime.onMessage.addListener((msg: ContentMessage, sender, sendResponse) => {
  (async () => {
    try {
      await booted;
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
          const result = await startRecordingInTab(msg.callUrl, await findCallTab());
          sendResponse({ ok: true, sessionId: result.sessionId });
          break;
        }
        case "keepAlive":
          void callChannel.ensure();
          sendResponse({ ok: true });
          break;
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
        case "showLiveTranscript":
          await showLiveOverlay(msg.sessionId);
          sendResponse({ ok: true });
          break;
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
          if (msg.kind === "remote") {
            await rememberCallFrame(sender);
            if (typeof sender.tab?.id === "number" && sender.tab.url) {
              await markJoined(sender.tab.id, sender.tab.url);
            }
            callChannel.refresh();
          }
          sendResponse({ ok: true });
          break;
        case "webrtcDetected":
          await rememberCallFrame(sender);
          controller.onWebrtcDetected(msg.url);
          callChannel.refresh();
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
  void forgetCallFrame(tabId).then(() => {
    if (callChannel.running) callChannel.refresh();
  });
  if (controller?.tabId === tabId) void controller.onTabClosed();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.url && callChannel.running) callChannel.refresh();
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

async function startRecordingInTab(
  callUrl: string,
  callTab: chrome.tabs.Tab | undefined,
): Promise<{ sessionId: string; uploadToken?: string }> {
  console.log(PREFIX, "startRecording, callTab:", callTab?.id, callTab?.url);
  const { livePanel, ...result } = await controller.startRecording(callUrl, callTab?.id);
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
      // После обновления расширения старый скрипт во вкладке отрезан, а разрешения scripting нет.
      await controller.abandonRecording();
      throw new Error("Обновите страницу созвона (F5) — расширение обновилось");
    }
  } else {
    console.warn(PREFIX, "no call tab found!");
  }
  if (livePanel) {
    try {
      await showLiveOverlay(result.sessionId);
    } catch (err) {
      console.warn(PREFIX, "live panel from folder setting failed:", err);
    }
  }
  return result;
}

async function showLiveOverlay(sessionId: string): Promise<void> {
  const callTab = await findCallTab();
  const candidates = [...new Set([controller.tabId, callTab?.id])].filter(
    (id): id is number => typeof id === "number",
  );
  if (candidates.length === 0) {
    throw new Error("Вкладка звонка не найдена");
  }
  for (const tabId of candidates) {
    try {
      // Панель — в основной странице: кадр звонка (у Телемоста — iframe) может быть не тем, что видно.
      await chrome.tabs.sendMessage(
        tabId,
        { action: "showLiveOverlay", sessionId },
        { frameId: 0 },
      );
      return;
    } catch {
      // Слушателя нет — пробуем следующую вкладку.
    }
  }
  // После обновления расширения content script появится только после
  // перезагрузки вкладки; разрешения scripting нет.
  throw new Error("Обновите страницу созвона (F5) — расширение переустановлено");
}

/** Вкладка, о которой знает канал: записываемая или та, где замечен звонок. */
async function currentCallTab(): Promise<chrome.tabs.Tab | undefined> {
  if (controller.tabId !== null) {
    try {
      return await chrome.tabs.get(controller.tabId);
    } catch {
      // Вкладку закрыли — ищем среди замеченных.
    }
  }
  for (const id of Object.keys(await readCallFrames())) {
    try {
      const tab = await chrome.tabs.get(Number(id));
      if (tab.url && isCallPage(tab.url)) return tab;
    } catch {
      // Закрытую вкладку забудет onRemoved.
    }
  }
  return undefined;
}

export async function describeCall(): Promise<CallPresence | null> {
  await booted;
  const tab = await currentCallTab();
  if (!tab?.url) return null;
  const recording = controller.state === "recording" || controller.state === "suspended";
  // markProcessing уже сбросил состояние, но сессия ещё ждёт хвост от вкладки.
  const stopping = !recording && controller.sessionId !== null;
  const joined = typeof tab.id === "number" && (await readJoined())[tab.id] === meetingKey(tab.url);
  return {
    platform: platformForUrl(tab.url)?.name ?? "",
    url: tab.url,
    title: tab.title ?? "",
    recording,
    ...(joined ? { joined } : {}),
    ...(stopping ? { stopping } : {}),
    ...((recording || stopping) && controller.sessionId ? { sessionId: controller.sessionId } : {}),
  };
}

export async function handleCallCommand(command: CallCommand, auto = false): Promise<void> {
  await booted;
  console.log(PREFIX, "command from desktop:", command, auto ? "(auto)" : "");
  if (command === "live") {
    if (controller.sessionId) await showLiveOverlay(controller.sessionId);
    return;
  }
  if (command === "stop") {
    if (controller.state === "recording" || controller.state === "suspended") {
      await stopActiveRecording(controller.tabId ?? undefined);
    }
    return;
  }
  if (controller.state === "recording" || controller.state === "suspended") return;
  const tab = await currentCallTab();
  if (!tab?.url) return;
  try {
    await startRecordingInTab(tab.url, tab);
    if (auto) {
      chrome.notifications.create("auto-recording", {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon-recording-128.png"),
        title: "Запись началась автоматически",
        message: "Так настроена папка этого созвона. Остановить — в попапе или в трее.",
      });
    }
  } catch (err) {
    chrome.notifications.create("tray-start-failed", {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-default-128.png"),
      title: "Не удалось начать запись",
      message: getErrorMessage(err),
    });
    throw err;
  }
}

const callChannel = new CallChannel({
  api: () => controller.api,
  describe: describeCall,
  onCommand: handleCallCommand,
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
  await booted;
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

// Сообщение, разбудившее worker, приходит раньше, чем bootstrap создаст controller.
const booted = bootstrap();
