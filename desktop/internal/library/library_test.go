package library

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"rechiv/desktop/internal/domain"

	"github.com/stretchr/testify/require"
)

func writeFixture(t *testing.T, dir, id, name string, value any) {
	t.Helper()
	raw, err := json.Marshal(value)
	require.NoError(t, err)
	writeRawFixture(t, dir, id, name, raw)
}

func writeRawFixture(t *testing.T, dir, id, name string, raw []byte) {
	t.Helper()
	path := filepath.Join(dir, "sessions", id, name)
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o700))
	require.NoError(t, os.WriteFile(path, raw, 0o600))
}

func fixtureSession(t *testing.T, dir, id string) *domain.Session {
	t.Helper()
	session := &domain.Session{
		SessionID: id,
		Title:     "Груминг",
		Status:    domain.StatusCompleted,
		CallURL:   "https://stream.wb.ru/room/planning",
		CreatedAt: time.Date(2026, 9, 23, 22, 30, 0, 0, time.UTC),
		Participants: map[string]*domain.Participant{
			"local": {
				SpeakerID: "local",
				Name:      "Пётр",
			},
		},
	}
	writeFixture(t, dir, id, "meta.json", session)
	writeFixture(t, dir, id, "result.json", domain.Transcript{
		Duration: "00:00:30",
		Segments: []domain.Segment{
			{
				SpeakerID: "local",
				Speaker:   "Старое имя",
				Start:     "00:00:00",
				End:       "00:00:10",
				Text:      "Первый вопрос",
			},
			{
				SpeakerID: "local",
				Speaker:   "Старое имя",
				Start:     "00:00:10",
				End:       "00:00:20",
				Text:      "Обсудим отчёт",
			},
			{
				SpeakerID: "local",
				Speaker:   "Старое имя",
				Start:     "00:00:20",
				End:       "00:00:30",
				Text:      "ОТЧЕТ готов",
			},
		},
	})
	return session
}

func TestListCalls(t *testing.T) {
	local := time.Local
	time.Local = time.FixedZone("test", 3*60*60)
	t.Cleanup(func() { time.Local = local })
	dir := t.TempDir()
	library := New(dir)
	unnamed := fixtureSession(t, dir, "unnamed")
	unnamed.Title = ""
	unnamed.CreatedAt = unnamed.CreatedAt.Add(-24 * time.Hour)
	writeFixture(t, dir, "unnamed", "meta.json", unnamed)
	fixtureSession(t, dir, "ready")
	writeFixture(t, dir, "ready", "summary.json", map[string]string{
		"content": "# Решения",
		"model":   "model",
	})
	processing := fixtureSession(t, dir, "processing")
	processing.Status = domain.StatusProcessing
	processing.CreatedAt = processing.CreatedAt.Add(time.Hour)
	writeFixture(t, dir, "processing", "meta.json", processing)
	writeRawFixture(t, dir, "broken", "meta.json", []byte(`{"sessionId":`))
	writeFixture(t, dir, "null-participant", "meta.json", map[string]any{
		"sessionId":    "null-participant",
		"createdAt":    unnamed.CreatedAt,
		"participants": map[string]any{"local": nil},
	})
	for _, tt := range []struct {
		name      string
		filter    ListFilter
		ids       []string
		wantError string
	}{
		{
			name: "все с пропуском битых",
			ids:  []string{"processing", "ready", "unnamed"},
		},
		{
			name:   "название",
			filter: ListFilter{Query: "ГРУМ"},
			ids:    []string{"processing", "ready"},
		},
		{
			name:   "участник",
			filter: ListFilter{Participant: "ПЕТР"},
			ids:    []string{"processing", "ready", "unnamed"},
		},
		{
			name: "местная дата",
			filter: ListFilter{
				From: "2026-09-24",
				To:   "2026-09-24",
			},
			ids: []string{"processing", "ready"},
		},
		{
			name: "местное время",
			filter: ListFilter{
				From: "2026-09-24T01:30:00",
				To:   "2026-09-24T02:30:00",
			},
			ids: []string{"ready"},
		},
		{
			name: "явный пояс",
			filter: ListFilter{
				From: "2026-09-23T22:30:00Z",
				To:   "2026-09-23T23:00:00Z",
			},
			ids: []string{"ready"},
		},
		{
			name:   "имя из комнаты",
			filter: ListFilter{Query: "planning"},
			ids:    []string{"unnamed"},
		},
		{
			name:   "нет участника",
			filter: ListFilter{Participant: "Другой"},
			ids:    []string{},
		},
		{
			name:      "ошибка даты",
			filter:    ListFilter{From: "вчера"},
			wantError: "дата",
		},
		{
			name: "обратный диапазон",
			filter: ListFilter{
				From: "2026-09-25",
				To:   "2026-09-23",
			},
			wantError: "from",
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			calls, err := library.ListCalls(t.Context(), tt.filter)
			if tt.wantError != "" {
				require.ErrorContains(t, err, tt.wantError)
				return
			}
			require.NoError(t, err)
			ids := make([]string, 0, len(calls))
			for _, call := range calls {
				ids = append(ids, call.ID)
			}
			require.Equal(t, tt.ids, ids)
		})
	}
	calls, err := library.ListCalls(t.Context(), ListFilter{})
	require.NoError(t, err)
	require.Equal(t, domain.StatusProcessing, calls[0].Status)
	require.True(t, calls[1].HasSummary)
	require.Equal(t, "00:00:30", calls[1].Duration)
	require.Equal(t, "2026-09-24T01:30:00+03:00", calls[1].CreatedAt)
	require.False(t, calls[2].HasSummary)
	require.Equal(t, "2026-09-23 01:30 — planning", calls[2].Title)
	fixtureSession(t, dir, "new-call")
	calls, err = library.ListCalls(t.Context(), ListFilter{})
	require.NoError(t, err)
	require.Len(t, calls, 4)
}

