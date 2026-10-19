import type { SttApiClient } from "../shared/api-client";
import { getConfig, isLlmConfigured } from "../shared/config";
import { generateConfiguredSummary, generateTopic, prepareLlmConfig } from "../shared/llm-client";
import type { SessionInfo, SummaryResult, TranscriptResult } from "../shared/types";

export interface AutoProcessingResult {
  summaryReady?: boolean;
  summaryFailed?: boolean;
  topicFailed?: boolean;
}

export function autoProcessingKey(sessionId: string): string {
  return `autoProcessing:${sessionId}`;
}

export async function processCompletedSession(
  api: SttApiClient,
  session: SessionInfo,
): Promise<AutoProcessingResult> {
  if (session.status !== "completed" || !session.folderId) return {};
  const key = autoProcessingKey(session.sessionId);
  const stored = await chrome.storage.local.get(key);
  // После остановки worker продолжаем только уведомление, без повторного запроса к LLM.
  if (stored[key]) return stored[key] as AutoProcessingResult;
  const result: AutoProcessingResult = {};
  await chrome.storage.local.set({ [key]: result });
  const config = await getConfig();
  if (!isLlmConfigured(config)) return result;
  const folder = (await api.listFolders()).find((folder) => folder.id === session.folderId);
  if (!folder) return result;
  const autoSummary = !!folder.settings?.autoSummary;
  const needsTopic = !!(
    folder.settings?.titleTemplate?.includes("{topic}") &&
    session.titleAuto &&
    !session.topic?.trim()
  );
  if (!autoSummary && !needsTopic) return result;
  result.summaryFailed = autoSummary;
  result.topicFailed = needsTopic;
  const saveProgress = () => chrome.storage.local.set({ [key]: { ...result } });
  await saveProgress();
  let summary: SummaryResult | null = null;
  let transcript: TranscriptResult | undefined;
  const getTranscript = async () => (transcript ??= await api.getTranscript(session.sessionId));
  try {
    summary = await api.getSummary(session.sessionId);
    if (autoSummary && !summary) {
      const generated = await generateConfiguredSummary(await getTranscript(), config);
      await api.putSummary(session.sessionId, generated, true);
      // За время генерации пользователь мог сохранить свою версию.
      summary = await api.getSummary(session.sessionId);
      if (!summary) throw new Error("Саммари не сохранилось");
    }
    result.summaryReady = autoSummary && !!summary;
    result.summaryFailed = false;
  } catch (error) {
    console.error("[Rechiv:sw] Не удалось подготовить саммари:", error);
  }
  await saveProgress();
  if (needsTopic) {
    try {
      const source = summary?.content ?? JSON.stringify(await getTranscript());
      const topic = await generateTopic(source, await prepareLlmConfig(config));
      const latest = await api.getSession(session.sessionId);
      if (latest.titleAuto && !latest.topic?.trim() && latest.folderId === session.folderId) {
        await api.putTopic(session.sessionId, topic);
      }
      result.topicFailed = false;
    } catch (error) {
      console.error("[Rechiv:sw] Не удалось определить тему:", error);
    }
  }
  await saveProgress();
  return result;
}
