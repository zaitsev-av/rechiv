package store

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"rechiv/desktop/internal/domain"
)

func TestFoldersLifecycle(t *testing.T) {
	dir := t.TempDir()
	st, err := New(dir)
	require.NoError(t, err)
	require.Empty(t, st.Folders())
	_, err = st.CreateFolder(" \n", "")
	require.ErrorIs(t, err, ErrInvalid)
	a, err := st.CreateFolder(" Дейли ", "")
	require.NoError(t, err)
	require.Equal(t, "Дейли", a.Name)
	b, err := st.CreateFolder("Ретро", "")
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
	folder, err := st.CreateFolder("One", "")
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

	_, err = st.CreateFolder("Two", "")
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
		f, err := st.CreateFolder("folder", "")
		require.NoError(t, err)
		require.Equal(t, i%5, f.Color)
	}
}

func TestStoreChangesAndFolderForCallURL(t *testing.T) {
	s, err := New(t.TempDir())
	require.NoError(t, err)
	changes := s.Changes()
	folder, err := s.CreateFolder("Дейли", "")
	require.NoError(t, err)
	select {
	case <-changes:
	default:
		t.Fatal("изменение папок не оповестило подписчиков")
	}

	changes = s.Changes()
	_, err = s.Create("https://telemost.yandex.ru/j/1")
	require.NoError(t, err)
	select {
	case <-changes:
	default:
		t.Fatal("новый созвон не оповестил подписчиков")
	}

	_, ok := s.FolderForCallURL("https://telemost.yandex.ru/j/1")
	require.False(t, ok)
	_, _, err = s.AddFolderRule(folder.ID, "https://telemost.yandex.ru/j/1")
	require.NoError(t, err)
	found, ok := s.FolderForCallURL("telemost.yandex.ru/j/1/")
	require.True(t, ok)
	require.Equal(t, folder.ID, found.ID)
	_, ok = s.FolderForCallURL("")
	require.False(t, ok)
}

func TestReadNestedFolders(t *testing.T) {
	for _, tt := range []struct {
		name, raw string
		parents   []string
	}{
		{"legacy", `[{"id":"a","name":"A"},{"id":"b","name":"B"}]`, []string{"", ""}},
		{"missing", `[{"id":"a","name":"A","parentId":"missing"},{"id":"b","name":"B","parentId":"a"}]`, []string{"", "a"}},
		{"cycle", `[{"id":"a","name":"A","parentId":"b"},{"id":"b","name":"B","parentId":"a"},{"id":"c","name":"C","parentId":"b"},{"id":"d","name":"D","parentId":"d"}]`, []string{"", "", "b", ""}},
		{"depth", `[{"id":"d","name":"D","parentId":"c"},{"id":"c","name":"C","parentId":"b"},{"id":"b","name":"B","parentId":"a"},{"id":"a","name":"A"},{"id":"e","name":"E","parentId":"d"}]`, []string{"", "b", "a", "", ""}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "folders.json")
			raw := []byte(`{"folders":` + tt.raw + `}`)
			require.NoError(t, os.WriteFile(path, raw, 0o600))
			var warning bytes.Buffer
			previous := log.Writer()
			log.SetOutput(&warning)
			t.Cleanup(func() { log.SetOutput(previous) })
			folders, broken := readFolders(path)
			require.False(t, broken)
			require.Len(t, folders, len(tt.parents))
			var original []domain.Folder
			require.NoError(t, json.Unmarshal([]byte(tt.raw), &original))
			for i, f := range folders {
				require.Equal(t, original[i].ID, f.ID)
				require.Equal(t, tt.parents[i], f.ParentID, f.ID)
			}
			if tt.name != "legacy" {
				require.Contains(t, warning.String(), "warning:")
			}
			after, err := os.ReadFile(path)
			require.NoError(t, err)
			require.Equal(t, raw, after)
		})
	}
}

func TestNestedFolderMoves(t *testing.T) {
	dir := t.TempDir()
	st, err := New(dir)
	require.NoError(t, err)
	a, err := st.CreateFolder("A", "")
	require.NoError(t, err)
	b, err := st.CreateFolder("B", a.ID)
	require.NoError(t, err)
	c, err := st.CreateFolder("C", b.ID)
	require.NoError(t, err)
	require.Equal(t, b.ID, c.ParentID)
	require.Equal(t, []domain.Folder{a, b, c}, domain.FolderPath(st.Folders(), c.ID))
	_, err = st.CreateFolder("D", c.ID)
	require.ErrorIs(t, err, ErrInvalid)
	_, err = st.CreateFolder("D", "missing")
	require.ErrorIs(t, err, ErrInvalid)
	other, err := st.CreateFolder("Other", "")
	require.NoError(t, err)
	before := st.Folders()
	for _, tt := range []struct {
		id, parent string
		want       error
	}{
		{"missing", "", ErrNotFound}, {a.ID, "missing", ErrInvalid},
		{a.ID, a.ID, ErrInvalid}, {a.ID, c.ID, ErrInvalid},
		{a.ID, other.ID, ErrInvalid}, {other.ID, c.ID, ErrInvalid},
	} {
		_, err := st.MoveFolder(tt.id, tt.parent)
		require.ErrorIs(t, err, tt.want)
		require.Equal(t, before, st.Folders())
	}
	changes := st.Changes()
	moved, err := st.MoveFolder(b.ID, other.ID)
	require.NoError(t, err)
	require.Equal(t, other.ID, moved.ParentID)
	select {
	case <-changes:
	default:
		t.Fatal("перенос не оповестил подписчиков")
	}
	moved, err = st.MoveFolder(b.ID, "")
	require.NoError(t, err)
	require.Empty(t, moved.ParentID)
	moved, err = st.MoveFolder(b.ID, "")
	require.NoError(t, err)
	require.Empty(t, moved.ParentID)
	restored, err := New(dir)
	require.NoError(t, err)
	require.Equal(t, st.Folders(), restored.Folders())
	require.Equal(t, b.ID, restored.Folders()[2].ParentID)
}

