package tools

import "rechiv/desktop/internal/library"

type ListCallsOutput struct {
	Calls []library.Call `json:"calls"`
}

type GetSummaryOutput = library.Summary
type GetTranscriptOutput = library.TranscriptPage
type SearchOutput = library.SearchPage
