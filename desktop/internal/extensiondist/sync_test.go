package extensiondist

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSync(t *testing.T) {
	t.Run("создаёт стабильную копию с нуля", func(t *testing.T) {
		root := t.TempDir()
		source := filepath.Join(root, "bundle", "extension")
		target := filepath.Join(root, "data", "extension")
		writeExtension(t, source, "0.4.1", "новая версия")

		changed, err := Sync(source, target)

		require.NoError(t, err)
		require.True(t, changed)
		content, err := os.ReadFile(filepath.Join(target, "background", "service-worker.js"))
		require.NoError(t, err)
		require.Equal(t, "новая версия", string(content))
	})

	t.Run("заменяет каталог при смене версии", func(t *testing.T) {
		root := t.TempDir()
		source := filepath.Join(root, "bundle", "extension")
		target := filepath.Join(root, "data", "extension")
		writeExtension(t, source, "0.4.2", "новая версия")
		writeExtension(t, target, "0.4.1", "старая версия")
		require.NoError(t, os.WriteFile(filepath.Join(target, "лишний.js"), []byte("старый"), 0o600))

		changed, err := Sync(source, target)

		require.NoError(t, err)
		require.True(t, changed)
		version, err := manifestVersion(target)
		require.NoError(t, err)
		require.Equal(t, "0.4.2", version)
		_, err = os.Stat(filepath.Join(target, "лишний.js"))
		require.ErrorIs(t, err, os.ErrNotExist)
	})

	t.Run("не копирует заново совпадающую версию", func(t *testing.T) {
		root := t.TempDir()
		source := filepath.Join(root, "bundle", "extension")
		target := filepath.Join(root, "data", "extension")
		writeExtension(t, source, "0.4.1", "из бандла")
		writeExtension(t, target, "0.4.1", "уже установленное")
		marker := filepath.Join(target, "не-трогать")
		require.NoError(t, os.WriteFile(marker, []byte("на месте"), 0o600))

		changed, err := Sync(source, target)

		require.NoError(t, err)
		require.False(t, changed)
		content, err := os.ReadFile(marker)
		require.NoError(t, err)
		require.Equal(t, "на месте", string(content))
	})

	t.Run("отсутствующий источник допустим", func(t *testing.T) {
		changed, err := Sync(filepath.Join(t.TempDir(), "missing"), filepath.Join(t.TempDir(), "extension"))

		require.NoError(t, err)
		require.False(t, changed)
	})

	t.Run("битый источник отвергается", func(t *testing.T) {
		root := t.TempDir()
		source := filepath.Join(root, "extension")
		require.NoError(t, os.MkdirAll(source, 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(source, "manifest.json"), []byte(`{"version":`), 0o600))

		changed, err := Sync(source, filepath.Join(root, "target"))

		require.Error(t, err)
		require.False(t, changed)
	})
}

func writeExtension(t *testing.T, dir, version, worker string) {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "background"), 0o755))
	manifest := `{"manifest_version":3,"version":"` + version + `"}`
	require.NoError(t, os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(manifest), 0o600))
	require.NoError(t, os.WriteFile(
		filepath.Join(dir, "background", "service-worker.js"),
		[]byte(worker),
		0o600,
	))
}