func TestDeleteNestedFolder(t *testing.T) {
	for _, nested := range []bool{false, true} {
		t.Run(fmt.Sprint(nested), func(t *testing.T) {
			dir := t.TempDir()
			st, err := New(dir)
			require.NoError(t, err)
			parent := ""
			if nested {
				f, err := st.CreateFolder("Parent", "")
				require.NoError(t, err)
				parent = f.ID
			}
			folder, err := st.CreateFolder("Folder", parent)
			require.NoError(t, err)
			child, err := st.CreateFolder("Child", folder.ID)
			require.NoError(t, err)
			own, err := st.Create("meet.google.com/own")
			require.NoError(t, err)
			descendant, err := st.Create("meet.google.com/child")
			require.NoError(t, err)
			require.NoError(t, st.MoveSessions([]string{own.SessionID}, folder.ID, true))
			require.NoError(t, st.MoveSessions([]string{descendant.SessionID}, child.ID, true))
			_, _, err = st.AddFolderRule(folder.ID, own.CallURL)
			require.NoError(t, err)
			_, _, err = st.AddFolderRule(child.ID, descendant.CallURL)
			require.NoError(t, err)
			require.NoError(t, st.DeleteFolder(folder.ID))
			st, err = New(dir)
			require.NoError(t, err)
			saved, err := st.Get(own.SessionID)
			require.NoError(t, err)
			require.Equal(t, parent, saved.FolderID)
			require.False(t, saved.FolderByRule)
			saved, err = st.Get(descendant.SessionID)
			require.NoError(t, err)
			require.Equal(t, child.ID, saved.FolderID)
			require.True(t, saved.FolderByRule)
			require.Equal(t, parent, st.Folders()[folderIndex(st.Folders(), child.ID)].ParentID)
			_, ok := st.FolderForCallURL(own.CallURL)
			require.False(t, ok)
			f, ok := st.FolderForCallURL(descendant.CallURL)
			require.True(t, ok)
			require.Equal(t, child.ID, f.ID)
		})
	}
}

func TestNestedFolderRuleAndSettings(t *testing.T) {
	st, err := New(t.TempDir())
	require.NoError(t, err)
	parent, err := st.CreateFolder("Parent", "")
	require.NoError(t, err)
	child, err := st.CreateFolder("Child", parent.ID)
	require.NoError(t, err)
	_, err = st.SetFolderSettings(parent.ID, domain.FolderSettings{TitleTemplate: "Parent", RetentionDays: 1})
	require.NoError(t, err)
	_, _, err = st.AddFolderRule(child.ID, "meet.google.com/child")
	require.NoError(t, err)
	session, err := st.Create("https://meet.google.com/child?x=1")
	require.NoError(t, err)
	saved, err := st.ApplyFolderRule(session.SessionID)
	require.NoError(t, err)
	require.Equal(t, child.ID, saved.FolderID)
	require.True(t, saved.FolderByRule)
	require.Empty(t, saved.Title)
	settings := domain.FolderSettings{TitleTemplate: "Child {date}", RetentionDays: 2, AutoRecord: true, AutoSummary: true, LivePanel: true}
	_, err = st.SetFolderSettings(child.ID, settings)
	require.NoError(t, err)
	saved, err = st.ApplyFolderRule(session.SessionID)
	require.NoError(t, err)
	require.Equal(t, domain.RenderTitleTemplate(settings.TitleTemplate, session.CreatedAt, ""), saved.Title)
	require.True(t, saved.TitleAuto)
	found, ok := st.FolderForCallURL(session.CallURL)
	require.True(t, ok)
	require.Equal(t, parent.ID, found.ParentID)
	require.Equal(t, settings, found.Settings)
	require.NoError(t, st.SetStatus(saved.SessionID, domain.StatusCompleted, ""))
	now := session.CreatedAt.Add(72 * time.Hour)
	ids, err := st.PreviewFolderRetention(parent.ID, 1, now)
	require.NoError(t, err)
	require.Empty(t, ids)
	ids, err = st.PreviewFolderRetention(child.ID, 2, now)
	require.NoError(t, err)
	require.Equal(t, []string{session.SessionID}, ids)
}
