package controller

import (
	"context"
	"errors"
	"io"
	"log"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"rechiv/desktop/internal/domain"
	"rechiv/desktop/internal/engine"
	"rechiv/desktop/internal/store"
)

type stubEngine struct{}

func (stubEngine) Transcribe(context.Context, string) ([]engine.Segment, error) { return nil, nil }
func (stubEngine) Ping(context.Context) error                                   { return nil }
func (stubEngine) Warmup(context.Context) error                                 { return nil }
func (stubEngine) Close() error                                                 { return nil }

type stubConverter struct{}

func (stubConverter) Convert(_ context.Context, _, outputPath string) (float64, error) {
	return 1, os.WriteFile(outputPath, []byte("wav"), 0o600)
}

func newTestController(t *testing.T) (*Controller, *store.Store) {
	t.Helper()
	sessionStore, err := store.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return New(sessionStore, stubEngine{}, stubConverter{}, log.New(io.Discard, "", 0)), sessionStore
}

func TestBuildTranscriptIncludesQueuedAudioInDuration(t *testing.T) {
	session := &domain.Session{
		SessionID:    "session-1",
		Status:       domain.StatusProcessing,
		CallURL:      "https://stream.wb.ru/room/1",
		CreatedAt:    time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC),
		Participants: map[string]*domain.Participant{},
	}
	jobs := []*Job{{
		SessionID:  session.SessionID,
		SpeakerID:  "local",
		ChunkIndex: 0,
		Offset:     5,
		Duration:   20,
		Status:     JobQueued,
	}}

	transcript, failed := buildTranscript(session, jobs, nil)

	if failed != 0 {
		t.Fatalf("failed chunks = %d", failed)
	}
	if transcript.Duration != "00:00:25" {
		t.Fatalf("duration = %q", transcript.Duration)
	}
	if len(transcript.Segments) != 0 {
		t.Fatalf("segments = %#v", transcript.Segments)
	}
}

// Имена в result.json — снимок на момент финализации. Переименование правит
// только метаданные сессии, поэтому чтение обязано подставлять имя заново:
// иначе правка отображается до перезагрузки страницы и пропадает после неё.
func TestTranscriptUsesCurrentSpeakerNames(t *testing.T) {
	controller, sessionStore := newTestController(t)

	session, err := sessionStore.Create("https://telemost.yandex.ru/j/1")
	require.NoError(t, err)
	_, err = sessionStore.UpdateSpeaker(session.SessionID, "local", "Старое имя")
	require.NoError(t, err)

	// Транскрипт на диске — с именем, каким оно было при финализации.
	stale := domain.Transcript{
		SessionID:    session.SessionID,
		Participants: []*domain.Participant{{SpeakerID: "local", Name: "Старое имя"}},
		Segments: []domain.Segment{
			{Speaker: "Старое имя", SpeakerID: "local", Text: "Раз"},
			{Speaker: "Старое имя", SpeakerID: "local", Text: "Два"},
		},
	}
	require.NoError(t, writeJSONAtomic(controller.TranscriptPath(session.SessionID), stale))
	require.NoError(t, sessionStore.SetStatus(session.SessionID, domain.StatusCompleted, ""))

	_, err = sessionStore.UpdateSpeaker(session.SessionID, "local", "Новое имя")
	require.NoError(t, err)

	transcript, err := controller.Transcript(session.SessionID)
	require.NoError(t, err)
	require.Equal(t, []string{"Новое имя"}, participantNames(transcript))
	for _, segment := range transcript.Segments {
		require.Equal(t, "Новое имя", segment.Speaker)
	}

	live, err := controller.LiveTranscript(session.SessionID)
	require.NoError(t, err)
	require.True(t, live.IsFinal)
	require.Equal(t, []string{"Новое имя"}, participantNames(live.Transcript))

	// Файл переписывать не должны: имя живёт в метаданных сессии, а в
	// транскрипте остаётся speakerID.
	var onDisk domain.Transcript
	require.NoError(t, ReadJSON(controller.TranscriptPath(session.SessionID), &onDisk))
	require.Equal(t, "Старое имя", onDisk.Segments[0].Speaker)
}

