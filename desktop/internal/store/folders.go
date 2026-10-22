package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"rechiv/desktop/internal/domain"
)

var ErrInvalid = errors.New("invalid folder name, URL or folder ID")

type folderFile struct {
	Folders []domain.Folder `json:"folders"`
}

// ReadFolders используется и отдельным процессом MCP, без изменения файлов.
func ReadFolders(path string) []domain.Folder {
	folders, _ := readFolders(path)
	return folders
}

func readFolders(path string) (folders []domain.Folder, broken bool) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return []domain.Folder{}, false
	}

	var data struct {
		Folders []struct {
			domain.Folder
			Settings json.RawMessage `json:"settings"`
		} `json:"folders"`
	}

	if err == nil {
		err = json.Unmarshal(raw, &data)
	}

	if err != nil {
		log.Printf("warning: read folders %s: %v", path, err)
		return []domain.Folder{}, true
	}

	folders = make([]domain.Folder, 0, len(data.Folders))
	seen, rules := map[string]bool{}, map[string]bool{}
	for _, entry := range data.Folders {
		folder := entry.Folder
		if len(entry.Settings) > 0 {
			if err := json.Unmarshal(entry.Settings, &folder.Settings); err != nil {
				folder.Settings = domain.FolderSettings{}
			}
		}

		if template, err := domain.ValidateTitleTemplate(folder.Settings.TitleTemplate); err == nil {
			folder.Settings.TitleTemplate = template
		} else {
			folder.Settings.TitleTemplate = ""
		}
		if folder.Settings.RetentionDays < 0 {
			folder.Settings.RetentionDays = 0
		}

		folder.Name = strings.TrimSpace(folder.Name)
		if folder.ID == "" || seen[folder.ID] || folder.Name == "" {
			log.Printf("warning: folders %s: skip folder %q", path, folder.ID)
			continue
		}

		seen[folder.ID] = true
		folder.Color = (folder.Color%5 + 5) % 5
		kept := []domain.FolderRule{}
		for _, r := range folder.Rules {
			key := domain.NormalizeCallURL(r.URL)
			if key == "" || rules[key] {
				continue
			}
			rules[key] = true
			kept = append(kept, domain.FolderRule{URL: key})
		}
		folder.Rules = kept
		folders = append(folders, folder)
	}

	return folders, false
}

func copyFolders(folders []domain.Folder) []domain.Folder {
	result := make([]domain.Folder, len(folders))
	for i, f := range folders {
		result[i] = f
		result[i].Rules = append([]domain.FolderRule{}, f.Rules...)
	}

	return result
}

func (s *Store) Folders() []domain.Folder {
	s.mu.RLock()
	defer s.mu.RUnlock()

	return copyFolders(s.folders)
}

func folderIndex(folders []domain.Folder, id string) int {
	return slices.IndexFunc(folders, func(f domain.Folder) bool { return f.ID == id })
}

func (s *Store) saveFoldersLocked(folders []domain.Folder) error {
	raw, err := json.MarshalIndent(folderFile{folders}, "", "  ")
	if err != nil {
		return err
	}

	if s.foldersBroken {
		if err = os.Rename(s.foldersPath, s.foldersPath+".broken"); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		s.foldersBroken = false
	}

	if err = os.WriteFile(s.foldersPath+".tmp", raw, 0o600); err != nil {
		return err
	}

	if err = os.Rename(s.foldersPath+".tmp", s.foldersPath); err != nil {
		return err
	}

	s.folders = copyFolders(folders)
	s.notifyLocked()

	return nil
}

func (s *Store) FolderForCallURL(raw string) (domain.Folder, bool) {
	key := domain.NormalizeCallURL(raw)
	if key == "" {
		return domain.Folder{}, false
	}

	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, f := range s.folders {
		for _, r := range f.Rules {
			if r.URL == key {
				return copyFolders([]domain.Folder{f})[0], true
			}
		}
	}

	return domain.Folder{}, false
}

func (s *Store) CreateFolder(name string) (domain.Folder, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	name = strings.TrimSpace(name)
	if name == "" {
		return domain.Folder{}, ErrInvalid
	}

	id, err := newUUID()
	if err != nil {
		return domain.Folder{}, err
	}

	color := 0
	if len(s.folders) > 0 {
		color = (s.folders[len(s.folders)-1].Color + 1) % 5
	}

	f := domain.Folder{ID: id, Name: name, Color: color, Rules: []domain.FolderRule{}}

	return f, s.saveFoldersLocked(append(copyFolders(s.folders), f))
}

