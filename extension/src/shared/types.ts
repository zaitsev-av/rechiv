export interface SessionInfo {
  sessionId: string;
  status: "recording" | "suspended" | "processing" | "completed" | "error";
  callUrl: string;
  title?: string;
  createdAt: string;
  finishedAt: string | null;
  participants: Participant[];
  chunksCount: number;
  processedChunks?: number;
  failedChunks?: number;
  progress?: number;
  error?: string;
  uploadToken?: string;
  duration?: string;
}

export interface Participant {
  speakerId: string;
  name: string | null;
}

export interface Segment {
  speaker: string;
  speakerId: string;
  start: string;
  end: string;
  text: string;
  error?: boolean;
}

export interface TranscriptResult {
  sessionId: string;
  date: string;
  callUrl: string;
  recordingStarted: string;
  duration: string;
  participants: Participant[];
  segments: Segment[];
}

export interface LiveTranscriptResult extends TranscriptResult {
  status: SessionInfo["status"];
  isFinal: boolean;
  processedChunks: number;
  totalChunks: number;
}

export interface StreamInfo {
  streamId: string;
  speakerId: string;
  kind: "local" | "remote";
}

export type RecordingState = "idle" | "detecting" | "recording" | "suspended";

export interface SummaryResult {
  editedAt?: string;
  content: string;
  createdAt: string;
  model: string;
  chunked: boolean;
}

export interface VadTimelineEvent {
  at: number;
  active: string[];
}

export interface VadParticipant {
  participantId: string;
  name: string;
}

/** Поток событий, а не поле участника: важно состояние на момент реплики. */
export interface VadMicEvent {
  at: number;
  unmuted: string[];
}

export interface VadTimeline {
  localParticipantId: string;
  participants: VadParticipant[];
  events: VadTimelineEvent[];
  micEvents: VadMicEvent[];
}