// Безымянные участники нумеруются одинаково при записи и при чтении: иначе
// «Спикер 1» в готовом транскрипте и в списке участников — разные люди.
func TestTranscriptSpeakerNumberingIsStable(t *testing.T) {
	controller, sessionStore := newTestController(t)

	session, err := sessionStore.Create("https://telemost.yandex.ru/j/2")
	require.NoError(t, err)
	for _, speakerID := range []string{"remote-b", "remote-a", "local"} {
		_, err = sessionStore.UpdateSpeaker(session.SessionID, speakerID, "")
		require.NoError(t, err)
	}

	fresh, _ := buildTranscript(mustGet(t, sessionStore, session.SessionID), nil, nil)
	require.NoError(t, writeJSONAtomic(controller.TranscriptPath(session.SessionID), fresh))
	require.NoError(t, sessionStore.SetStatus(session.SessionID, domain.StatusCompleted, ""))

	read, err := controller.Transcript(session.SessionID)
	require.NoError(t, err)
	require.Equal(t, participantNames(fresh), participantNames(read))
	require.Equal(t, []string{"Спикер 1", "Спикер 2", "Спикер 3"}, participantNames(read))
}

func mustGet(t *testing.T, sessionStore *store.Store, id string) *domain.Session {
	t.Helper()
	session, err := sessionStore.Get(id)
	require.NoError(t, err)
	return session
}

func participantNames(transcript domain.Transcript) []string {
	names := make([]string, 0, len(transcript.Participants))
	for _, participant := range transcript.Participants {
		names = append(names, participant.Name)
	}
	return names
}

func TestBuildTranscriptAttributesRemoteSegmentsByVAD(t *testing.T) {
	const (
		firstID  = "participant-a"
		secondID = "participant-b"
	)
	session := &domain.Session{
		SessionID: "session-vad",
		Status:    domain.StatusProcessing,
		CallURL:   "https://telemost.yandex.ru/j/1",
		CreatedAt: time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC),
		Participants: map[string]*domain.Participant{
			"local": {SpeakerID: "local", Name: "Александр"},
		},
	}
	timeline := func(events ...VADEvent) *VADTimeline {
		return &VADTimeline{
			LocalParticipantID: "participant-local",
			Participants: []VADParticipant{
				{ParticipantID: firstID, Name: "Анна"},
				{ParticipantID: secondID, Name: "Борис"},
			},
			Events: events,
		}
	}
	job := func(speakerID string, start, end float64) []*Job {
		return []*Job{{
			SessionID: session.SessionID,
			SpeakerID: speakerID,
			Duration:  end,
			Status:    JobCompleted,
			Segments:  []JobSegment{{Text: "Реплика", Start: start, End: end}},
		}}
	}

	tests := []struct {
		name     string
		jobs     []*Job
		timeline *VADTimeline
		wantID   string
		wantName string
	}{
		{
			name:     "один участник активен весь сегмент",
			jobs:     job("remote-room-mix", 10, 12),
			timeline: timeline(VADEvent{At: 0, Active: []string{firstID}}),
			wantID:   firstID,
			wantName: "Анна",
		},
		{
			name: "граница двух участников даёт примерно равное покрытие",
			jobs: job("remote-room-mix", 10, 12),
			timeline: timeline(
				VADEvent{At: 0, Active: []string{firstID}},
				VADEvent{At: 10.7, Active: []string{firstID, secondID}},
				VADEvent{At: 11.3, Active: []string{secondID}},
			),
			wantID:   UnknownSpeakerID,
			wantName: UnknownSpeakerName,
		},
		{
			// Порога по доле покрытия нет намеренно: серверный флаг смещён
			// относительно речи, и требовать от него накрыть реплику целиком
			// значит терять почти всё. Конкурента нет — выбирать не из чего.
			name: "частичное покрытие без конкурента",
			jobs: job("remote-room-mix", 0, 2),
			timeline: timeline(
				VADEvent{At: 1, Active: []string{firstID}},
				VADEvent{At: 2.1, Active: []string{}},
			),
			wantID:   firstID,
			wantName: "Анна",
		},
		{
			// Флаг не попал в реплику вовсе — его и ловит запасное окно.
			name: "активность рядом с репликой, но не внутри",
			jobs: job("remote-room-mix", 10, 12),
			timeline: timeline(
				VADEvent{At: 0, Active: []string{}},
				VADEvent{At: 12.4, Active: []string{secondID}},
				VADEvent{At: 13, Active: []string{}},
			),
			wantID:   secondID,
			wantName: "Борис",
		},
		{
			name:     "на сегменте никто не активен",
			jobs:     job("remote-room-mix", 0, 2),
			timeline: timeline(VADEvent{At: 0, Active: []string{}}),
			wantID:   UnknownSpeakerID,
			wantName: UnknownSpeakerName,
		},
		{
			name:     "локальная дорожка не переатрибутируется",
			jobs:     job("local", 0, 2),
			timeline: timeline(VADEvent{At: 0, Active: []string{firstID}}),
			wantID:   "local",
			wantName: "Александр",
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			transcript, failed := buildTranscript(session, testCase.jobs, testCase.timeline)

			require.Zero(t, failed)
			require.Len(t, transcript.Segments, 1)
			require.Equal(t, testCase.wantID, transcript.Segments[0].SpeakerID)
			require.Equal(t, testCase.wantName, transcript.Segments[0].Speaker)
		})
	}
}

