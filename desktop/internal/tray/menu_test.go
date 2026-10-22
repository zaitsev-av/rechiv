package tray

import (
	"fmt"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"rechiv/desktop/internal/calls"
	"rechiv/desktop/internal/domain"

	"github.com/stretchr/testify/require"
)

func TestBuildMenuState(t *testing.T) {
	now := time.Date(2026, 10, 19, 17, 42, 0, 0, time.FixedZone("Minsk", 3*60*60))
	config := Config{SessionsURL: "http://localhost:9876/", OnboardingURL: "http://localhost:9876/onboarding.html", Model: "v3_e2e_ctc", Engine: "onnx", Version: "1.0"}
	recording := &domain.Session{SessionID: "recording", Title: "Дейли", Status: domain.StatusRecording, CreatedAt: now.Add(-754 * time.Second)}
	processing := &domain.Session{SessionID: "processing", Title: "Ретро", Status: domain.StatusProcessing, CreatedAt: now.Add(-time.Minute), ChunksCount: 8, ProcessedChunks: 5}
	finishedAt := now.Add(-10 * time.Minute)
	completed := &domain.Session{SessionID: "completed", Title: "Итоги", Status: domain.StatusCompleted, CreatedAt: now.Add(-time.Hour), FinishedAt: &finishedAt}
	tests := []struct {
		name       string
		engine     string
		detail     string
		sessions   []*domain.Session
		contact    time.Time
		title      string
		hint       string
		indicator  Indicator
		statusURL  string
		files      bool
		icon       Icon
		timer      string
		primary    string
		primaryURL string
	}{
		{name: "recording overrides processing and engine error", engine: EngineFailed, sessions: []*domain.Session{processing, recording}, title: "Идёт запись · 12:34", hint: "Дейли", indicator: IndicatorRed, statusURL: config.SessionsURL + "transcript.html?sessionId=recording", icon: IconRecording, timer: "12:34"},
		{name: "processing overrides engine error and missing extension", engine: EngineFailed, sessions: []*domain.Session{processing}, title: "Расшифровка · 62%", hint: "Ретро", indicator: IndicatorBlue, statusURL: config.SessionsURL + "transcript.html?sessionId=processing", icon: IconProcessing},
		{name: "error overrides missing extension", engine: EngineFailed, detail: "Нет модели", title: "Не удалось запустить", indicator: IndicatorOrange, files: true, hint: "Нет модели", icon: IconIdle},
		{name: "error without detail", engine: EngineFailed, title: "Не удалось запустить", indicator: IndicatorOrange, files: true, icon: IconIdle},
		{name: "starting overrides missing extension", engine: EngineStarting, title: "Готовится к работе…", indicator: IndicatorGray, icon: IconIdle},
		{name: "initial engine state", title: "Готовится к работе…", indicator: IndicatorGray, icon: IconIdle},
		{name: "extension never contacted", engine: EngineReady, title: "Расширение не подключено", indicator: IndicatorOrange, statusURL: config.OnboardingURL, hint: "Без него записывать созвоны нельзя", icon: IconIdle, primary: "Подключить расширение…", primaryURL: config.OnboardingURL},
		{name: "extension silent with past recordings", engine: EngineReady, sessions: []*domain.Session{completed}, title: "Нет активного созвона", indicator: IndicatorGreen, hint: "Откройте встречу в браузере — Rechiv её увидит", icon: IconIdle, primary: "Открыть «Итоги»", primaryURL: config.SessionsURL + "transcript.html?sessionId=completed"},
		{name: "idle", engine: EngineReady, contact: now, title: "Нет активного созвона", indicator: IndicatorGreen, hint: "Откройте встречу в браузере — Rechiv её увидит", icon: IconIdle},
		{name: "old contact does not imply disconnection", engine: EngineReady, contact: now.Add(-24 * time.Hour), title: "Нет активного созвона", indicator: IndicatorGreen, hint: "Откройте встречу в браузере — Rechiv её увидит", icon: IconIdle},
		{name: "recent transcript", engine: EngineReady, contact: now, sessions: []*domain.Session{completed}, title: "Нет активного созвона", indicator: IndicatorGreen, hint: "Откройте встречу в браузере — Rechiv её увидит", icon: IconIdle, primary: "Открыть «Итоги»", primaryURL: config.SessionsURL + "transcript.html?sessionId=completed"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			menu := BuildMenu(Status{Engine: tt.engine, Detail: tt.detail, Sessions: tt.sessions, LastExtension: tt.contact}, config, now)
			require.Equal(t, Item{Title: tt.title, URL: tt.statusURL, ShowFiles: tt.files, Visible: true, Enabled: tt.statusURL != "" || tt.files}, menu.Status)
			require.Equal(t, tt.indicator, menu.Indicator)
			require.Equal(t, Item{Title: tt.hint, Visible: tt.hint != ""}, menu.Hint)
			withoutUI := BuildMenu(Status{Engine: tt.engine, Detail: tt.detail, Sessions: tt.sessions, LastExtension: tt.contact}, Config{}, now)
			require.False(t, withoutUI.Status.Enabled)
			require.Equal(t, tt.icon, menu.Icon)
			require.Equal(t, tt.timer, menu.Timer)
			require.Equal(t, tt.primary, menu.Primary.Title)
			require.Equal(t, tt.primaryURL, menu.Primary.URL)
			require.Equal(t, tt.primary != "", menu.Primary.Visible)
			require.Equal(t, tt.primaryURL != "", menu.Primary.Enabled)
		})
	}
}

