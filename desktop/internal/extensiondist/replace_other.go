//go:build !darwin || !cgo

package extensiondist

import (
	"fmt"
	"os"
	"path/filepath"
)

func replaceDirectory(staged, target string) error {
	if _, err := os.Lstat(target); os.IsNotExist(err) {
		return os.Rename(staged, target)
	} else if err != nil {
		return err
	}

	backup := filepath.Join(filepath.Dir(target), "."+filepath.Base(target)+"-previous")
	_ = os.RemoveAll(backup)
	if err := os.Rename(target, backup); err != nil {
		return err
	}
	if err := os.Rename(staged, target); err != nil {
		if rollbackErr := os.Rename(backup, target); rollbackErr != nil {
			return fmt.Errorf("%w; откат также не удался: %v", err, rollbackErr)
		}
		return err
	}
	return os.RemoveAll(backup)
}
