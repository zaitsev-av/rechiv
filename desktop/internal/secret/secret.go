package secret

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

type Store interface {
	// Get возвращает пустую строку, если ключа нет.
	Get() (string, error)
	Set(value string) error
	Delete() error
}

type File struct {
	Path string
}

func (f File) Get() (string, error) {
	raw, err := os.ReadFile(f.Path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	return strings.TrimSpace(string(raw)), err
}

func (f File) Set(value string) error {
	if err := os.MkdirAll(filepath.Dir(f.Path), 0o700); err != nil {
		return err
	}
	tmp := f.Path + ".tmp"
	if err := os.WriteFile(tmp, []byte(value), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, f.Path)
}

func (f File) Delete() error {
	if err := os.Remove(f.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
