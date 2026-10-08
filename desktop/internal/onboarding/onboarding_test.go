package onboarding

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

type fakeBrowserSource struct {
	defaultBrowser Application
	defaultErr     error
	applications   map[string]Application
}

func (f fakeBrowserSource) DefaultBrowser() (Application, error) {
	return f.defaultBrowser, f.defaultErr
}

func (f fakeBrowserSource) Application(bundleID string) (Application, bool) {
	application, found := f.applications[bundleID]
	return application, found
}

type commandCall struct {
	name string
	args []string
}

type fakeRunner struct {
	calls []commandCall
	err   error
}

func (f *fakeRunner) Run(name string, args ...string) error {
	f.calls = append(f.calls, commandCall{name: name, args: append([]string(nil), args...)})
	return f.err
}

func TestServiceState(t *testing.T) {
	extensionDir := writeBuiltExtension(t)
	browsers := fakeBrowserSource{
		defaultBrowser: Application{Name: "Safari", BundleID: "com.apple.Safari"},
		applications: map[string]Application{
			"com.google.Chrome": {
				Name: "Google Chrome", BundleID: "com.google.Chrome", IsChromium: true,
			},
			"ru.yandex.desktop.yandex-browser": {
				Name: "Yandex Browser", BundleID: "ru.yandex.desktop.yandex-browser", IsChromium: true,
			},
		},
	}

	state := New(extensionDir, browsers, &fakeRunner{}).State()

	require.Equal(t, extensionDir, state.ExtensionDir)
	require.Equal(t, Browser{
		Supported: false,
		Name:      "Safari",
		BundleID:  "com.apple.Safari",
	}, state.Browser)
	require.Equal(t, []BrowserChoice{
		{Name: "Google Chrome", BundleID: "com.google.Chrome"},
		{Name: "Yandex Browser", BundleID: "ru.yandex.desktop.yandex-browser"},
	}, state.ChromiumBrowsers)
}

func TestServiceStateUnknownChromium(t *testing.T) {
	browser := Application{
		Name: "Новый Chromium", BundleID: "example.new.browser", IsChromium: true,
	}
	state := New("", fakeBrowserSource{defaultBrowser: browser}, &fakeRunner{}).State()

	require.True(t, state.Browser.Supported)
	require.Equal(t, "chrome://extensions/", state.Browser.ExtensionsURL)
	require.Equal(t, []BrowserChoice{{
		Name: "Новый Chromium", BundleID: "example.new.browser",
	}}, state.ChromiumBrowsers)
}

// Брендовые схемы вроде brave:// снаружи не открываются, поэтому адрес у всех
// Chromium-браузеров один — проверено на живом Brave.
func TestExtensionsURLByBrowser(t *testing.T) {
	for _, testCase := range []struct {
		name     string
		bundleID string
	}{
		{name: "Chrome", bundleID: "com.google.Chrome"},
		{name: "Arc", bundleID: "company.thebrowser.Browser"},
		{name: "Edge", bundleID: "com.microsoft.edgemac"},
		{name: "Brave", bundleID: "com.brave.Browser"},
		{name: "Vivaldi", bundleID: "com.vivaldi.Vivaldi"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			browser := describeBrowser(Application{BundleID: testCase.bundleID})
			require.True(t, browser.Supported)
			require.Equal(t, "chrome://extensions/", browser.ExtensionsURL)
		})
	}
}

