package store

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"rechiv/desktop/internal/domain"
)

func TestReadFolderSettings(t *testing.T) {
	path := filepath.Join(t.TempDir(), "folders.json")
	require.NoError(t, os.WriteFile(path, []byte(`{"folders":[
 {"id":"old","name":"Old"},
 {"id":"bad","name":"Bad","settings":{"titleTemplate":"{unknown}","retentionDays":-1}},
 {"id":"typed","name":"Typed","settings":{"retentionDays":"oops"}},
 {"id":"good","name":"Good","settings":{"titleTemplate":"  {date}  ","retentionDays":30,"autoSummary":true}},
 {"id":"stage1","name":"Stage 1","settings":{"titleTemplate":"{date}","retentionDays":14}}
 ]}`), 0600))
	folders, broken := readFolders(path)
	require.False(t, broken)
	require.Len(t, folders, 5)
	for _, f := range folders[:3] {
		require.Equal(t, domain.FolderSettings{}, f.Settings)
	}
	require.Equal(t, domain.FolderSettings{TitleTemplate: "{date}", RetentionDays: 30, AutoSummary: true}, folders[3].Settings)
	require.Equal(t, domain.FolderSettings{TitleTemplate: "{date}", RetentionDays: 14}, folders[4].Settings)
}

func TestFolderTemplateLifecycle(t *testing.T) {
	dir := t.TempDir()
	st, err := New(dir)
	require.NoError(t, err)
	f, err := st.CreateFolder("Daily")
	require.NoError(t, err)
	_, err = st.SetFolderSettings(f.ID, domain.FolderSettings{TitleTemplate: "  Дейли {date} "})
	require.NoError(t, err)
	for _, settings := range []domain.FolderSettings{{TitleTemplate: "{bad}"}, {TitleTemplate: "{date}{date}"}, {RetentionDays: -1}} {
		_, err = st.SetFolderSettings(f.ID, settings)
		require.ErrorIs(t, err, ErrInvalid)
	}
	_, err = st.SetFolderSettings("missing", domain.FolderSettings{})
	require.ErrorIs(t, err, ErrNotFound)
	_, _, err = st.AddFolderRule(f.ID, "meet.google.com/daily")
	require.NoError(t, err)
	automatic, err := st.Create("meet.google.com/daily")
	require.NoError(t, err)
	automatic, err = st.ApplyFolderRule(automatic.SessionID)
	require.NoError(t, err)
	require.True(t, automatic.TitleAuto)
	require.Equal(t, domain.RenderTitleTemplate("Дейли {date}", automatic.CreatedAt, ""), automatic.Title)
	require.Equal(t, f.ID, automatic.FolderID)
	restored, err := New(dir)
	require.NoError(t, err)
	saved, err := restored.Get(automatic.SessionID)
	require.NoError(t, err)
	require.Equal(t, automatic, saved)
	require.Equal(t, "Дейли {date}", restored.Folders()[0].Settings.TitleTemplate)

	manual, err := st.Create("")
	require.NoError(t, err)
	_, err = st.SetTitle(manual.SessionID, "Релиз")
	require.NoError(t, err)
	blank, err := st.Create("")
	require.NoError(t, err)
	require.NoError(t, st.MoveSessions([]string{manual.SessionID, blank.SessionID}, f.ID, true))
	saved, err = st.Get(blank.SessionID)
	require.NoError(t, err)
	require.Empty(t, saved.Title)
	require.False(t, saved.TitleAuto)
	preview, err := st.PreviewFolderTitles(f.ID)
	require.NoError(t, err)
	require.Equal(t, []string{blank.SessionID}, preview.Renamed)
	require.Equal(t, []string{manual.SessionID}, preview.Manual)
	count, err := st.ApplyFolderTitles(f.ID)
	require.NoError(t, err)
	require.Equal(t, 1, count)
	saved, _ = st.Get(blank.SessionID)
	require.True(t, saved.TitleAuto)
	saved, _ = st.Get(manual.SessionID)
	require.Equal(t, "Релиз", saved.Title)
	_, err = st.SetFolderSettings(f.ID, domain.FolderSettings{TitleTemplate: "Ретро {time}"})
	require.NoError(t, err)
	preview, err = st.PreviewFolderTitles(f.ID)
	require.NoError(t, err)
	require.ElementsMatch(t, []string{automatic.SessionID, blank.SessionID}, preview.Renamed)
	count, err = st.ApplyFolderTitles(f.ID)
	require.NoError(t, err)
	require.Equal(t, 2, count)
	saved, _ = st.Get(automatic.SessionID)
	require.Equal(t, domain.RenderTitleTemplate("Ретро {time}", saved.CreatedAt, ""), saved.Title)
	_, err = st.SetTitle(automatic.SessionID, "Вручную")
	require.NoError(t, err)
	saved, _ = st.Get(automatic.SessionID)
	require.False(t, saved.TitleAuto)
	saved, err = st.ApplyFolderRule(automatic.SessionID)
	require.NoError(t, err)
	require.Equal(t, "Вручную", saved.Title)
	require.False(t, saved.TitleAuto)
	require.NoError(t, st.MoveSessions([]string{blank.SessionID}, "", false))
	saved, _ = st.Get(blank.SessionID)
	require.True(t, saved.TitleAuto)
	require.NotEmpty(t, saved.Title)
	_, err = st.SetFolderSettings(f.ID, domain.FolderSettings{})
	require.NoError(t, err)
	require.NoError(t, st.MoveSessions([]string{blank.SessionID}, f.ID, false))
	count, err = st.ApplyFolderTitles(f.ID)
	require.NoError(t, err)
	require.Zero(t, count)
}