// Состояние микрофонов площадка публикует отдельно от речевой активности, и
// сигнал этот сильнее: замьюченный участник звучать не может вовсе. Замерено
// 19 августа на созвоне тринадцати человек — микрофон был включён ровно у
// одного, и весь удалённый звук мог принадлежать только ему.
func TestBuildTranscriptUsesMicrophoneState(t *testing.T) {
	const (
		firstID  = "participant-a"
		secondID = "participant-b"
	)
	session := &domain.Session{
		SessionID: "session-mic",
		Status:    domain.StatusProcessing,
		CallURL:   "https://telemost.yandex.ru/j/1",
		CreatedAt: time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC),
		Participants: map[string]*domain.Participant{
			"local": {SpeakerID: "local", Name: "Александр"},
		},
	}
	timeline := func(events []VADEvent, mic []VADMicEvent) *VADTimeline {
		return &VADTimeline{
			LocalParticipantID: "participant-local",
			Participants: []VADParticipant{
				{ParticipantID: firstID, Name: "Анна"},
				{ParticipantID: secondID, Name: "Борис"},
			},
			Events:    events,
			MicEvents: mic,
		}
	}
	job := func(start, end float64) []*Job {
		return []*Job{{
			SessionID: session.SessionID,
			SpeakerID: "remote-room-mix",
			Duration:  end,
			Status:    JobCompleted,
			Segments:  []JobSegment{{Text: "Реплика", Start: start, End: end}},
		}}
	}

	tests := []struct {
		name     string
		jobs     []*Job
		timeline *VADTimeline
		wantID   string
		wantName string
	}{
		{
			// Ровно один включённый микрофон снимает вопрос без всякого vad:
			// серверный флаг запаздывает, а кнопка микрофона — нет.
			name: "единственный размьюченный назван без vad",
			jobs: job(10, 12),
			timeline: timeline(
				[]VADEvent{{At: 0, Active: []string{}}},
				[]VADMicEvent{{At: 0, Unmuted: []string{firstID}}},
			),
			wantID:   firstID,
			wantName: "Анна",
		},
		{
			// Такое расхождение и даёт ложные имена: флаг у замьюченного мог
			// остаться с прошлой реплики.
			name: "vad указывает на замьюченного, микрофон — на другого",
			jobs: job(10, 12),
			timeline: timeline(
				[]VADEvent{{At: 0, Active: []string{secondID}}},
				[]VADMicEvent{{At: 0, Unmuted: []string{firstID}}},
			),
			wantID:   firstID,
			wantName: "Анна",
		},
		{
			// Без микрофонов такое перекрытие честно уходило бы в неизвестные.
			name: "замьюченный не спорит за реплику в перекрытии",
			jobs: job(10, 12),
			timeline: timeline(
				[]VADEvent{{At: 10, Active: []string{firstID, secondID}}},
				[]VADMicEvent{
					{At: 0, Unmuted: []string{firstID, secondID}},
					{At: 9, Unmuted: []string{secondID}},
				},
			),
			wantID:   secondID,
			wantName: "Борис",
		},
		{
			// Созвон 29 сентября: sendAudio=false держался минутами, пока
			// человек говорил, а сервер зажигал его vad.
			name: "vad зажёгся при выключенном микрофоне — сервер его слышит",
			jobs: job(10, 12),
			timeline: timeline(
				[]VADEvent{{At: 0, Active: []string{}}, {At: 9.5, Active: []string{secondID}}},
				[]VADMicEvent{{At: 0, Unmuted: []string{firstID}}},
			),
			wantID:   secondID,
			wantName: "Борис",
		},
		{
			// Флаг зажёгся при включённом микрофоне и гаснет с запозданием.
			name: "хвост vad после выключения микрофона не в счёт",
			jobs: job(10, 12),
			timeline: timeline(
				[]VADEvent{{At: 0, Active: []string{}}, {At: 8, Active: []string{secondID}}},
				[]VADMicEvent{
					{At: 0, Unmuted: []string{firstID, secondID}},
					{At: 9, Unmuted: []string{firstID}},
				},
			),
			wantID:   firstID,
			wantName: "Анна",
		},
		{
			name: "двое размьючены и молчат — имени нет",
			jobs: job(10, 12),
			timeline: timeline(
				[]VADEvent{{At: 0, Active: []string{}}},
				[]VADMicEvent{{At: 0, Unmuted: []string{firstID, secondID}}},
			),
			wantID:   UnknownSpeakerID,
			wantName: UnknownSpeakerName,
		},
		{
			// Микрофон включают посреди разговора, и для реплики важно
			// состояние на её момент, а не на конец записи.
			name: "микрофон включили посреди записи",
			jobs: job(10, 12),
			timeline: timeline(
				[]VADEvent{{At: 0, Active: []string{}}},
				[]VADMicEvent{
					{At: 0, Unmuted: []string{firstID}},
					{At: 9.5, Unmuted: []string{secondID}},
				},
			),
			wantID:   secondID,
			wantName: "Борис",
		},
		{
			// Записи без микрофонного сигнала должны работать как раньше.
			name: "без состояний микрофонов решает только vad",
			jobs: job(10, 12),
			timeline: timeline(
				[]VADEvent{{At: 0, Active: []string{secondID}}},
				nil,
			),
			wantID:   secondID,
			wantName: "Борис",
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			transcript, failed := buildTranscript(session, testCase.jobs, testCase.timeline)

			require.Zero(t, failed)
			require.Len(t, transcript.Segments, 1)
			require.Equal(t, testCase.wantID, transcript.Segments[0].SpeakerID)
			require.Equal(t, testCase.wantName, transcript.Segments[0].Speaker)
		})
	}
}

