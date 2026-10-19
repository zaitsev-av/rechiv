package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	"rechiv/desktop/internal/controller"
	"rechiv/desktop/internal/engine"
	"rechiv/desktop/internal/mocks"
	"rechiv/desktop/internal/onboarding"
	"rechiv/desktop/internal/store"
)

const (
	testAPIToken        = "test-api-token"
	testExpectedVersion = "0.4.1"
	foreignExtensionID  = "abcdefghijklmnopabcdefghijklmnop"
)

type healthResponse struct {
	Status       string `json:"status"`
	AuthRequired bool   `json:"authRequired"`
	Engine       struct {
		Status string `json:"status"`
		Error  string `json:"error"`
	} `json:"engine"`
	Extension extensionHealthResponse `json:"extension"`
}

type sessionView struct {
	SessionID   string `json:"sessionId"`
	UploadToken string `json:"uploadToken"`
	Title       string `json:"title"`
}

type fakeOnboardingService struct {
	state              onboarding.State
	openExtensionsErr  error
	revealErr          error
	openedWithBundleID string
}

func (f *fakeOnboardingService) State() onboarding.State {
	return f.state
}

func (f *fakeOnboardingService) OpenExtensions(bundleID string) error {
	f.openedWithBundleID = bundleID
	return f.openExtensionsErr
}

func (f *fakeOnboardingService) Reveal() error {
	return f.revealErr
}

// newTestServer поднимает сервер с замоканными движком и конвертером.
// Ожидания задаёт вызывающий: probeEngine дёргает Ping в фоне, поэтому
// каждый тест обязан описать поведение движка сам.
func newTestServer(
	t *testing.T,
	setup func(engineMock *mocks.MockEngine, converterMock *mocks.MockAudioConverter),
) (*Server, *controller.Controller) {
	t.Helper()
	return newTestServerWithExtensionID(t, "", setup)
}

func newTestServerWithExtensionID(
	t *testing.T,
	allowedExtensionID string,
	setup func(engineMock *mocks.MockEngine, converterMock *mocks.MockAudioConverter),
) (*Server, *controller.Controller) {
	t.Helper()

	ctrl := gomock.NewController(t)
	engineMock := mocks.NewMockEngine(ctrl)
	converterMock := mocks.NewMockAudioConverter(ctrl)
	engineMock.EXPECT().Close().Return(nil).AnyTimes()
	setup(engineMock, converterMock)

	sessionStore, err := store.New(t.TempDir())
	require.NoError(t, err)

	control := controller.New(sessionStore, engineMock, converterMock, log.New(io.Discard, "", 0))
	require.NoError(t, control.Start())
	// Закрываем контроллер раньше, чем gomock проверит ожидания: иначе фоновые
	// вызовы движка пришли бы уже после Finish.
	t.Cleanup(func() { _ = control.Close() })

	return New(
		control,
		testAPIToken,
		allowedExtensionID,
		testExpectedVersion,
		log.New(io.Discard, "", 0),
	), control
}

func healthyEngine(segments ...engine.Segment) func(*mocks.MockEngine, *mocks.MockAudioConverter) {
	return func(engineMock *mocks.MockEngine, converterMock *mocks.MockAudioConverter) {
		engineMock.EXPECT().Ping(gomock.Any()).Return(nil).AnyTimes()
		engineMock.EXPECT().Warmup(gomock.Any()).Return(nil).AnyTimes()
		engineMock.EXPECT().
			Transcribe(gomock.Any(), gomock.Any()).
			Return(segments, nil).
			AnyTimes()
		converterMock.EXPECT().
			Convert(gomock.Any(), gomock.Any(), gomock.Any()).
			Return(2.0, nil).
			AnyTimes()
	}
}

func Test_health(t *testing.T) {
	type args struct {
		pingErr error
	}
	type want struct {
		engineStatus  string
		engineError   string
		serviceStatus string
	}

	tests := []struct {
		name string
		args args
		want want
	}{
		{
			name: "движок поднялся",
			args: args{},
			want: want{engineStatus: "ready", serviceStatus: "ok"},
		},
		{
			name: "движок не поднялся, но сервис жив",
			args: args{pingErr: errors.New("No module named 'torch'")},
			want: want{
				engineStatus:  "error",
				engineError:   "No module named 'torch'",
				serviceStatus: "ok",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			is := require.New(t)
			handler, _ := newTestServer(t, func(
				engineMock *mocks.MockEngine,
				_ *mocks.MockAudioConverter,
			) {
				engineMock.EXPECT().Ping(gomock.Any()).Return(tt.args.pingErr).AnyTimes()
			})

			// Движок проверяется в фоне — ждём, пока результат дойдёт до /health.
			var health healthResponse
			is.Eventually(func() bool {
				health = healthResponse{}
				decodeJSONResponse(t, doRequest(t, handler, request(http.MethodGet, "/health", nil, "")), &health)
				return health.Engine.Status == tt.want.engineStatus
			}, 3*time.Second, 10*time.Millisecond)

			is.Equal(tt.want.serviceStatus, health.Status)
			is.True(health.AuthRequired)
			is.Equal(tt.want.engineError, health.Engine.Error)
		})
	}
}

func TestDefaultExtensionID(t *testing.T) {
	require.Regexp(t, `^[a-p]{32}$`, DefaultExtensionID)
}