func TestFolderRetentionPreview(t *testing.T) {
	st, err := New(t.TempDir())
	require.NoError(t, err)
	f, err := st.CreateFolder("Daily")
	require.NoError(t, err)
	now := time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)
	want := []string{}
	for _, tt := range []struct {
		status  domain.SessionStatus
		age     time.Duration
		folder  bool
		expired bool
	}{
		{domain.StatusCompleted, 31 * 24 * time.Hour, true, true},
		{domain.StatusError, 31 * 24 * time.Hour, true, true},
		{domain.SessionStatus("suspended"), 31 * 24 * time.Hour, true, true},
		{domain.StatusRecording, 31 * 24 * time.Hour, true, false},
		{domain.StatusProcessing, 31 * 24 * time.Hour, true, false},
		{domain.StatusCompleted, 29 * 24 * time.Hour, true, false},
		{domain.StatusCompleted, 30 * 24 * time.Hour, true, false},
		{domain.StatusCompleted, 31 * 24 * time.Hour, false, false},
	} {
		session, err := st.Create("")
		require.NoError(t, err)
		if tt.folder {
			require.NoError(t, st.MoveSessions([]string{session.SessionID}, f.ID, false))
		}
		st.sessions[session.SessionID].CreatedAt = now.Add(-tt.age)
		st.sessions[session.SessionID].Status = tt.status
		if tt.expired {
			want = append(want, session.SessionID)
		}
	}
	got, err := st.PreviewFolderRetention(f.ID, 30, now)
	require.NoError(t, err)
	require.ElementsMatch(t, want, got)
	got, err = st.PreviewFolderRetention(f.ID, 0, now)
	require.NoError(t, err)
	require.Empty(t, got)
	_, err = st.PreviewFolderRetention(f.ID, -1, now)
	require.ErrorIs(t, err, ErrInvalid)
	_, err = st.PreviewFolderRetention("missing", 1, now)
	require.ErrorIs(t, err, ErrNotFound)
}

func TestApplyTitlesUsesSavedTopic(t *testing.T) {
	dir := t.TempDir()
	st, err := New(dir)
	require.NoError(t, err)
	f, err := st.CreateFolder("Daily")
	require.NoError(t, err)
	_, err = st.SetFolderSettings(f.ID, domain.FolderSettings{TitleTemplate: "Дейли — {topic}", AutoSummary: true})
	require.NoError(t, err)
	for _, topic := range []string{"План релиза", ""} {
		session, err := st.Create("")
		require.NoError(t, err)
		require.NoError(t, st.MoveSessions([]string{session.SessionID}, f.ID, false))
		_, err = st.SetTopic(session.SessionID, topic)
		require.NoError(t, err)
	}
	st, err = New(dir)
	require.NoError(t, err)
	require.True(t, st.Folders()[0].Settings.AutoSummary)
	count, err := st.ApplyFolderTitles(f.ID)
	require.NoError(t, err)
	require.Equal(t, 2, count)
	for _, session := range st.sessions {
		want := "Дейли"
		if session.Topic != "" {
			want += " — " + session.Topic
		}
		require.Equal(t, want, session.Title)
	}
}
