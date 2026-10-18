package library

import "rechiv/desktop/internal/domain"

const DefaultLimit = 200

type ListFilter struct {
	From, To, Query, Participant, Folder string
}

type TranscriptFilter struct {
	From, To      string
	Offset, Limit int
}

type SearchFilter struct {
	ID, Query     string
	Offset, Limit int
}

type Call struct {
	Folder       string                `json:"folder,omitempty"`
	ID           string                `json:"id"`
	Title        string                `json:"title"`
	CreatedAt    string                `json:"created_at"`
	Duration     string                `json:"duration"`
	Participants []*domain.Participant `json:"participants"`
	Status       domain.SessionStatus  `json:"status"`
	HasSummary   bool                  `json:"has_summary"`
}

type Summary struct {
	EditedAt  string `json:"editedAt,omitempty"`
	ID        string `json:"id"`
	Available bool   `json:"available"`
	Content   string `json:"content"`
	Model     string `json:"model"`
}

type TranscriptPage struct {
	ID         string   `json:"id"`
	Lines      []string `json:"lines"`
	Total      int      `json:"total" jsonschema:"Всего сегментов до фильтрации"`
	NextOffset *int     `json:"next_offset" jsonschema:"Индекс продолжения; null — конец"`
}

type Match struct {
	CallID       string `json:"call_id"`
	CallTitle    string `json:"call_title"`
	CreatedAt    string `json:"created_at"`
	Timecode     string `json:"timecode"`
	Speaker      string `json:"speaker"`
	Text         string `json:"text"`
	SegmentIndex int    `json:"segment_index"`
}

type SearchPage struct {
	Matches    []Match `json:"matches"`
	NextOffset *int    `json:"next_offset" jsonschema:"Смещение продолжения; null — конец"`
}
