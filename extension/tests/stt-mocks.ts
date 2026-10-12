import { SttApiClient } from "../src/shared/api-client";
import type { SessionInfo } from "../src/shared/types";

export function mockSession(partial: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: "abc123",
    status: "recording",
    callUrl: "https://stream.wb.ru/room/test",
    createdAt: "2026-03-31T10:00:00",
    finishedAt: null,
    participants: [],
    chunksCount: 0,
    ...partial,
  };
}

export function mockSttApi(
  overrides: Partial<Pick<SttApiClient, keyof SttApiClient>>,
): SttApiClient {
  return Object.assign(new SttApiClient("http://localhost:9876"), overrides);
}
