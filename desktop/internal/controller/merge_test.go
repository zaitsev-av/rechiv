package controller

import (
	"testing"

	"github.com/stretchr/testify/require"

	"rechiv/desktop/internal/domain"
)

func segment(speakerID string, start, end float64, text string) domain.Segment {
	return domain.Segment{
		SpeakerID: speakerID,
		Start:     formatDuration(start),
		End:       formatDuration(end),
		Text:      text,
		StartSec:  start,
		EndSec:    end,
	}
}

func texts(segments []domain.Segment) []string {
	result := make([]string, 0, len(segments))
	for _, item := range segments {
		result = append(result, item.Text)
	}
	return result
}

var participants = []*domain.Participant{{SpeakerID: "local", Name: "Олег Ветров"}, {SpeakerID: "a", Name: "Борис Ковалёв"}}

// Реплика с созвона 25 сентября: пауза 3 секунды посреди фразы.
func TestMergeSegmentsJoinsOneSpeakersPhrase(t *testing.T) {
	merged := mergeSegments([]domain.Segment{
		segment("local", 277.1, 279.6, "Так, привет. Я вчера"),
		segment("local", 279.9, 284.5, "Отдал в ревью задачу."),
		segment("local", 284.8, 286.7, "Осталось там только"),
		segment("local", 289.7, 295.1, "Asgard поправить процент"),
	}, participants)

	require.Equal(t, []string{
		"Так, привет. Я вчера отдал в ревью задачу. Осталось там только Asgard поправить процент",
	}, texts(merged))
	require.Equal(t, "00:04:37", merged[0].Start)
	require.Equal(t, 295.1, merged[0].EndSec)
	require.Equal(t, formatDuration(295.1), merged[0].End)
}

func TestMergeSegmentsKeepsTurnsApart(t *testing.T) {
	merged := mergeSegments([]domain.Segment{
		segment("a", 0, 2, "Привет"),
		segment("local", 2.5, 4, "Привет"),
		segment("a", 4.5, 6, "Начнём"),
		segment("a", 10, 12, "После долгой паузы"),
	}, participants)

	require.Equal(t, []string{"Привет", "Привет", "Начнём", "После долгой паузы"}, texts(merged))
}

func TestMergeSegmentsLeavesUnknownAndErrorsAlone(t *testing.T) {
	failed := segment("a", 3, 5, "")
	failed.Error = true
	merged := mergeSegments([]domain.Segment{
		segment(UnknownSpeakerID, 0, 1, "Пока пока."),
		segment(UnknownSpeakerID, 1.2, 2, "Пока всем."),
		failed,
		segment("a", 5.5, 7, "Дальше"),
	}, participants)

	require.Len(t, merged, 4)
}

func TestMergeSegmentsBreaksLongMonologueOnSentenceEnd(t *testing.T) {
	merged := mergeSegments([]domain.Segment{
		segment("a", 0, 30, "Первая часть"),
		segment("a", 30.5, 50, "продолжение без точки"),
		segment("a", 50.5, 60, "Конец мысли."),
		segment("a", 61, 70, "Новая мысль."),
	}, participants)

	require.Equal(t, []string{
		"Первая часть продолжение без точки конец мысли.",
		"Новая мысль.",
	}, texts(merged))
}

func TestMergeSegmentsKeepsNamesAndAcronymsCapitalized(t *testing.T) {
	merged := mergeSegments([]domain.Segment{
		segment("local", 0, 2, "Спроси у"),
		segment("local", 2.2, 3, "Бориса, он знает"),
		segment("local", 3.2, 4, "API и"),
		segment("local", 4.2, 5, "Прод, и"),
		segment("local", 5.2, 6, "Диму позови"),
		segment("a", 8, 9, "Позову, но Дима занят."),
	}, participants)

	require.Equal(t, []string{
		"Спроси у Бориса, он знает API и прод, и Диму позови",
		"Позову, но Дима занят.",
	}, texts(merged))
}
