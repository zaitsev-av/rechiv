package library

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"rechiv/desktop/internal/domain"
	"rechiv/desktop/internal/store"
)

var ErrNotFound = errors.New("созвон не найден")

type Library struct{ sessionsDir string }

func New(dataDir string) *Library {
	return &Library{sessionsDir: filepath.Join(dataDir, "sessions")}
}

func (l *Library) ListCalls(ctx context.Context, filter ListFilter) ([]Call, error) {
	from, to, err := dateRange(filter.From, filter.To)
	if err != nil {
		return nil, err
	}
	sessions, err := l.sessions(ctx)
	if err != nil {
		return nil, err
	}
	folders := store.ReadFolders(filepath.Join(filepath.Dir(l.sessionsDir), "folders.json"))
	names := map[string]string{}
	for _, f := range folders {
		names[f.ID] = f.Name
	}
	calls := make([]Call, 0, len(sessions))
	for _, session := range sessions {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if !from.IsZero() && session.CreatedAt.Before(from) || !to.IsZero() && !session.CreatedAt.Before(to) {
			continue
		}
		call := l.call(session)
		call.Folder = names[session.FolderID]
		inbox := strings.EqualFold(filter.Folder, "inbox") || strings.EqualFold(filter.Folder, "Входящие")
		if inbox && call.Folder != "" || !inbox && !contains(call.Folder, filter.Folder) {
			continue
		}
		if !contains(call.Title, filter.Query) || !hasParticipant(call, filter.Participant) {
			continue
		}
		calls = append(calls, call)
	}
	return calls, nil
}

func (l *Library) GetSummary(ctx context.Context, id string) (*Summary, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if _, err := l.session(id); err != nil {
		return nil, err
	}
	result := &Summary{ID: id}
	err := l.readJSON(id, "summary.json", result)
	if errors.Is(err, os.ErrNotExist) {
		return result, nil
	}
	if err != nil {
		return nil, err
	}
	result.ID, result.Available = id, true
	return result, nil
}

func (l *Library) sessions(ctx context.Context) ([]*domain.Session, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(l.sessionsDir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	sessions := make([]*domain.Session, 0, len(entries))
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if !entry.IsDir() {
			continue
		}
		session, err := l.session(entry.Name())
		if err != nil {
			continue
		}
		sessions = append(sessions, session)
	}
	sort.Slice(sessions, func(i, j int) bool {
		if sessions[i].CreatedAt.Equal(sessions[j].CreatedAt) {
			return sessions[i].SessionID < sessions[j].SessionID
		}
		return sessions[i].CreatedAt.After(sessions[j].CreatedAt)
	})
	return sessions, nil
}

func (l *Library) session(id string) (*domain.Session, error) {
	var session domain.Session
	if err := l.readJSON(id, "meta.json", &session); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if session.SessionID != id || session.CreatedAt.IsZero() {
		return nil, errors.New("неверная meta.json")
	}
	for _, participant := range session.Participants {
		if participant == nil {
			return nil, errors.New("неверный участник в meta.json")
		}
	}
	return &session, nil
}

func (l *Library) readJSON(id, name string, target any) error {
	if id == "" || filepath.Base(id) != id {
		return errors.New("неверный ID созвона")
	}
	root, err := os.OpenRoot(l.sessionsDir)
	if err != nil {
		return err
	}
	defer root.Close()
	raw, err := root.ReadFile(filepath.Join(id, name))
	if err != nil {
		return err
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return fmt.Errorf("read %s: %w", name, err)
	}
	return nil
}

func (l *Library) timeline(id string) (*domain.VADTimeline, error) {
	var timeline domain.VADTimeline
	if err := l.readJSON(id, "vad.json", &timeline); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	return &timeline, nil
}

func (l *Library) call(session *domain.Session) Call {
	transcript := domain.Transcript{}
	_ = l.readJSON(session.SessionID, "result.json", &transcript)

	timeline, _ := l.timeline(session.SessionID)
	domain.ApplySpeakerNames(session, timeline, &transcript)
	if transcript.Participants == nil {
		transcript.Participants = []*domain.Participant{}
	}

	return Call{
		ID:           session.SessionID,
		Title:        callTitle(session),
		CreatedAt:    session.CreatedAt.Local().Format(time.RFC3339),
		Duration:     transcript.Duration,
		Participants: transcript.Participants,
		Status:       session.Status,
		HasSummary:   l.hasSummary(session.SessionID),
	}
}

func (l *Library) hasSummary(id string) bool {
	root, err := os.OpenRoot(l.sessionsDir)
	if err != nil {
		return false
	}
	defer root.Close()

	info, err := root.Stat(filepath.Join(id, "summary.json"))

	return err == nil && !info.IsDir()
}

func callTitle(session *domain.Session) string {
	if title := strings.TrimSpace(session.Title); title != "" {
		return title
	}

	title := session.CreatedAt.Local().Format("2006-01-02 15:04")
	if u, err := url.Parse(session.CallURL); err == nil {
		room := path.Base(strings.TrimRight(u.Path, "/"))
		if room != "." && room != "/" && room != "" {
			return title + " — " + room
		}
	}

	return title
}

func contains(value, query string) bool {
	normalize := func(s string) string { return strings.ReplaceAll(strings.ToLower(s), "ё", "е") }
	return strings.Contains(normalize(value), normalize(query))

}

func hasParticipant(call Call, query string) bool {
	if query == "" {
		return true
	}

	for _, participant := range call.Participants {
		if participant != nil && contains(participant.Name, query) {
			return true
		}
	}

	return false
}

func dateRange(from, to string) (time.Time, time.Time, error) {
	start, err := parseDate(from, false)
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	end, err := parseDate(to, true)
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	if !start.IsZero() && !end.IsZero() && !start.Before(end) {
		return start, end, errors.New("from должен быть раньше to")
	}
	return start, end, nil
}

func parseDate(value string, end bool) (time.Time, error) {
	if value == "" {
		return time.Time{}, nil
	}
	if date, err := time.ParseInLocation(time.DateOnly, value, time.Local); err == nil {
		if end {
			date = date.AddDate(0, 0, 1)
		}
		return date, nil
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05"} {
		if date, err := time.ParseInLocation(layout, value, time.Local); err == nil {
			return date, nil
		}
	}
	return time.Time{}, errors.New(
		"дата должна быть YYYY-MM-DD или YYYY-MM-DDTHH:MM:SS с необязательным часовым поясом",
	)
}
