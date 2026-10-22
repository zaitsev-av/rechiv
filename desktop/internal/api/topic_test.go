package api

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"rechiv/desktop/internal/domain"
)

func TestTopicRoutes(t *testing.T) {
	server, c := newTestServer(t, healthyEngine())
	folder, err := c.Store().CreateFolder("Daily")
	require.NoError(t, err)
	_, err = c.Store().SetFolderSettings(folder.ID, domain.FolderSettings{TitleTemplate: "Дейли — {topic}"})
	require.NoError(t, err)
	session, err := c.Store().Create("")
	require.NoError(t, err)
	require.NoError(t, c.Store().MoveSessions([]string{session.SessionID}, folder.ID, false))
	_, err = c.Store().ApplyFolderTitles(folder.ID)
	require.NoError(t, err)
	call := func(id, body, token string, code int) *httptest.ResponseRecorder {
		t.Helper()
		rec := httptest.NewRecorder()
		server.ServeHTTP(rec, request("PUT", "/sessions/"+id+"/topic", strings.NewReader(body), token))
		require.Equal(t, code, rec.Code, rec.Body.String())
		return rec
	}
	for _, tt := range []struct {
		body string
		code int
	}{
		{`{"topic":"  План релиза продукта  "}`, 200},
		{`{"topic":"` + strings.Repeat("я", 120) + `"}`, 200},
		{`{"topic":"` + strings.Repeat("я", 121) + `"}`, 422},
		{`{"topic":"тема\nсозвона"}`, 422}, {`{"topic":"\nтема"}`, 422}, {`{"topic":"тема\r"}`, 422},
		{`{"topic":"тема\u2028созвона"}`, 422}, {`{"topic":12}`, 400}, {`{`, 400},
	} {
		t.Run(tt.body, func(t *testing.T) { call(session.SessionID, tt.body, testAPIToken, tt.code) })
	}
	call("missing", `{"topic":"Релиз"}`, testAPIToken, 404)
	call(session.SessionID, `{"topic":"Релиз"}`, "", 401)
	var result sessionResponse
	require.NoError(t, json.Unmarshal(call(session.SessionID, `{"topic":"  План релиза продукта  "}`, testAPIToken, 200).Body.Bytes(), &result))
	require.Equal(t, "План релиза продукта", result.Topic)
	require.Equal(t, "Дейли — План релиза продукта", result.Title)
	require.True(t, result.TitleAuto)
	stored, err := c.Store().Get(session.SessionID)
	require.NoError(t, err)
	require.Equal(t, result.Topic, stored.Topic)
	_, err = c.Store().SetTitle(session.SessionID, "Ручное название")
	require.NoError(t, err)
	result = sessionResponse{}
	require.NoError(t, json.Unmarshal(call(session.SessionID, `{"topic":"Новая тема"}`, testAPIToken, 200).Body.Bytes(), &result))
	require.Equal(t, "Ручное название", result.Title)
	require.False(t, result.TitleAuto)
	require.Equal(t, "Новая тема", result.Topic)
}

// Автосаммари не перезаписывает версию, сохранённую страницей за время генерации.
func TestWriteSummaryKeepsExisting(t *testing.T) {
	server, c := newTestServer(t, healthyEngine())
	session, err := c.Store().Create("")
	require.NoError(t, err)
	written, err := c.WriteSummary(session.SessionID, map[string]string{"content": "авто"}, true)
	require.NoError(t, err)
	require.True(t, written)
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, request("PUT", "/sessions/"+session.SessionID+"/summary", strings.NewReader(`{"content":"ручное"}`), testAPIToken))
	require.Equal(t, 200, rec.Code)
	written, err = c.WriteSummary(session.SessionID, map[string]string{"content": "не перезаписывать"}, true)
	require.NoError(t, err)
	require.False(t, written)
	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, request("GET", "/sessions/"+session.SessionID+"/summary", nil, testAPIToken))
	require.JSONEq(t, `{"content":"ручное"}`, rec.Body.String())
}
