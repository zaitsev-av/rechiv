package api

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"rechiv/desktop/internal/calls"
	"rechiv/desktop/internal/controller"
	"rechiv/desktop/internal/domain"
	"rechiv/desktop/internal/llm"
	"rechiv/desktop/internal/onboarding"
	"rechiv/desktop/internal/store"
)

const (
	DefaultExtensionID = "pabaipjlapdafgdfefmnnjecdcjdilhf"
	extensionIDAny     = "any"

	extensionVersionHeader = "X-Rechiv-Extension-Version"
	extensionOriginPrefix  = "chrome-extension://"

	developmentVersion = "dev"
)

var allowedPageOrigins = []string{
	"https://stream.wb.ru",
	"https://telemost.yandex.ru",
	"https://meet.google.com",
}

type Server struct {
	controller         *controller.Controller
	apiToken           string
	allowedExtensionID string
	expectedVersion    string
	logger             *log.Logger
	handler            http.Handler
	webUIDir           string
	onboarding         onboardingService
	appearanceMu       sync.Mutex
	extensionMu        sync.RWMutex
	lastExtension      *observedExtension
	calls              *calls.Hub
	done               chan struct{}
	llmSettings        *llm.Settings
	llmClient          llmClient
	summaries          summaryGenerator
	closeOnce          sync.Once
}

type Option func(*Server)

type onboardingService interface {
	State() onboarding.State
	OpenExtensions(bundleID string) error
	Reveal() error
}

type observedExtension struct {
	ID         string
	Version    string
	LastSeenAt time.Time
}

type extensionHealthResponse struct {
	ExpectedID      string     `json:"expectedId"`
	ExpectedVersion string     `json:"expectedVersion"`
	Installed       bool       `json:"installed"`
	ID              string     `json:"id"`
	Version         string     `json:"version"`
	LastSeenAt      *time.Time `json:"lastSeenAt"`
	Outdated        bool       `json:"outdated"`
}

func WithWebUI(dir string) Option {
	return func(s *Server) { s.webUIDir = dir }
}

func WithOnboarding(service onboardingService) Option {
	return func(s *Server) { s.onboarding = service }
}

type createSessionRequest struct {
	CallURL string `json:"callUrl"`
}

type updateTitleRequest struct {
	Title string `json:"title"`
}

type updateSpeakerRequest struct {
	SpeakerID string `json:"speakerId"`
	Name      string `json:"name"`
}

type sessionResponse struct {
	FolderID        string                  `json:"folderId"`
	FolderByRule    bool                    `json:"folderByRule"`
	CallKey         string                  `json:"callKey"`
	SessionID       string                  `json:"sessionId"`
	Status          domain.SessionStatus    `json:"status"`
	CallURL         string                  `json:"callUrl"`
	Title           string                  `json:"title,omitempty"`
	Topic           string                  `json:"topic,omitempty"`
	TitleAuto       bool                    `json:"titleAuto,omitempty"`
	CreatedAt       string                  `json:"createdAt"`
	FinishedAt      *string                 `json:"finishedAt"`
	Participants    map[string]*participant `json:"participants"`
	ChunksCount     int                     `json:"chunksCount"`
	ProcessedChunks int                     `json:"processedChunks"`
	FailedChunks    int                     `json:"failedChunks"`
	LastChunkAt     *string                 `json:"lastChunkAt,omitempty"`
	Progress        int                     `json:"progress"`
	Error           string                  `json:"error,omitempty"`
	UploadToken     string                  `json:"uploadToken,omitempty"`
	Duration        string                  `json:"duration,omitempty"`
	LivePanel       bool                    `json:"livePanel,omitempty"`
	AutoProcessing  *domain.AutoProcessing  `json:"autoProcessing,omitempty"`
	SummaryJob      *domain.SummaryJob      `json:"summaryJob,omitempty"`
}

type participant struct {
	SpeakerID string `json:"speakerId"`
	Name      string `json:"name,omitempty"`
	Intervals []any  `json:"intervals"`
}

