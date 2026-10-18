import { extensionVersionHeaders } from "./extension-version";
import { clearCachedSttToken, ensureSttToken } from "./stt-token";
import type {
  Folder,
  FolderSettings,
  LiveTranscriptResult,
  SessionInfo,
  SummaryResult,
  TranscriptResult,
  VadTimeline,
} from "./types";

export interface HealthResult {
  status: string;
  authRequired?: boolean;
  service?: string;
  engine?: { status: "starting" | "ready" | "error"; error?: string };
  extension?: {
    expectedId: string;
    expectedVersion: string;
    installed: boolean;
    id: string;
    version: string;
    lastSeenAt: string | null;
    outdated: boolean;
  };
}

export interface OnboardingBrowser {
  supported: boolean;
  name: string;
  bundleId: string;
  extensionsUrl: string;
}

export interface OnboardingState {
  /** Пустая строка — расширение не найдено ни в бандле, ни в дереве проекта. */
  extensionDir: string;
  browser: OnboardingBrowser;
  chromiumBrowsers: { name: string; bundleId: string }[];
}

export function resolvePageSttApiBaseUrl(configuredBaseUrl: string, pageProtocol: string): string {
  return pageProtocol === "http:" ? "" : configuredBaseUrl;
}

export function createPageSttApiClient(configuredBaseUrl: string): SttApiClient {
  return new SttApiClient(resolvePageSttApiBaseUrl(configuredBaseUrl, location.protocol));
}

export class SttApiClient {
  private _coreAuthRequired: boolean | null = null;

  constructor(private baseUrl: string) {}

  async isAvailable(): Promise<boolean> {
    try {
      await this.health();
      return true;
    } catch {
      return false;
    }
  }

  async health(): Promise<HealthResult> {
    const response = await fetch(`${this.baseUrl}/health`, { headers: extensionVersionHeaders() });
    if (!response.ok) throw new Error(`GET /health failed: ${response.status}`);
    const result = await response.json();
    this._coreAuthRequired = result.authRequired === true;
    return result;
  }

  async createSession(callUrl: string): Promise<SessionInfo> {
    return this._postCore("/sessions", { callUrl });
  }

  async getSession(sessionId: string): Promise<SessionInfo> {
    return this._getCore(`/sessions/${sessionId}`);
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this._getCore("/sessions");
  }

  async listFolders(): Promise<Folder[]> {
    return this._getCore("/folders");
  }

  async createFolder(name: string): Promise<Folder> {
    return this._postCore("/folders", { name });
  }

  async renameFolder(id: string, name: string): Promise<Folder> {
    return this._folderRequest(`/folders/${encodeURIComponent(id)}`, "PATCH", { name });
  }

  async setFolderSettings(id: string, settings: FolderSettings): Promise<Folder> {
    return this._folderRequest(`/folders/${encodeURIComponent(id)}/settings`, "PUT", settings);
  }

  async previewFolderTitles(id: string): Promise<{ renamed: string[]; manual: string[] }> {
    return this._getCore(`/folders/${encodeURIComponent(id)}/titles`);
  }

  async applyFolderTitles(id: string): Promise<{ renamed: number }> {
    return this._postCore(`/folders/${encodeURIComponent(id)}/titles`, {});
  }

  async previewFolderRetention(id: string, days: number): Promise<{ sessions: string[] }> {
    return this._getCore(`/folders/${encodeURIComponent(id)}/retention?days=${days}`);
  }

  async deleteFolder(id: string): Promise<void> {
    await this._folderRequest(`/folders/${encodeURIComponent(id)}`, "DELETE");
  }

  async addFolderRule(id: string, url: string): Promise<{ folder: Folder; matching: string[] }> {
    return this._postCore(`/folders/${encodeURIComponent(id)}/rules`, { url });
  }

  async deleteFolderRule(id: string, url: string): Promise<void> {
    await this._folderRequest(
      `/folders/${encodeURIComponent(id)}/rules?url=${encodeURIComponent(url)}`,
      "DELETE",
    );
  }

  async moveSession(id: string, folderId: string): Promise<SessionInfo> {
    return this._folderRequest(`/sessions/${encodeURIComponent(id)}/folder`, "PUT", { folderId });
  }

  async moveFolderSessions(id: string, sessionIds: string[], byRule: boolean): Promise<void> {
    await this._folderRequest(`/folders/${encodeURIComponent(id)}/sessions`, "POST", {
      sessionIds,
      byRule,
    });
  }

