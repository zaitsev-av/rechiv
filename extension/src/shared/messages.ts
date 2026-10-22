import type { LiveTranscriptResult, RecordingState, VadTimeline } from "./types";

export type InterceptorMessage =
  | { type: "RECHIV_TRACK_ADDED"; streamId: string; kind: "local" | "remote" }
  | { type: "RECHIV_TRACK_ENDED"; streamId: string }
  | { type: "RECHIV_CONNECTION_STATE"; state: RTCPeerConnectionState }
  | { type: "RECHIV_WEBRTC_DETECTED" }
  | {
      type: "RECHIV_CHUNK";
      speakerId: string;
      data: string;
      timestamp: number;
      attribution?: { participantId: string; name: string };
    }
  | { type: "RECHIV_CAPTURE_STOPPED"; vadTimeline?: VadTimeline }
  | { type: "RECHIV_VAD_TIMELINE"; vadTimeline: VadTimeline }
  | { type: "RECHIV_SPEAKER_MAP"; map: Record<string, string> }
  | { type: "RECHIV_START_CAPTURE"; sessionId: string; uploadToken?: string }
  | { type: "RECHIV_STOP_CAPTURE" };

export type ContentMessage =
  | { action: "trackAdded"; streamId: string; kind: "local" | "remote" }
  | { action: "trackEnded"; streamId: string }
  | { action: "connectionStateChanged"; state: string }
  | { action: "webrtcDetected"; url: string }
  | { action: "speakerIdentified"; sessionId: string; speakerId: string; name: string }
  | { action: "chunkReady"; speakerId: string; chunkIndex: number; timestamp: number }
  | { action: "getState" }
  | { action: "announcePresence" }
  | { action: "keepAlive" }
  | { action: "startRecording"; callUrl: string }
  | { action: "stopRecording" }
  | { action: "continueRecording" }
  | { action: "finishRecording" }
  | { action: "showLiveTranscript"; sessionId: string }
  | { action: "getLiveTranscript"; sessionId: string }
  | { action: "openTranscript"; sessionId: string }
  | {
      action: "uploadChunk";
      sessionId: string;
      speakerId: string;
      timestamp: number;
      data: string;
      attributedTo?: string;
    }
  | { action: "uploadVadTimeline"; sessionId: string; vadTimeline: VadTimeline }
  | { action: "doFinishSession"; sessionId: string; vadTimeline?: VadTimeline };

export type ServiceWorkerResponse =
  | { state: RecordingState; sessionId: string | null; error?: string }
  | { ok: true; sessionId?: string; uploadToken?: string }
  | { ok: true; live: LiveTranscriptResult }
  | { ok: false; error: string };