func Test_healthExtension(t *testing.T) {
	tests := []struct {
		name        string
		seenVersion string
		installed   bool
		outdated    bool
	}{
		{name: "расширение ещё не обращалось"},
		{
			name:        "установлена актуальная версия",
			seenVersion: testExpectedVersion,
			installed:   true,
		},
		{
			name:        "установлена старая версия",
			seenVersion: "0.4.0",
			installed:   true,
			outdated:    true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			is := require.New(t)
			handler, _ := newTestServer(t, healthyEngine())
			if tt.installed {
				req := request(http.MethodGet, "/sessions", nil, testAPIToken)
				req.Header.Set("Origin", extensionOriginPrefix+DefaultExtensionID)
				req.Header.Set(extensionVersionHeader, tt.seenVersion)
				resp := doRequest(t, handler, req)
				is.Equal(http.StatusOK, resp.StatusCode)
				resp.Body.Close()
			}

			var health healthResponse
			decodeJSONResponse(t, doRequest(t, handler, request(http.MethodGet, "/health", nil, "")), &health)

			is.Equal(DefaultExtensionID, health.Extension.ExpectedID)
			is.Equal(testExpectedVersion, health.Extension.ExpectedVersion)
			is.Equal(tt.installed, health.Extension.Installed)
			is.Equal(tt.outdated, health.Extension.Outdated)
			if !tt.installed {
				is.Empty(health.Extension.ID)
				is.Empty(health.Extension.Version)
				is.Nil(health.Extension.LastSeenAt)
				return
			}
			is.Equal(DefaultExtensionID, health.Extension.ID)
			is.Equal(tt.seenVersion, health.Extension.Version)
			is.NotNil(health.Extension.LastSeenAt)
			is.WithinDuration(time.Now(), *health.Extension.LastSeenAt, time.Second)
		})
	}
}

// Основной трафик расширения идёт из service worker, а он к хосту из
// host_permissions ходит без Origin, поэтому опознавать расширение только по
// нему нельзя: онбординг показывал бы «не установлено» при живом расширении.
func Test_healthExtensionWithoutOrigin(t *testing.T) {
	tests := []struct {
		name         string
		version      string
		secFetchSite string
		installed    bool
	}{
		{
			name:         "service worker присылает версию",
			version:      testExpectedVersion,
			secFetchSite: "none",
			installed:    true,
		},
		{name: "запрос без версии расширением не считается", secFetchSite: "none"},
		{name: "версия без Sec-Fetch-Site не в счёт", version: testExpectedVersion},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			is := require.New(t)
			handler, _ := newTestServer(t, healthyEngine())

			req := request(http.MethodGet, "/sessions", nil, testAPIToken)
			if tt.version != "" {
				req.Header.Set(extensionVersionHeader, tt.version)
			}
			if tt.secFetchSite != "" {
				req.Header.Set("Sec-Fetch-Site", tt.secFetchSite)
			}
			resp := doRequest(t, handler, req)
			is.Equal(http.StatusOK, resp.StatusCode)
			resp.Body.Close()

			var health healthResponse
			decodeJSONResponse(t, doRequest(t, handler, request(http.MethodGet, "/health", nil, "")), &health)

			is.Equal(tt.installed, health.Extension.Installed)
			if !tt.installed {
				return
			}
			is.Equal(tt.version, health.Extension.Version)
			is.False(health.Extension.Outdated)
			// Origin не пришёл, проверить ID нечем — выдумывать его не нужно.
			is.Empty(health.Extension.ID)
		})
	}
}

// Preflight идёт без кастомных заголовков: если бы он затирал версию, онбординг
// между OPTIONS и самим запросом мигал бы «расширение устарело».
func Test_healthExtensionPreflightKeepsVersion(t *testing.T) {
	is := require.New(t)
	handler, _ := newTestServer(t, healthyEngine())

	seen := request(http.MethodGet, "/sessions", nil, testAPIToken)
	seen.Header.Set("Origin", extensionOriginPrefix+DefaultExtensionID)
	seen.Header.Set(extensionVersionHeader, testExpectedVersion)
	doRequest(t, handler, seen).Body.Close()

	preflight := request(http.MethodOptions, "/sessions", nil, "")
	preflight.Header.Set("Origin", extensionOriginPrefix+DefaultExtensionID)
	doRequest(t, handler, preflight).Body.Close()

	var health healthResponse
	decodeJSONResponse(t, doRequest(t, handler, request(http.MethodGet, "/health", nil, "")), &health)

	is.Equal(testExpectedVersion, health.Extension.Version)
	is.Equal(DefaultExtensionID, health.Extension.ID)
	is.False(health.Extension.Outdated)
}

func Test_extensionOutdated(t *testing.T) {
	tests := []struct {
		name     string
		actual   string
		expected string
		outdated bool
	}{
		{name: "версии совпали", actual: "0.4.1", expected: "0.4.1"},
		{name: "расширение старее приложения", actual: "0.4.0", expected: "0.4.1", outdated: true},
		{name: "сборка из исходников", actual: "0.4.1", expected: developmentVersion},
		{name: "версия расширения неизвестна", expected: "0.4.1"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			require.Equal(t, tt.outdated, extensionOutdated(tt.actual, tt.expected))
		})
	}
}

