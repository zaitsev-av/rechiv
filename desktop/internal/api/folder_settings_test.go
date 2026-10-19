package api

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"rechiv/desktop/internal/domain"
)

func TestFolderSettingsRoutes(t *testing.T) {
	server, c := newTestServer(t, healthyEngine())
	call := func(method, path, body string, code int) *httptest.ResponseRecorder {
		t.Helper()
		rec := httptest.NewRecorder()
		server.ServeHTTP(rec, request(method, path, strings.NewReader(body), testAPIToken))
		require.Equal(t, code, rec.Code, rec.Body.String())
		return rec
	}
	folder, err := c.Store().CreateFolder("Daily")
	require.NoError(t, err)
	path := "/folders/" + folder.ID
	var result domain.Folder
	require.NoError(t, json.Unmarshal(call("PUT", path+"/settings", `{"titleTemplate":" Дейли {date} ","retentionDays":30,"autoSummary":true}`, 200).Body.Bytes(), &result))
	require.Equal(t, domain.FolderSettings{TitleTemplate: "Дейли {date}", RetentionDays: 30, AutoSummary: true}, result.Settings)
	require.Contains(t, call("GET", "/folders", "", 200).Body.String(), `"settings"`)
	session, err := c.Store().Create("")
	require.NoError(t, err)
	call("PUT", "/sessions/"+session.SessionID+"/folder", `{"folderId":"`+folder.ID+`"}`, 200)
	require.JSONEq(t, `{"renamed":["`+session.SessionID+`"],"manual":[]}`, call("GET", path+"/titles", "", 200).Body.String())
	require.JSONEq(t, `{"renamed":1}`, call("POST", path+"/titles", "", 200).Body.String())
	require.Contains(t, call("GET", "/sessions/"+session.SessionID, "", 200).Body.String(), `"titleAuto":true`)
	require.JSONEq(t, `{"renamed":0}`, call("POST", path+"/titles", "", 200).Body.String())
	_, err = c.Store().SetTitle(session.SessionID, "Ручное")
	require.NoError(t, err)
	require.JSONEq(t, `{"renamed":[],"manual":["`+session.SessionID+`"]}`, call("GET", path+"/titles", "", 200).Body.String())
	require.JSONEq(t, `{"sessions":[]}`, call("GET", path+"/retention?days=1", "", 200).Body.String())
	for _, tt := range []struct {
		method, path, body string
		code               int
	}{
		{"PUT", path + "/settings", `{"titleTemplate":"{unknown}"}`, 422},
		{"PUT", path + "/settings", `{"titleTemplate":"{date}{date}"}`, 422},
		{"PUT", path + "/settings", `{"retentionDays":-1}`, 422},
		{"PUT", path + "/settings", `{`, 400},
		{"PUT", "/folders/missing/settings", `{}`, 404},
		{"GET", "/folders/missing/titles", "", 404},
		{"POST", "/folders/missing/titles", "", 404},
		{"GET", "/folders/missing/retention?days=1", "", 404},
		{"GET", path + "/retention?days=-1", "", 422},
		{"GET", path + "/retention?days=bad", "", 422},
		{"GET", path + "/retention?days=1.5", "", 422},
		{"GET", path + "/retention", "", 422},
	} {
		t.Run(tt.method+tt.path+tt.body, func(t *testing.T) { call(tt.method, tt.path, tt.body, tt.code) })
	}
	for _, tt := range []struct{ method, path string }{
		{"PUT", path + "/settings"}, {"GET", path + "/titles"}, {"POST", path + "/titles"}, {"GET", path + "/retention?days=1"},
	} {
		rec := httptest.NewRecorder()
		server.ServeHTTP(rec, request(tt.method, tt.path, nil, ""))
		require.Equal(t, 401, rec.Code)
	}
}
