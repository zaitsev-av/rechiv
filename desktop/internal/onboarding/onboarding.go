package onboarding

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const firstRunMarker = "onboarding_shown"

var (
	ErrBrowserNotFound    = errors.New("браузер не найден")
	ErrUnsupportedBrowser = errors.New("браузер не поддерживается")
	ErrExtensionNotFound  = errors.New("каталог расширения не найден")
)

type Browser struct {
	Supported     bool   `json:"supported"`
	Name          string `json:"name"`
	BundleID      string `json:"bundleId"`
	ExtensionsURL string `json:"extensionsUrl"`
}

type BrowserChoice struct {
	Name     string `json:"name"`
	BundleID string `json:"bundleId"`
}

type State struct {
	ExtensionDir     string          `json:"extensionDir"`
	Browser          Browser         `json:"browser"`
	ChromiumBrowsers []BrowserChoice `json:"chromiumBrowsers"`
}

type Application struct {
	Name       string
	BundleID   string
	Path       string
	IsChromium bool
}

type BrowserSource interface {
	DefaultBrowser() (Application, error)
	Application(bundleID string) (Application, bool)
}

type CommandRunner interface {
	Run(name string, args ...string) error
}

type execRunner struct{}

func (execRunner) Run(name string, args ...string) error {
	return exec.Command(name, args...).Run()
}

type Service struct {
	extensionDir string
	browsers     BrowserSource
	runner       CommandRunner
}

func New(extensionDir string, browsers BrowserSource, runner CommandRunner) *Service {
	if browsers == nil {
		browsers = platformBrowserSource()
	}
	if runner == nil {
		runner = execRunner{}
	}
	return &Service{
		extensionDir: extensionDir,
		browsers:     browsers,
		runner:       runner,
	}
}

func (s *Service) State() State {
	state := State{
		ExtensionDir:     s.existingExtensionDir(),
		ChromiumBrowsers: make([]BrowserChoice, 0),
	}

	defaultApplication, defaultErr := s.browsers.DefaultBrowser()
	if defaultErr == nil {
		state.Browser = describeBrowser(defaultApplication)
	}

	seen := make(map[string]struct{}, len(chromiumApplications)+1)
	for _, definition := range chromiumApplications {
		application, found := s.browsers.Application(definition.BundleID)
		if !found {
			continue
		}
		browser := describeBrowser(application)
		if !browser.Supported {
			continue
		}
		key := strings.ToLower(browser.BundleID)
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		state.ChromiumBrowsers = append(state.ChromiumBrowsers, BrowserChoice{
			Name:     browser.Name,
			BundleID: browser.BundleID,
		})
	}

	if state.Browser.Supported {
		key := strings.ToLower(state.Browser.BundleID)
		if _, duplicate := seen[key]; !duplicate {
			state.ChromiumBrowsers = append(state.ChromiumBrowsers, BrowserChoice{
				Name:     state.Browser.Name,
				BundleID: state.Browser.BundleID,
			})
		}
	}

	return state
}

func (s *Service) OpenExtensions(bundleID string) error {
	bundleID = strings.TrimSpace(bundleID)
	var (
		application Application
		found       bool
	)

	if bundleID == "" {
		var err error
		application, err = s.browsers.DefaultBrowser()
		if err != nil {
			return fmt.Errorf("%w: не удалось определить браузер по умолчанию", ErrBrowserNotFound)
		}
		found = true
	} else {
		application, found = s.browsers.Application(bundleID)
	}

	if !found {
		return fmt.Errorf("%w: браузер с bundleId %q не установлен", ErrBrowserNotFound, bundleID)
	}

	browser := describeBrowser(application)
	if !browser.Supported {
		name := browser.Name
		if name == "" {
			name = browser.BundleID
		}

		return fmt.Errorf("%w: %s не поддерживает расширения Chromium", ErrUnsupportedBrowser, name)
	}

	target, value := openTarget(application)
	if err := s.runner.Run("/usr/bin/open", target, value, browser.ExtensionsURL); err != nil {
		return fmt.Errorf("не удалось открыть страницу расширений в %s: %w", browser.Name, err)
	}

	return nil
}

// Имя ненадёжно при переименовании или переносе .app: используем путь LaunchServices либо bundle id.
func openTarget(application Application) (string, string) {
	if strings.TrimSpace(application.Path) != "" {
		return "-a", application.Path
	}

	return "-b", application.BundleID
}

