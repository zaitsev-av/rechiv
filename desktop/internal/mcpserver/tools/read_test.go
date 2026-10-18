package tools_test

import (
	"encoding/json"
	"errors"
	"testing"

	"rechiv/desktop/internal/library"
	"rechiv/desktop/internal/mcpserver"
	"rechiv/desktop/internal/mcpserver/tools/mocks"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"
)

type mocksList struct{ library *mocks.MockCallLibrary }

func TestReadTools(t *testing.T) {
	tests := []struct {
		name, tool          string
		args                map[string]any
		setupMocks          func(mocksList)
		wantJSON, wantError string
	}{
		{
			name: "фильтры списка",
			tool: "rechiv_list_calls",
			args: map[string]any{
				"from":        "2026-09-24",
				"to":          "2026-09-24",
				"query":       "груминг",
				"participant": "Анна",
				"folder":      "Дейли",
			},
			setupMocks: func(m mocksList) {
				m.library.EXPECT().
					ListCalls(gomock.Any(), library.ListFilter{
						From:        "2026-09-24",
						To:          "2026-09-24",
						Query:       "груминг",
						Participant: "Анна",
						Folder:      "Дейли",
					}).
					Return([]library.Call{{ID: "call", Folder: "Дейли"}}, nil)
			},
			wantJSON: `{"calls":[{"id":"call","title":"","created_at":"","duration":"","participants":null,"status":"","has_summary":false,"folder":"Дейли"}]}`,
		},
		{
			name: "ошибка списка",
			tool: "rechiv_list_calls",
			args: map[string]any{},
			setupMocks: func(m mocksList) {
				m.library.EXPECT().
					ListCalls(gomock.Any(), library.ListFilter{}).
					Return(nil, errors.New("read directory"))
			},
			wantError: "read directory",
		},
		{
			name: "саммари",
			tool: "rechiv_get_summary",
			args: map[string]any{"id": "call"},
			setupMocks: func(m mocksList) {
				m.library.EXPECT().
					GetSummary(gomock.Any(), "call").Return(&library.Summary{
					ID:        "call",
					Available: true,
					Content:   "# Итоги\nРешили",
					Model:     "test",
				}, nil)
			},
			wantJSON: `{"id":"call","available":true,"content":"# Итоги\nРешили","model":"test"}`,
		},
		{
			name: "нет саммари",
			tool: "rechiv_get_summary",
			args: map[string]any{"id": "call"},
			setupMocks: func(m mocksList) {
				m.library.EXPECT().
					GetSummary(gomock.Any(), "call").Return(&library.Summary{ID: "call"}, nil)
			},
			wantJSON: `{"id":"call","available":false,"content":"","model":""}`,
		},
		{
			name: "нет созвона",
			tool: "rechiv_get_summary",
			args: map[string]any{"id": "missing"},
			setupMocks: func(m mocksList) {
				m.library.EXPECT().
					GetSummary(gomock.Any(), "missing").Return(nil, library.ErrNotFound)
			},
			wantError: "не найден",
		},
		{
			name: "пустой ответ",
			tool: "rechiv_get_summary",
			args: map[string]any{"id": "call"},
			setupMocks: func(m mocksList) {
				m.library.EXPECT().
					GetSummary(gomock.Any(), "call").Return(nil, nil)
			},
			wantError: "пустой ответ",
		},
		{
			name: "страница транскрипта",
			tool: "rechiv_get_transcript",
			args: map[string]any{
				"id":     "call",
				"offset": 3,
				"limit":  2,
			},
			setupMocks: func(m mocksList) {
				next := 5
				m.library.EXPECT().
					GetTranscript(gomock.Any(), "call", library.TranscriptFilter{
						Offset: 3,
						Limit:  2,
					}).
					Return(&library.TranscriptPage{
						ID:         "call",
						Lines:      []string{"[00:00:03] Анна: Раз", "[00:00:04] Анна: Два"},
						Total:      10,
						NextOffset: &next,
					}, nil)
			},
			wantJSON: `{
                "id": "call",
                "lines": ["[00:00:03] Анна: Раз", "[00:00:04] Анна: Два"],
                "total": 10,
                "next_offset": 5
            }`,
		},
		{
			name: "диапазон времени",
			tool: "rechiv_get_transcript",
			args: map[string]any{
				"id":   "call",
				"from": "00:00:10",
				"to":   "00:00:20",
			},
			setupMocks: func(m mocksList) {
				m.library.EXPECT().
					GetTranscript(gomock.Any(), "call", library.TranscriptFilter{
						From: "00:00:10",
						To:   "00:00:20",
					}).
					Return(&library.TranscriptPage{
						ID:    "call",
						Lines: []string{},
						Total: 10,
					}, nil)
			},
			wantJSON: `{"id":"call","lines":[],"total":10,"next_offset":null}`,
		},
		{
			name: "ещё обрабатывается",
			tool: "rechiv_get_transcript",
			args: map[string]any{"id": "call"},
			setupMocks: func(m mocksList) {
				m.library.EXPECT().
					GetTranscript(gomock.Any(), "call", library.TranscriptFilter{}).
					Return(nil, errors.New("ещё обрабатывается"))
			},
			wantError: "ещё обрабатывается",
		},
		{
			name: "поиск",
			tool: "rechiv_search",
			args: map[string]any{
				"id":     "call",
				"query":  "текст",
				"offset": 2,
				"limit":  1,
			},
			setupMocks: func(m mocksList) {
				m.library.EXPECT().
					Search(gomock.Any(), library.SearchFilter{
						ID:     "call",
						Query:  "текст",
						Offset: 2,
						Limit:  1,
					}).
					Return(&library.SearchPage{
						Matches: []library.Match{
							{
								CallID:       "call",
								CallTitle:    "Груминг",
								CreatedAt:    "2026-09-24T01:30:00+03:00",
								Timecode:     "00:00:10",
								Speaker:      "Анна",
								Text:         "текст",
								SegmentIndex: 3,
							},
						},
					}, nil)
			},
			wantJSON: `{
                "matches": [{
                    "call_id": "call",
                    "call_title": "Груминг",
                    "created_at": "2026-09-24T01:30:00+03:00",
                    "timecode": "00:00:10",
                    "speaker": "Анна",
                    "text": "текст",
                    "segment_index": 3
                }],
                "next_offset": null
            }`,
		},
		{
			name: "ошибка поиска",
			tool: "rechiv_search",
			args: map[string]any{"query": ""},
			setupMocks: func(m mocksList) {
				m.library.EXPECT().
					Search(gomock.Any(), library.SearchFilter{}).
					Return(nil, errors.New("query не должен быть пустым"))
			},
			wantError: "query",
		},
		{
			name:      "нет обязательного id",
			tool:      "rechiv_get_summary",
			args:      map[string]any{},
			wantError: "id",
		},
		{
			name:      "нет обязательного query",
			tool:      "rechiv_search",
			args:      map[string]any{},
			wantError: "query",
		},
		{
			name:      "неверный тип",
			tool:      "rechiv_get_transcript",
			args:      map[string]any{"id": 123},
			wantError: "string",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			is := require.New(t)
			m := mocksList{library: mocks.NewMockCallLibrary(gomock.NewController(t))}
			if tt.setupMocks != nil {
				tt.setupMocks(m)
			}
			server := mcpserver.NewServer(mcpserver.DefaultConfig("test"), m.library)
			ct, st := mcp.NewInMemoryTransports()
			ss, err := server.Connect(t.Context(), st, nil)
			is.NoError(err)
			client := mcp.NewClient(&mcp.Implementation{
				Name:    "test",
				Version: "test",
			}, nil)
			cs, err := client.Connect(t.Context(), ct, nil)
			is.NoError(err)
			t.Cleanup(func() {
				is.NoError(cs.Close())
				is.NoError(ss.Wait())
			})
			got, err := cs.CallTool(t.Context(), &mcp.CallToolParams{
				Name:      tt.tool,
				Arguments: tt.args,
			})
			is.NoError(err)
			is.Equal(tt.wantError != "", got.IsError)
			if tt.wantError != "" {
				is.Nil(got.StructuredContent)
				is.Contains(got.Content[0].(*mcp.TextContent).Text, tt.wantError)
				return
			}
			data, err := json.Marshal(got.StructuredContent)
			is.NoError(err)
			is.JSONEq(tt.wantJSON, string(data))
			is.JSONEq(string(data), got.Content[0].(*mcp.TextContent).Text)
			listed, err := cs.ListTools(t.Context(), nil)
			is.NoError(err)
			for _, tool := range listed.Tools {
				if tool.Name != tt.tool {
					continue
				}
				raw, err := json.Marshal(tool.OutputSchema)
				is.NoError(err)
				var schema jsonschema.Schema
				is.NoError(json.Unmarshal(raw, &schema))
				resolved, err := schema.Resolve(nil)
				is.NoError(err)
				is.NoError(resolved.Validate(got.StructuredContent))
			}
		})
	}
}