// Живой транскрипт строится без разметки речи, а имя потока одно на всю
// запись: на площадке с комнатным миксом под ним оказывались все подряд.
// Поэтому фрагмент несёт то, что площадка знала в момент записи.
func TestBuildTranscriptUsesChunkAttributionWhileRecording(t *testing.T) {
	const speakerID = "remote-room-mix"
	session := &domain.Session{
		SessionID: "session-live",
		Status:    domain.StatusRecording,
		CallURL:   "https://telemost.yandex.ru/j/1",
		CreatedAt: time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC),
		Participants: map[string]*domain.Participant{
			"local":         {SpeakerID: "local", Name: "Александр"},
			"participant-a": {SpeakerID: "participant-a", Name: "Анна"},
			speakerID:       {SpeakerID: speakerID},
		},
	}
	job := func(attributedTo string) *Job {
		return &Job{
			SessionID:    session.SessionID,
			SpeakerID:    speakerID,
			AttributedTo: attributedTo,
			Duration:     2,
			Status:       JobCompleted,
			Segments:     []JobSegment{{Text: "Реплика", Start: 0, End: 2}},
		}
	}

	t.Run("фрагмент уходит тому, кого назвала площадка", func(t *testing.T) {
		transcript, failed := buildTranscript(session, []*Job{job("participant-a")}, nil)

		require.Zero(t, failed)
		require.Equal(t, "participant-a", transcript.Segments[0].SpeakerID)
		require.Equal(t, "Анна", transcript.Segments[0].Speaker)
	})

	// Имя придёт отдельным запросом и может опоздать; до тех пор честнее
	// показать поток, чем «Спикер N» рядом с настоящими именами.
	t.Run("без известного имени остаётся поток", func(t *testing.T) {
		transcript, failed := buildTranscript(session, []*Job{job("participant-неизвестный")}, nil)

		require.Zero(t, failed)
		require.Equal(t, speakerID, transcript.Segments[0].SpeakerID)
	})

	t.Run("без атрибуции ничего не меняется", func(t *testing.T) {
		transcript, failed := buildTranscript(session, []*Job{job("")}, nil)

		require.Zero(t, failed)
		require.Equal(t, speakerID, transcript.Segments[0].SpeakerID)
	})

	// Разметка речи точнее: она смотрит на каждую реплику, а не на фрагмент
	// целиком, поэтому на finalize решает она.
	t.Run("разметка речи важнее атрибуции фрагмента", func(t *testing.T) {
		timeline := &VADTimeline{
			LocalParticipantID: "participant-local",
			Participants:       []VADParticipant{{ParticipantID: "participant-b", Name: "Борис"}},
			Events:             []VADEvent{{At: 0, Active: []string{"participant-b"}}},
		}

		transcript, failed := buildTranscript(session, []*Job{job("participant-a")}, timeline)

		require.Zero(t, failed)
		require.Equal(t, "participant-b", transcript.Segments[0].SpeakerID)
	})
}

