package secret

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestFile(t *testing.T) {
	store := File{Path: filepath.Join(t.TempDir(), "dir", "key")}
	value, err := store.Get()
	require.NoError(t, err)
	require.Empty(t, value)

	require.NoError(t, store.Set("sk-1"))
	value, err = store.Get()
	require.NoError(t, err)
	require.Equal(t, "sk-1", value)
	info, err := os.Stat(store.Path)
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0o600), info.Mode().Perm())

	require.NoError(t, store.Delete())
	require.NoError(t, store.Delete())
	value, err = store.Get()
	require.NoError(t, err)
	require.Empty(t, value)
}
