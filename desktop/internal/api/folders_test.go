package api

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"rechiv/desktop/internal/domain"
)

func TestFolderRoutes(t *testing.T) {
	server, control := newTestServer(t, healthyEngine())
	call := func(method, path, body string, code int) *httptest.ResponseRecorder {
		t.Helper()
		rec := httptest.NewRecorder()
		server.ServeHTTP(rec, request(method, path, strings.NewReader(body), testAPIToken))
		require.Equal(t, code, rec.Code, rec.Body.String())
		return rec
	}
	require.JSONEq(t, `[]`, call("GET", "/folders", "", 200).Body.String())
	var folder domain.Folder
	require.NoError(t, json.Unmarshal(call("POST", "/folders", `{"name":"Дейли"}`, 201).Body.Bytes(), &folder))
	path := "/folders/" + folder.ID
	call("PATCH", path, `{"name":"Ретро"}`, 200)
	require.Contains(t, call("GET", "/folders", "", 200).Body.String(), "Ретро")
	session, err := control.Store().Create("https://meet.google.com/room?x=1")
	require.NoError(t, err)
	var rule struct {
		Folder   domain.Folder `json:"folder"`
		Matching []string      `json:"matching"`
	}
	require.NoError(t, json.Unmarshal(call("POST", path+"/rules", `{"url":"https://meet.google.com/room/"}`, 200).Body.Bytes(), &rule))
	require.Equal(t, []string{session.SessionID}, rule.Matching)
	sessionPath := "/sessions/" + session.SessionID + "/folder"
	var view sessionResponse
	require.NoError(t, json.Unmarshal(call("PUT", sessionPath, `{"folderId":"`+folder.ID+`"}`, 200).Body.Bytes(), &view))
	require.Equal(t, folder.ID, view.FolderID)
	require.False(t, view.FolderByRule)
	require.Equal(t, "meet.google.com/room", view.CallKey)
	call("PUT", sessionPath, `{"folderId":""}`, 200)
	call("POST", path+"/sessions", `{"sessionIds":["`+session.SessionID+`"],"byRule":true}`, 204)
	require.NoError(t, json.Unmarshal(call("GET", "/sessions/"+session.SessionID, "", 200).Body.Bytes(), &view))
	require.True(t, view.FolderByRule)
	call("DELETE", path+"/rules?url=https%3A%2F%2Fmeet.google.com%2Froom%3Fx%3D2", "", 204)
	saved, err := control.Store().Get(session.SessionID)
	require.NoError(t, err)
	require.Equal(t, folder.ID, saved.FolderID)
	call("DELETE", path, "", 204)
	saved, err = control.Store().Get(session.SessionID)
	require.NoError(t, err)
	require.Empty(t, saved.FolderID)
	require.False(t, saved.FolderByRule)
	for _, tt := range []struct {
		method, path, body string
		code               int
	}{
		{"POST", "/folders", `{"name":" "}`, 422}, {"POST", "/folders", `{`, 400},
		{"PATCH", path, `{"name":"name"}`, 404}, {"DELETE", path, "", 404},
		{"POST", path + "/rules", `{"url":"meet.google.com/room"}`, 404},
		{"DELETE", path + "/rules?url=meet.google.com/room", "", 404},
		{"POST", path + "/sessions", `{"sessionIds":[]}`, 404},
		{"PUT", sessionPath, `{"folderId":"missing"}`, 422},
		{"PUT", "/sessions/missing/folder", `{"folderId":""}`, 404},
	} {
		t.Run(tt.method+tt.path, func(t *testing.T) { call(tt.method, tt.path, tt.body, tt.code) })
	}
	require.NoError(t, json.Unmarshal(call("POST", "/folders", `{"name":"New"}`, 201).Body.Bytes(), &folder))
	path = "/folders/" + folder.ID
	call("PATCH", path, `{"name":""}`, 422)
	call("POST", path+"/rules", `{"url":"bad"}`, 422)
	call("DELETE", path+"/rules?url=bad", "", 422)
	call("POST", path+"/sessions", `{"sessionIds":["missing"],"byRule":true}`, 404)
	for _, tt := range []struct{ method, path string }{
		{"PATCH", path}, {"POST", path + "/rules"}, {"POST", path + "/sessions"}, {"PUT", sessionPath},
	} {
		call(tt.method, tt.path, `{`, 400)
	}
}

func TestFolderRoutesRequireAuthWithWebUI(t *testing.T) {
	server, control := newTestServer(t, healthyEngine())
	server = New(control, testAPIToken, "", testExpectedVersion, nil, WithWebUI(t.TempDir()))
	for _, tt := range []struct{ method, path string }{
		{"PUT", "/folders/id/settings"}, {"GET", "/folders/id/titles"}, {"POST", "/folders/id/titles"}, {"GET", "/folders/id/retention?days=1"},
		{"GET", "/folders"}, {"POST", "/folders"}, {"PATCH", "/folders/id"}, {"DELETE", "/folders/id"},
		{"POST", "/folders/id/rules"}, {"DELETE", "/folders/id/rules?url=x"}, {"POST", "/folders/id/sessions"}, {"PUT", "/sessions/id/folder"},
	} {
		rec := httptest.NewRecorder()
		server.ServeHTTP(rec, request(tt.method, tt.path, nil, ""))
		require.Equal(t, 401, rec.Code, tt)
	}
	rec := httptest.NewRecorder()
	req := request("OPTIONS", "/folders/id", nil, "")
	req.Header.Set("Origin", extensionOriginPrefix+DefaultExtensionID)
	server.ServeHTTP(rec, req)
	require.Contains(t, rec.Header().Get("Access-Control-Allow-Methods"), "PATCH")
}
