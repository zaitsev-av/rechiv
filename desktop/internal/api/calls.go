package api

import (
	"net/http"
	"strings"
	"time"

	"rechiv/desktop/internal/calls"
)

// Меньше таймаута записи сервера и с запасом под засыпание service worker (30 с).
const maxCallPollWait = 25 * time.Second

func WithCalls(hub *calls.Hub) Option {
	return func(s *Server) { s.calls = hub }
}

type callPollRequest struct {
	Call *calls.Call `json:"call"`
	Wait int         `json:"wait"`
}

type callPollResponse struct {
	Command calls.Command `json:"command,omitempty"`
	// Auto — запись начинает настройка папки, а не пользователь: расширение предупредит об этом.
	Auto bool `json:"auto,omitempty"`
}

func (s *Server) pollCalls(w http.ResponseWriter, r *http.Request) {
	if s.calls == nil {
		writeError(w, http.StatusNotFound, "Канал созвонов не настроен")
		return
	}
	var body callPollRequest
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.Call != nil {
		body.Call.Platform = clip(body.Call.Platform, 60)
		body.Call.Title = clip(body.Call.Title, 200)
		body.Call.URL = clip(body.Call.URL, 2048)
		body.Call.SessionID = clip(body.Call.SessionID, 100)
	}
	s.calls.Report(body.Call)

	var response callPollResponse
	if s.shouldAutoStart(body.Call) {
		s.logger.Printf("calls: auto-recording %s by folder setting", body.Call.Platform)
		response.Command = calls.CommandStart
		response.Auto = true
	} else if body.Call != nil && body.Wait > 0 {
		wait := min(time.Duration(body.Wait)*time.Second, maxCallPollWait)
		response.Command = s.calls.Wait(r.Context(), wait)
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) shouldAutoStart(call *calls.Call) bool {
	if call == nil || !call.Joined || call.Recording {
		return false
	}
	folder, ok := s.controller.Store().FolderForCallURL(call.URL)
	return ok && folder.Settings.AutoRecord && s.calls.ClaimAutoStart(call.URL)
}

func clip(text string, limit int) string {
	runes := []rune(strings.TrimSpace(text))
	if len(runes) > limit {
		runes = runes[:limit]
	}
	return string(runes)
}
