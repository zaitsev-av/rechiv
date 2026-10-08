export interface ActiveSession {
  sessionId: string;
  callUrl: string;
  uploadToken?: string;
  tabId?: number;
}

export interface BufferedChunk {
  sessionId: string;
  speakerId: string;
  timestamp: number;
  data: string;
}

export class RecordingStorage {
  async getActiveSession(): Promise<ActiveSession | null> {
    const result = await chrome.storage.local.get("activeSession");
    return result.activeSession ?? null;
  }

  async setActiveSession(
    sessionId: string,
    callUrl: string,
    uploadToken?: string,
    tabId?: number,
  ): Promise<void> {
    const activeSession: ActiveSession = { sessionId, callUrl };
    if (uploadToken) activeSession.uploadToken = uploadToken;
    if (typeof tabId === "number") activeSession.tabId = tabId;
    await chrome.storage.local.set({ activeSession });
  }

  async clearActiveSession(): Promise<void> {
    await chrome.storage.local.remove("activeSession");
  }

  async getChunkBuffer(): Promise<BufferedChunk[]> {
    const result = await chrome.storage.local.get("chunkBuffer");
    const buffer = (result.chunkBuffer ?? []) as Array<Partial<BufferedChunk>>;
    return buffer.filter((chunk): chunk is BufferedChunk => typeof chunk.sessionId === "string");
  }

  async addToChunkBuffer(chunk: BufferedChunk): Promise<void> {
    const buffer = await this.getChunkBuffer();
    buffer.push(chunk);
    await chrome.storage.local.set({ chunkBuffer: buffer });
  }

  async setChunkBuffer(buffer: BufferedChunk[]): Promise<void> {
    await chrome.storage.local.set({ chunkBuffer: buffer });
  }

  async clearChunkBuffer(): Promise<void> {
    await chrome.storage.local.remove("chunkBuffer");
  }

  async getPendingSessions(): Promise<string[]> {
    const result = await chrome.storage.local.get("pendingSessions");
    const pending = result.pendingSessions;
    return Array.isArray(pending) ? pending.filter((id) => typeof id === "string") : [];
  }

  async setPendingSessions(sessionIds: string[]): Promise<void> {
    await chrome.storage.local.set({ pendingSessions: sessionIds });
  }
}
