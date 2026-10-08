package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"rechiv/desktop/internal/onboarding"
)

func TestOnboardingState(t *testing.T) {
	service := &fakeOnboardingService{state: onboarding.State{
		ExtensionDir: "/Users/test/Library/Application Support/Rechiv/extension",
		Browser: onboarding.Browser{
			Supported:     true,
			Name:          "Google Chrome",
			BundleID:      "com.google.Chrome",
			ExtensionsURL: "chrome://extensions/",
		},
		ChromiumBrowsers: []onboarding.BrowserChoice{
			{Name: "Google Chrome", BundleID: "com.google.Chrome"},
		},
	}}
	server := newOnboardingAPIServer(t, service)

	response := doRequest(t, server, request(http.MethodGet, "/onboarding/state", nil, testAPIToken))

	require.Equal(t, http.StatusOK, response.StatusCode)
	var state onboarding.State
	decodeJSONResponse(t, response, &state)
	require.Equal(t, service.state, state)
}

func TestOpenExtensions(t *testing.T) {
	t.Run("успешный путь", func(t *testing.T) {
		service := &fakeOnboardingService{}
		server := newOnboardingAPIServer(t, service)

		response := doRequest(t, server, request(
			http.MethodPost,
			"/onboarding/open-extensions",
			bytes.NewBufferString(`{"bundleId":"com.google.Chrome"}`),
			testAPIToken,
		))

		require.Equal(t, http.StatusOK, response.StatusCode)
		defer response.Body.Close()
		var body map[string]string
		require.NoError(t, json.NewDecoder(response.Body).Decode(&body))
		require.Equal(t, "opened", body["status"])
		require.Equal(t, "com.google.Chrome", service.openedWithBundleID)
	})

	t.Run("без bundleId использует браузер по умолчанию", func(t *testing.T) {
		service := &fakeOnboardingService{}
		server := newOnboardingAPIServer(t, service)

		response := doRequest(t, server, request(
			http.MethodPost, "/onboarding/open-extensions", nil, testAPIToken,
		))

		require.Equal(t, http.StatusOK, response.StatusCode)
		response.Body.Close()
		require.Empty(t, service.openedWithBundleID)
	})

	for _, testCase := range []struct {
		name  string
		error error
	}{
		{
			name:  "неизвестный bundleId",
			error: fmt.Errorf("%w: браузер не установлен", onboarding.ErrBrowserNotFound),
		},
		{
			name:  "не Chromium браузер",
			error: fmt.Errorf("%w: Safari", onboarding.ErrUnsupportedBrowser),
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			service := &fakeOnboardingService{openExtensionsErr: testCase.error}
			server := newOnboardingAPIServer(t, service)

			response := doRequest(t, server, request(
				http.MethodPost,
				"/onboarding/open-extensions",
				bytes.NewBufferString(`{}`),
				testAPIToken,
			))

			require.Equal(t, http.StatusUnprocessableEntity, response.StatusCode)
			defer response.Body.Close()
			var body map[string]string
			require.NoError(t, json.NewDecoder(response.Body).Decode(&body))
			require.Contains(t, body["detail"], testCase.error.Error())
		})
	}
}

func TestRevealExtension(t *testing.T) {
	t.Run("успешный путь", func(t *testing.T) {
		server := newOnboardingAPIServer(t, &fakeOnboardingService{})

		response := doRequest(t, server, request(
			http.MethodPost, "/onboarding/reveal", nil, testAPIToken,
		))

		require.Equal(t, http.StatusOK, response.StatusCode)
		defer response.Body.Close()
		var body map[string]string
		require.NoError(t, json.NewDecoder(response.Body).Decode(&body))
		require.Equal(t, "opened", body["status"])
	})

	t.Run("каталог отсутствует", func(t *testing.T) {
		service := &fakeOnboardingService{
			revealErr: fmt.Errorf("%w: расширение ещё не собрано", onboarding.ErrExtensionNotFound),
		}
		server := newOnboardingAPIServer(t, service)

		response := doRequest(t, server, request(
			http.MethodPost, "/onboarding/reveal", nil, testAPIToken,
		))

		require.Equal(t, http.StatusUnprocessableEntity, response.StatusCode)
		response.Body.Close()
	})
}

func TestOnboardingRequiresTokenWithWebUI(t *testing.T) {
	server := newOnboardingAPIServer(t, &fakeOnboardingService{})
	for _, testCase := range []struct {
		method string
		path   string
	}{
		{method: http.MethodGet, path: "/onboarding/state"},
		{method: http.MethodPost, path: "/onboarding/open-extensions"},
		{method: http.MethodPost, path: "/onboarding/reveal"},
	} {
		t.Run(testCase.path, func(t *testing.T) {
			response := doRequest(t, server, request(testCase.method, testCase.path, nil, ""))
			defer response.Body.Close()
			require.Equal(t, http.StatusUnauthorized, response.StatusCode)
		})
	}
}

func newOnboardingAPIServer(t *testing.T, service onboardingService) *Server {
	t.Helper()
	server := newWebUIServer(t, map[string]string{"index.html": "<h1>Rechiv</h1>"})
	server.onboarding = service
	return server
}