func (s *Store) RenameFolder(id, name string) (domain.Folder, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	i := folderIndex(s.folders, id)
	if i < 0 {
		return domain.Folder{}, ErrNotFound
	}

	name = strings.TrimSpace(name)
	if name == "" {
		return domain.Folder{}, ErrInvalid
	}

	folders := copyFolders(s.folders)
	folders[i].Name = name

	return folders[i], s.saveFoldersLocked(folders)
}

func (s *Store) DeleteFolder(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := folderIndex(s.folders, id)
	if i < 0 {
		return ErrNotFound
	}

	for _, session := range s.sessions {
		if session.FolderID == id {
			if err := s.setFolderLocked(session, "", false); err != nil {
				return err
			}
		}
	}

	return s.saveFoldersLocked(slices.Delete(copyFolders(s.folders), i, i+1))
}

func (s *Store) AddFolderRule(id, raw string) (domain.Folder, []string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	i := folderIndex(s.folders, id)
	if i < 0 {
		return domain.Folder{}, nil, ErrNotFound
	}

	key := domain.NormalizeCallURL(raw)
	if key == "" {
		return domain.Folder{}, nil, ErrInvalid
	}

	folders := copyFolders(s.folders)
	for j := range folders {
		folders[j].Rules = slices.DeleteFunc(folders[j].Rules, func(r domain.FolderRule) bool { return r.URL == key })
	}

	folders[i].Rules = append(folders[i].Rules, domain.FolderRule{URL: key})
	if err := s.saveFoldersLocked(folders); err != nil {
		return domain.Folder{}, nil, err
	}

	matching := []string{}
	for _, session := range s.sessions {
		if session.FolderID != id && domain.NormalizeCallURL(session.CallURL) == key {
			matching = append(matching, session.SessionID)
		}
	}

	slices.Sort(matching)

	return folders[i], matching, nil
}

func (s *Store) DeleteFolderRule(id, raw string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	i := folderIndex(s.folders, id)
	if i < 0 {
		return ErrNotFound
	}

	key := domain.NormalizeCallURL(raw)
	if key == "" {
		return ErrInvalid
	}

	folders := copyFolders(s.folders)
	folders[i].Rules = slices.DeleteFunc(folders[i].Rules, func(r domain.FolderRule) bool { return r.URL == key })

	return s.saveFoldersLocked(folders)
}

func (s *Store) setFolderLocked(session *domain.Session, id string, byRule bool) error {
	updated := clone(session)
	updated.FolderID = id
	updated.FolderByRule = id != "" && byRule
	if err := s.saveLocked(updated); err != nil {
		return err
	}
	s.sessions[session.SessionID] = updated

	return nil
}

