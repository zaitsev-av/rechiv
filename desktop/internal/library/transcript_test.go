package library

import (
	"fmt"
	"testing"
	"time"

	"rechiv/desktop/internal/domain"

	"github.com/stretchr/testify/require"
)

func TestGetTranscript(t *testing.T) {
	dir := t.TempDir()
	fixtureSession(t, dir, "call")
	library := New(dir)
	for _, tt := range []struct {
		name      string
		filter    TranscriptFilter
		count     int
		first     string
		next      *int
		wantError string
	}{
		{
			name:  "весь короткий",
			count: 3,
			first: "[00:00:00] Пётр: Первый вопрос",
		},
		{
			name: "страница",
			filter: TranscriptFilter{
				Offset: 1,
				Limit:  1,
			},
			count: 1,
			first: "[00:00:10] Пётр: Обсудим отчёт",
			next:  intPointer(2),
		},
		{
			name: "последняя",
			filter: TranscriptFilter{
				Offset: 2,
				Limit:  1,
			},
			count: 1,
			first: "[00:00:20] Пётр: ОТЧЕТ готов",
		},
		{
			name:   "за концом",
			filter: TranscriptFilter{Offset: 10},
		},
		{
			name: "время",
			filter: TranscriptFilter{
				From: "00:00:10",
				To:   "00:00:20",
			},
			count: 1,
			first: "[00:00:10] Пётр: Обсудим отчёт",
		},
		{
			name:   "начало",
			filter: TranscriptFilter{To: "00:00:10"},
			count:  1,
			first:  "[00:00:00] Пётр: Первый вопрос",
		},
		{
			name: "время с пагинацией",
			filter: TranscriptFilter{
				From:  "00:00:10",
				Limit: 1,
			},
			count: 1,
			first: "[00:00:10] Пётр: Обсудим отчёт",
			next:  intPointer(2),
		},
		{
			name: "продолжение времени",
			filter: TranscriptFilter{
				From:   "00:00:10",
				Offset: 2,
				Limit:  1,
			},
			count: 1,
			first: "[00:00:20] Пётр: ОТЧЕТ готов",
		},
		{
			name:   "пустой диапазон",
			filter: TranscriptFilter{From: "00:01:00"},
		},
		{
			name: "обратное время",
			filter: TranscriptFilter{
				From: "00:00:20",
				To:   "00:00:10",
			},
			wantError: "from",
		},
		{
			name:      "неверное время",
			filter:    TranscriptFilter{To: "00:60:00"},
			wantError: "время",
		},
		{
			name:      "неверный offset",
			filter:    TranscriptFilter{Offset: -1},
			wantError: "offset",
		},
		{
			name:      "неверный limit",
			filter:    TranscriptFilter{Limit: -1},
			wantError: "limit",
		},
		{
			name:      "слишком большой limit",
			filter:    TranscriptFilter{Limit: 201},
			wantError: "limit",
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			page, err := library.GetTranscript(t.Context(), "call", tt.filter)
			if tt.wantError != "" {
				require.ErrorContains(t, err, tt.wantError)
				return
			}
			require.NoError(t, err)
			require.Equal(t, 3, page.Total)
			require.Len(t, page.Lines, tt.count)
			require.Equal(t, tt.next, page.NextOffset)
			if tt.count > 0 {
				require.Equal(t, tt.first, page.Lines[0])
			}
		})
	}
}

func TestTranscriptDefaultPage(t *testing.T) {
	dir := t.TempDir()
	fixtureSession(t, dir, "call")
	segments := make([]domain.Segment, 201)
	for i := range segments {
		segments[i] = domain.Segment{
			SpeakerID: "local",
			Start:     "00:00:00",
			Text:      fmt.Sprint(i),
		}
	}
	writeFixture(t, dir, "call", "result.json", domain.Transcript{Segments: segments})
	page, err := New(dir).GetTranscript(t.Context(), "call", TranscriptFilter{})
	require.NoError(t, err)
	require.Len(t, page.Lines, 200)
	require.Equal(t, 201, page.Total)
	require.Equal(t, 200, *page.NextOffset)
}

