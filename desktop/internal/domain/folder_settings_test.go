package domain

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestValidateTitleTemplate(t *testing.T) {
	for _, tt := range []struct {
		input, want string
		invalid     bool
	}{
		{"", "", false}, {" \n ", "", false}, {" Дейли {date} ", "Дейли {date}", false},
		{"{weekday} {time} {date}", "{weekday} {time} {date}", false},
		{strings.Repeat("я", 200), strings.Repeat("я", 200), false},
		{strings.Repeat("я", 201), "", true}, {"{date} {date}", "", true},
		{"{time}{time}", "", true}, {"{weekday}{weekday}", "", true},
		{"{topic}", "", true}, {"{date", "", true}, {"date}", "", true},
		{"{{date}}", "", true}, {"{}", "", true}, {"{DATE}", "", true},
	} {
		t.Run(tt.input, func(t *testing.T) {
			got, err := ValidateTitleTemplate(tt.input)
			if tt.invalid {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
				require.Equal(t, tt.want, got)
			}
		})
	}
}

func TestRenderTitleTemplate(t *testing.T) {
	original := time.Local
	time.Local = time.FixedZone("test", 3*60*60)
	t.Cleanup(func() { time.Local = original })
	for _, tt := range []struct{ template, date, want string }{
		{"Дейли {date} {time} {weekday}", "2026-10-14T21:01:00Z", "Дейли 15.10.2026 00:01 четверг"},
		{"{weekday}", "2026-10-14T07:00:00Z", "среда"},
		{"{weekday}", "2026-10-12T07:00:00Z", "понедельник"},
		{"{weekday}", "2026-10-13T07:00:00Z", "вторник"},
		{"{weekday}", "2026-10-16T07:00:00Z", "пятница"},
		{"{weekday}", "2026-10-17T07:00:00Z", "суббота"},
		{"{weekday}", "2026-10-18T07:00:00Z", "воскресенье"},
		{"", "2026-10-14T07:00:00Z", ""}, {"Название", "2026-10-14T07:00:00Z", "Название"},
	} {
		t.Run(tt.date+tt.template, func(t *testing.T) {
			date, err := time.Parse(time.RFC3339, tt.date)
			require.NoError(t, err)
			require.Equal(t, tt.want, RenderTitleTemplate(tt.template, date))
		})
	}
}