func TestBuildTranscriptWithoutVADKeepsStreamSpeaker(t *testing.T) {
	session := &domain.Session{
		SessionID: "session-without-vad",
		Status:    domain.StatusProcessing,
		CallURL:   "https://stream.wb.ru/room/1",
		CreatedAt: time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC),
		Participants: map[string]*domain.Participant{
			"remote-stream": {SpeakerID: "remote-stream", Name: "Гость"},
		},
	}
	jobs := []*Job{{
		SessionID: session.SessionID,
		SpeakerID: "remote-stream",
		Duration:  2,
		Status:    JobCompleted,
		Segments:  []JobSegment{{Text: "Реплика", Start: 0, End: 2}},
	}}

	transcript, _ := buildTranscript(session, jobs, nil)

	require.Equal(t, "remote-stream", transcript.Segments[0].SpeakerID)
	require.Equal(t, "Гость", transcript.Segments[0].Speaker)
}

func TestBuildTranscriptKeepsParticipantsWithEqualNamesSeparate(t *testing.T) {
	session := &domain.Session{
		SessionID: "session-equal-names",
		Status:    domain.StatusProcessing,
		CallURL:   "https://telemost.yandex.ru/j/1",
		CreatedAt: time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC),
		Participants: map[string]*domain.Participant{
			"local": {SpeakerID: "local", Name: "Ведущий"},
		},
	}
	timeline := &VADTimeline{
		Participants: []VADParticipant{
			{ParticipantID: "guest-a", Name: "Гость"},
			{ParticipantID: "guest-b", Name: "Гость"},
		},
		Events: []VADEvent{
			{At: 0, Active: []string{"guest-a"}},
			{At: 2, Active: []string{"guest-b"}},
		},
	}
	jobs := []*Job{{
		SessionID: session.SessionID,
		SpeakerID: "remote-room-mix",
		Duration:  3,
		Status:    JobCompleted,
		Segments: []JobSegment{
			{Text: "Первая", Start: 0, End: 1},
			{Text: "Вторая", Start: 2, End: 3},
		},
	}}

	transcript, _ := buildTranscript(session, jobs, timeline)

	guestIDs := make([]string, 0, 2)
	for _, participant := range transcript.Participants {
		if participant.Name == "Гость" {
			guestIDs = append(guestIDs, participant.SpeakerID)
		}
	}
	require.ElementsMatch(t, []string{"guest-a", "guest-b"}, guestIDs)
	require.Equal(t, "guest-a", transcript.Segments[0].SpeakerID)
	require.Equal(t, "guest-b", transcript.Segments[1].SpeakerID)
}

func TestQueueOrder(t *testing.T) {
	type args struct {
		queued []*Job
	}
	type want struct {
		offset float64
	}

	live := func(offset float64) *Job {
		return &Job{SessionID: "session-1", Offset: offset, Live: true}
	}
	backlog := func(offset float64) *Job {
		return &Job{SessionID: "session-1", Offset: offset}
	}

	tests := []struct {
		name string
		args args
		want want
	}{
		{
			name: "короткая очередь обрабатывается по порядку",
			args: args{queued: []*Job{live(0), live(20)}},
			want: want{offset: 0},
		},
		{
			name: "при отставании берётся свежий фрагмент",
			args: args{queued: []*Job{live(0), live(20), live(40), live(60)}},
			want: want{offset: 60},
		},
		{
			name: "восстановленные задачи в приоритет не идут",
			args: args{queued: []*Job{backlog(0), backlog(20), backlog(40), backlog(60)}},
			want: want{offset: 0},
		},
		{
			name: "свежая запись важнее хвоста прошлой сессии",
			args: args{queued: []*Job{backlog(0), backlog(20), live(5), backlog(40)}},
			want: want{offset: 5},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			is := require.New(t)
			control, _ := newTestController(t)
			for _, job := range tt.args.queued {
				control.enqueue(job)
			}

			job, ok := control.dequeue()

			is.True(ok)
			is.Equal(tt.want.offset, job.Offset)
		})
	}
}

