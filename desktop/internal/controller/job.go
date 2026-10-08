package controller

import (
	"encoding/json"
	"os"
)

type JobStatus string

const (
	JobQueued     JobStatus = "queued"
	JobProcessing JobStatus = "processing"
	JobCompleted  JobStatus = "completed"
	JobError      JobStatus = "error"
)

type JobSegment struct {
	Text  string  `json:"text"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

type Job struct {
	SessionID    string       `json:"sessionId"`
	SpeakerID    string       `json:"speakerId"`
	ChunkIndex   int          `json:"chunkIndex"`
	Offset       float64      `json:"offset"`
	Duration     float64      `json:"duration"`
	WebMPath     string       `json:"webmPath"`
	WAVPath      string       `json:"wavPath"`
	Status       JobStatus    `json:"status"`
	Attempts     int          `json:"attempts"`
	Live         bool         `json:"live,omitempty"`
	AttributedTo string       `json:"attributedTo,omitempty"`
	Error        string       `json:"error,omitempty"`
	Segments     []JobSegment `json:"segments,omitempty"`
	MetadataPath string       `json:"-"`
}

func readJob(path string) (*Job, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var job Job
	if err := json.Unmarshal(raw, &job); err != nil {
		return nil, err
	}
	job.MetadataPath = path
	return &job, nil
}

func writeJob(job *Job) error {
	raw, err := json.MarshalIndent(job, "", "  ")
	if err != nil {
		return err
	}
	tmp := job.MetadataPath + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, job.MetadataPath)
}
