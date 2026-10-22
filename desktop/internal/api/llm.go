package api

import (
	"context"
	"errors"
	"net/http"
	"os"

	"rechiv/desktop/internal/domain"
	"rechiv/desktop/internal/llm"
)

type llmClient interface {
	Check(ctx context.Context, config llm.Config) llm.CheckResult
}

type summaryGenerator interface {
	GenerateSummary(sessionID string) (bool, error)
}

// WithSummaries отдаёт саммари по кнопке фоновой задаче desktop: уход со страницы её не прерывает.
func WithSummaries(generator summaryGenerator) Option {
	return func(s *Server) {
		s.summaries = generator
	}
}

func WithLLM(settings *llm.Settings, client llmClient) Option {
	return func(s *Server) {
		s.llmSettings = settings
		s.llmClient = client
	}
}

// Ключ отдаётся только с токеном приложения; на диске он остаётся в Keychain.
type llmSettingsResponse struct {
	URL        string `json:"url"`
	Model      string `json:"model"`
	APIKey     string `json:"apiKey"`
	Configured bool   `json:"configured"`
}

type llmSettingsRequest struct {
	URL    string  `json:"url"`
	Model  string  `json:"model"`
	APIKey *string `json:"apiKey"`
}

func llmView(config llm.Config) llmSettingsResponse {
	return llmSettingsResponse{URL: config.URL, Model: config.Model, APIKey: config.APIKey, Configured: config.Configured()}
}

func (s *Server) llmReady(w http.ResponseWriter) bool {
	if s.llmSettings == nil {
		writeError(w, http.StatusNotFound, "Настройки LLM недоступны")
		return false
	}
	return true
}

func (s *Server) getLLMSettings(w http.ResponseWriter, _ *http.Request) {
	if !s.llmReady(w) {
		return
	}
	config, err := s.llmSettings.Load()
	if err != nil {
		s.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, llmView(config))
}

func (s *Server) putLLMSettings(w http.ResponseWriter, r *http.Request) {
	if !s.llmReady(w) {
		return
	}
	var body llmSettingsRequest
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	config, err := s.llmSettings.Save(body.URL, body.Model, body.APIKey)
	if errors.Is(err, llm.ErrInvalid) {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	if err != nil {
		s.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, llmView(config))
}

// checkLLM проверяет поля формы до сохранения; без нового ключа берётся сохранённый.
func (s *Server) checkLLM(w http.ResponseWriter, r *http.Request) {
	if !s.llmReady(w) {
		return
	}
	var body llmSettingsRequest
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	config := llm.Config{URL: clip(body.URL, 2048), Model: clip(body.Model, 200)}
	if body.APIKey != nil {
		config.APIKey = clip(*body.APIKey, 4096)
	} else {
		stored, err := s.llmSettings.Load()
		if err != nil {
			s.internalError(w, err)
			return
		}
		config.APIKey = stored.APIKey
	}
	if !config.Configured() {
		writeError(w, http.StatusUnprocessableEntity, "Для проверки нужны адрес, модель и токен.")
		return
	}
	writeJSON(w, http.StatusOK, s.llmClient.Check(r.Context(), config))
}

func (s *Server) generateSummary(w http.ResponseWriter, r *http.Request) {
	if !s.llmReady(w) {
		return
	}
	id := r.PathValue("id")
	session, err := s.controller.Store().Get(id)
	if err != nil {
		s.storeError(w, err)
		return
	}
	if session.Status != domain.StatusCompleted && session.Status != domain.StatusError {
		writeError(w, http.StatusConflict, "Транскрипт ещё не готов")
		return
	}
	config, err := s.llmSettings.Load()
	if err != nil {
		s.internalError(w, err)
		return
	}
	if !config.Configured() {
		writeError(w, http.StatusConflict, "LLM не подключён: укажите его в настройках Rechiv")
		return
	}
	if _, err := os.Stat(s.controller.TranscriptPath(id)); err != nil {
		s.storeError(w, err)
		return
	}
	if s.summaries == nil {
		writeError(w, http.StatusServiceUnavailable, "Генерация саммари недоступна")
		return
	}
	if _, err := s.summaries.GenerateSummary(id); err != nil {
		s.storeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, domain.SummaryJob{Running: true})
}
