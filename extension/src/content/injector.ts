// Isolated world: мост между interceptor (main world) и service worker.

import { getConfig } from "@shared/config";
import type { InterceptorMessage } from "@shared/messages";
import { RecordingStorage } from "@shared/storage";
import type { VadTimeline } from "@shared/types";
import { retry } from "@shared/utils";
import { domParser } from "./dom-parser";
import { showLiveTranscriptOverlay } from "./live-overlay";
import { capabilitiesForHost } from "./platforms/registry";

let storage: RecordingStorage;
let currentSessionId: string | null = null;
let currentUploadToken: string | null = null;
let domPollInterval: ReturnType<typeof setInterval> | null = null;
const knownStreams = new Set<string>();

// Надёжные привязки адаптера имеют приоритет над догадками DOM.
const adapterMappedStreams = new Set<string>();
const identifiedNames = new Map<string, string>();
let pendingVadTimeline: VadTimeline | undefined;
let captureStopAcknowledged = false;

const PREFIX = "[Rechiv:injector]";

const remoteStreamIsPerson = capabilitiesForHost(location.host).audio === "per-participant";

async function init() {
  const config = await getConfig();
  console.log(PREFIX, "init, sttServiceUrl:", config.sttServiceUrl);
  storage = new RecordingStorage();

  window.addEventListener("message", handleInterceptorMessage);
  chrome.runtime.onMessage.addListener(handleServiceWorkerMessage);
}

function handleInterceptorMessage(event: MessageEvent) {
  if (event.source !== window) return;
  const msg = event.data as InterceptorMessage;
  if (!msg?.type?.startsWith("RECHIV_")) return;

  switch (msg.type) {
    case "RECHIV_WEBRTC_DETECTED":
      chrome.runtime.sendMessage({
        action: "webrtcDetected",
        url: location.href,
      });
      break;

    case "RECHIV_TRACK_ADDED":
      knownStreams.add(msg.streamId);
      chrome.runtime.sendMessage({
        action: "trackAdded",
        streamId: msg.streamId,
        kind: msg.kind,
      });
      break;

    case "RECHIV_TRACK_ENDED":
      chrome.runtime.sendMessage({
        action: "trackEnded",
        streamId: msg.streamId,
      });
      break;

    case "RECHIV_CONNECTION_STATE":
      chrome.runtime.sendMessage({
        action: "connectionStateChanged",
        state: msg.state,
      });
      break;

    case "RECHIV_SPEAKER_MAP":
      handleSpeakerMap(msg.map);
      break;

    case "RECHIV_CHUNK":
      handleChunk(msg.speakerId, msg.data, msg.timestamp, msg.attribution);
      break;

    case "RECHIV_VAD_TIMELINE":
      if (currentSessionId) sendVadTimeline(currentSessionId, msg.vadTimeline);
      break;

    case "RECHIV_CAPTURE_STOPPED":
      pendingVadTimeline = msg.vadTimeline;
      captureStopAcknowledged = true;

      if (msg.vadTimeline && currentSessionId) sendVadTimeline(currentSessionId, msg.vadTimeline);
      break;
  }
}

let pendingUploads = 0;
let waitingForFinish = false;

function sendVadTimeline(sessionId: string, vadTimeline: VadTimeline): void {
  void chrome.runtime
    .sendMessage({ action: "uploadVadTimeline", sessionId, vadTimeline })
    .catch((err: unknown) => {
      console.warn(PREFIX, "early VAD timeline upload failed:", err);
    });
}

