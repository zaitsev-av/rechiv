package controller

import (
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"rechiv/desktop/internal/domain"
	"rechiv/desktop/internal/store"
)

func TestRetentionOnStartAndSettings(t *testing.T) {
	c, st := newTestController(t)
	t.Cleanup(func() { require.NoError(t, c.Close()) })
	f, err := st.CreateFolder("Daily")
	require.NoError(t, err)
	other, err := st.CreateFolder("Other")
	require.NoError(t, err)
	create := func(folder string, status domain.SessionStatus) string {
		session, err := st.Create("")
		require.NoError(t, err)
		require.NoError(t, st.MoveSessions([]string{session.SessionID}, folder, false))
		require.NoError(t, st.SetStatus(session.SessionID, status, ""))
		_, err = c.loadJobs(session.SessionID)
		require.NoError(t, err)
		return session.SessionID
	}
	expired := create(f.ID, domain.StatusCompleted)
	recording := create(f.ID, domain.StatusRecording)
	processing := create(f.ID, domain.StatusProcessing)
	otherID := create(other.ID, domain.StatusCompleted)
	now := time.Now().Add(31 * 24 * time.Hour)
	c.now = func() time.Time { return now }
	_, err = st.SetFolderSettings(f.ID, domain.FolderSettings{RetentionDays: 30})
	require.NoError(t, err)
	preview, err := c.PreviewFolderRetention(f.ID, 30)
	require.NoError(t, err)
	require.Equal(t, []string{expired}, preview)
	require.NoError(t, c.Start())
	_, err = st.Get(expired)
	require.ErrorIs(t, err, store.ErrNotFound)
	c.jobsMu.Lock()
	_, cached := c.jobsCache[expired]
	c.jobsMu.Unlock()
	require.False(t, cached)
	_, err = st.Get(recording)
	require.NoError(t, err)
	// Восстановление processing может завершить пустую сессию после стартового прохода.
	_, err = st.Get(processing)
	require.NoError(t, err)
	_, err = st.Get(otherID)
	require.NoError(t, err)
	_, err = c.SetFolderSettings(other.ID, domain.FolderSettings{RetentionDays: 30})
	require.NoError(t, err)
	_, err = st.Get(otherID)
	require.ErrorIs(t, err, store.ErrNotFound)
}

func TestRetentionTicksAndStops(t *testing.T) {
	c, st := newTestController(t)
	f, err := st.CreateFolder("Daily")
	require.NoError(t, err)
	session, err := st.Create("")
	require.NoError(t, err)
	require.NoError(t, st.MoveSessions([]string{session.SessionID}, f.ID, false))
	require.NoError(t, st.SetStatus(session.SessionID, domain.StatusCompleted, ""))
	_, err = st.SetFolderSettings(f.ID, domain.FolderSettings{RetentionDays: 1})
	require.NoError(t, err)
	var now atomic.Int64
	now.Store(session.CreatedAt.UnixNano())
	c.now = func() time.Time { return time.Unix(0, now.Load()) }
	c.RunRetention("")
	_, err = st.Get(session.SessionID)
	require.NoError(t, err)
	ticks := make(chan time.Time)
	c.wg.Go(func() { c.retentionLoop(ticks) })
	now.Store(session.CreatedAt.Add(25 * time.Hour).UnixNano())
	ticks <- c.now()
	require.Eventually(t, func() bool { _, err := st.Get(session.SessionID); return err == store.ErrNotFound }, time.Second, time.Millisecond)
	closed := make(chan struct{})
	go func() { _ = c.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("retention loop did not stop")
	}
}

func TestCreateSessionAppliesTitleTemplate(t *testing.T) {
	c, st := newTestController(t)
	t.Cleanup(func() { require.NoError(t, c.Close()) })
	f, err := st.CreateFolder("Daily")
	require.NoError(t, err)
	_, err = st.SetFolderSettings(f.ID, domain.FolderSettings{TitleTemplate: "Дейли {date} {time}"})
	require.NoError(t, err)
	_, _, err = st.AddFolderRule(f.ID, "meet.google.com/daily")
	require.NoError(t, err)
	session, err := c.CreateSession("https://meet.google.com/daily?x=1")
	require.NoError(t, err)
	require.Equal(t, f.ID, session.FolderID)
	require.True(t, session.TitleAuto)
	require.Equal(t, domain.RenderTitleTemplate("Дейли {date} {time}", session.CreatedAt, ""), session.Title)
	unmatched, err := c.CreateSession("https://meet.google.com/other")
	require.NoError(t, err)
	require.Empty(t, unmatched.Title)
	require.NoError(t, st.MoveSessions([]string{unmatched.SessionID}, f.ID, false))
	unmatched, err = st.Get(unmatched.SessionID)
	require.NoError(t, err)
	require.Empty(t, unmatched.Title)
}