func Test_createSessionWarmsUpModel(t *testing.T) {
	type args struct {
		sessions int
	}
	type want struct {
		warmups int
	}

	tests := []struct {
		name string
		args args
		want want
	}{
		{
			name: "первая запись греет модель",
			args: args{sessions: 1},
			want: want{warmups: 1},
		},
		{
			name: "следующие записи модель не перегружают",
			args: args{sessions: 3},
			want: want{warmups: 1},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			is := require.New(t)
			warmups := make(chan struct{}, tt.args.sessions)
			handler, _ := newTestServer(t, func(
				engineMock *mocks.MockEngine,
				_ *mocks.MockAudioConverter,
			) {
				engineMock.EXPECT().Ping(gomock.Any()).Return(nil).AnyTimes()
				engineMock.EXPECT().
					Warmup(gomock.Any()).
					DoAndReturn(func(context.Context) error {
						warmups <- struct{}{}
						return nil
					}).
					AnyTimes()
			})

			for range tt.args.sessions {
				resp := doRequest(t, handler, request(
					http.MethodPost,
					"/sessions",
					bytes.NewReader([]byte(`{"callUrl":"https://stream.wb.ru/room/1"}`)),
					testAPIToken,
				))
				is.Equal(http.StatusCreated, resp.StatusCode)
				resp.Body.Close()
			}

			// Прогрев идёт в фоне: ждём первый и убеждаемся, что повторов нет.
			is.Eventually(func() bool { return len(warmups) >= tt.want.warmups },
				3*time.Second, 10*time.Millisecond)
			time.Sleep(50 * time.Millisecond)
			is.Len(warmups, tt.want.warmups)
		})
	}
}

func Test_updateTitle(t *testing.T) {
	type args struct {
		body string
	}
	type want struct {
		status int
		title  string
	}

	tests := []struct {
		name string
		args args
		want want
	}{
		{
			name: "название сохраняется в сессии",
			args: args{body: `{"title":"Планёрка"}`},
			want: want{status: http.StatusOK, title: "Планёрка"},
		},
		{
			name: "пробелы по краям срезаются",
			args: args{body: `{"title":"  Ретро  "}`},
			want: want{status: http.StatusOK, title: "Ретро"},
		},
		{
			name: "пустое название очищает поле",
			args: args{body: `{"title":""}`},
			want: want{status: http.StatusOK, title: ""},
		},
		{
			name: "некорректный JSON отвергается",
			args: args{body: `{`},
			want: want{status: http.StatusBadRequest},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			is := require.New(t)
			handler, control := newTestServer(t, healthyEngine())
			session, err := control.CreateSession("https://stream.wb.ru/room/1")
			is.NoError(err)

			resp := doRequest(t, handler, request(
				http.MethodPut,
				"/sessions/"+session.SessionID+"/title",
				bytes.NewReader([]byte(tt.args.body)),
				testAPIToken,
			))
			is.Equal(tt.want.status, resp.StatusCode)
			if tt.want.status != http.StatusOK {
				resp.Body.Close()
				return
			}

			var updated sessionView
			decodeJSONResponse(t, resp, &updated)
			is.Equal(tt.want.title, updated.Title)

			// Название должно пережить перечитывание сессии.
			stored, err := control.Store().Get(session.SessionID)
			is.NoError(err)
			is.Equal(tt.want.title, stored.Title)
		})
	}
}

func Test_bootstrapToken(t *testing.T) {
	type args struct {
		origin       string
		secFetchSite string
	}
	type want struct {
		status int
		token  string
	}

	tests := []struct {
		name string
		args args
		want want
	}{
		{
			name: "запрос из расширения",
			args: args{origin: extensionOriginPrefix + DefaultExtensionID},
			want: want{status: http.StatusOK, token: testAPIToken},
		},
		{
			name: "запрос из чужого расширения",
			args: args{origin: extensionOriginPrefix + foreignExtensionID},
			want: want{status: http.StatusForbidden},
		},
		{
			name: "без Origin, но с Sec-Fetch-Site: none",
			args: args{secFetchSite: "none"},
			want: want{status: http.StatusOK, token: testAPIToken},
		},
		{
			name: "без Origin и Sec-Fetch-Site",
			args: args{},
			want: want{status: http.StatusForbidden},
		},
		{
			name: "с чужим Origin",
			args: args{origin: "https://example.com", secFetchSite: "none"},
			want: want{status: http.StatusForbidden},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			is := require.New(t)
			handler, _ := newTestServer(t, healthyEngine())

			req := request(http.MethodGet, "/auth/token", nil, "")
			if tt.args.origin != "" {
				req.Header.Set("Origin", tt.args.origin)
			}
			if tt.args.secFetchSite != "" {
				req.Header.Set("Sec-Fetch-Site", tt.args.secFetchSite)
			}
			resp := doRequest(t, handler, req)

			is.Equal(tt.want.status, resp.StatusCode)
			if tt.want.token != "" {
				var body map[string]string
				decodeJSONResponse(t, resp, &body)
				is.Equal(tt.want.token, body["token"])
			}
		})
	}
}