func TestBuildMenuProgress(t *testing.T) {
	for _, tt := range []struct {
		chunks, processed int
		want              string
	}{
		{0, 0, "Расшифровка"},
		{10, 0, "Расшифровка · 0%"},
		{3, 1, "Расшифровка · 33%"},
		{100, 29, "Расшифровка · 29%"},
		{10, 10, "Расшифровка · 100%"},
		{10, 20, "Расшифровка · 100%"},
		{10, -1, "Расшифровка · 0%"},
	} {
		t.Run(fmt.Sprintf("%d/%d", tt.processed, tt.chunks), func(t *testing.T) {
			menu := BuildMenu(Status{Sessions: []*domain.Session{{Status: domain.StatusProcessing, ChunksCount: tt.chunks, ProcessedChunks: tt.processed}}}, Config{}, time.Now())
			require.Equal(t, tt.want, menu.Status.Title)
		})
	}
}

func TestBuildMenuRecentWindow(t *testing.T) {
	now := time.Date(2026, 10, 19, 17, 42, 0, 0, time.UTC)
	for _, tt := range []struct {
		name   string
		age    time.Duration
		status domain.SessionStatus
		show   bool
	}{
		{"just finished", 0, domain.StatusCompleted, true},
		{"boundary", 30 * time.Minute, domain.StatusCompleted, true},
		{"expired", 30*time.Minute + time.Second, domain.StatusCompleted, false},
		{"future", -time.Second, domain.StatusCompleted, false},
		{"failed session", time.Minute, domain.StatusError, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			finished := now.Add(-tt.age)
			menu := BuildMenu(Status{Engine: EngineReady, LastExtension: now, Sessions: []*domain.Session{{SessionID: "id", Status: tt.status, FinishedAt: &finished}}}, Config{SessionsURL: "http://localhost/"}, now)
			require.Equal(t, tt.show, menu.Primary.Visible)
		})
	}
}

