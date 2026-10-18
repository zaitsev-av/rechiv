package store

import (
	"bytes"
	"log"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"rechiv/desktop/internal/domain"
)

func TestFoldersLifecycle(t *testing.T) {
	dir := t.TempDir()
	st, err := New(dir)
	require.NoError(t, err)
	require.Empty(t, st.Folders())
	_, err = st.CreateFolder(" \n")
	require.ErrorIs(t, err, ErrInvalid)
	a, err := st.CreateFolder(" Дейли ")
	require.NoError(t, err)
	require.Equal(t, "Дейли", a.Name)
	b, err := st.CreateFolder("Ретро")
	require.NoError(t, err)
	require.NotEqual(t, a.ID, b.ID)
	require.Equal(t, 1, b.Color)
	a, err = st.RenameFolder(a.ID, "Стендапы")
	require.NoError(t, err)
	require.Equal(t, "Стендапы", a.Name)
	_, err = st.RenameFolder(a.ID, "")
	require.ErrorIs(t, err, ErrInvalid)
	_, err = st.RenameFolder("missing", "name")
	require.ErrorIs(t, err, ErrNotFound)
	session, err := st.Create("https://meet.google.com/abc?authuser=1")
	require.NoError(t, err)
	f, matching, err := st.AddFolderRule(a.ID, "https://meet.google.com/abc/")
	require.NoError(t, err)
	require.Equal(t, []string{session.SessionID}, matching)
	require.Equal(t, "meet.google.com/abc", f.Rules[0].URL)
	f.Rules[0].URL = "changed"
	require.Equal(t, "meet.google.com/abc", st.Folders()[0].Rules[0].URL)
	_, _, err = st.AddFolderRule(b.ID, "meet.google.com/abc#x")
	require.NoError(t, err)
	require.Empty(t, st.Folders()[0].Rules)
	require.Len(t, st.Folders()[1].Rules, 1)
	require.NoError(t, st.MoveSessions([]string{session.SessionID}, b.ID, true))
	_, matching, err = st.AddFolderRule(b.ID, "meet.google.com/abc")
	require.NoError(t, err)
	require.Empty(t, matching)
	restored, err := New(dir)
	require.NoError(t, err)
	saved, err := restored.Get(session.SessionID)
	require.NoError(t, err)
	require.Equal(t, b.ID, saved.FolderID)
	require.True(t, saved.FolderByRule)
	require.NoError(t, st.DeleteFolderRule(b.ID, "https://meet.google.com/abc?x=1"))
	saved, err = st.Get(session.SessionID)
	require.NoError(t, err)
	require.Equal(t, b.ID, saved.FolderID)
	require.NoError(t, st.MoveSessions([]string{session.SessionID}, a.ID, false))
	saved, err = st.Get(session.SessionID)
	require.NoError(t, err)
	require.False(t, saved.FolderByRule)
	require.NoError(t, st.DeleteFolder(a.ID))
	saved, err = st.Get(session.SessionID)
	require.NoError(t, err)
	require.Empty(t, saved.FolderID)
	require.False(t, saved.FolderByRule)
	restored, err = New(dir)
	require.NoError(t, err)
	saved, err = restored.Get(session.SessionID)
	require.NoError(t, err)
	require.Empty(t, saved.FolderID)
	require.ErrorIs(t, st.DeleteFolder(a.ID), ErrNotFound)
	require.ErrorIs(t, st.MoveSessions([]string{session.SessionID}, "missing", false), ErrInvalid)
	require.ErrorIs(t, st.MoveSessions([]string{session.SessionID, "missing"}, b.ID, true), ErrNotFound)
	saved, _ = st.Get(session.SessionID)
	require.Empty(t, saved.FolderID)
	_, _, err = st.AddFolderRule(b.ID, "broken")
	require.ErrorIs(t, err, ErrInvalid)
	// Возвращаемые структуры не дают менять состояние без мьютекса.
	folders := st.Folders()
	folders[0].Name = "changed"
	require.Equal(t, "Ретро", st.Folders()[0].Name)
}

func TestFoldersMissingCorruptAndLegacyMeta(t *testing.T) {
	dir := t.TempDir()
	st, err := New(dir)
	require.NoError(t, err)
	session, err := st.Create("")
	require.NoError(t, err)
	raw, err := os.ReadFile(filepath.Join(st.SessionDir(session.SessionID), "meta.json"))
	require.NoError(t, err)
	require.NotContains(t, string(raw), "folderId")
	st, err = New(dir)
	require.NoError(t, err)
	saved, err := st.Get(session.SessionID)
	require.NoError(t, err)
	require.Empty(t, saved.FolderID)
	folder, err := st.CreateFolder("One")
	require.NoError(t, err)
	require.NoError(t, st.MoveSessions([]string{session.SessionID}, folder.ID, true))
	path := filepath.Join(dir, "folders.json")
	require.NoError(t, os.WriteFile(path, []byte("{broken"), 0o600))
	var warning bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&warning)
	st, err = New(dir)
	log.SetOutput(previous)
	require.NoError(t, err)
	require.Contains(t, warning.String(), "warning:")
	require.Empty(t, st.Folders())
	saved, err = st.Get(session.SessionID)
	require.NoError(t, err)
	require.Empty(t, saved.FolderID)
	require.False(t, saved.FolderByRule)
	require.Empty(t, st.List()[0].FolderID)
	after, err := os.ReadFile(path)
	require.NoError(t, err)
	require.Equal(t, "{broken", string(after))

	_, err = st.CreateFolder("Two")
	require.NoError(t, err)
	backup, err := os.ReadFile(path + ".broken")
	require.NoError(t, err)
	require.Equal(t, "{broken", string(backup))
	require.NoError(t, os.Remove(path))
	st, err = New(dir)
	require.NoError(t, err)
	require.Empty(t, st.List()[0].FolderID)
}

func TestReadFoldersSkipsOnlyBadEntries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "folders.json")
	raw := `{"folders":[
		{"id":"","name":"Без id","color":0},
		{"id":"a","name":"Дейли","color":7,"rules":[{"url":"https://meet.google.com/abc-defg-hij/?authuser=0"},{"url":"не ссылка"}]},
		{"id":"a","name":"Повтор","color":1},
		{"id":"b","name":"  ","color":1}
	]}`
	require.NoError(t, os.WriteFile(path, []byte(raw), 0o600))

	folders := ReadFolders(path)

	require.Len(t, folders, 1)
	require.Equal(t, "Дейли", folders[0].Name)
	require.Equal(t, 2, folders[0].Color)
	require.Equal(t, []domain.FolderRule{{URL: "meet.google.com/abc-defg-hij"}}, folders[0].Rules)
}

func TestFolderColorsCycle(t *testing.T) {
	st, err := New(t.TempDir())
	require.NoError(t, err)
	for i := 0; i < 7; i++ {
		f, err := st.CreateFolder("folder")
		require.NoError(t, err)
		require.Equal(t, i%5, f.Color)
	}
}