func Test_extensionOriginAccess(t *testing.T) {
	tests := []struct {
		name               string
		allowedExtensionID string
		originID           string
		path               string
		token              string
		wantStatus         int
	}{
		{
			name:       "своё расширение получает токен",
			originID:   DefaultExtensionID,
			path:       "/auth/token",
			wantStatus: http.StatusOK,
		},
		{
			name:       "чужое расширение не получает токен при пустой настройке",
			originID:   foreignExtensionID,
			path:       "/auth/token",
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "своё расширение ходит в остальные маршруты",
			originID:   DefaultExtensionID,
			path:       "/sessions",
			token:      testAPIToken,
			wantStatus: http.StatusOK,
		},
		{
			name:       "чужое расширение заблокировано на остальных маршрутах",
			originID:   foreignExtensionID,
			path:       "/sessions",
			token:      testAPIToken,
			wantStatus: http.StatusForbidden,
		},
		{
			name:               "режим any отдаёт токен любому расширению",
			allowedExtensionID: extensionIDAny,
			originID:           foreignExtensionID,
			path:               "/auth/token",
			wantStatus:         http.StatusOK,
		},
		{
			name:               "режим any открывает остальные маршруты",
			allowedExtensionID: extensionIDAny,
			originID:           foreignExtensionID,
			path:               "/sessions",
			token:              testAPIToken,
			wantStatus:         http.StatusOK,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			handler, _ := newTestServerWithExtensionID(t, tt.allowedExtensionID, healthyEngine())
			req := request(http.MethodGet, tt.path, nil, tt.token)
			req.Header.Set("Origin", extensionOriginPrefix+tt.originID)

			resp := doRequest(t, handler, req)
			defer resp.Body.Close()
			require.Equal(t, tt.wantStatus, resp.StatusCode)
		})
	}
}

func Test_uploadChunk(t *testing.T) {
	type args struct {
		speakerID       string
		timestamp       string
		withFile        bool
		bearer          string
		useUploadToken  bool
		wrongUploadTokn bool
		fillQueue       bool
	}
	type want struct {
		status         int
		hasRetryAfter  bool
		chunkAccepted  bool
		queueOverflown bool
	}

	tests := []struct {
		name string
		args args
		want want
	}{
		{
			name: "с bearer-токеном",
			args: args{speakerID: "local", timestamp: "0", withFile: true, bearer: testAPIToken},
			want: want{status: http.StatusAccepted, chunkAccepted: true},
		},
		{
			name: "с токеном загрузки сессии",
			args: args{speakerID: "remote-1", timestamp: "4", withFile: true, useUploadToken: true},
			want: want{status: http.StatusAccepted, chunkAccepted: true},
		},
		{
			name: "без токена",
			args: args{speakerID: "local", timestamp: "0", withFile: true},
			want: want{status: http.StatusUnauthorized},
		},
		{
			name: "с чужим токеном загрузки",
			args: args{
				speakerID:       "local",
				timestamp:       "0",
				withFile:        true,
				wrongUploadTokn: true,
			},
			want: want{status: http.StatusUnauthorized},
		},
		{
			name: "без speakerId",
			args: args{timestamp: "0", withFile: true, bearer: testAPIToken},
			want: want{status: http.StatusUnprocessableEntity},
		},
		{
			name: "с отрицательным timestamp",
			args: args{speakerID: "local", timestamp: "-1", withFile: true, bearer: testAPIToken},
			want: want{status: http.StatusUnprocessableEntity},
		},
		{
			name: "без файла",
			args: args{speakerID: "local", timestamp: "0", bearer: testAPIToken},
			want: want{status: http.StatusUnprocessableEntity},
		},
		{
			name: "очередь распознавания переполнена",
			args: args{
				speakerID: "local",
				timestamp: "0",
				withFile:  true,
				bearer:    testAPIToken,
				fillQueue: true,
			},
			want: want{
				status:         http.StatusServiceUnavailable,
				hasRetryAfter:  true,
				queueOverflown: true,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			is := require.New(t)

			setup := healthyEngine()
			if tt.args.fillQueue {
				setup = blockedEngine()
			}
			handler, control := newTestServer(t, setup)

			session, err := control.CreateSession("https://stream.wb.ru/room/1")
			is.NoError(err)

			if tt.args.fillQueue {
				fillQueue(t, handler, session.SessionID)
			}

			uploadToken := ""
			switch {
			case tt.args.useUploadToken:
				uploadToken = session.UploadToken
			case tt.args.wrongUploadTokn:
				uploadToken = "definitely-not-the-upload-token"
			}

			body, contentType := chunkForm(t, tt.args.speakerID, tt.args.timestamp, uploadToken, tt.args.withFile)
			req := request(http.MethodPost, "/sessions/"+session.SessionID+"/chunks", body, tt.args.bearer)
			req.Header.Set("Content-Type", contentType)
			resp := doRequest(t, handler, req)

			is.Equal(tt.want.status, resp.StatusCode)
			if tt.want.hasRetryAfter {
				// Клиент должен понять, что фрагмент не потерян и запрос стоит повторить.
				is.NotEmpty(resp.Header.Get("Retry-After"))
			}
			if tt.want.chunkAccepted {
				var accepted struct {
					Accepted bool `json:"accepted"`
				}
				decodeJSONResponse(t, resp, &accepted)
				is.True(accepted.Accepted)
			}
			if !tt.want.queueOverflown {
				is.Less(control.QueueDepth(), controller.MaxQueueDepth)
			}
		})
	}
}