async function handleChunk(
  speakerId: string,
  base64Data: string,
  timestamp: number,
  attribution?: { participantId: string; name: string },
) {
  console.log(PREFIX, "handleChunk", speakerId, "ts:", timestamp, "dataLen:", base64Data.length);
  if (!currentSessionId) {
    console.warn(PREFIX, "no currentSessionId, dropping chunk");
    return;
  }
  const sessionId = currentSessionId;

  // Раньше фрагмента, иначе демон покажет «Спикер N».
  if (attribution) sendSpeakerName(sessionId, attribution.participantId, attribution.name);

  pendingUploads++;
  try {
    await retry(
      async () => {
        const resp = await chrome.runtime.sendMessage({
          action: "uploadChunk",
          sessionId,
          speakerId,
          timestamp,
          data: base64Data,
          ...(attribution ? { attributedTo: attribution.participantId } : {}),
        });
        if (resp && !resp.ok) throw new Error(resp.error ?? "upload failed");
        return resp;
      },
      // 503 — очередь распознавания занята; буфер сбросится только на следующей записи.
      { attempts: 5, delays: [1000, 3000, 8000, 15000] },
    );
    console.log(PREFIX, "chunk uploaded OK");
  } catch (err) {
    console.error(PREFIX, "Upload failed after retries, buffering:", err);
    await storage.addToChunkBuffer({
      sessionId,
      speakerId,
      timestamp,
      data: base64Data,
    });
  } finally {
    pendingUploads--;
    checkAllUploaded();
  }
}

function checkAllUploaded() {
  if (waitingForFinish && captureStopAcknowledged && pendingUploads === 0) {
    console.log(PREFIX, "all chunks uploaded, sending finishSession");
    waitingForFinish = false;
    sendFinishSession();
  }
}

function sendFinishSession() {
  chrome.runtime.sendMessage({
    action: "doFinishSession",
    sessionId: currentSessionId,
    ...(pendingVadTimeline ? { vadTimeline: pendingVadTimeline } : {}),
  });
  pendingVadTimeline = undefined;
  currentSessionId = null;
  currentUploadToken = null;
}

type ServiceWorkerCommand =
  | { action: "startCapture"; sessionId: string; uploadToken?: string }
  | { action: "stopCapture" }
  | { action: "flushCapture" }
  | { action: "showLiveOverlay"; sessionId: string };

function handleServiceWorkerMessage(
  msg: ServiceWorkerCommand,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (resp: { ok: boolean }) => void,
) {
  console.log(PREFIX, "received from SW:", msg);

  switch (msg.action) {
    case "startCapture":
      startCapture(msg.sessionId, msg.uploadToken);
      sendResponse({ ok: true });
      break;
    case "stopCapture":
      stopCapture();
      sendResponse({ ok: true });
      break;
    case "flushCapture":
      flushCapture();
      sendResponse({ ok: true });
      break;
    case "showLiveOverlay":
      showLiveTranscriptOverlay(msg.sessionId);
      sendResponse({ ok: true });
      break;
  }

  return true;
}

async function startCapture(sessionId: string, uploadToken?: string) {
  console.log(PREFIX, "startCapture", sessionId);

  currentSessionId = sessionId;
  currentUploadToken = uploadToken ?? null;
  pendingVadTimeline = undefined;
  captureStopAcknowledged = false;
  adapterMappedStreams.clear();
  identifiedNames.clear();

  const config = await getConfig();
  window.postMessage(
    {
      type: "RECHIV_START_CAPTURE",
      sessionId,
      uploadToken: currentUploadToken ?? undefined,
      sttServiceUrl: config.sttServiceUrl,
    },
    location.origin,
  );

  domPollInterval = setInterval(() => pollDomForNames(sessionId), 5000);

  flushChunkBuffer(sessionId);
}

function flushCapture() {
  console.log(PREFIX, "flushCapture, sessionId:", currentSessionId);
  window.postMessage({ type: "RECHIV_STOP_CAPTURE" }, location.origin);
  if (domPollInterval) {
    clearInterval(domPollInterval);
    domPollInterval = null;
  }
}

function stopCapture() {
  console.log(PREFIX, "stopCapture, keeping sessionId:", currentSessionId);
  flushCapture();
  waitingForFinish = true;
  setTimeout(() => {
    if (waitingForFinish) {
      console.warn(PREFIX, "finish timeout, pending:", pendingUploads);
      waitingForFinish = false;
      sendFinishSession();
    }
  }, 10_000);
}

