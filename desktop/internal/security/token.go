package security

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func EnsureToken(dataDir, name string) (string, error) {
	path := filepath.Join(dataDir, name)
	if raw, err := os.ReadFile(path); err == nil {
		token := strings.TrimSpace(string(raw))
		if token == "" {
			return "", fmt.Errorf("%s is empty", path)
		}
		return token, nil
	} else if !os.IsNotExist(err) {
		return "", err
	}

	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return "", err
	}

	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}

	token := hex.EncodeToString(buf)
	if err := os.WriteFile(path, []byte(token+"\n"), 0o600); err != nil {
		return "", err
	}

	return token, nil
}

func RandomToken() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}

	return hex.EncodeToString(buf), nil
}
