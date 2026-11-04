package engine

import "context"

// Word — слово с таймингами от начала файла, как у Segment.
type Word struct {
	Text  string  `json:"text"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

type Segment struct {
	Text  string  `json:"text"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Words []Word  `json:"words,omitempty"`
}

type Engine interface {
	Ping(ctx context.Context) error
	Close() error
	Warmup(ctx context.Context) error
	Transcribe(ctx context.Context, audioPath string) ([]Segment, error)
}