func TestGetSummary(t *testing.T) {
	dir := t.TempDir()
	fixtureSession(t, dir, "call")
	library := New(dir)
	summary, err := library.GetSummary(t.Context(), "call")
	require.NoError(t, err)
	require.Equal(t, &Summary{ID: "call"}, summary)
	writeFixture(t, dir, "call", "summary.json", map[string]string{
		"content": "# Решения\nСделать",
		"model":   "test",
	})
	summary, err = library.GetSummary(t.Context(), "call")
	require.NoError(t, err)
	require.Equal(t, &Summary{
		ID:        "call",
		Available: true,
		Content:   "# Решения\nСделать",
		Model:     "test",
	}, summary)
	writeRawFixture(t, dir, "call", "summary.json", []byte("broken"))
	calls, err := library.ListCalls(t.Context(), ListFilter{})
	require.NoError(t, err)
	require.True(t, calls[0].HasSummary)
	_, err = library.GetSummary(t.Context(), "call")
	require.Error(t, err)
	_, err = library.GetSummary(t.Context(), "missing")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestCurrentSpeakerNames(t *testing.T) {
	for _, withVAD := range []bool{false, true} {
		t.Run(fmt.Sprintf("vad=%t", withVAD), func(t *testing.T) {
			dir := t.TempDir()
			session := fixtureSession(t, dir, "call")
			speakerID := "local"
			if withVAD {
				speakerID = "remote-uuid"
				writeFixture(t, dir, "call", "vad.json", domain.VADTimeline{
					Participants: []domain.VADParticipant{{
						ParticipantID: speakerID,
						Name:          "Старое имя",
					}},
				})
			}
			writeFixture(t, dir, "call", "result.json", domain.Transcript{
				Segments: []domain.Segment{{
					SpeakerID: speakerID,
					Speaker:   "Старое имя",
					Start:     "00:00:00",
					Text:      "ответ",
				}},
			})
			library := New(dir)
			session.Participants[speakerID] = &domain.Participant{
				SpeakerID: speakerID,
				Name:      "Новое имя",
			}
			writeFixture(t, dir, "call", "meta.json", session)
			page, err := library.GetTranscript(t.Context(), "call", TranscriptFilter{})
			require.NoError(t, err)
			require.Equal(t, []string{"[00:00:00] Новое имя: ответ"}, page.Lines)
			calls, err := library.ListCalls(t.Context(), ListFilter{Participant: "Новое имя"})
			require.NoError(t, err)
			require.Len(t, calls, 1)
			matches, err := library.Search(t.Context(), SearchFilter{Query: "ответ"})
			require.NoError(t, err)
			require.Equal(t, "Новое имя", matches.Matches[0].Speaker)
			raw, err := os.ReadFile(filepath.Join(dir, "sessions", "call", "result.json"))
			require.NoError(t, err)
			require.Contains(t, string(raw), "Старое имя")
		})
	}
}

func TestEmptyLibraryDoesNotCreateFiles(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "absent")
	library := New(dir)
	calls, err := library.ListCalls(t.Context(), ListFilter{})
	require.NoError(t, err)
	require.Empty(t, calls)
	matches, err := library.Search(t.Context(), SearchFilter{Query: "test"})
	require.NoError(t, err)
	require.Empty(t, matches.Matches)
	_, err = library.GetSummary(t.Context(), "missing")
	require.ErrorIs(t, err, ErrNotFound)
	_, err = library.GetTranscript(t.Context(), "missing", TranscriptFilter{})
	require.ErrorIs(t, err, ErrNotFound)
	_, err = os.Stat(dir)
	require.True(t, os.IsNotExist(err))
}

