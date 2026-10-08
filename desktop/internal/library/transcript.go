package library

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"rechiv/desktop/internal/domain"
)

func (l *Library) GetTranscript(
	ctx context.Context,
	id string,
	filter TranscriptFilter,
) (*TranscriptPage, error) {
	limit, err := pageLimit(filter.Offset, filter.Limit)
	if err != nil {
		return nil, err
	}
	from, to, err := transcriptRange(filter.From, filter.To)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	session, err := l.session(id)
	if err != nil {
		return nil, err
	}
	segments, err := l.segments(session)
	if err != nil {
		return nil, err
	}
	result := &TranscriptPage{
		ID:    id,
		Lines: []string{},
		Total: len(segments),
	}
	for i := min(filter.Offset, len(segments)); i < len(segments); i++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		segment := segments[i]
		if filter.From != "" || filter.To != "" {
			start, err := parseTimecode(segment.Start)
			if err != nil {
				return nil, err
			}
			if start < from || to >= 0 && start >= to {
				continue
			}
		}
		if len(result.Lines) == limit {
			result.NextOffset = &i
			break
		}
		result.Lines = append(result.Lines, fmt.Sprintf("[%s] %s: %s", segment.Start, segment.Speaker, segment.Text))
	}
	return result, nil
}

func (l *Library) segments(session *domain.Session) ([]domain.Segment, error) {
	if session.Status == domain.StatusRecording || session.Status == domain.StatusProcessing {
		return nil, errors.New("созвон ещё обрабатывается: транскрипт пока недоступен")
	}
	var transcript domain.Transcript
	if err := l.readJSON(session.SessionID, "result.json", &transcript); err != nil {
		return nil, err
	}
	timeline, err := l.timeline(session.SessionID)
	if err != nil {
		return nil, err
	}
	domain.ApplySpeakerNames(session, timeline, &transcript)
	return transcript.Segments, nil
}

func (l *Library) Search(ctx context.Context, filter SearchFilter) (*SearchPage, error) {
	if strings.TrimSpace(filter.Query) == "" {
		return nil, errors.New("query не должен быть пустым")
	}
	limit, err := pageLimit(filter.Offset, filter.Limit)
	if err != nil {
		return nil, err
	}
	sessions, err := l.searchSessions(ctx, filter.ID)
	if err != nil {
		return nil, err
	}
	result := &SearchPage{Matches: []Match{}}
	matched := 0
	for _, session := range sessions {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		segments, err := l.segments(session)
		if err != nil {
			if filter.ID != "" {
				return nil, err
			}
			continue
		}
		for i, segment := range segments {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if !contains(segment.Text, filter.Query) {
				continue
			}
			matched++
			if matched <= filter.Offset {
				continue
			}
			if len(result.Matches) == limit {
				next := matched - 1
				result.NextOffset = &next
				return result, nil
			}
			result.Matches = append(result.Matches, Match{
				CallID:       session.SessionID,
				CallTitle:    callTitle(session),
				CreatedAt:    session.CreatedAt.Local().Format(time.RFC3339),
				Timecode:     segment.Start,
				Speaker:      segment.Speaker,
				Text:         segment.Text,
				SegmentIndex: i,
			})
		}
	}
	return result, nil
}

func (l *Library) searchSessions(ctx context.Context, id string) ([]*domain.Session, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if id == "" {
		return l.sessions(ctx)
	}
	session, err := l.session(id)
	if err != nil {
		return nil, err
	}
	return []*domain.Session{session}, nil
}

func pageLimit(offset, limit int) (int, error) {
	if offset < 0 {
		return 0, errors.New("offset должен быть неотрицательным")
	}
	if limit == 0 {
		return DefaultLimit, nil
	}
	if limit < 1 || limit > DefaultLimit {
		return 0, fmt.Errorf("limit должен быть от 1 до %d", DefaultLimit)
	}
	return limit, nil
}

func transcriptRange(from, to string) (int, int, error) {
	start, end := 0, -1
	var err error
	if from != "" {
		start, err = parseTimecode(from)
		if err != nil {
			return 0, 0, err
		}
	}
	if to != "" {
		end, err = parseTimecode(to)
		if err != nil {
			return 0, 0, err
		}
	}
	if end >= 0 && start >= end {
		return 0, 0, errors.New("from должен быть раньше to")
	}
	return start, end, nil
}

func parseTimecode(value string) (int, error) {
	parts := strings.Split(value, ":")
	if len(parts) != 3 {
		return 0, errors.New("время должно быть HH:MM:SS")
	}
	var numbers [3]int
	for i, part := range parts {
		if len(part) < 2 || strings.Trim(part, "0123456789") != "" {
			return 0, errors.New("время должно быть HH:MM:SS")
		}
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 || i > 0 && n > 59 {
			return 0, errors.New("неверное время HH:MM:SS")
		}
		numbers[i] = n
	}
	return numbers[0]*3600 + numbers[1]*60 + numbers[2], nil
}
