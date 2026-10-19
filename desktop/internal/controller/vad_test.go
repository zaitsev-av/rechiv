package controller

import (
	"os"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSaveVADTimelineKeepsFullSnapshot(t *testing.T) {
	full := VADTimeline{
		LocalParticipantID: "local",
		Participants:       []VADParticipant{{ParticipantID: "guest", Name: "Гость"}},
		Events:             []VADEvent{{At: 0, Active: []string{"guest"}}, {At: 20, Active: []string{}}},
		MicEvents:          []VADMicEvent{{At: 0, Unmuted: []string{"guest"}}, {At: 30, Unmuted: []string{}}},
	}
	for _, tc := range []struct {
		name   string
		change func(*VADTimeline)
	}{
		{"меньше VAD-событий с тем же концом", func(v *VADTimeline) { v.Events = v.Events[1:] }},
		{"меньше состояний микрофонов с тем же концом", func(v *VADTimeline) { v.MicEvents = v.MicEvents[1:] }},
		{"старее VAD при том же числе", func(v *VADTimeline) { v.Events = []VADEvent{{At: 0}, {At: 10}} }},
		{"старее микрофоны при том же числе", func(v *VADTimeline) { v.MicEvents = []VADMicEvent{{At: 0}, {At: 10}} }},
		{"пустой снимок", func(v *VADTimeline) { *v = VADTimeline{} }},
		{"меньше участников", func(v *VADTimeline) { v.Participants = nil }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			control, sessionStore := newTestController(t)
			session, err := sessionStore.Create("https://telemost.yandex.ru/j/1")
			require.NoError(t, err)
			require.NoError(t, control.SaveVADTimeline(session.SessionID, full))
			stale := full
			tc.change(&stale)
			require.NoError(t, control.SaveVADTimeline(session.SessionID, stale))
			stored, err := control.readVADTimeline(session.SessionID)
			require.NoError(t, err)
			require.Equal(t, &full, stored)
		})
	}
}

func TestSaveVADTimelineAcceptsGrowingAndEqualSnapshots(t *testing.T) {
	control, sessionStore := newTestController(t)
	session, err := sessionStore.Create("https://telemost.yandex.ru/j/1")
	require.NoError(t, err)
	timeline := VADTimeline{Events: []VADEvent{{At: 0}}}
	require.NoError(t, control.SaveVADTimeline(session.SessionID, timeline))
	timeline.Events = append(timeline.Events, VADEvent{At: 20})
	timeline.MicEvents = []VADMicEvent{{At: 0}, {At: 30}}
	timeline.Participants = []VADParticipant{{ParticipantID: "guest", Name: "Гость"}}
	require.NoError(t, control.SaveVADTimeline(session.SessionID, timeline))
	timeline.Participants[0].Name = "Новое имя"
	require.NoError(t, control.SaveVADTimeline(session.SessionID, timeline))
	require.NoError(t, control.SaveVADTimeline(session.SessionID, timeline))
	stored, err := control.readVADTimeline(session.SessionID)
	require.NoError(t, err)
	require.Equal(t, &timeline, stored)
}

func TestSaveVADTimelineConcurrentSnapshots(t *testing.T) {
	control, sessionStore := newTestController(t)
	session, err := sessionStore.Create("https://telemost.yandex.ru/j/1")
	require.NoError(t, err)
	var wg sync.WaitGroup
	errors := make(chan error, 20)
	for i := range 20 {
		wg.Go(func() {
			errors <- control.SaveVADTimeline(session.SessionID, VADTimeline{
				Events:    []VADEvent{{At: float64(i)}},
				MicEvents: []VADMicEvent{{At: float64(i)}},
			})
		})
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		require.NoError(t, err)
	}
	stored, err := control.readVADTimeline(session.SessionID)
	require.NoError(t, err)
	require.Equal(t, float64(19), stored.Events[0].At)
	require.Equal(t, float64(19), stored.MicEvents[0].At)
}

func TestSaveVADTimelineAfterFinalization(t *testing.T) {
	control, sessionStore := newTestController(t)
	session, err := sessionStore.Create("https://telemost.yandex.ru/j/1")
	require.NoError(t, err)
	require.NoError(t, control.finalize(session.SessionID))
	before, err := os.ReadFile(control.TranscriptPath(session.SessionID))
	require.NoError(t, err)
	require.NoError(t, control.SaveVADTimeline(session.SessionID, VADTimeline{
		Events: []VADEvent{{At: 20}},
	}))
	after, err := os.ReadFile(control.TranscriptPath(session.SessionID))
	require.NoError(t, err)
	require.Equal(t, before, after)
	_, err = control.Transcript(session.SessionID)
	require.NoError(t, err)
}
