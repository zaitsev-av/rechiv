package api

import (
	"bufio"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"rechiv/desktop/internal/calls"
	"rechiv/desktop/internal/controller"
	"rechiv/desktop/internal/domain"
	"rechiv/desktop/internal/store"
)

func TestPollCalls(t *testing.T) {
	sessions, err := store.New(t.TempDir())
	require.NoError(t, err)
	control := controller.New(sessions, nil, nil, log.New(io.Discard, "", 0))
	hub := calls.NewHub()
	server := New(control, testAPIToken, "", "dev", nil, WithCalls(hub), WithWebUI(t.TempDir()))
	poll := func(body, token string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		server.ServeHTTP(rec, request("POST", "/calls/poll", strings.NewReader(body), token))
		return rec
	}

	require.Equal(t, http.StatusUnauthorized, poll(`{"call":null}`, "").Code)
	require.Equal(t, http.StatusBadRequest, poll(`{"call":{"extra":1}}`, testAPIToken).Code)

	response := poll(`{"call":{"platform":"Яндекс Телемост","url":"https://telemost.yandex.ru/j/1","title":"  Дейли  ","recording":false},"wait":0}`, testAPIToken)
	require.Equal(t, http.StatusOK, response.Code)
	require.JSONEq(t, `{}`, response.Body.String())
	require.Equal(t, &calls.Call{Platform: "Яндекс Телемост", URL: "https://telemost.yandex.ru/j/1", Title: "Дейли"}, hub.Current())

	go func() {
		time.Sleep(20 * time.Millisecond)
		hub.Send(calls.CommandStart)
	}()
	response = poll(`{"call":{"url":"https://telemost.yandex.ru/j/1"},"wait":5}`, testAPIToken)
	require.JSONEq(t, `{"command":"start"}`, response.Body.String())

	require.Equal(t, http.StatusOK, poll(`{"call":null,"wait":5}`, testAPIToken).Code)
	require.Nil(t, hub.Current())
}

func TestPollCallsAutoStart(t *testing.T) {
	sessions, err := store.New(t.TempDir())
	require.NoError(t, err)
	control := controller.New(sessions, nil, nil, log.New(io.Discard, "", 0))
	server := New(control, testAPIToken, "", "dev", nil, WithCalls(calls.NewHub()))
	folder, err := sessions.CreateFolder("Дейли")
	require.NoError(t, err)
	_, _, err = sessions.AddFolderRule(folder.ID, "https://telemost.yandex.ru/j/1")
	require.NoError(t, err)
	poll := func(call string) string {
		rec := httptest.NewRecorder()
		server.ServeHTTP(rec, request("POST", "/calls/poll", strings.NewReader(`{"call":`+call+`,"wait":0}`), testAPIToken))
		require.Equal(t, http.StatusOK, rec.Code)
		return rec.Body.String()
	}
	joined := `{"url":"https://telemost.yandex.ru/j/1","joined":true}`

	require.JSONEq(t, `{}`, poll(joined), "без настройки папки автозаписи нет")
	_, err = sessions.SetFolderSettings(folder.ID, domain.FolderSettings{AutoRecord: true})
	require.NoError(t, err)
	require.JSONEq(t, `{}`, poll(`{"url":"https://telemost.yandex.ru/j/1"}`), "до входа в созвон не пишем")
	require.JSONEq(t, `{}`, poll(`{"url":"https://telemost.yandex.ru/j/2","joined":true}`), "чужая ссылка")
	require.JSONEq(t, `{"command":"start","auto":true}`, poll(joined))
	require.JSONEq(t, `{}`, poll(joined), "одна попытка на созвон")
}

func TestCreateSessionLivePanel(t *testing.T) {
	server, control := newTestServer(t, healthyEngine())
	sessions := control.Store()
	folder, err := sessions.CreateFolder("Дейли")
	require.NoError(t, err)
	_, _, err = sessions.AddFolderRule(folder.ID, "https://telemost.yandex.ru/j/1")
	require.NoError(t, err)
	_, err = sessions.SetFolderSettings(folder.ID, domain.FolderSettings{LivePanel: true})
	require.NoError(t, err)
	create := func(url string) map[string]any {
		rec := httptest.NewRecorder()
		server.ServeHTTP(rec, request("POST", "/sessions", strings.NewReader(`{"callUrl":"`+url+`"}`), testAPIToken))
		require.Equal(t, http.StatusCreated, rec.Code)
		var body map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		return body
	}

	require.Equal(t, true, create("https://telemost.yandex.ru/j/1")["livePanel"])
	require.NotContains(t, create("https://telemost.yandex.ru/j/2"), "livePanel")
}

func TestEventsStream(t *testing.T) {
	sessions, err := store.New(t.TempDir())
	require.NoError(t, err)
	control := controller.New(sessions, nil, nil, log.New(io.Discard, "", 0))
	server := New(control, testAPIToken, "", "dev", nil)
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()
	defer server.Close()

	response, err := http.Get(httpServer.URL + "/events")
	require.NoError(t, err, "поток доступен без токена")
	defer response.Body.Close()
	require.Equal(t, http.StatusOK, response.StatusCode)
	require.Equal(t, "text/event-stream", response.Header.Get("Content-Type"))

	reader := bufio.NewReader(response.Body)
	line, err := reader.ReadString('\n')
	require.NoError(t, err)
	require.Equal(t, "retry: 3000\n", line)

	_, err = sessions.CreateFolder("Дейли")
	require.NoError(t, err)
	var received []string
	for len(received) < 2 {
		line, err = reader.ReadString('\n')
		require.NoError(t, err)
		if strings.HasPrefix(line, "event:") || strings.HasPrefix(line, "data:") {
			received = append(received, strings.TrimSpace(line))
		}
	}
	require.Equal(t, []string{"event: sessions", "data: {}"}, received)
}
