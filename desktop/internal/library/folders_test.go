package library

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
	"rechiv/desktop/internal/store"
)

func TestListCallsFolders(t *testing.T) {
	dir := t.TempDir()
	st, err := store.New(dir)
	require.NoError(t, err)
	f, err := st.CreateFolder("Планёрки")
	require.NoError(t, err)
	session := fixtureSession(t, dir, "one")
	session.FolderID = f.ID
	writeFixture(t, dir, "one", "meta.json", session)
	fixtureSession(t, dir, "two")
	orphan := fixtureSession(t, dir, "three")
	orphan.FolderID = "missing"
	writeFixture(t, dir, "three", "meta.json", orphan)
	lib := New(dir)
	for _, tt := range []struct {
		filter string
		count  int
	}{
		{"", 3}, {"ПЛАНЕР", 1}, {"планёр", 1}, {"inbox", 2}, {"ВХОДЯЩИЕ", 2}, {"other", 0},
	} {
		calls, err := lib.ListCalls(context.Background(), ListFilter{Folder: tt.filter})
		require.NoError(t, err)
		require.Len(t, calls, tt.count, tt.filter)
	}
	calls, err := lib.ListCalls(context.Background(), ListFilter{Folder: "планер"})
	require.NoError(t, err)
	require.Equal(t, "Планёрки", calls[0].Folder)
	raw, err := json.Marshal(calls[0])
	require.NoError(t, err)
	require.Contains(t, string(raw), `"folder":"Планёрки"`)
	_, err = st.RenameFolder(f.ID, "Дейли")
	require.NoError(t, err)
	calls, err = lib.ListCalls(context.Background(), ListFilter{Folder: "дейли"})
	require.NoError(t, err)
	require.Len(t, calls, 1)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "folders.json"), []byte("broken"), 0o600))
	calls, err = lib.ListCalls(context.Background(), ListFilter{Folder: "inbox"})
	require.NoError(t, err)
	require.Len(t, calls, 3)
}