func (s *Store) MoveSessions(ids []string, folderID string, byRule bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if folderID != "" && folderIndex(s.folders, folderID) < 0 {
		return ErrInvalid
	}

	for _, id := range ids {
		if _, ok := s.sessions[id]; !ok {
			return ErrNotFound
		}
	}

	for _, id := range ids {
		if err := s.setFolderLocked(s.sessions[id], folderID, byRule); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) ApplyFolderRule(id string) (*domain.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.sessions[id]
	if !ok {
		return nil, ErrNotFound
	}

	key := domain.NormalizeCallURL(session.CallURL)
	for _, f := range s.folders {
		for _, r := range f.Rules {
			if key != "" && r.URL == key {
				updated := clone(session)
				updated.FolderID = f.ID
				updated.FolderByRule = true
				if f.Settings.TitleTemplate != "" && (updated.Title == "" || updated.TitleAuto) {
					updated.Title = domain.RenderTitleTemplate(f.Settings.TitleTemplate, updated.CreatedAt, updated.Topic)
					updated.TitleAuto = true
				}
				if err := s.saveLocked(updated); err != nil {
					return nil, err
				}
				s.sessions[id] = updated
				return clone(updated), nil
			}
		}
	}

	return s.sessionViewLocked(session), nil
}

func (s *Store) sessionViewLocked(session *domain.Session) *domain.Session {
	result := clone(session)
	if folderIndex(s.folders, result.FolderID) < 0 {
		result.FolderID = ""
		result.FolderByRule = false
	}

	return result
}

func (s *Store) SetFolderSettings(id string, settings domain.FolderSettings) (domain.Folder, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := folderIndex(s.folders, id)
	if i < 0 {
		return domain.Folder{}, ErrNotFound
	}

	template, err := domain.ValidateTitleTemplate(settings.TitleTemplate)
	if err != nil {
		return domain.Folder{}, fmt.Errorf("%w: %v", ErrInvalid, err)
	}

	if settings.RetentionDays < 0 {
		return domain.Folder{}, fmt.Errorf("%w: срок хранения не может быть отрицательным", ErrInvalid)
	}

	settings.TitleTemplate = template
	folders := copyFolders(s.folders)
	folders[i].Settings = settings

	return folders[i], s.saveFoldersLocked(folders)
}

type FolderTitles struct {
	Renamed []string `json:"renamed"`
	Manual  []string `json:"manual"`
}

func (s *Store) folderTitlesLocked(id string) (FolderTitles, error) {
	result := FolderTitles{Renamed: []string{}, Manual: []string{}}
	i := folderIndex(s.folders, id)
	if i < 0 {
		return result, ErrNotFound
	}

	template := s.folders[i].Settings.TitleTemplate
	for _, session := range s.sessions {
		if session.FolderID != id {
			continue
		}
		if session.Title != "" && !session.TitleAuto {
			result.Manual = append(result.Manual, session.SessionID)
		} else if template != "" && session.Title != domain.RenderTitleTemplate(template, session.CreatedAt, session.Topic) {
			result.Renamed = append(result.Renamed, session.SessionID)
		}
	}

	slices.Sort(result.Renamed)
	slices.Sort(result.Manual)

	return result, nil
}

func (s *Store) PreviewFolderTitles(id string) (FolderTitles, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.folderTitlesLocked(id)
}

func (s *Store) ApplyFolderTitles(id string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	preview, err := s.folderTitlesLocked(id)
	if err != nil {
		return 0, err
	}
	template := s.folders[folderIndex(s.folders, id)].Settings.TitleTemplate
	for n, sessionID := range preview.Renamed {
		updated := clone(s.sessions[sessionID])
		updated.Title = domain.RenderTitleTemplate(template, updated.CreatedAt, updated.Topic)
		updated.TitleAuto = true
		if err := s.saveLocked(updated); err != nil {
			return n, err
		}
		s.sessions[sessionID] = updated
	}
	return len(preview.Renamed), nil
}

func (s *Store) PreviewFolderRetention(id string, days int, now time.Time) ([]string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if folderIndex(s.folders, id) < 0 {
		return nil, ErrNotFound
	}
	if days < 0 {
		return nil, ErrInvalid
	}
	result := []string{}
	for _, session := range s.sessions {
		if days > 0 && session.FolderID == id && session.Status != domain.StatusRecording && session.Status != domain.StatusProcessing && now.Sub(session.CreatedAt).Hours()/24 > float64(days) {
			result = append(result, session.SessionID)
		}
	}
	slices.Sort(result)
	return result, nil
}

func (s *Store) SetTopic(id, topic string) (*domain.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok := s.sessions[id]

	if !ok {
		return nil, ErrNotFound
	}

	if strings.ContainsAny(topic, "\r\n\u0085\u2028\u2029") || utf8.RuneCountInString(strings.TrimSpace(topic)) > 120 {
		return nil, fmt.Errorf("%w: тема должна быть одной строкой до 120 символов", ErrInvalid)
	}

	updated := clone(session)
	updated.Topic = strings.TrimSpace(topic)
	i := folderIndex(s.folders, updated.FolderID)
	if updated.TitleAuto && i >= 0 && s.folders[i].Settings.TitleTemplate != "" {
		updated.Title = domain.RenderTitleTemplate(s.folders[i].Settings.TitleTemplate, updated.CreatedAt, updated.Topic)
	}

	if err := s.saveLocked(updated); err != nil {
		return nil, err
	}

	s.sessions[id] = updated

	return s.sessionViewLocked(updated), nil
}
