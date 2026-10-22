package api

import (
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"rechiv/desktop/internal/controller"
	"rechiv/desktop/internal/store"
)

func TestAppearance(t *testing.T) {
	dataDir := t.TempDir()
	sessions, err := store.New(dataDir)
	require.NoError(t, err)
	control := controller.New(sessions, nil, nil, log.New(io.Discard, "", 0))
	newServer := func() *Server {
		return New(control, testAPIToken, "", "dev", nil, WithWebUI(t.TempDir()))
	}
	server := newServer()
	call := func(method, body, token, condition string) *httptest.ResponseRecorder {
		req := request(method, "/settings/appearance", strings.NewReader(body), token)
		req.Header.Set("If-None-Match", condition)
		rec := httptest.NewRecorder()
		server.ServeHTTP(rec, req)
		return rec
	}
	for _, method := range []string{"GET", "PUT"} {
		require.Equal(t, http.StatusUnauthorized, call(method, `{}`, "", "").Code)
	}
	response := call("GET", "", testAPIToken, "")
	require.Equal(t, http.StatusOK, response.Code)
	require.JSONEq(t, `{"theme":"","palette":""}`, response.Body.String())
	for _, tt := range []struct {
		body string
		code int
	}{
		{`{`, 400}, {`[]`, 400}, {`{"theme":true}`, 400},
		{`{"theme":"dark","palette":"stone","extra":1}`, 400},
		{`{"theme":"dark","palette":"stone"} {}`, 400},
		{`null`, 422}, {`{}`, 422}, {`{"theme":"dark"}`, 422},
		{`{"theme":"system","palette":"stone"}`, 422},
		{`{"theme":"dark","palette":"purple"}`, 422},
		{`{"theme":"","palette":""}`, 422},
	} {
		t.Run(tt.body, func(t *testing.T) { require.Equal(t, tt.code, call("PUT", tt.body, testAPIToken, "").Code) })
	}
	for _, theme := range []string{"light", "dark"} {
		for _, palette := range []string{"graphite", "stone", "amber"} {
			body := `{"theme":"` + theme + `","palette":"` + palette + `"}`
			response = call("PUT", body, testAPIToken, "")
			require.Equal(t, 200, response.Code)
			require.JSONEq(t, body, response.Body.String())
			server = newServer()
			require.JSONEq(t, body, call("GET", "", testAPIToken, "").Body.String())
			raw, err := os.ReadFile(filepath.Join(dataDir, "appearance.json"))
			require.NoError(t, err)
			require.JSONEq(t, body, string(raw))
		}
	}
	require.NoFileExists(t, server.appearancePath()+".tmp")
	require.Equal(t, 405, call("POST", `{}`, testAPIToken, "").Code)
	require.NoError(t, os.WriteFile(server.appearancePath(), []byte(`broken`), 0600))
	require.Equal(t, 500, call("GET", "", testAPIToken, "").Code)
	require.NoError(t, os.Remove(server.appearancePath()))
	require.NoError(t, os.Mkdir(server.appearancePath(), 0700))
	require.Equal(t, 500, call("PUT", `{"theme":"light","palette":"stone"}`, testAPIToken, "").Code)
}
