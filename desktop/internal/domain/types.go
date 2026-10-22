package domain

import "time"

type SessionStatus string

const (
	StatusRecording  SessionStatus = "recording"
	StatusProcessing SessionStatus = "processing"
	StatusCompleted  SessionStatus = "completed"
	StatusError      SessionStatus = "error"
)

type Participant struct {
	SpeakerID string `json:"speakerId"`
	Name      string `json:"name,omitempty"`
}

type Session struct {
	FolderID           string                  `json:"folderId,omitempty"`
	FolderByRule       bool                    `json:"folderByRule,omitempty"`
	SessionID          string                  `json:"sessionId"`
	Status             SessionStatus           `json:"status"`
	CallURL            string                  `json:"callUrl"`
	Title              string                  `json:"title,omitempty"`
	Topic              string                  `json:"topic,omitempty"`
	TitleAuto          bool                    `json:"titleAuto,omitempty"`
	CreatedAt          time.Time               `json:"createdAt"`
	FinishedAt         *time.Time              `json:"finishedAt,omitempty"`
	Participants       map[string]*Participant `json:"participants"`
	ChunksCount        int                     `json:"chunksCount"`
	ProcessedChunks    int                     `json:"processedChunks"`
	FailedChunks       int                     `json:"failedChunks"`
	LastChunkAt        *time.Time              `json:"lastChunkAt,omitempty"`
	Error              string                  `json:"error,omitempty"`
	UploadToken        string                  `json:"uploadToken"`
	NextChunkBySpeaker map[string]int          `json:"nextChunkBySpeaker"`
	AutoProcessing     *AutoProcessing         `json:"autoProcessing,omitempty"`
	SummaryJob         *SummaryJob             `json:"summaryJob,omitempty"`
}

// SummaryJob — саммари по кнопке: идёт в desktop и не зависит от открытой страницы.
type SummaryJob struct {
	Running bool   `json:"running,omitempty"`
	Error   string `json:"error,omitempty"`
}

type AutoProcessing struct {
	Pending       bool `json:"pending,omitempty"`
	SummaryReady  bool `json:"summaryReady,omitempty"`
	SummaryFailed bool `json:"summaryFailed,omitempty"`
	TopicFailed   bool `json:"topicFailed,omitempty"`
}

type Segment struct {
	Speaker   string  `json:"speaker"`
	SpeakerID string  `json:"speakerId"`
	Start     string  `json:"start"`
	End       string  `json:"end"`
	Text      string  `json:"text"`
	Error     bool    `json:"error,omitempty"`
	StartSec  float64 `json:"-"`
	EndSec    float64 `json:"-"`
}

type Transcript struct {
	SessionID        string         `json:"sessionId"`
	Date             string         `json:"date"`
	CallURL          string         `json:"callUrl"`
	RecordingStarted string         `json:"recordingStarted"`
	Duration         string         `json:"duration"`
	Participants     []*Participant `json:"participants"`
	Segments         []Segment      `json:"segments"`
}

type LiveTranscript struct {
	Transcript
	Status          SessionStatus `json:"status"`
	IsFinal         bool          `json:"isFinal"`
	ProcessedChunks int           `json:"processedChunks"`
	TotalChunks     int           `json:"totalChunks"`
}
