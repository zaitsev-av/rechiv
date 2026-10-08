//go:build darwin && cgo

package onboarding

/*
#cgo LDFLAGS: -framework CoreServices -framework CoreFoundation
#include <stdlib.h>

char *rechiv_default_https_bundle_id(void);
int rechiv_application_for_bundle_id(const char *bundle_id, char **name, char **path);
*/
import "C"

import (
	"errors"
	"os"
	"path/filepath"
	"unsafe"
)

type launchServicesBrowserSource struct{}

func platformBrowserSource() BrowserSource {
	return launchServicesBrowserSource{}
}

func (launchServicesBrowserSource) DefaultBrowser() (Application, error) {
	bundleID := C.rechiv_default_https_bundle_id()
	if bundleID == nil {
		return Application{}, errors.New("LaunchServices не вернул обработчик https")
	}

	defer C.free(unsafe.Pointer(bundleID))
	application, found := launchServicesBrowserSource{}.Application(C.GoString(bundleID))
	if !found {
		return Application{}, errors.New("LaunchServices не нашёл приложение обработчика https")
	}

	return application, nil
}

func (launchServicesBrowserSource) Application(bundleID string) (Application, bool) {
	cBundleID := C.CString(bundleID)
	defer C.free(unsafe.Pointer(cBundleID))
	var cName, cPath *C.char
	if C.rechiv_application_for_bundle_id(cBundleID, &cName, &cPath) == 0 {
		return Application{}, false
	}
	defer C.free(unsafe.Pointer(cName))
	defer C.free(unsafe.Pointer(cPath))

	application := Application{
		Name:     C.GoString(cName),
		BundleID: bundleID,
		Path:     C.GoString(cPath),
	}

	if info, err := os.Stat(application.Path); err != nil || !info.IsDir() {
		return Application{}, false
	}

	_, known := chromiumDefinition(bundleID)
	application.IsChromium = known || hasChromiumFramework(application.Path)

	return application, true
}

func hasChromiumFramework(applicationPath string) bool {
	frameworks := filepath.Join(applicationPath, "Contents", "Frameworks")
	patterns := []string{
		filepath.Join(frameworks, "*Chromium*Framework.framework"),
		filepath.Join(frameworks, "*Chrome*Framework.framework"),
		filepath.Join(frameworks, "* Framework.framework", "Versions", "*", "Helpers", "chrome_crashpad_handler"),
	}

	for _, pattern := range patterns {
		if matches, _ := filepath.Glob(pattern); len(matches) > 0 {
			return true
		}
	}

	return false
}