func TestUnfinishedTranscript(t *testing.T) {
	for _, status := range []domain.SessionStatus{domain.StatusRecording, domain.StatusProcessing} {
		t.Run(string(status), func(t *testing.T) {
			dir := t.TempDir()
			session := fixtureSession(t, dir, "call")
			session.Status = status
			writeFixture(t, dir, "call", "meta.json", session)
			library := New(dir)
			calls, err := library.ListCalls(t.Context(), ListFilter{})
			require.NoError(t, err)
			require.Equal(t, status, calls[0].Status)
			_, err = library.GetTranscript(t.Context(), "call", TranscriptFilter{})
			require.ErrorContains(t, err, "ещё обрабатывается")
			_, err = library.Search(t.Context(), SearchFilter{
				ID:    "call",
				Query: "отчет",
			})
			require.ErrorContains(t, err, "ещё обрабатывается")
			page, err := library.Search(t.Context(), SearchFilter{Query: "отчет"})
			require.NoError(t, err)
			require.Empty(t, page.Matches)
		})
	}
}

func TestSearch(t *testing.T) {
	dir := t.TempDir()
	fixtureSession(t, dir, "call")
	fixtureSession(t, dir, "broken")
	writeRawFixture(t, dir, "broken", "result.json", []byte("broken"))
	library := New(dir)
	for _, tt := range []struct {
		name      string
		filter    SearchFilter
		count     int
		next      *int
		wantError string
	}{
		{
			name:   "регистр и ё",
			filter: SearchFilter{Query: "ОТчЕт"},
			count:  2,
		},
		{
			name: "один созвон",
			filter: SearchFilter{
				ID:    "call",
				Query: "отчёт",
			},
			count: 2,
		},
		{
			name: "первая страница",
			filter: SearchFilter{
				Query: "отчет",
				Limit: 1,
			},
			count: 1,
			next:  intPointer(1),
		},
		{
			name: "последняя страница",
			filter: SearchFilter{
				Query:  "отчет",
				Offset: 1,
				Limit:  1,
			},
			count: 1,
		},
		{
			name:   "нет совпадений",
			filter: SearchFilter{Query: "не существует"},
		},
		{
			name: "за концом",
			filter: SearchFilter{
				Query:  "отчет",
				Offset: 10,
			},
		},
		{
			name:      "пустой запрос",
			filter:    SearchFilter{Query: " "},
			wantError: "query",
		},
		{
			name: "неверное смещение",
			filter: SearchFilter{
				Query:  "отчет",
				Offset: -1,
			},
			wantError: "offset",
		},
		{
			name: "большая страница",
			filter: SearchFilter{
				Query: "отчет",
				Limit: 201,
			},
			wantError: "limit",
		},
		{
			name: "битый транскрипт",
			filter: SearchFilter{
				ID:    "broken",
				Query: "отчет",
			},
			wantError: "result.json",
		},
		{
			name: "нет созвона",
			filter: SearchFilter{
				ID:    "missing",
				Query: "отчет",
			},
			wantError: "не найден",
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			page, err := library.Search(t.Context(), tt.filter)
			if tt.wantError != "" {
				require.ErrorContains(t, err, tt.wantError)
				return
			}
			require.NoError(t, err)
			require.Len(t, page.Matches, tt.count)
			require.Equal(t, tt.next, page.NextOffset)
			if tt.count > 0 {
				match := page.Matches[0]
				require.Equal(t, "call", match.CallID)
				require.Equal(t, "Груминг", match.CallTitle)
				require.Equal(
					t,
					time.Date(2026, 9, 23, 22, 30, 0, 0, time.UTC).Local().Format(time.RFC3339),
					match.CreatedAt,
				)
				require.Equal(t, "Пётр", match.Speaker)
				fragment, err := library.GetTranscript(t.Context(), match.CallID, TranscriptFilter{
					Offset: match.SegmentIndex,
					Limit:  1,
				})
				require.NoError(t, err)
				require.Equal(
					t,
					fmt.Sprintf("[%s] %s: %s", match.Timecode, match.Speaker, match.Text),
					fragment.Lines[0],
				)
			}
		})
	}
}

func TestParseTimecode(t *testing.T) {
	for _, value := range []string{"", "12:34", "-1:00:00", "00:00:60", "xx:00:00", "999999999999999999999:00:00"} {
		t.Run(value, func(t *testing.T) {
			_, err := parseTimecode(value)
			require.Error(t, err)
		})
	}
	seconds, err := parseTimecode("100:01:02")
	require.NoError(t, err)
	require.Equal(t, 360062, seconds)
}

func intPointer(value int) *int { return &value }