func New(
	control *controller.Controller,
	apiToken string,
	allowedExtensionID string,
	expectedVersion string,
	logger *log.Logger,
	options ...Option,
) *Server {
	if logger == nil {
		logger = log.Default()
	}
	allowedExtensionID = strings.TrimSpace(allowedExtensionID)
	if allowedExtensionID == "" {
		allowedExtensionID = DefaultExtensionID
	}
	server := &Server{
		controller:         control,
		apiToken:           apiToken,
		allowedExtensionID: allowedExtensionID,
		expectedVersion:    expectedVersion,
		logger:             logger,
		done:               make(chan struct{}),
	}
	for _, option := range options {
		option(server)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /settings/appearance", server.getAppearance)
	mux.HandleFunc("PUT /settings/appearance", server.putAppearance)
	mux.HandleFunc("GET /settings/llm", server.getLLMSettings)
	mux.HandleFunc("PUT /settings/llm", server.putLLMSettings)
	mux.HandleFunc("POST /settings/llm/check", server.checkLLM)
	mux.HandleFunc("POST /sessions/{id}/summary/generate", server.generateSummary)

	mux.HandleFunc("PUT /folders/{id}/settings", server.setFolderSettings)
	mux.HandleFunc("GET /folders/{id}/titles", server.previewFolderTitles)
	mux.HandleFunc("POST /folders/{id}/titles", server.applyFolderTitles)
	mux.HandleFunc("GET /folders/{id}/retention", server.previewFolderRetention)
	mux.HandleFunc("GET /folders", server.listFolders)
	mux.HandleFunc("POST /folders", server.createFolder)
	mux.HandleFunc("PATCH /folders/{id}", server.renameFolder)
	mux.HandleFunc("DELETE /folders/{id}", server.deleteFolder)
	mux.HandleFunc("POST /folders/{id}/rules", server.addFolderRule)
	mux.HandleFunc("DELETE /folders/{id}/rules", server.deleteFolderRule)
	mux.HandleFunc("POST /folders/{id}/sessions", server.moveFolderSessions)
	mux.HandleFunc("PUT /sessions/{id}/folder", server.moveSession)
	mux.HandleFunc("POST /calls/poll", server.pollCalls)
	mux.HandleFunc("GET /events", server.events)
	mux.HandleFunc("GET /health", server.health)
	mux.HandleFunc("GET /auth/token", server.bootstrapToken)
	mux.HandleFunc("GET /onboarding/state", server.onboardingState)
	mux.HandleFunc("POST /onboarding/open-extensions", server.openExtensions)
	mux.HandleFunc("POST /onboarding/reveal", server.revealExtension)
	mux.HandleFunc("POST /sessions", server.createSession)
	mux.HandleFunc("GET /sessions", server.listSessions)
	mux.HandleFunc("GET /sessions/{id}", server.getSession)
	mux.HandleFunc("POST /sessions/{id}/chunks", server.uploadChunk)
	mux.HandleFunc("POST /sessions/{id}/vad", server.uploadVAD)
	mux.HandleFunc("POST /sessions/{id}/speakers", server.updateSpeaker)
	mux.HandleFunc("PUT /sessions/{id}/title", server.updateTitle)
	mux.HandleFunc("PUT /sessions/{id}/topic", server.updateTopic)
	mux.HandleFunc("POST /sessions/{id}/finish", server.finishSession)
	mux.HandleFunc("POST /sessions/{id}/retry", server.retrySession)
	mux.HandleFunc("GET /sessions/{id}/live", server.getLiveTranscript)
	mux.HandleFunc("GET /sessions/{id}/transcript", server.getTranscript)
	mux.HandleFunc("PUT /sessions/{id}/transcript", server.putTranscript)
	mux.HandleFunc("GET /sessions/{id}/summary", server.getSummary)
	mux.HandleFunc("PUT /sessions/{id}/summary", server.putSummary)
	mux.HandleFunc("DELETE /sessions/{id}", server.deleteSession)

	if server.webUIDir != "" {
		mux.Handle("GET /", http.FileServer(http.Dir(server.webUIDir)))
	}

	server.handler = server.middleware(mux)

	return server
}

func isWebUIPath(path string) bool {
	switch {
	case path == "/health", strings.HasPrefix(path, "/auth/"):
		return false
	case strings.HasPrefix(path, "/settings/"), strings.HasPrefix(path, "/onboarding/"):
		return false
	case path == "/folders", strings.HasPrefix(path, "/folders/"):
		return false
	case path == "/sessions", strings.HasPrefix(path, "/sessions/"):
		return false
	case path == "/events", strings.HasPrefix(path, "/calls/"):
		return false
	default:
		return true
	}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.handler.ServeHTTP(w, r)
}

func (s *Server) LastExtensionContact() time.Time {
	s.extensionMu.RLock()
	defer s.extensionMu.RUnlock()
	if s.lastExtension == nil {
		return time.Time{}
	}
	return s.lastExtension.LastSeenAt
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	engineState, engineDetail := s.controller.EngineStatus()
	engine := map[string]any{"status": string(engineState)}
	if engineDetail != "" {
		engine["error"] = engineDetail
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":       "ok",
		"authRequired": true,
		"service":      "rechiv-desktop",
		"engine":       engine,
		"extension":    s.extensionHealth(),
	})
}