func Test_uploadVADBeacon(t *testing.T) {
	for _, tc := range []struct {
		name       string
		token      string
		origin     string
		wantStatus int
	}{
		{"токен сессии", "session", "https://telemost.yandex.ru", http.StatusOK},
		{"без токена", "", "https://telemost.yandex.ru", http.StatusUnauthorized},
		{"неверный токен", "invalid", "https://telemost.yandex.ru", http.StatusUnauthorized},
		{"токен другой сессии", "other", "https://telemost.yandex.ru", http.StatusUnauthorized},
		{"чужое расширение", "session", extensionOriginPrefix + foreignExtensionID, http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler, control := newTestServer(t, healthyEngine())
			session, err := control.CreateSession("https://telemost.yandex.ru/j/1")
			require.NoError(t, err)
			token := tc.token
			if token == "session" {
				token = session.UploadToken
			} else if token == "other" {
				other, err := control.CreateSession("https://telemost.yandex.ru/j/2")
				require.NoError(t, err)
				token = other.UploadToken
			}
			body, err := json.Marshal(map[string]any{
				"uploadToken":  token,
				"participants": []controller.VADParticipant{{ParticipantID: "guest", Name: "Гость"}},
				"events":       []controller.VADEvent{{At: 0, Active: []string{"guest"}}},
				"micEvents":    []controller.VADMicEvent{{At: 0, Unmuted: []string{"guest"}}},
			})
			require.NoError(t, err)
			req := request(http.MethodPost, "/sessions/"+session.SessionID+"/vad", bytes.NewReader(body), "")
			req.Header.Set("Content-Type", "text/plain;charset=UTF-8")
			req.Header.Set("Origin", tc.origin)
			req.Header.Set("Sec-Fetch-Mode", "no-cors")
			req.Header.Set("Sec-Fetch-Site", "cross-site")
			resp := doRequest(t, handler, req)
			defer resp.Body.Close()
			require.Equal(t, tc.wantStatus, resp.StatusCode)
			if tc.origin == "https://telemost.yandex.ru" {
				require.Equal(t, tc.origin, resp.Header.Get("Access-Control-Allow-Origin"))
			}
			if tc.wantStatus == http.StatusOK {
				var stored controller.VADTimeline
				require.NoError(t, controller.ReadJSON(control.VADPath(session.SessionID), &stored))
				require.Equal(t, []string{"guest"}, stored.Events[0].Active)
				require.Equal(t, []string{"guest"}, stored.MicEvents[0].Unmuted)
			} else {
				_, err := os.Stat(control.VADPath(session.SessionID))
				require.ErrorIs(t, err, os.ErrNotExist)
			}
		})
	}
}

func Test_uploadVAD(t *testing.T) {
	t.Run("сохраняет и сортирует таймлайн", func(t *testing.T) {
		handler, control := newTestServer(t, healthyEngine())
		session, err := control.CreateSession("https://telemost.yandex.ru/j/1")
		require.NoError(t, err)
		body := `{
			"localParticipantId":"local-id",
			"participants":[{"participantId":"guest-id","name":"Гость"}],
			"events":[{"at":12.5,"active":["guest-id"]},{"at":2,"active":[]}]
		}`

		resp := doRequest(t, handler, request(
			http.MethodPost,
			"/sessions/"+session.SessionID+"/vad",
			bytes.NewReader([]byte(body)),
			testAPIToken,
		))

		require.Equal(t, http.StatusOK, resp.StatusCode)
		resp.Body.Close()
		var stored controller.VADTimeline
		require.NoError(t, controller.ReadJSON(control.VADPath(session.SessionID), &stored))
		require.Equal(t, "local-id", stored.LocalParticipantID)
		require.Equal(t, []float64{2, 12.5}, []float64{stored.Events[0].At, stored.Events[1].At})
	})

	t.Run("пустой список событий допустим", func(t *testing.T) {
		handler, control := newTestServer(t, healthyEngine())
		session, err := control.CreateSession("https://telemost.yandex.ru/j/1")
		require.NoError(t, err)

		resp := doRequest(t, handler, request(
			http.MethodPost,
			"/sessions/"+session.SessionID+"/vad",
			bytes.NewReader([]byte(`{"localParticipantId":"","participants":[],"events":[]}`)),
			testAPIToken,
		))

		require.Equal(t, http.StatusOK, resp.StatusCode)
		resp.Body.Close()
	})

	for _, testCase := range []struct {
		name       string
		body       string
		wantStatus int
	}{
		{name: "кривой JSON", body: `{`, wantStatus: http.StatusBadRequest},
		{
			name:       "отрицательное время",
			body:       `{"localParticipantId":"","participants":[],"events":[{"at":-1,"active":[]}]}`,
			wantStatus: http.StatusUnprocessableEntity,
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			handler, control := newTestServer(t, healthyEngine())
			session, err := control.CreateSession("https://telemost.yandex.ru/j/1")
			require.NoError(t, err)

			resp := doRequest(t, handler, request(
				http.MethodPost,
				"/sessions/"+session.SessionID+"/vad",
				bytes.NewReader([]byte(testCase.body)),
				testAPIToken,
			))

			require.Equal(t, testCase.wantStatus, resp.StatusCode)
			resp.Body.Close()
		})
	}

	t.Run("несуществующая сессия", func(t *testing.T) {
		handler, _ := newTestServer(t, healthyEngine())

		resp := doRequest(t, handler, request(
			http.MethodPost,
			"/sessions/missing/vad",
			bytes.NewReader([]byte(`{"localParticipantId":"","participants":[],"events":[]}`)),
			testAPIToken,
		))

		require.Equal(t, http.StatusNotFound, resp.StatusCode)
		resp.Body.Close()
	})

	t.Run("требует авторизацию", func(t *testing.T) {
		handler, control := newTestServer(t, healthyEngine())
		session, err := control.CreateSession("https://telemost.yandex.ru/j/1")
		require.NoError(t, err)

		resp := doRequest(t, handler, request(
			http.MethodPost,
			"/sessions/"+session.SessionID+"/vad",
			bytes.NewReader([]byte(`{"localParticipantId":"","participants":[],"events":[]}`)),
			"",
		))

		require.Equal(t, http.StatusUnauthorized, resp.StatusCode)
		resp.Body.Close()
	})
}

