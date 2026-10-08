package extensiondist

import (
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

func Sync(source, target string) (bool, error) {
	if strings.TrimSpace(source) == "" {
		return false, nil
	}

	info, err := os.Stat(source)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("проверить источник расширения: %w", err)
	}

	if !info.IsDir() {
		return false, fmt.Errorf("источник расширения %s не является каталогом", source)
	}

	sourceVersion, err := manifestVersion(source)
	if err != nil {
		return false, fmt.Errorf("прочитать исходный manifest.json: %w", err)
	}

	if targetVersion, targetErr := manifestVersion(target); targetErr == nil && targetVersion == sourceVersion {
		return false, nil
	}

	parent := filepath.Dir(target)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return false, fmt.Errorf("создать каталог для расширения: %w", err)
	}

	staged, err := os.MkdirTemp(parent, "."+filepath.Base(target)+"-*")
	if err != nil {
		return false, fmt.Errorf("создать временный каталог расширения: %w", err)
	}

	keepStaged := true
	defer func() {
		if keepStaged {
			_ = os.RemoveAll(staged)
		}
	}()

	if err := copyDirectory(source, staged); err != nil {
		return false, fmt.Errorf("скопировать расширение: %w", err)
	}

	if err := replaceDirectory(staged, target); err != nil {
		return false, fmt.Errorf("подменить каталог расширения: %w", err)
	}

	keepStaged = false

	return true, nil
}

func manifestVersion(dir string) (string, error) {
	if strings.TrimSpace(dir) == "" {
		return "", fs.ErrNotExist
	}

	file, err := os.Open(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return "", err
	}
	defer file.Close()

	var manifest struct {
		Version string `json:"version"`
	}

	decoder := json.NewDecoder(file)
	if err := decoder.Decode(&manifest); err != nil {
		return "", err
	}

	manifest.Version = strings.TrimSpace(manifest.Version)
	if manifest.Version == "" {
		return "", fmt.Errorf("поле version пустое")
	}

	return manifest.Version, nil
}

func copyDirectory(source, target string) error {
	return filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}

		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}

		if relative == "." {
			return nil
		}

		destination := filepath.Join(target, relative)
		info, err := entry.Info()
		if err != nil {
			return err
		}

		switch {
		case entry.IsDir():
			if err := os.Mkdir(destination, info.Mode().Perm()); err != nil {
				return err
			}
			return os.Chmod(destination, info.Mode().Perm())
		case entry.Type()&os.ModeSymlink != 0:
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(link, destination)
		case entry.Type().IsRegular():
			return copyFile(path, destination, info.Mode().Perm())
		default:
			return fmt.Errorf("неподдерживаемый тип файла %s", path)
		}
	})
}

func copyFile(source, target string, mode fs.FileMode) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()

	output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}

	if _, err := io.Copy(output, input); err != nil {
		_ = output.Close()
		return err
	}

	if err := output.Close(); err != nil {
		return err
	}

	return os.Chmod(target, mode)
}
