package calls

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestHub() (*Hub, *time.Time) {
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	hub := NewHub()
	hub.now = func() time.Time { return now }
	return hub, &now
}

func TestHubCallExpires(t *testing.T) {
	hub, now := newTestHub()
	assert.Nil(t, hub.Current())

	hub.Report(&Call{Platform: "Телемост", URL: "https://telemost.yandex.ru/j/1"})
	require.NotNil(t, hub.Current())
	assert.Equal(t, "Телемост", hub.Current().Platform)

	*now = now.Add(callTTL + time.Second)
	assert.Nil(t, hub.Current())
	assert.False(t, hub.Send(CommandStart), "команда без живого созвона не принимается")
}

func TestHubReportNilForgetsCallAndCommand(t *testing.T) {
	hub, _ := newTestHub()
	hub.Report(&Call{Platform: "Телемост"})
	require.True(t, hub.Send(CommandStart))
	hub.Report(nil)

	assert.Nil(t, hub.Current())
	assert.Equal(t, Command(""), hub.Wait(context.Background(), time.Millisecond))
}

func TestHubWaitReturnsQueuedCommand(t *testing.T) {
	hub, _ := newTestHub()
	hub.Report(&Call{Platform: "Телемост"})
	require.True(t, hub.Send(CommandStart))
	require.True(t, hub.Send(CommandStop))

	assert.Equal(t, CommandStop, hub.Wait(context.Background(), time.Second), "новая команда заменяет недоставленную")
	assert.Equal(t, Command(""), hub.Wait(context.Background(), time.Millisecond), "команда доставляется один раз")
}

func TestHubWaitWakesOnSend(t *testing.T) {
	hub := NewHub()
	hub.Report(&Call{Platform: "Телемост"})
	got := make(chan Command, 1)
	go func() { got <- hub.Wait(context.Background(), 5*time.Second) }()

	time.Sleep(20 * time.Millisecond)
	require.True(t, hub.Send(CommandStart))
	select {
	case command := <-got:
		assert.Equal(t, CommandStart, command)
	case <-time.After(time.Second):
		t.Fatal("Wait не проснулся после Send")
	}
}

func TestHubDropsStaleCommand(t *testing.T) {
	hub, now := newTestHub()
	hub.Report(&Call{Platform: "Телемост"})
	require.True(t, hub.Send(CommandStart))

	*now = now.Add(commandTTL + time.Second)
	assert.Equal(t, Command(""), hub.Wait(context.Background(), time.Millisecond))
}

func TestHubCloseReleasesWaiters(t *testing.T) {
	hub := NewHub()
	done := make(chan struct{})
	go func() {
		hub.Wait(context.Background(), 5*time.Second)
		close(done)
	}()

	time.Sleep(20 * time.Millisecond)
	hub.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Close не отпустил ожидание")
	}
}

func TestHubClaimAutoStartOncePerCall(t *testing.T) {
	hub, now := newTestHub()
	url := "https://telemost.yandex.ru/j/1"
	hub.Report(&Call{URL: url})
	require.True(t, hub.ClaimAutoStart(url))
	hub.Report(&Call{URL: url})
	assert.False(t, hub.ClaimAutoStart(url), "после ручной остановки автозапись не повторяется")

	hub.Report(nil)
	hub.Report(&Call{URL: url})
	assert.True(t, hub.ClaimAutoStart(url), "закрытая вкладка — новый созвон")

	*now = now.Add(callTTL + time.Second)
	hub.Report(&Call{URL: url})
	assert.True(t, hub.ClaimAutoStart(url), "о закрытии не узнали, но созвон давно пропал")
	assert.False(t, hub.ClaimAutoStart(""))
}

func TestHubStopping(t *testing.T) {
	hub, now := newTestHub()
	start := *now
	hub.Report(&Call{URL: "u", Recording: true})
	assert.False(t, hub.Current().Stopping)

	require.True(t, hub.Send(CommandStop))
	*now = now.Add(5 * time.Second)
	hub.Report(&Call{URL: "u", Recording: true})
	current := hub.Current()
	assert.True(t, current.Stopping, "клик в трее виден сразу, до ответа вкладки")
	assert.Equal(t, start, current.StoppingSince)

	hub.Report(&Call{URL: "u", Stopping: true})
	assert.Equal(t, start, hub.Current().StoppingSince, "время остановки не сдвигается")

	hub.Report(&Call{URL: "u"})
	assert.False(t, hub.Current().Stopping)
	assert.True(t, hub.Current().StoppingSince.IsZero())

	*now = now.Add(time.Second)
	hub.Report(&Call{URL: "u", Stopping: true})
	assert.Equal(t, *now, hub.Current().StoppingSince, "остановка из попапа отмечается по отчёту вкладки")
}

func TestHubStopSurvivesClosedTab(t *testing.T) {
	hub, now := newTestHub()
	start := *now
	hub.Report(&Call{URL: "u", Recording: true, SessionID: "s1"})
	require.True(t, hub.Send(CommandStop))

	*now = now.Add(3 * time.Second)
	hub.Report(nil)
	assert.Nil(t, hub.Current())
	assert.Equal(t, Stop{SessionID: "s1", Since: start}, hub.Stopping(), "хвост дописывается и без вкладки")

	hub.Report(&Call{URL: "u", Recording: true, SessionID: "s2"})
	assert.Equal(t, Stop{}, hub.Stopping(), "новая запись — новая сессия")

	*now = now.Add(time.Second)
	hub.Report(nil)
	assert.Equal(t, Stop{SessionID: "s2", Since: *now}, hub.Stopping(), "закрытая вкладка останавливает запись")
}