// На площадке с комнатным миксом имя потока одно на всю запись, поэтому
// фрагмент несёт того, кого площадка слышала в его границах. Проверяем весь
// путь: поле формы — задание — живой транскрипт.
func Test_chunkAttributionReachesLiveTranscript(t *testing.T) {
	is := require.New(t)
	handler, _ := newTestServer(t, healthyEngine(engine.Segment{
		Text: "Реплика собеседника", Start: 0.1, End: 0.9,
	}))

	create := doRequest(t, handler, request(
		http.MethodPost,
		"/sessions",
		bytes.NewReader([]byte(`{"callUrl":"https://telemost.yandex.ru/j/1"}`)),
		testAPIToken,
	))
	is.Equal(http.StatusCreated, create.StatusCode)
	var created sessionView
	decodeJSONResponse(t, create, &created)

	// Имя участника приезжает отдельно от фрагмента — без него живой
	// транскрипт показал бы «Спикер N».
	speaker := doRequest(t, handler, request(
		http.MethodPost,
		"/sessions/"+created.SessionID+"/speakers",
		bytes.NewReader([]byte(`{"speakerId":"participant-a","name":"Глеб"}`)),
		testAPIToken,
	))
	is.Equal(http.StatusOK, speaker.StatusCode)

	body, contentType := chunkFormWithAttribution(t, "remote-mix", "0", "", "participant-a", true)
	upload := request(http.MethodPost, "/sessions/"+created.SessionID+"/chunks", body, testAPIToken)
	upload.Header.Set("Content-Type", contentType)
	is.Equal(http.StatusAccepted, doRequest(t, handler, upload).StatusCode)

	var live struct {
		Segments []struct {
			Speaker   string `json:"speaker"`
			SpeakerID string `json:"speakerId"`
		} `json:"segments"`
	}
	is.Eventually(func() bool {
		resp := doRequest(t, handler, request(
			http.MethodGet,
			"/sessions/"+created.SessionID+"/live",
			nil,
			testAPIToken,
		))
		live.Segments = nil
		decodeJSONResponse(t, resp, &live)
		return len(live.Segments) == 1
	}, 3*time.Second, 10*time.Millisecond)

	is.Equal("participant-a", live.Segments[0].SpeakerID)
	is.Equal("Глеб", live.Segments[0].Speaker)
}

// Test_sessionLifecycle проверяет последовательность шагов записи, поэтому
// остаётся сценарным: разбиение на независимые кейсы потеряло бы порядок.
func Test_sessionLifecycle(t *testing.T) {
	is := require.New(t)
	handler, _ := newTestServer(t, healthyEngine(engine.Segment{
		Text: "Проверяем транскрибацию", Start: 0.1, End: 0.9,
	}))

	unauthorized := doRequest(t, handler, request(
		http.MethodPost,
		"/sessions",
		bytes.NewReader([]byte(`{"callUrl":"https://stream.wb.ru/room/1"}`)),
		"",
	))
	is.Equal(http.StatusUnauthorized, unauthorized.StatusCode)

	create := doRequest(t, handler, request(
		http.MethodPost,
		"/sessions",
		bytes.NewReader([]byte(`{"callUrl":"https://stream.wb.ru/room/1"}`)),
		testAPIToken,
	))
	is.Equal(http.StatusCreated, create.StatusCode)
	var created sessionView
	decodeJSONResponse(t, create, &created)
	is.NotEmpty(created.SessionID)
	is.NotEmpty(created.UploadToken)

	speaker := doRequest(t, handler, request(
		http.MethodPost,
		"/sessions/"+created.SessionID+"/speakers",
		bytes.NewReader([]byte(`{"speakerId":"local","name":"Анна"}`)),
		testAPIToken,
	))
	is.Equal(http.StatusOK, speaker.StatusCode)

	body, contentType := chunkForm(t, "local", "0", "", true)
	upload := request(http.MethodPost, "/sessions/"+created.SessionID+"/chunks", body, testAPIToken)
	upload.Header.Set("Content-Type", contentType)
	is.Equal(http.StatusAccepted, doRequest(t, handler, upload).StatusCode)

	var live struct {
		Status          string `json:"status"`
		IsFinal         bool   `json:"isFinal"`
		ProcessedChunks int    `json:"processedChunks"`
		TotalChunks     int    `json:"totalChunks"`
		Segments        []struct {
			Text string `json:"text"`
		} `json:"segments"`
	}
	var liveHeaders http.Header
	is.Eventually(func() bool {
		resp := doRequest(t, handler, request(
			http.MethodGet,
			"/sessions/"+created.SessionID+"/live",
			nil,
			testAPIToken,
		))
		liveHeaders = resp.Header
		live.Segments = nil
		decodeJSONResponse(t, resp, &live)
		return len(live.Segments) == 1
	}, 3*time.Second, 10*time.Millisecond)

	is.Equal("recording", live.Status)
	is.False(live.IsFinal)
	is.Equal(1, live.ProcessedChunks)
	is.Equal(1, live.TotalChunks)
	is.Equal("Проверяем транскрибацию", live.Segments[0].Text)
	// Live-ответы не должны кэшироваться расширением.
	is.Equal("no-store", liveHeaders.Get("Cache-Control"))

	finish := doRequest(t, handler, request(
		http.MethodPost,
		"/sessions/"+created.SessionID+"/finish",
		nil,
		testAPIToken,
	))
	is.Equal(http.StatusAccepted, finish.StatusCode)

	var transcript struct {
		Duration string `json:"duration"`
		Segments []struct {
			Speaker string `json:"speaker"`
			Start   string `json:"start"`
			Text    string `json:"text"`
		} `json:"segments"`
	}
	is.Eventually(func() bool {
		resp := doRequest(t, handler, request(
			http.MethodGet,
			"/sessions/"+created.SessionID+"/transcript",
			nil,
			testAPIToken,
		))
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return false
		}
		decodeJSONResponse(t, resp, &transcript)
		return true
	}, 3*time.Second, 10*time.Millisecond)

	is.Equal("00:00:02", transcript.Duration)
	is.Len(transcript.Segments, 1)
	is.Equal("Анна", transcript.Segments[0].Speaker)
	is.Equal("00:00:00", transcript.Segments[0].Start)
	is.Equal("Проверяем транскрибацию", transcript.Segments[0].Text)
}

