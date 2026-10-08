package store

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"rechiv/desktop/internal/domain"
	"rechiv/desktop/internal/security"
)

var ErrNotFound = errors.New("session not found")

type Store struct {
	mu          sync.RWMutex
	sessionsDir string
	sessions    map[string]*domain.Session
}

func New(dataDir string) (*Store, error) {
	sessionsDir := filepath.Join(dataDir, "sessions")
	if err := os.MkdirAll(sessionsDir, 0o700); err != nil {
		return nil, err
	}

	s := &Store{sessionsDir: sessionsDir, sessions: make(map[string]*domain.Session)}
	if err := s.load(); err != nil {
		return nil, err
	}

	return s, nil
}

func (s *Store) SessionsDir() string {
	return s.sessionsDir
}

func (s *Store) SessionDir(id string) string {
	return filepath.Join(s.sessionsDir, id)
}

func (s *Store) Create(callURL string) (*domain.Session, error) {
	id, err := newUUID()
	if err != nil {
		return nil, err
	}

	uploadToken, err := security.RandomToken()
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	session := &domain.Session{
		SessionID:          id,
		Status:             domain.StatusRecording,
		CallURL:            callURL,
		CreatedAt:          now,
		Participants:       make(map[string]*domain.Participant),
		UploadToken:        uploadToken,
		NextChunkBySpeaker: make(map[string]int),
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	sessionDir := s.SessionDir(id)
	for _, dir := range []string{sessionDir, filepath.Join(sessionDir, "chunks"), filepath.Join(sessionDir, "jobs")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, err
		}
	}

	s.sessions[id] = session
	if err := s.saveLocked(session); err != nil {
		delete(s.sessions, id)
		return nil, err
	}

	return clone(session), nil
}

func (s *Store) Get(id string) (*domain.Session, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	session, ok := s.sessions[id]
	if !ok {
		return nil, ErrNotFound
	}

	return clone(session), nil
}

func (s *Store) List() []*domain.Session {
	s.mu.RLock()
	defer s.mu.RUnlock()

	items := make([]*domain.Session, 0, len(s.sessions))
	for _, session := range s.sessions {
		items = append(items, clone(session))
	}

	sort.Slice(items, func(i, j int) bool {
		return items[i].CreatedAt.After(items[j].CreatedAt)
	})

	return items
}

func (s *Store) ReserveChunk(id, speakerID string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.sessions[id]
	if !ok {
		return 0, ErrNotFound
	}

	if session.Status != domain.StatusRecording {
		return 0, fmt.Errorf("session is not recording")
	}

	index := session.NextChunkBySpeaker[speakerID]
	session.NextChunkBySpeaker[speakerID] = index + 1
	session.ChunksCount++

	now := time.Now().UTC()
	session.LastChunkAt = &now
	if _, ok := session.Participants[speakerID]; !ok {
		session.Participants[speakerID] = &domain.Participant{SpeakerID: speakerID}
	}

	if err := s.saveLocked(session); err != nil {
		return 0, err
	}

	return index, nil
}

func (s *Store) CancelChunk(id, speakerID string, index int) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.sessions[id]
	if !ok {
		return ErrNotFound
	}

	if session.ChunksCount > 0 {
		session.ChunksCount--
	}

	if session.NextChunkBySpeaker[speakerID] == index+1 {
		session.NextChunkBySpeaker[speakerID] = index
	}

	return s.saveLocked(session)
}

func (s *Store) UpdateSpeaker(id, speakerID, name string) (*domain.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.sessions[id]
	if !ok {
		return nil, ErrNotFound
	}

	participant, ok := session.Participants[speakerID]
	if !ok {
		participant = &domain.Participant{SpeakerID: speakerID}
		session.Participants[speakerID] = participant
	}

	participant.Name = name

	if err := s.saveLocked(session); err != nil {
		return nil, err
	}

	return clone(session), nil
}

func (s *Store) SetTitle(id, title string) (*domain.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.sessions[id]
	if !ok {
		return nil, ErrNotFound
	}

	session.Title = title
	if err := s.saveLocked(session); err != nil {
		return nil, err
	}

	return clone(session), nil
}

func (s *Store) SetStatus(id string, status domain.SessionStatus, message string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.sessions[id]
	if !ok {
		return ErrNotFound
	}

	session.Status = status
	session.Error = message

	if status == domain.StatusCompleted || status == domain.StatusError {
		now := time.Now().UTC()
		session.FinishedAt = &now
	}

	return s.saveLocked(session)
}

func (s *Store) SetProgress(id string, processed, failed int) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.sessions[id]
	if !ok {
		return ErrNotFound
	}

	// Старт сверяет прогресс всех сессий и без этой проверки переписывал бы каждую.
	if session.ProcessedChunks == processed && session.FailedChunks == failed {
		return nil
	}
	session.ProcessedChunks = processed
	session.FailedChunks = failed

	return s.saveLocked(session)
}

func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.sessions[id]; !ok {
		return ErrNotFound
	}

	if err := os.RemoveAll(s.SessionDir(id)); err != nil {
		return err
	}

	delete(s.sessions, id)

	return nil
}

func (s *Store) load() error {
	entries, err := os.ReadDir(s.sessionsDir)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		path := filepath.Join(s.sessionsDir, entry.Name(), "meta.json")
		raw, err := os.ReadFile(path)
		if os.IsNotExist(err) {
			continue
		}

		if err != nil {
			return err
		}

		var session domain.Session
		if err := json.Unmarshal(raw, &session); err != nil {
			return fmt.Errorf("load %s: %w", path, err)
		}

		if session.Participants == nil {
			session.Participants = make(map[string]*domain.Participant)
		}

		if session.NextChunkBySpeaker == nil {
			session.NextChunkBySpeaker = make(map[string]int)
		}

		s.sessions[session.SessionID] = &session
	}

	return nil
}

func (s *Store) saveLocked(session *domain.Session) error {
	path := filepath.Join(s.SessionDir(session.SessionID), "meta.json")

	raw, err := json.MarshalIndent(session, "", "  ")
	if err != nil {
		return err
	}

	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}

	return os.Rename(tmp, path)
}

func clone(session *domain.Session) *domain.Session {
	raw, _ := json.Marshal(session)

	var result domain.Session
	_ = json.Unmarshal(raw, &result)

	return &result
}

func newUUID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}

	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	buf := make([]byte, 36)

	hex.Encode(buf[0:8], value[0:4])
	buf[8] = '-'
	hex.Encode(buf[9:13], value[4:6])
	buf[13] = '-'
	hex.Encode(buf[14:18], value[6:8])
	buf[18] = '-'
	hex.Encode(buf[19:23], value[8:10])
	buf[23] = '-'
	hex.Encode(buf[24:36], value[10:16])

	return string(buf), nil
}