func TestBuildMenuRecentSessions(t *testing.T) {
	now := time.Date(2026, 10, 19, 17, 42, 0, 0, time.FixedZone("Minsk", 3*60*60))
	sessions := make([]*domain.Session, 7)
	for i := range sessions {
		sessions[i] = &domain.Session{SessionID: fmt.Sprint(i), Title: fmt.Sprintf("Созвон %d", i), Status: domain.StatusCompleted, CreatedAt: now.Add(time.Duration(i-10) * time.Hour).UTC()}
	}
	sessions[6].SessionID = "id & вопрос"
	lastChunk := sessions[6].CreatedAt.Add(15*time.Minute + 21*time.Second)
	sessions[6].LastChunkAt = &lastChunk
	sessions[5].Status = domain.StatusError
	sessions[4].Status = domain.StatusProcessing
	sessions[3].Status = domain.StatusRecording
	status := Status{Engine: EngineReady, Sessions: sessions}
	menu := BuildMenu(status, Config{SessionsURL: "http://localhost:9876/"}, now)
	require.False(t, menu.Empty.Visible)
	require.Equal(t, "Созвон 6 · 19.10.2026 13:42 · 15:21 · готово", menu.Recent[0].Title)
	require.Equal(t, "http://localhost:9876/transcript.html?sessionId=id+%26+%D0%B2%D0%BE%D0%BF%D1%80%D0%BE%D1%81", menu.Recent[0].URL)
	require.Contains(t, menu.Recent[1].Title, "ошибка")
	require.Contains(t, menu.Recent[2].Title, "идёт обработка")
	require.Contains(t, menu.Recent[3].Title, "идёт запись")
	for i, item := range menu.Recent {
		require.True(t, item.Visible)
		require.True(t, item.Enabled)
		require.Contains(t, item.Title, fmt.Sprintf("Созвон %d", 6-i))
	}
	require.Equal(t, "0", sessions[0].SessionID)
	require.Equal(t, menu, BuildMenu(status, Config{SessionsURL: "http://localhost:9876/"}, now))

	status.Sessions = sessions[:1]
	menu = BuildMenu(status, Config{}, now)
	require.True(t, menu.Recent[0].Visible)
	require.False(t, menu.Recent[0].Enabled)
	require.Empty(t, menu.Recent[0].URL)
	for _, item := range menu.Recent[1:] {
		require.False(t, item.Visible)
	}
	menu = BuildMenu(Status{}, Config{}, now)
	require.Equal(t, Item{Title: "Пока нет записей", Visible: true}, menu.Empty)
	require.False(t, menu.AllSessions.Enabled)
}

func TestBuildMenuLatestFinished(t *testing.T) {
	now := time.Now()
	olderFinish, newerFinish := now.Add(-10*time.Minute), now.Add(-time.Minute)
	sessions := []*domain.Session{
		{SessionID: "started-later", Status: domain.StatusCompleted, CreatedAt: now.Add(-time.Hour), FinishedAt: &olderFinish},
		{SessionID: "finished-later", Status: domain.StatusCompleted, CreatedAt: now.Add(-2 * time.Hour), FinishedAt: &newerFinish},
		{SessionID: "no-finish", Status: domain.StatusError, CreatedAt: now},
	}
	menu := BuildMenu(Status{Engine: EngineReady, LastExtension: now, Sessions: sessions}, Config{SessionsURL: "http://localhost/"}, now)
	require.Equal(t, "http://localhost/transcript.html?sessionId=finished-later", menu.Primary.URL)
	menu = BuildMenu(Status{Engine: EngineReady, LastExtension: now, Sessions: sessions}, Config{}, now)
	require.True(t, menu.Primary.Visible)
	require.False(t, menu.Primary.Enabled)
}

func TestBuildMenuModel(t *testing.T) {
	for _, tt := range []struct {
		model, engine, state, title, footer string
	}{
		{"v3_e2e_ctc", "onnx", EngineReady, "GigaAM v3", "Модель загружена"},
		{"v3_e2e_ctc", "torch", EngineStarting, "GigaAM v3", "Модель загружается"},
		{"custom-model", "torch", EngineFailed, "custom-model", "Модель: ошибка"},
	} {
		t.Run(tt.state, func(t *testing.T) {
			menu := BuildMenu(Status{Engine: tt.state}, Config{Model: tt.model, Engine: tt.engine, Version: "1.2.3"}, time.Now())
			require.Equal(t, "Текущая модель: "+tt.title, menu.ModelTitle)
			require.Equal(t, []Choice{{Title: tt.title + " · русский", Tooltip: "Движок: " + tt.engine, Checked: true}}, menu.Models)
			require.Equal(t, []Choice{{Title: "Русский", Checked: true}}, menu.Languages)
			require.Equal(t, tt.footer+" · Rechiv 1.2.3", menu.ModelStatus)
		})
	}
}