func (s *Server) extensionHealth() extensionHealthResponse {
	s.extensionMu.RLock()
	defer s.extensionMu.RUnlock()

	expectedID := s.allowedExtensionID
	if expectedID == extensionIDAny {
		expectedID = DefaultExtensionID
	}

	result := extensionHealthResponse{
		ExpectedID:      expectedID,
		ExpectedVersion: s.expectedVersion,
	}

	if s.lastExtension == nil {
		return result
	}

	lastSeenAt := s.lastExtension.LastSeenAt
	result.Installed = true
	result.ID = s.lastExtension.ID
	result.Version = s.lastExtension.Version
	result.LastSeenAt = &lastSeenAt
	result.Outdated = extensionOutdated(s.lastExtension.Version, s.expectedVersion)

	return result
}

func extensionOutdated(actual, expected string) bool {
	if actual == "" || expected == "" || expected == developmentVersion {
		return false
	}

	return actual != expected
}

func (s *Server) bootstrapToken(w http.ResponseWriter, r *http.Request) {
	if !s.canBootstrapToken(r) {
		writeError(w, http.StatusForbidden, "Запрос должен исходить из расширения Rechiv")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"token": s.apiToken})
}

func (s *Server) onboardingState(w http.ResponseWriter, _ *http.Request) {
	if s.onboarding == nil {
		writeError(w, http.StatusServiceUnavailable, "Онбординг недоступен")
		return
	}

	writeJSON(w, http.StatusOK, s.onboarding.State())
}

func (s *Server) openExtensions(w http.ResponseWriter, r *http.Request) {
	if s.onboarding == nil {
		writeError(w, http.StatusServiceUnavailable, "Онбординг недоступен")
		return
	}

	var body struct {
		BundleID string `json:"bundleId"`
	}

	if err := decodeOptionalJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	if err := s.onboarding.OpenExtensions(body.BundleID); err != nil {
		if errors.Is(err, onboarding.ErrBrowserNotFound) || errors.Is(err, onboarding.ErrUnsupportedBrowser) {
			writeError(w, http.StatusUnprocessableEntity, err.Error())
			return
		}

		s.internalError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "opened"})
}

func (s *Server) revealExtension(w http.ResponseWriter, _ *http.Request) {
	if s.onboarding == nil {
		writeError(w, http.StatusServiceUnavailable, "Онбординг недоступен")
		return
	}

	if err := s.onboarding.Reveal(); err != nil {
		if errors.Is(err, onboarding.ErrExtensionNotFound) {
			writeError(w, http.StatusUnprocessableEntity, err.Error())
			return
		}

		s.internalError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "opened"})
}

func (s *Server) createSession(w http.ResponseWriter, r *http.Request) {
	var body createSessionRequest
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	if strings.TrimSpace(body.CallURL) == "" {
		writeError(w, http.StatusUnprocessableEntity, "callUrl обязателен")
		return
	}

	session, err := s.controller.CreateSession(body.CallURL)
	if err != nil {
		s.internalError(w, err)
		return
	}

	view := s.sessionView(session)
	if folder, ok := s.controller.Store().FolderForCallURL(session.CallURL); ok && folder.ID == session.FolderID {
		view.LivePanel = folder.Settings.LivePanel
	}
	writeJSON(w, http.StatusCreated, view)
}

func (s *Server) listSessions(w http.ResponseWriter, _ *http.Request) {
	sessions := s.controller.Store().List()
	result := make([]sessionResponse, 0, len(sessions))
	for _, session := range sessions {
		result = append(result, s.sessionView(session))
	}

	writeJSON(w, http.StatusOK, result)
}

