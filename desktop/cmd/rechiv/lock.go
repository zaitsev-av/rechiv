package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

var errAlreadyRunning = errors.New("rechiv уже запущен")

func acquireInstanceLock(dataDir string) (*os.File, error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, err
	}

	file, err := os.OpenFile(filepath.Join(dataDir, "rechiv.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}

	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, errAlreadyRunning
		}
		return nil, fmt.Errorf("lock data directory: %w", err)
	}

	return file, nil
}