func TestBuildMenuTimer(t *testing.T) {
	now := time.Now()
	for _, tt := range []struct {
		age  time.Duration
		want string
	}{
		{-time.Minute, "00:00"},
		{0, "00:00"},
		{12*time.Minute + 59*time.Second, "12:59"},
		{time.Hour + 2*time.Second, "1:00:02"},
	} {
		t.Run(tt.want, func(t *testing.T) {
			menu := BuildMenu(Status{Sessions: []*domain.Session{{Status: domain.StatusRecording, CreatedAt: now.Add(-tt.age)}}}, Config{}, now)
			require.Equal(t, tt.want, menu.Timer)
		})
	}
}

func TestShorten(t *testing.T) {
	text := strings.Repeat("Я", 70)
	short := shorten(text)
	require.True(t, utf8.ValidString(short))
	require.Equal(t, strings.Repeat("Я", 60)+"…", short)
	require.Equal(t, "Название созвона", shorten("Название\nсозвона"))
}

func TestBuildMenuDurationFallback(t *testing.T) {
	now := time.Date(2026, 10, 19, 17, 42, 0, 0, time.UTC)
	created, lastChunk := now.Add(-time.Hour), now.Add(-45*time.Minute)
	for _, tt := range []struct {
		name      string
		status    domain.SessionStatus
		lastChunk *time.Time
		want      string
	}{
		{"recording", domain.StatusRecording, &lastChunk, "1:00:00"},
		{"processing", domain.StatusProcessing, &lastChunk, "15:00"},
		{"completed", domain.StatusCompleted, &lastChunk, "15:00"},
		{"no chunks", domain.StatusError, nil, "00:00"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			session := &domain.Session{SessionID: "id", Status: tt.status, CreatedAt: created, LastChunkAt: tt.lastChunk, FinishedAt: &now}
			menu := BuildMenu(Status{Sessions: []*domain.Session{session}}, Config{}, now)
			require.Contains(t, menu.Recent[0].Title, " · "+tt.want+" · ")
		})
	}
}

func TestBuildMenuSelectsNewestActiveSession(t *testing.T) {
	now := time.Now()
	older := &domain.Session{SessionID: "old", Title: "Старая", CreatedAt: now.Add(-time.Minute), Status: domain.StatusRecording}
	newer := &domain.Session{SessionID: "new", Title: "Новая", CreatedAt: now, Status: domain.StatusRecording}
	status := Status{Sessions: []*domain.Session{older, newer}}
	menu := BuildMenu(status, Config{}, now)
	require.Equal(t, "Новая", menu.Hint.Title)
	require.Equal(t, "00:00", menu.Timer)
	require.Same(t, older, status.Sessions[0])

	older.CreatedAt = now
	older.SessionID = "a"
	menu = BuildMenu(status, Config{}, now)
	require.Equal(t, "Старая", menu.Hint.Title)
}

func TestBuildMenuOnboardingWithoutWebUI(t *testing.T) {
	menu := BuildMenu(Status{Engine: EngineReady}, Config{}, time.Now())
	require.Equal(t, "Подключить расширение…", menu.Primary.Title)
	require.True(t, menu.Primary.Visible)
	require.False(t, menu.Primary.Enabled)
}

func TestBuildMenuRecordingPlatform(t *testing.T) {
	for _, tt := range []struct{ url, suffix string }{
		{"https://telemost.yandex.ru/j/123", " · Телемост"},
		{"https://stream.wb.ru/room/123", " · WB Stream"},
		{"https://meet.google.com/abc-defg-hij", " · Google Meet"},
		{"https://stream.wb.ru.example/room/123", ""},
		{"%%%", ""}, {"", ""},
	} {
		t.Run(tt.url, func(t *testing.T) {
			menu := BuildMenu(Status{Sessions: []*domain.Session{{Status: domain.StatusRecording, CallURL: tt.url}}}, Config{}, time.Now())
			require.Equal(t, "Созвон"+tt.suffix, menu.Hint.Title)
		})
	}
}