func TestOpenExtensions(t *testing.T) {
	chrome := Application{
		Name:       "Google Chrome",
		BundleID:   "com.google.Chrome",
		Path:       "/Applications/Google Chrome.app",
		IsChromium: true,
	}
	safari := Application{Name: "Safari", BundleID: "com.apple.Safari"}
	browsers := fakeBrowserSource{
		defaultBrowser: chrome,
		applications: map[string]Application{
			chrome.BundleID: chrome,
			safari.BundleID: safari,
		},
	}

	t.Run("открывает браузер по умолчанию", func(t *testing.T) {
		runner := &fakeRunner{}
		err := New("", browsers, runner).OpenExtensions("")

		require.NoError(t, err)
		require.Equal(t, []commandCall{{
			name: "/usr/bin/open",
			args: []string{"-a", chrome.Path, "chrome://extensions/"},
		}}, runner.calls)
	})

	// Путь известен не всегда: тогда адресуем браузер bundle id, потому что имя
	// приложения на диске может отличаться от того, что мы показываем.
	t.Run("без пути открывает по bundle id", func(t *testing.T) {
		pathless := Application{Name: "Brave Browser", BundleID: "com.brave.Browser"}
		runner := &fakeRunner{}
		source := fakeBrowserSource{
			applications: map[string]Application{pathless.BundleID: pathless},
		}

		err := New("", source, runner).OpenExtensions(pathless.BundleID)

		require.NoError(t, err)
		require.Equal(t, []commandCall{{
			name: "/usr/bin/open",
			args: []string{"-b", pathless.BundleID, "chrome://extensions/"},
		}}, runner.calls)
	})

	t.Run("неизвестный bundleId", func(t *testing.T) {
		err := New("", browsers, &fakeRunner{}).OpenExtensions("unknown.browser")

		require.ErrorIs(t, err, ErrBrowserNotFound)
		require.Contains(t, err.Error(), "не установлен")
	})

	t.Run("не Chromium браузер", func(t *testing.T) {
		err := New("", browsers, &fakeRunner{}).OpenExtensions(safari.BundleID)

		require.ErrorIs(t, err, ErrUnsupportedBrowser)
		require.Contains(t, err.Error(), "Safari")
	})
}

func TestReveal(t *testing.T) {
	t.Run("показывает существующий каталог в Finder", func(t *testing.T) {
		dir := writeBuiltExtension(t)
		runner := &fakeRunner{}

		err := New(dir, fakeBrowserSource{}, runner).Reveal()

		require.NoError(t, err)
		require.Equal(t, []commandCall{{
			name: "/usr/bin/open", args: []string{"-R", dir},
		}}, runner.calls)
	})

	t.Run("отсутствующий каталог", func(t *testing.T) {
		err := New(filepath.Join(t.TempDir(), "missing"), fakeBrowserSource{}, &fakeRunner{}).Reveal()

		require.ErrorIs(t, err, ErrExtensionNotFound)
	})
}

func TestOpenFirstOnboarding(t *testing.T) {
	dataDir := t.TempDir()
	runner := &fakeRunner{}
	service := New("", fakeBrowserSource{}, runner)

	opened, err := service.OpenFirstOnboarding(dataDir, "http://127.0.0.1:9876/onboarding.html")
	require.NoError(t, err)
	require.True(t, opened)
	require.Len(t, runner.calls, 1)

	opened, err = service.OpenFirstOnboarding(dataDir, "http://127.0.0.1:9876/onboarding.html")
	require.NoError(t, err)
	require.False(t, opened)
	require.Len(t, runner.calls, 1)
}

func TestOpenFirstOnboardingRetriesAfterOpenError(t *testing.T) {
	dataDir := t.TempDir()
	runner := &fakeRunner{err: errors.New("open failed")}
	service := New("", fakeBrowserSource{}, runner)

	opened, err := service.OpenFirstOnboarding(dataDir, "http://127.0.0.1:9876/onboarding.html")
	require.Error(t, err)
	require.False(t, opened)

	runner.err = nil
	opened, err = service.OpenFirstOnboarding(dataDir, "http://127.0.0.1:9876/onboarding.html")
	require.NoError(t, err)
	require.True(t, opened)
}

func writeBuiltExtension(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "extension")
	require.NoError(t, os.MkdirAll(dir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(`{"version":"0.4.1"}`), 0o600))
	return dir
}
