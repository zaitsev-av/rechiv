//go:build !darwin || !cgo

package onboarding

import "errors"

type unavailableBrowserSource struct{}

func platformBrowserSource() BrowserSource {
	return unavailableBrowserSource{}
}

func (unavailableBrowserSource) DefaultBrowser() (Application, error) {
	return Application{}, errors.New("LaunchServices доступен только на macOS")
}

func (unavailableBrowserSource) Application(string) (Application, bool) {
	return Application{}, false
}
