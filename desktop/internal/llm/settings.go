package llm

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"rechiv/desktop/internal/secret"
)

var ErrInvalid = errors.New("invalid llm settings")

// Settings хранит адрес и модель в файле, а ключ — в secret.Store.
type Settings struct {
	mu     sync.Mutex
	path   string
	secret secret.Store
}

func NewSettings(dataDir string, store secret.Store) *Settings {
	return &Settings{path: filepath.Join(dataDir, "llm.json"), secret: store}
}

func (s *Settings) Load() (Config, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked()
}

func (s *Settings) loadLocked() (Config, error) {
	var config Config
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return config, nil
	}
	if err != nil {
		return config, err
	}
	if err := json.Unmarshal(raw, &config); err != nil {
		return Config{}, fmt.Errorf("%s: %w", s.path, err)
	}
	config.APIKey, err = s.secret.Get()
	return config, err
}

// Save: nil apiKey оставляет сохранённый ключ. Три поля — все или ни одного:
// половина выглядела бы рабочей настройкой.
func (s *Settings) Save(rawURL, model string, apiKey *string) (Config, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.loadLocked()
	if err != nil {
		return Config{}, err
	}
	config := Config{URL: strings.TrimRight(strings.TrimSpace(rawURL), "/"), Model: strings.TrimSpace(model), APIKey: current.APIKey}
	if apiKey != nil {
		config.APIKey = strings.TrimSpace(*apiKey)
	}
	if config.URL == "" && config.Model == "" && (apiKey == nil || config.APIKey == "") {
		if err := s.secret.Delete(); err != nil {
			return Config{}, err
		}
		if err := os.Remove(s.path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return Config{}, err
		}
		return Config{}, nil
	}
	if !config.Configured() {
		return Config{}, fmt.Errorf("%w: заполните адрес, модель и токен — или очистите все три", ErrInvalid)
	}
	if parsed, err := url.Parse(config.URL); err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return Config{}, fmt.Errorf("%w: адрес должен начинаться с http:// или https://", ErrInvalid)
	}
	if apiKey != nil && config.APIKey != current.APIKey {
		if err := s.secret.Set(config.APIKey); err != nil {
			return Config{}, err
		}
	}
	raw, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return Config{}, err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return Config{}, err
	}
	if err := os.WriteFile(s.path+".tmp", raw, 0o600); err != nil {
		return Config{}, err
	}
	return config, os.Rename(s.path+".tmp", s.path)
}