  private async _folderRequest<T>(path: string, method: string, body?: unknown): Promise<T> {
    const response = await this._fetchCore(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status}`);
    return response.status === 204 ? (undefined as T) : response.json();
  }

  async uploadChunk(
    sessionId: string,
    speakerId: string,
    timestamp: number,
    audioBlob: Blob,
    attributedTo?: string,
  ): Promise<{ status: string; chunkIndex: number }> {
    const form = new FormData();
    form.append("speakerId", speakerId);
    form.append("timestamp", String(timestamp));
    if (attributedTo) form.append("attributedTo", attributedTo);
    form.append("file", audioBlob, `${speakerId}.webm`);
    const resp = await this._fetchCore(`/sessions/${sessionId}/chunks`, {
      method: "POST",
      body: form,
    });
    // 503 временный: вызывающая сторона повторит загрузку.
    if (resp.status === 503) throw new Error("Локальный сервис перегружен, повторю позже");
    if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
    return resp.json();
  }

  async updateSpeaker(sessionId: string, speakerId: string, name: string): Promise<void> {
    await this._postCore(`/sessions/${sessionId}/speakers`, { speakerId, name });
  }

  async updateTitle(sessionId: string, title: string): Promise<void> {
    const resp = await this._fetchCore(`/sessions/${sessionId}/title`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!resp.ok) throw new Error(`PUT /sessions/${sessionId}/title failed: ${resp.status}`);
  }

  async finishSession(sessionId: string): Promise<{ status: string }> {
    return this._postCore(`/sessions/${sessionId}/finish`);
  }

  async uploadVadTimeline(sessionId: string, timeline: VadTimeline): Promise<void> {
    await this._postCore(`/sessions/${sessionId}/vad`, timeline);
  }

  async getTranscript(sessionId: string): Promise<TranscriptResult> {
    return this._getCore(`/sessions/${sessionId}/transcript`);
  }

  async getLiveTranscript(sessionId: string): Promise<LiveTranscriptResult> {
    return this._getCore(`/sessions/${sessionId}/live`);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const resp = await this._fetchCore(`/sessions/${sessionId}`, { method: "DELETE" });
    if (!resp.ok) throw new Error(`DELETE /sessions/${sessionId} failed: ${resp.status}`);
  }

  async getSummary(sessionId: string): Promise<SummaryResult | null> {
    const resp = await this._fetchCore(`/sessions/${sessionId}/summary`, { method: "GET" });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`GET /sessions/${sessionId}/summary failed: ${resp.status}`);
    return resp.json();
  }

  async putSummary(sessionId: string, summary: SummaryResult): Promise<void> {
    const resp = await this._fetchCore(`/sessions/${sessionId}/summary`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(summary),
    });
    if (!resp.ok) throw new Error(`PUT /sessions/${sessionId}/summary failed: ${resp.status}`);
  }

  async getOnboardingState(): Promise<OnboardingState> {
    return this._getCore("/onboarding/state");
  }

  async openExtensionsPage(bundleId?: string): Promise<void> {
    await this._onboardingAction(
      "/onboarding/open-extensions",
      bundleId ? { bundleId } : undefined,
    );
  }

  async revealExtensionDir(): Promise<void> {
    await this._onboardingAction("/onboarding/reveal");
  }

  // Отказ онбординга видит пользователь: нужен текст, а не код ответа.
  private async _onboardingAction(path: string, body?: unknown): Promise<void> {
    const resp = await this._fetchCore(path, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (resp.ok) return;
    const detail = await resp
      .json()
      .then((payload) => (payload as { detail?: string }).detail)
      .catch(() => undefined);
    throw new Error(detail ?? `POST ${path} failed: ${resp.status}`);
  }

  private async _fetchCore(path: string, init: RequestInit): Promise<Response> {
    const versionedInit = {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        ...extensionVersionHeaders(),
      },
    };
    const requestInit =
      init.method === "GET" ? { ...versionedInit, cache: init.cache ?? "no-store" } : versionedInit;
    if (this._coreAuthRequired !== true) {
      const response = await fetch(`${this.baseUrl}${path}`, requestInit);
      if (response.status !== 401) return response;
      this._coreAuthRequired = true;
    }

    const withToken = (token: string): RequestInit => ({
      ...requestInit,
      headers: {
        ...(requestInit.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${token}`,
      },
    });
    let token = await ensureSttToken(this.baseUrl);
    let response = await fetch(`${this.baseUrl}${path}`, withToken(token));
    if (response.status === 401) {
      await clearCachedSttToken();
      token = await ensureSttToken(this.baseUrl);
      response = await fetch(`${this.baseUrl}${path}`, withToken(token));
    }
    return response;
  }

  private async _getCore<T>(path: string): Promise<T> {
    const resp = await this._fetchCore(path, { method: "GET" });
    if (!resp.ok) throw new Error(`GET ${path} failed: ${resp.status}`);
    return resp.json();
  }

  private async _postCore<T>(path: string, body?: unknown): Promise<T> {
    const resp = await this._fetchCore(path, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!resp.ok) throw new Error(`POST ${path} failed: ${resp.status}`);
    try {
      return await resp.json();
    } catch {
      return undefined as T;
    }
  }
}