func TestLibraryRejectsEscapingPaths(t *testing.T) {
	dir := t.TempDir()
	fixtureSession(t, dir, "call")
	require.NoError(t, os.Symlink(t.TempDir(), filepath.Join(dir, "sessions", "outside")))
	for _, id := range []string{"", ".", "..", "../call", "/tmp", `..\call`, "outside"} {
		t.Run(id, func(t *testing.T) {
			library := New(dir)
			_, err := library.GetSummary(t.Context(), id)
			require.Error(t, err)
			_, err = library.GetTranscript(t.Context(), id, TranscriptFilter{})
			require.Error(t, err)
			_, err = library.Search(t.Context(), SearchFilter{
				ID:    id,
				Query: "text",
			})
			if id != "" {
				require.Error(t, err)
			}
		})
	}
}

func TestLibraryCancellation(t *testing.T) {
	library := New(t.TempDir())
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err := library.ListCalls(ctx, ListFilter{})
	require.ErrorIs(t, err, context.Canceled)
	_, err = library.GetSummary(ctx, "call")
	require.ErrorIs(t, err, context.Canceled)
	_, err = library.GetTranscript(ctx, "call", TranscriptFilter{})
	require.ErrorIs(t, err, context.Canceled)
	_, err = library.Search(ctx, SearchFilter{Query: "text"})
	require.ErrorIs(t, err, context.Canceled)
}

func TestLibraryOnlyReads(t *testing.T) {
	dir := t.TempDir()
	fixtureSession(t, dir, "call")
	writeFixture(t, dir, "call", "summary.json", map[string]string{"content": "Итоги"})
	before := snapshotFiles(t, dir)
	library := New(dir)
	_, err := library.ListCalls(t.Context(), ListFilter{})
	require.NoError(t, err)
	_, err = library.GetSummary(t.Context(), "call")
	require.NoError(t, err)
	_, err = library.GetTranscript(t.Context(), "call", TranscriptFilter{})
	require.NoError(t, err)
	_, err = library.Search(t.Context(), SearchFilter{Query: "отчет"})
	require.NoError(t, err)
	require.Equal(t, before, snapshotFiles(t, dir))
}

func snapshotFiles(t *testing.T, dir string) map[string]string {
	t.Helper()
	files := map[string]string{}
	require.NoError(t, filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			files[path] = "directory"
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		files[path] = string(raw)
		return nil
	}))
	return files
}

func TestLibraryReadsAtomicUpdates(t *testing.T) {
	dir := t.TempDir()
	session := fixtureSession(t, dir, "call")
	library := New(dir)
	done := make(chan error, 1)
	go func() {
		var err error
		defer func() { done <- err }()
		path := filepath.Join(dir, "sessions", "call", "meta.json")
		for i := range 30 {
			session.Participants["local"].Name = fmt.Sprintf("Имя %d", i)
			var raw []byte
			raw, err = json.Marshal(session)
			if err != nil {
				return
			}
			err = os.WriteFile(path+".tmp", raw, 0o600)
			if err != nil {
				return
			}
			err = os.Rename(path+".tmp", path)
			if err != nil {
				return
			}
		}
	}()
	for range 30 {
		page, err := library.GetTranscript(t.Context(), "call", TranscriptFilter{})
		require.NoError(t, err)
		require.Len(t, page.Lines, 3)
	}
	require.NoError(t, <-done)
	page, err := library.GetTranscript(t.Context(), "call", TranscriptFilter{})
	require.NoError(t, err)
	require.Contains(t, page.Lines[0], "Имя 29")
}

func TestSummaryEditedAt(t *testing.T) {
	for _, editedAt := range []string{"", "2026-10-08T12:34:56Z"} {
		t.Run(editedAt, func(t *testing.T) {
			dir := t.TempDir()
			fixtureSession(t, dir, "call")
			data := map[string]string{"content": "Правка", "model": "original"}
			if editedAt != "" {
				data["editedAt"] = editedAt
			}
			writeFixture(t, dir, "call", "summary.json", data)
			summary, err := New(dir).GetSummary(t.Context(), "call")
			require.NoError(t, err)
			require.Equal(t, editedAt, summary.EditedAt)
			raw, err := json.Marshal(summary)
			require.NoError(t, err)
			if editedAt == "" {
				require.NotContains(t, string(raw), "editedAt")
			} else {
				require.Contains(t, string(raw), `"editedAt":"`+editedAt+`"`)
			}
		})
	}
}
