package engine

import "context"

type Segment struct {
	Text  string  `json:"text"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

type Engine interface {
	Ping(ctx context.Context) error
	Close() error
	Warmup(ctx context.Context) error
	Transcribe(ctx context.Context, audioPath string) ([]Segment, error)
}