// blockedEngine удерживает воркер на первом фрагменте, чтобы очередь росла.
func blockedEngine() func(*mocks.MockEngine, *mocks.MockAudioConverter) {
	return func(engineMock *mocks.MockEngine, converterMock *mocks.MockAudioConverter) {
		engineMock.EXPECT().Ping(gomock.Any()).Return(nil).AnyTimes()
		engineMock.EXPECT().Warmup(gomock.Any()).Return(nil).AnyTimes()
		engineMock.EXPECT().
			Transcribe(gomock.Any(), gomock.Any()).
			DoAndReturn(func(ctx context.Context, _ string) ([]engine.Segment, error) {
				<-ctx.Done()
				return nil, ctx.Err()
			}).
			AnyTimes()
		converterMock.EXPECT().
			Convert(gomock.Any(), gomock.Any(), gomock.Any()).
			Return(2.0, nil).
			AnyTimes()
	}
}

// fillQueue грузит фрагменты, пока сервер не начнёт отвечать 503. Одну задачу
// сразу забирает воркер, поэтому запас к MaxQueueDepth обязателен.
func fillQueue(t *testing.T, handler http.Handler, sessionID string) {
	t.Helper()
	for range controller.MaxQueueDepth + 5 {
		body, contentType := chunkForm(t, "local", "0", "", true)
		req := request(http.MethodPost, "/sessions/"+sessionID+"/chunks", body, testAPIToken)
		req.Header.Set("Content-Type", contentType)
		resp := doRequest(t, handler, req)
		resp.Body.Close()
		if resp.StatusCode == http.StatusServiceUnavailable {
			return
		}
	}
	t.Fatal("очередь так и не переполнилась")
}

func chunkForm(
	t *testing.T,
	speakerID, timestamp, uploadToken string,
	withFile bool,
) (io.Reader, string) {
	return chunkFormWithAttribution(t, speakerID, timestamp, uploadToken, "", withFile)
}

func chunkFormWithAttribution(
	t *testing.T,
	speakerID, timestamp, uploadToken, attributedTo string,
	withFile bool,
) (io.Reader, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if attributedTo != "" {
		require.NoError(t, writer.WriteField("attributedTo", attributedTo))
	}
	if speakerID != "" {
		require.NoError(t, writer.WriteField("speakerId", speakerID))
	}
	if timestamp != "" {
		require.NoError(t, writer.WriteField("timestamp", timestamp))
	}
	if uploadToken != "" {
		require.NoError(t, writer.WriteField("uploadToken", uploadToken))
	}
	if withFile {
		file, err := writer.CreateFormFile("file", "chunk.webm")
		require.NoError(t, err)
		_, err = file.Write([]byte("fake audio"))
		require.NoError(t, err)
	}
	require.NoError(t, writer.Close())
	return &body, writer.FormDataContentType()
}

func request(method, target string, body io.Reader, token string) *http.Request {
	req := httptest.NewRequest(method, target, body)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return req
}

func doRequest(t *testing.T, handler http.Handler, req *http.Request) *http.Response {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	return recorder.Result()
}

func decodeJSONResponse(t *testing.T, response *http.Response, target any) {
	t.Helper()
	defer response.Body.Close()
	require.NoError(t, json.NewDecoder(response.Body).Decode(target))
}

