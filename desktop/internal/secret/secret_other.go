//go:build !darwin

package secret

import "path/filepath"

func Default(dataDir string) Store {
	return File{Path: filepath.Join(dataDir, "llm_api_key")}
}
