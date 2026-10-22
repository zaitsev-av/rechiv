package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"rechiv/desktop/internal/domain"
	"rechiv/desktop/internal/llm"
	"rechiv/desktop/internal/secret"
)

type fakeLLMClient struct {
	checked llm.Config
}

type fakeSummaries struct {
	started []string
}

func (f *fakeSummaries) GenerateSummary(sessionID string) (bool, error) {
	f.started = append(f.started, sessionID)
	return true, nil
}

func (f *fakeLLMClient) Check(_ context.Context, config llm.Config) llm.CheckResult {
	f.checked = config
	return llm.CheckResult{State: "ok", Detail: "Модель «m» доступна"}
}

func TestLLMSettings(t *testing.T) {
	server, control := newTestServer(t, healthyEngine())
	dir := t.TempDir()
	settings := llm.NewSettings(dir, secret.File{Path: filepath.Join(dir, "key")})
	client := &fakeLLMClient{}
	WithLLM(settings, client)(server)
	summaries := &fakeSummaries{}
	WithSummaries(summaries)(server)
	call := func(method, path, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		server.ServeHTTP(rec, request(method, path, strings.NewReader(body), testAPIToken))
		return rec
	}

	require.JSONEq(t, `{"url":"","model":"","apiKey":"","configured":false}`, call("GET", "/settings/llm", "").Body.String())
	unauthorized := httptest.NewRecorder()
	server.ServeHTTP(unauthorized, request("GET", "/settings/llm", nil, ""))
	require.Equal(t, http.StatusUnauthorized, unauthorized.Code, "ключ отдаётся только с токеном приложения")
	require.Equal(t, http.StatusUnprocessableEntity, call("PUT", "/settings/llm", `{"url":"https://llm.example/v1","model":""}`).Code)

	saved := call("PUT", "/settings/llm", `{"url":"https://llm.example/v1","model":"m","apiKey":"sk-secret"}`)
	require.Equal(t, http.StatusOK, saved.Code)
	require.JSONEq(t, `{"url":"https://llm.example/v1","model":"m","apiKey":"sk-secret","configured":true}`, saved.Body.String())

	check := call("POST", "/settings/llm/check", `{"url":"https://llm.example/v1","model":"m"}`)
	require.JSONEq(t, `{"state":"ok","detail":"Модель «m» доступна"}`, check.Body.String())
	require.Equal(t, "sk-secret", client.checked.APIKey, "без нового ключа проверяется сохранённый")
	call("POST", "/settings/llm/check", `{"url":"https://llm.example/v1","model":"m","apiKey":"sk-new"}`)
	require.Equal(t, "sk-new", client.checked.APIKey)

	session, err := control.CreateSession("https://telemost.yandex.ru/j/1")
	require.NoError(t, err)
	require.Equal(t, http.StatusConflict, call("POST", "/sessions/"+session.SessionID+"/summary/generate", "").Code, "транскрипт ещё не готов")
	require.NoError(t, os.WriteFile(control.TranscriptPath(session.SessionID), []byte(`{"segments":[]}`), 0o600))
	require.NoError(t, control.Store().SetStatus(session.SessionID, domain.StatusCompleted, ""))

	generated := call("POST", "/sessions/"+session.SessionID+"/summary/generate", "")
	require.Equal(t, http.StatusAccepted, generated.Code)
	require.JSONEq(t, `{"running":true}`, generated.Body.String())
	require.Equal(t, []string{session.SessionID}, summaries.started, "саммари идёт в desktop, а не в запросе страницы")

	require.Equal(t, http.StatusOK, call("PUT", "/settings/llm", `{"url":"","model":"","apiKey":""}`).Code)
	require.Equal(t, http.StatusConflict, call("POST", "/sessions/"+session.SessionID+"/summary/generate", "").Code, "без LLM")
}
