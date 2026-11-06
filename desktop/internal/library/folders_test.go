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
	f, err := st.CreateFolder("Планёрки", "")
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

func TestNestedFolderPaths(t *testing.T) {
	dir := t.TempDir()
	st, err := store.New(dir)
	require.NoError(t, err)
	parent, err := st.CreateFolder("Груминги", "")
	require.NoError(t, err)
	child, err := st.CreateFolder("Платежи", parent.ID)
	require.NoError(t, err)
	leaf, err := st.CreateFolder("Планёрки", child.ID)
	require.NoError(t, err)
	for id, folderID := range map[string]string{"parent": parent.ID, "child": child.ID, "leaf": leaf.ID} {
		session := fixtureSession(t, dir, id)
		session.FolderID = folderID
		writeFixture(t, dir, id, "meta.json", session)
	}
	fixtureSession(t, dir, "inbox")
	lib := New(dir)
	for _, tt := range []struct {
		filter string
		count  int
	}{
		{"ГРУМИНГ", 3}, {"Платеж", 2}, {"планер", 1}, {"Груминги / Платежи", 2}, {"inbox", 1}, {"Входящие", 1},
	} {
		calls, err := lib.ListCalls(context.Background(), ListFilter{Folder: tt.filter})
		require.NoError(t, err)
		require.Len(t, calls, tt.count, tt.filter)
	}
	calls, err := lib.ListCalls(context.Background(), ListFilter{Folder: "планер"})
	require.NoError(t, err)
	require.Equal(t, "Планёрки", calls[0].Folder)
	require.Equal(t, "Груминги / Платежи / Планёрки", calls[0].FolderPath)
	raw, err := json.Marshal(calls[0])
	require.NoError(t, err)
	require.Contains(t, string(raw), `"folderPath":"Груминги / Платежи / Планёрки"`)
	_, err = st.RenameFolder(parent.ID, "Встречи")
	require.NoError(t, err)
	calls, err = lib.ListCalls(context.Background(), ListFilter{Folder: "груминг"})
	require.NoError(t, err)
	require.Empty(t, calls)
	_, err = st.MoveFolder(child.ID, "")
	require.NoError(t, err)
	calls, err = lib.ListCalls(context.Background(), ListFilter{Folder: "планер"})
	require.NoError(t, err)
	require.Equal(t, "Платежи / Планёрки", calls[0].FolderPath)
}