func TestBuildMenuCallChannel(t *testing.T) {
	now := time.Now()
	config := Config{SessionsURL: "http://localhost:9876/"}
	telemost := &calls.Call{URL: "https://telemost.yandex.ru/j/123"}
	recording := &domain.Session{SessionID: "rec", Status: domain.StatusRecording, CreatedAt: now.Add(-time.Minute)}

	menu := BuildMenu(Status{Engine: EngineReady, Call: telemost}, config, now)
	require.Equal(t, "Созвон в Телемосте", menu.Status.Title)
	require.False(t, menu.Status.Enabled)
	require.Equal(t, IndicatorBlue, menu.Indicator)
	require.Equal(t, "Запись не идёт", menu.Hint.Title)
	require.Equal(t, Item{Title: "Начать запись", Tooltip: "Запись начнётся во вкладке созвона", Command: calls.CommandStart, Enabled: true, Visible: true}, menu.Primary)

	menu = BuildMenu(Status{Engine: EngineReady, Call: &calls.Call{URL: "https://example.com/x"}}, config, now)
	require.Equal(t, "Открыт созвон", menu.Status.Title)

	menu = BuildMenu(Status{Engine: EngineFailed, Call: telemost}, config, now)
	require.Equal(t, "Не удалось запустить", menu.Status.Title, "без модели запись не начать")

	menu = BuildMenu(Status{Engine: EngineReady, Call: &calls.Call{URL: telemost.URL, Recording: true}, Sessions: []*domain.Session{recording}}, config, now)
	require.Equal(t, calls.CommandStop, menu.Primary.Command)
	require.Equal(t, "Остановить запись", menu.Primary.Title)
	require.Equal(t, calls.CommandLive, menu.Live.Command)
	require.True(t, menu.Live.Visible)

	menu = BuildMenu(Status{Engine: EngineReady, Call: &calls.Call{URL: telemost.URL, Recording: true, Stopping: true, StoppingSince: now.Add(-20 * time.Second)}, Sessions: []*domain.Session{recording}}, config, now)
	require.Equal(t, "Запись останавливается · 00:40", menu.Status.Title)
	require.Equal(t, "00:40", menu.Timer, "таймер замирает на моменте остановки")
	require.Equal(t, IndicatorOrange, menu.Indicator)
	require.Equal(t, IconStopping, menu.Icon)
	require.False(t, menu.Primary.Visible)
	require.False(t, menu.Live.Visible)

	menu = BuildMenu(Status{Engine: EngineReady, Stop: calls.Stop{SessionID: recording.SessionID, Since: now.Add(-20 * time.Second)}, Sessions: []*domain.Session{recording}}, config, now)
	require.Equal(t, "Запись останавливается · 00:40", menu.Status.Title, "вкладку закрыли, хвост ещё едет")
	require.Equal(t, IndicatorOrange, menu.Indicator)

	menu = BuildMenu(Status{Engine: EngineReady, Stop: calls.Stop{SessionID: "other", Since: now}, Sessions: []*domain.Session{recording}}, config, now)
	require.Equal(t, IndicatorRed, menu.Indicator, "остановка другой сессии не в счёт")

	menu = BuildMenu(Status{Engine: EngineReady, Call: telemost, CallFolder: "Дейли"}, config, now)
	require.Equal(t, "Папка «Дейли» · запись не идёт", menu.Hint.Title)
	require.False(t, menu.Live.Visible)

	menu = BuildMenu(Status{Engine: EngineReady, Sessions: []*domain.Session{recording}}, config, now)
	require.False(t, menu.Primary.Visible, "без канала остановить запись из трея нельзя")
	require.False(t, menu.Live.Visible)
}