// Страницы звонков досылают недописанный фрагмент через sendBeacon при закрытии
// вкладки, поэтому их origin должен проходить CORS.
func TestCORSAllowsCallPageOrigins(t *testing.T) {
	tests := []struct {
		name       string
		origin     string
		allowed    bool
		wantStatus int
	}{
		{
			name: "WB Stream", origin: "https://stream.wb.ru", allowed: true,
			wantStatus: http.StatusNoContent,
		},
		{
			name: "Телемост", origin: "https://telemost.yandex.ru", allowed: true,
			wantStatus: http.StatusNoContent,
		},
		{
			name: "расширение", origin: extensionOriginPrefix + DefaultExtensionID, allowed: true,
			wantStatus: http.StatusNoContent,
		},
		{
			name: "чужое расширение", origin: extensionOriginPrefix + foreignExtensionID, allowed: false,
			wantStatus: http.StatusForbidden,
		},
		{
			name: "чужая страница", origin: "https://example.com", allowed: false,
			wantStatus: http.StatusNoContent,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			is := require.New(t)
			handler, _ := newTestServer(t, healthyEngine())

			req := request(http.MethodOptions, "/sessions", nil, "")
			req.Header.Set("Origin", tt.origin)
			req.Header.Set("Access-Control-Request-Headers", extensionVersionHeader)
			resp := doRequest(t, handler, req)
			is.Equal(tt.wantStatus, resp.StatusCode)

			if tt.allowed {
				is.Equal(tt.origin, resp.Header.Get("Access-Control-Allow-Origin"))
				is.Contains(resp.Header.Get("Access-Control-Allow-Headers"), extensionVersionHeader)
			} else {
				is.Empty(resp.Header.Get("Access-Control-Allow-Origin"))
			}
		})
	}
}

func newWebUIServer(t *testing.T, files map[string]string) *Server {
	t.Helper()

	dir := t.TempDir()
	for name, content := range files {
		require.NoError(t, os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600))
	}

	ctrl := gomock.NewController(t)
	engineMock := mocks.NewMockEngine(ctrl)
	engineMock.EXPECT().Close().Return(nil).AnyTimes()
	engineMock.EXPECT().Ping(gomock.Any()).Return(nil).AnyTimes()
	engineMock.EXPECT().Warmup(gomock.Any()).Return(nil).AnyTimes()

	sessionStore, err := store.New(t.TempDir())
	require.NoError(t, err)
	control := controller.New(sessionStore, engineMock, mocks.NewMockAudioConverter(ctrl),
		log.New(io.Discard, "", 0))
	require.NoError(t, control.Start())
	t.Cleanup(func() { _ = control.Close() })

	return New(
		control,
		testAPIToken,
		"",
		testExpectedVersion,
		log.New(io.Discard, "", 0),
		WithWebUI(dir),
	)
}

func Test_webUI(t *testing.T) {
	server := newWebUIServer(t, map[string]string{
		"index.html":      "<h1>Созвоны</h1>",
		"transcript.html": "<h1>Транскрипт</h1>",
	})

	t.Run("корень отдаёт список созвонов без токена", func(t *testing.T) {
		// Токена у обычной навигации браузера быть не может: заголовок
		// подставить неоткуда.
		recorder := httptest.NewRecorder()
		server.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))

		require.Equal(t, http.StatusOK, recorder.Code)
		require.Contains(t, recorder.Body.String(), "Созвоны")
	})

	t.Run("страница транскрипта отдаётся по имени файла", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		server.ServeHTTP(recorder,
			httptest.NewRequest(http.MethodGet, "/transcript.html", nil))

		require.Equal(t, http.StatusOK, recorder.Code)
		require.Contains(t, recorder.Body.String(), "Транскрипт")
	})

	// Главное: раздача страниц не должна открывать доступ к самим данным.
	t.Run("данные по-прежнему требуют токен", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		server.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/sessions", nil))

		require.Equal(t, http.StatusUnauthorized, recorder.Code)
	})

	t.Run("выход за пределы каталога не проходит", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		server.ServeHTTP(recorder,
			httptest.NewRequest(http.MethodGet, "/../../etc/passwd", nil))

		require.NotEqual(t, http.StatusOK, recorder.Code)
	})
}

// Без собранного интерфейса сервер остаётся чистым API: так работает разработка.
func Test_webUIDisabled(t *testing.T) {
	server, _ := newTestServer(t, healthyEngine())

	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))

	require.NotEqual(t, http.StatusOK, recorder.Code)
}

// Токен нужен и расширению, и странице, которую приложение отдало само.
// Sec-Fetch-Site браузер проставляет сам и из JavaScript его не подделать,
// поэтому чужая вкладка сюда не попадёт.
func Test_bootstrapToken_sameOrigin(t *testing.T) {
	withUI := newWebUIServer(t, map[string]string{"index.html": "<h1>Созвоны</h1>"})
	withoutUI, _ := newTestServer(t, healthyEngine())

	for _, testCase := range []struct {
		name       string
		server     *Server
		fetchSite  string
		wantStatus int
	}{
		{"свой интерфейс получает токен", withUI, "same-origin", http.StatusOK},
		{"чужая вкладка не получает", withUI, "cross-site", http.StatusForbidden},
		{"без интерфейса same-origin не считается", withoutUI, "same-origin", http.StatusForbidden},
		{"обращение не из страницы получает", withUI, "none", http.StatusOK},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/auth/token", nil)
			request.Header.Set("Sec-Fetch-Site", testCase.fetchSite)
			recorder := httptest.NewRecorder()

			testCase.server.ServeHTTP(recorder, request)

			require.Equal(t, testCase.wantStatus, recorder.Code)
			if testCase.wantStatus == http.StatusOK {
				require.Contains(t, recorder.Body.String(), testAPIToken)
			}
		})
	}
}