func (s *Service) Reveal() error {
	dir := s.existingExtensionDir()
	if dir == "" {
		return fmt.Errorf("%w: расширение ещё не собрано", ErrExtensionNotFound)
	}

	if err := s.runner.Run("/usr/bin/open", "-R", dir); err != nil {
		return fmt.Errorf("не удалось показать каталог расширения: %w", err)
	}

	return nil
}

func (s *Service) OpenFirstOnboarding(dataDir, url string) (bool, error) {
	if strings.TrimSpace(url) == "" {
		return false, nil
	}

	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return false, fmt.Errorf("создать каталог данных для онбординга: %w", err)
	}

	marker := filepath.Join(dataDir, firstRunMarker)
	file, err := os.OpenFile(marker, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if errors.Is(err, os.ErrExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("создать маркер онбординга: %w", err)
	}

	if closeErr := file.Close(); closeErr != nil {
		_ = os.Remove(marker)
		return false, fmt.Errorf("закрыть маркер онбординга: %w", closeErr)
	}

	if err := s.runner.Run("/usr/bin/open", url); err != nil {
		_ = os.Remove(marker)
		return false, fmt.Errorf("открыть онбординг: %w", err)
	}

	return true, nil
}

func (s *Service) existingExtensionDir() string {
	if strings.TrimSpace(s.extensionDir) == "" {
		return ""
	}

	info, err := os.Stat(s.extensionDir)
	if err != nil || !info.IsDir() {
		return ""
	}

	manifest, err := os.Stat(filepath.Join(s.extensionDir, "manifest.json"))
	if err != nil || manifest.IsDir() {
		return ""
	}

	return s.extensionDir
}

const extensionsURL = "chrome://extensions/"

type chromiumApplication struct {
	Name     string
	BundleID string
}

var chromiumApplications = []chromiumApplication{
	{Name: "Google Chrome", BundleID: "com.google.Chrome"},
	{Name: "Google Chrome Beta", BundleID: "com.google.Chrome.beta"},
	{Name: "Google Chrome Dev", BundleID: "com.google.Chrome.dev"},
	{Name: "Google Chrome Canary", BundleID: "com.google.Chrome.canary"},
	{Name: "Chromium", BundleID: "org.chromium.Chromium"},
	{Name: "Arc", BundleID: "company.thebrowser.Browser"},
	{Name: "Microsoft Edge", BundleID: "com.microsoft.edgemac"},
	{Name: "Microsoft Edge Beta", BundleID: "com.microsoft.edgemac.Beta"},
	{Name: "Microsoft Edge Dev", BundleID: "com.microsoft.edgemac.Dev"},
	{Name: "Microsoft Edge Canary", BundleID: "com.microsoft.edgemac.Canary"},
	{Name: "Brave Browser", BundleID: "com.brave.Browser"},
	{Name: "Brave Browser Beta", BundleID: "com.brave.Browser.beta"},
	{Name: "Brave Browser Nightly", BundleID: "com.brave.Browser.nightly"},
	{Name: "Vivaldi", BundleID: "com.vivaldi.Vivaldi"},
	{Name: "Yandex Browser", BundleID: "ru.yandex.desktop.yandex-browser"},
	{Name: "Opera", BundleID: "com.operasoftware.Opera"},
	{Name: "Opera GX", BundleID: "com.operasoftware.OperaGX"},
}

func describeBrowser(application Application) Browser {
	browser := Browser{
		Name:     strings.TrimSpace(application.Name),
		BundleID: strings.TrimSpace(application.BundleID),
	}

	if definition, found := chromiumDefinition(browser.BundleID); found {
		browser.Supported = true
		browser.ExtensionsURL = extensionsURL
		if browser.Name == "" {
			browser.Name = definition.Name
		}
		return browser
	}

	if application.IsChromium {
		browser.Supported = true
		browser.ExtensionsURL = extensionsURL
	}

	return browser
}

func chromiumDefinition(bundleID string) (chromiumApplication, bool) {
	for _, definition := range chromiumApplications {
		if strings.EqualFold(definition.BundleID, bundleID) {
			return definition, true
		}
	}

	return chromiumApplication{}, false
}