func TestUploadChunkRejectsWhenQueueIsFull(t *testing.T) {
	// Воркер не запускаем: очередь никто не разгребает, как при перегрузке.
	control, sessionStore := newTestController(t)
	session, err := control.CreateSession("https://stream.wb.ru/room/1")
	if err != nil {
		t.Fatal(err)
	}
	for range MaxQueueDepth {
		control.enqueue(&Job{SessionID: session.SessionID})
	}

	_, err = control.UploadChunk(
		context.Background(),
		session.SessionID,
		"local",
		"",
		0,
		strings.NewReader("audio"),
	)
	if !errors.Is(err, ErrQueueBusy) {
		t.Fatalf("err = %v, want ErrQueueBusy", err)
	}

	// Отказ должен быть чистым: фрагмент не зарезервирован, прогресс не поехал.
	stored, err := sessionStore.Get(session.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.ChunksCount != 0 {
		t.Fatalf("chunksCount = %d, want 0", stored.ChunksCount)
	}
}

func TestUploadChunkAcceptsWhenQueueHasRoom(t *testing.T) {
	control, _ := newTestController(t)
	session, err := control.CreateSession("https://stream.wb.ru/room/1")
	if err != nil {
		t.Fatal(err)
	}
	for range MaxQueueDepth - 1 {
		control.enqueue(&Job{SessionID: session.SessionID})
	}

	if _, err := control.UploadChunk(
		context.Background(),
		session.SessionID,
		"local",
		"",
		0,
		strings.NewReader("audio"),
	); err != nil {
		t.Fatalf("upload rejected below the threshold: %v", err)
	}
}

func TestProgressReflectsJobUpdatesAfterCacheIsWarm(t *testing.T) {
	control, sessionStore := newTestController(t)
	session, err := control.CreateSession("https://stream.wb.ru/room/1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := control.UploadChunk(
		context.Background(),
		session.SessionID,
		"local",
		"",
		0,
		strings.NewReader("audio"),
	); err != nil {
		t.Fatal(err)
	}

	// Прогреваем кэш, затем обновляем задачу — прогресс обязан увидеть изменение.
	jobs, err := control.loadJobs(session.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 {
		t.Fatalf("jobs = %d, want 1", len(jobs))
	}
	jobs[0].Status = JobError
	if err := control.saveJob(jobs[0]); err != nil {
		t.Fatal(err)
	}
	if err := control.reconcileProgress(session.SessionID); err != nil {
		t.Fatal(err)
	}

	stored, err := sessionStore.Get(session.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.ProcessedChunks != 1 || stored.FailedChunks != 1 {
		t.Fatalf("progress = %d/%d, want 1 processed and 1 failed",
			stored.ProcessedChunks, stored.FailedChunks)
	}
}

func TestDeleteSessionDropsCachedJobs(t *testing.T) {
	control, _ := newTestController(t)
	session, err := control.CreateSession("https://stream.wb.ru/room/1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := control.UploadChunk(
		context.Background(),
		session.SessionID,
		"local",
		"",
		0,
		strings.NewReader("audio"),
	); err != nil {
		t.Fatal(err)
	}
	if _, err := control.loadJobs(session.SessionID); err != nil {
		t.Fatal(err)
	}

	if err := control.DeleteSession(session.SessionID); err != nil {
		t.Fatal(err)
	}

	jobs, err := control.loadJobs(session.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 0 {
		t.Fatalf("jobs after delete = %d, want 0", len(jobs))
	}
}

func TestCreateSessionFolderRule(t *testing.T) {
	c, st := newTestController(t)
	defer c.Close()
	folder, err := st.CreateFolder("Дейли")
	require.NoError(t, err)
	_, _, err = st.AddFolderRule(folder.ID, "meet.google.com/room")
	require.NoError(t, err)
	session, err := c.CreateSession("https://www.MEET.google.com/room/?authuser=0")
	require.NoError(t, err)
	require.Equal(t, folder.ID, session.FolderID)
	require.True(t, session.FolderByRule)
	require.NoError(t, st.MoveSessions([]string{session.SessionID}, "", false))
	_, _, err = st.AddFolderRule(folder.ID, "meet.google.com/room")
	require.NoError(t, err)
	saved, err := st.Get(session.SessionID)
	require.NoError(t, err)
	require.Empty(t, saved.FolderID)
	require.False(t, saved.FolderByRule)
	unmatched, err := c.CreateSession("https://meet.google.com/another")
	require.NoError(t, err)
	require.Empty(t, unmatched.FolderID)
}