func (s *Server) getSession(w http.ResponseWriter, r *http.Request) {
	session, err := s.controller.Store().Get(r.PathValue("id"))
	if err != nil {
		s.storeError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, s.sessionView(session))
}

func (s *Server) uploadChunk(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	session, err := s.controller.Store().Get(sessionID)
	if err != nil {
		s.storeError(w, err)
		return
	}

	if err := r.ParseMultipartForm(34 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "Некорректный multipart-запрос")
		return
	}

	if !s.authorized(r) && !tokensEqual(r.FormValue("uploadToken"), session.UploadToken) {
		writeError(w, http.StatusUnauthorized, "Неверный токен загрузки")
		return
	}

	speakerID := strings.TrimSpace(r.FormValue("speakerId"))
	if speakerID == "" {
		writeError(w, http.StatusUnprocessableEntity, "speakerId обязателен")
		return
	}

	offset, err := strconv.ParseFloat(r.FormValue("timestamp"), 64)
	if err != nil || offset < 0 {
		writeError(w, http.StatusUnprocessableEntity, "timestamp должен быть неотрицательным числом")
		return
	}

	file, _, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "file обязателен")
		return
	}

	defer file.Close()
	attributedTo := strings.TrimSpace(r.FormValue("attributedTo"))
	index, err := s.controller.UploadChunk(
		r.Context(),
		sessionID,
		speakerID,
		attributedTo,
		offset,
		file,
	)

	if errors.Is(err, controller.ErrQueueBusy) {
		w.Header().Set("Retry-After", "5")
		writeError(w, http.StatusServiceUnavailable, "Очередь распознавания переполнена, повторите позже")
		return
	}
	if err != nil {
		s.internalError(w, err)
		return
	}

	writeJSON(w, http.StatusAccepted, map[string]any{
		"accepted":   true,
		"status":     "queued",
		"chunkIndex": index,
	})
}