async function flushChunkBuffer(sessionId: string) {
  const buffer = await storage.getChunkBuffer();
  if (buffer.length === 0) return;
  const matching = buffer.filter((chunk) => chunk.sessionId === sessionId);
  if (matching.length === 0) return;
  console.log(PREFIX, "flushing chunk buffer:", matching.length, "chunks");

  const uploaded = new Set<number>();
  for (let i = 0; i < matching.length; i++) {
    const chunk = matching[i];
    try {
      const response = await chrome.runtime.sendMessage({
        action: "uploadChunk",
        sessionId,
        speakerId: chunk.speakerId,
        timestamp: chunk.timestamp,
        data: chunk.data,
      });
      if (response && !response.ok) return;
      uploaded.add(i);
    } catch {
      return;
    }
  }
  let matchingIndex = 0;
  const remaining = buffer.filter((chunk) => {
    if (chunk.sessionId !== sessionId) return true;
    const keep = !uploaded.has(matchingIndex);
    matchingIndex++;
    return keep;
  });
  await storage.setChunkBuffer(remaining);
}

function handleSpeakerMap(map: Record<string, string>) {
  if (!currentSessionId) return;
  console.log(PREFIX, "Adapter speaker map:", map);
  for (const [streamId, name] of Object.entries(map)) {
    adapterMappedStreams.add(streamId);
    sendSpeakerName(currentSessionId, streamId, name);
  }
}

function sendSpeakerName(sessionId: string, speakerId: string, name: string) {
  const normalizedName = name.replace(/\s+/g, " ").trim();
  if (!normalizedName || identifiedNames.get(speakerId) === normalizedName) return;
  identifiedNames.set(speakerId, normalizedName);
  void chrome.runtime
    .sendMessage({
      action: "speakerIdentified",
      sessionId,
      speakerId,
      name: normalizedName,
    })
    .then((response) => {
      if (!response?.ok) {
        console.warn(PREFIX, "speakerIdentified failed:", response?.error);
        if (identifiedNames.get(speakerId) === normalizedName) {
          identifiedNames.delete(speakerId);
        }
      }
    })
    .catch((err) => {
      console.warn(PREFIX, "speakerIdentified failed:", err);
      if (identifiedNames.get(speakerId) === normalizedName) {
        identifiedNames.delete(speakerId);
      }
    });
}

function pollDomForNames(sessionId: string) {
  let unmappedStreams = [...knownStreams].filter((id) => !adapterMappedStreams.has(id));

  if (!remoteStreamIsPerson) {
    unmappedStreams = unmappedStreams.filter((id) => id === "local");
  }

  if (unmappedStreams.length === 0) return;

  const matchedStreams = new Set<string>();
  const matchedNames = new Set<string>();

  // srcObject есть только при включённой камере.
  for (const streamId of unmappedStreams) {
    const name = domParser.findParticipantName(streamId);
    if (name) {
      matchedStreams.add(streamId);
      matchedNames.add(name);
      sendSpeakerName(sessionId, streamId, name);
    }
  }

  const remainingStreams = unmappedStreams.filter((id) => !matchedStreams.has(id));
  if (remainingStreams.length > 0) {
    const allNames = domParser.getAllParticipantNames().filter((name) => !matchedNames.has(name));
    const hasLocal = remainingStreams.includes("local");
    const remoteIds = remainingStreams.filter((id) => id !== "local");

    const pending: string[] = [];
    if (hasLocal) {
      const explicitLocalName = domParser.getLocalParticipantName();
      if (explicitLocalName) {
        sendSpeakerName(sessionId, "local", explicitLocalName);
        const localNameIndex = allNames.indexOf(explicitLocalName);
        if (localNameIndex !== -1) allNames.splice(localNameIndex, 1);
      } else {
        pending.push("local");
      }
    }
    pending.push(...remoteIds);

    // Порядок плиток не связан с порядком потоков: имя — только при единственном варианте.
    if (pending.length === 1 && allNames.length === 1) {
      sendSpeakerName(sessionId, pending[0], allNames[0]);
    }
  }
}

init();