func (s *Server) uploadVAD(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	session, err := s.controller.Store().Get(sessionID)
	if err != nil {
		s.storeError(w, err)
		return
	}

	var body struct {
		controller.VADTimeline
		UploadToken string `json:"uploadToken"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	if !s.authorized(r) && !tokensEqual(body.UploadToken, session.UploadToken) {
		writeError(w, http.StatusUnauthorized, "Неверный токен загрузки")
		return
	}

	if err := s.controller.SaveVADTimeline(sessionID, body.VADTimeline); err != nil {
		if errors.Is(err, controller.ErrInvalidVADTimeline) {
			writeError(w, http.StatusUnprocessableEntity, err.Error())
			return
		}
		s.storeError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "stored"})
}

func (s *Server) updateSpeaker(w http.ResponseWriter, r *http.Request) {
	var body updateSpeakerRequest
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	if strings.TrimSpace(body.SpeakerID) == "" || strings.TrimSpace(body.Name) == "" {
		writeError(w, http.StatusUnprocessableEntity, "speakerId и name обязательны")
		return
	}

	session, err := s.controller.Store().UpdateSpeaker(r.PathValue("id"), body.SpeakerID, body.Name)
	if err != nil {
		s.storeError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, s.sessionView(session))
}

func (s *Server) updateTopic(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Topic string `json:"topic"`
	}
	if !folderBody(w, r, &body) {
		return
	}
	session, err := s.controller.Store().SetTopic(r.PathValue("id"), body.Topic)
	if err != nil {
		s.folderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.sessionView(session))
}

func (s *Server) updateTitle(w http.ResponseWriter, r *http.Request) {
	var body updateTitleRequest
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	session, err := s.controller.Store().SetTitle(r.PathValue("id"), strings.TrimSpace(body.Title))
	if err != nil {
		s.storeError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, s.sessionView(session))
}

func (s *Server) finishSession(w http.ResponseWriter, r *http.Request) {
	if err := s.controller.FinishSession(r.PathValue("id")); err != nil {
		s.storeError(w, err)
		return
	}

	writeJSON(w, http.StatusAccepted, map[string]any{"accepted": true, "status": "processing"})
}

func (s *Server) retrySession(w http.ResponseWriter, r *http.Request) {
	if err := s.controller.RetryFailed(r.PathValue("id")); err != nil {
		if controller.IsNotFound(err) {
			writeError(w, http.StatusNotFound, "Session not found")
		} else {
			writeError(w, http.StatusConflict, err.Error())
		}
		return
	}

	writeJSON(w, http.StatusAccepted, map[string]any{"accepted": true, "status": "processing"})
}

func (s *Server) getLiveTranscript(w http.ResponseWriter, r *http.Request) {
	transcript, err := s.controller.LiveTranscript(r.PathValue("id"))
	if err != nil {
		s.storeError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, transcript)
}

func (s *Server) getTranscript(w http.ResponseWriter, r *http.Request) {
	transcript, err := s.controller.Transcript(r.PathValue("id"))
	if err != nil {
		if controller.IsNotFound(err) {
			writeError(w, http.StatusNotFound, "Session not found")
			return
		}
		writeError(w, http.StatusNotFound, "Transcript not found")
		return
	}

	writeJSON(w, http.StatusOK, transcript)
}

func (s *Server) putTranscript(w http.ResponseWriter, r *http.Request) {
	if _, err := s.controller.Store().Get(r.PathValue("id")); err != nil {
		s.storeError(w, err)
		return
	}

	s.putJSONFile(w, r, s.controller.TranscriptPath(r.PathValue("id")))
}

func (s *Server) getSummary(w http.ResponseWriter, r *http.Request) {
	if _, err := s.controller.Store().Get(r.PathValue("id")); err != nil {
		s.storeError(w, err)
		return
	}

	s.serveJSONFile(w, s.controller.SummaryPath(r.PathValue("id")), "Summary not found")
}

func (s *Server) putSummary(w http.ResponseWriter, r *http.Request) {
	if _, err := s.controller.Store().Get(r.PathValue("id")); err != nil {
		s.storeError(w, err)
		return
	}
	var body any
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := s.controller.WriteSummary(r.PathValue("id"), body, false); err != nil {
		s.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, body)
}

func (s *Server) deleteSession(w http.ResponseWriter, r *http.Request) {
	if err := s.controller.DeleteSession(r.PathValue("id")); err != nil {
		s.storeError(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) serveJSONFile(w http.ResponseWriter, path, notFoundMessage string) {
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		writeError(w, http.StatusNotFound, notFoundMessage)
		return
	}

	if err != nil {
		s.internalError(w, err)
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}

func (s *Server) putJSONFile(w http.ResponseWriter, r *http.Request, path string) {
	var body any
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	if err := controller.WriteJSON(path, body); err != nil {
		s.internalError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, body)
}

func (s *Server) sessionView(session *domain.Session) sessionResponse {
	participants := make(map[string]*participant, len(session.Participants))
	for id, item := range session.Participants {
		participants[id] = &participant{
			SpeakerID: item.SpeakerID,
			Name:      item.Name,
			Intervals: []any{},
		}
	}

	var finishedAt *string
	if session.FinishedAt != nil {
		value := session.FinishedAt.Format("2006-01-02T15:04:05.999999999Z07:00")
		finishedAt = &value
	}

	var lastChunkAt *string
	if session.LastChunkAt != nil {
		value := session.LastChunkAt.Format("2006-01-02T15:04:05.999999999Z07:00")
		lastChunkAt = &value
	}

	progress := 0
	if session.ChunksCount > 0 {
		progress = session.ProcessedChunks * 100 / session.ChunksCount
	}

	if session.Status == domain.StatusCompleted {
		progress = 100
	}

	response := sessionResponse{
		FolderID: session.FolderID, FolderByRule: session.FolderByRule, CallKey: domain.NormalizeCallURL(session.CallURL),
		SessionID:       session.SessionID,
		Status:          session.Status,
		CallURL:         session.CallURL,
		Title:           session.Title,
		TitleAuto:       session.TitleAuto,
		Topic:           session.Topic,
		CreatedAt:       session.CreatedAt.Format("2006-01-02T15:04:05.999999999Z07:00"),
		FinishedAt:      finishedAt,
		Participants:    participants,
		ChunksCount:     session.ChunksCount,
		ProcessedChunks: session.ProcessedChunks,
		FailedChunks:    session.FailedChunks,
		LastChunkAt:     lastChunkAt,
		Progress:        progress,
		Error:           session.Error,
		UploadToken:     session.UploadToken,
		AutoProcessing:  session.AutoProcessing,
		SummaryJob:      session.SummaryJob,
	}

	if session.Status == domain.StatusCompleted || session.Status == domain.StatusError {
		var transcript struct {
			Duration string `json:"duration"`
		}
		if err := controller.ReadJSON(s.controller.TranscriptPath(session.SessionID), &transcript); err == nil {
			response.Duration = transcript.Duration
		}
	}

	return response
}

func (s *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		origin := r.Header.Get("Origin")

		if strings.HasPrefix(origin, extensionOriginPrefix) && !s.validExtensionOrigin(origin) {
			writeError(w, http.StatusForbidden, "Запрос должен исходить из расширения Rechiv")
			return
		}

		s.noteExtensionFromRequest(r)
		if origin != "" && (s.validExtensionOrigin(origin) || allowedPageOrigin(origin)) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, "+extensionVersionHeader)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		}

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		if r.URL.Path == "/health" || r.URL.Path == "/auth/token" || r.URL.Path == "/events" {
			next.ServeHTTP(w, r)
			return
		}

		if s.webUIDir != "" && isWebUIPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}

		if strings.HasSuffix(r.URL.Path, "/chunks") || strings.HasSuffix(r.URL.Path, "/vad") {
			next.ServeHTTP(w, r)
			return
		}

		if !s.authorized(r) {
			writeError(w, http.StatusUnauthorized, "Missing or invalid bearer token")
			return
		}

		next.ServeHTTP(w, r)
	})
}

func (s *Server) authorized(r *http.Request) bool {
	value := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))

	return tokensEqual(value, s.apiToken)
}

func allowedPageOrigin(origin string) bool {
	return slices.Contains(allowedPageOrigins, origin)
}

func (s *Server) validExtensionOrigin(origin string) bool {
	id, ok := extensionIDFromOrigin(origin)

	return ok && (s.allowedExtensionID == extensionIDAny || id == s.allowedExtensionID)
}

func extensionIDFromOrigin(origin string) (string, bool) {
	if !strings.HasPrefix(origin, extensionOriginPrefix) {
		return "", false
	}

	id := strings.TrimSuffix(strings.TrimPrefix(origin, extensionOriginPrefix), "/")
	if id == "" || strings.Contains(id, "/") {
		return "", false
	}

	return id, true
}

func (s *Server) noteExtensionFromRequest(r *http.Request) {
	version := r.Header.Get(extensionVersionHeader)
	origin := r.Header.Get("Origin")
	if id, ok := extensionIDFromOrigin(origin); ok && s.validExtensionOrigin(origin) {
		s.noteExtension(id, version)
		return
	}

	if origin == "" && strings.TrimSpace(version) != "" && r.Header.Get("Sec-Fetch-Site") == "none" {
		s.noteExtension("", version)
	}
}

func (s *Server) noteExtension(id, version string) {
	s.extensionMu.Lock()
	defer s.extensionMu.Unlock()
	version = strings.TrimSpace(version)
	if last := s.lastExtension; last != nil {
		if version == "" {
			version = last.Version
		}
		if id == "" {
			id = last.ID
		}
	}
	s.lastExtension = &observedExtension{
		ID:         id,
		Version:    version,
		LastSeenAt: time.Now().UTC(),
	}
}

func (s *Server) canBootstrapToken(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin != "" {
		return s.validExtensionOrigin(origin)
	}

	switch r.Header.Get("Sec-Fetch-Site") {
	case "none":
		return true
	case "same-origin":
		return s.webUIDir != ""
	default:
		return false
	}
}

func (s *Server) storeError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "Session not found")
		return
	}

	s.internalError(w, err)
}

func (s *Server) internalError(w http.ResponseWriter, err error) {
	s.logger.Printf("request failed: %v", err)
	writeError(w, http.StatusInternalServerError, err.Error())
}

func decodeJSON(r *http.Request, target any) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 2*1024*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}

	return nil
}

func decodeOptionalJSON(r *http.Request, target any) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 2*1024*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil && !errors.Is(err, io.EOF) {
		return fmt.Errorf("некорректный JSON: %w", err)
	}

	return nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"detail": message})
}

func tokensEqual(left, right string) bool {
	if left == "" || right == "" || len(left) != len(right) {
		return false
	}

	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}
