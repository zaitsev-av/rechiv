package tray

import (
	"fmt"
	"net/url"
	"slices"
	"strings"
	"time"

	"rechiv/desktop/internal/calls"
	"rechiv/desktop/internal/domain"
)

type Icon string

const (
	IconIdle       Icon = "idle"
	IconRecording  Icon = "recording"
	IconProcessing Icon = "processing"
	IconStopping   Icon = "stopping"
	recentLimit         = 5
	recentWindow        = 30 * time.Minute
)

type Indicator string

const (
	IndicatorRed    Indicator = "red"
	IndicatorBlue   Indicator = "blue"
	IndicatorGreen  Indicator = "green"
	IndicatorOrange Indicator = "orange"
	IndicatorGray   Indicator = "gray"
)

type Item struct {
	Command   calls.Command
	ShowFiles bool
	Title     string
	Tooltip   string
	URL       string
	Enabled   bool
	Visible   bool
}

type Choice struct {
	Title   string
	Tooltip string
	Checked bool
}

type Menu struct {
	Status      Item
	Indicator   Indicator
	Hint        Item
	Live        Item
	Primary     Item
	Icon        Icon
	Timer       string
	Recent      [recentLimit]Item
	Empty       Item
	AllSessions Item
	ModelTitle  string
	Models      []Choice
	Languages   []Choice
	ModelStatus string
}

func BuildMenu(status Status, config Config, now time.Time) Menu {
	menu := Menu{
		Status:      Item{Title: "Нет активного созвона", Visible: true},
		Indicator:   IndicatorGreen,
		Hint:        Item{Title: "Откройте встречу в браузере — Rechiv её увидит"},
		Icon:        IconIdle,
		Empty:       Item{Title: "Пока нет записей", Visible: true},
		AllSessions: link("Все созвоны", "Открыть список созвонов в браузере", config.SessionsURL),
	}
	modelName := config.Model
	if modelName == "v3_e2e_ctc" {
		modelName = "GigaAM v3"
	}
	menu.ModelTitle = "Текущая модель: " + modelName
	menu.Models = []Choice{{Title: modelName + " · русский", Tooltip: "Движок: " + config.Engine, Checked: true}}
	menu.Languages = []Choice{{Title: "Русский", Checked: true}}
	modelState := "Модель загружается"
	switch status.Engine {
	case EngineReady:
		modelState = "Модель загружена"
	case EngineFailed:
		modelState = "Модель: ошибка"
	}
	menu.ModelStatus = modelState + " · Rechiv " + config.Version

	// Снимок хранилища не меняем; при одинаковом времени порядок остаётся стабильным.
	sessions := slices.Clone(status.Sessions)
	slices.SortFunc(sessions, func(a, b *domain.Session) int {
		if order := b.CreatedAt.Compare(a.CreatedAt); order != 0 {
			return order
		}
		return strings.Compare(a.SessionID, b.SessionID)
	})
	var recording, processing, latestFinished *domain.Session
	for i, session := range sessions {
		if i < recentLimit {
			menu.Empty.Visible = false
			end := session.CreatedAt
			if session.Status == domain.StatusRecording {
				end = now
			} else if session.LastChunkAt != nil {
				// FinishedAt включает ожидание расшифровки, это не длительность записи.
				end = *session.LastChunkAt
			}
			duration := elapsed(end.Sub(session.CreatedAt))
			title := fmt.Sprintf("%s · %s · %s · %s", shorten(sessionTitle(session)), session.CreatedAt.In(now.Location()).Format("02.01.2006 15:04"), duration, sessionState(session.Status))
			menu.Recent[i] = link(title, sessionTitle(session), transcriptURL(config.SessionsURL, session.SessionID))
		}
		switch session.Status {
		case domain.StatusRecording:
			if recording == nil {
				recording = session
			}
		case domain.StatusProcessing:
			if processing == nil {
				processing = session
			}
		case domain.StatusCompleted, domain.StatusError:
			if session.FinishedAt != nil && !session.FinishedAt.After(now) && (latestFinished == nil || session.FinishedAt.After(*latestFinished.FinishedAt)) {
				latestFinished = session
			}
		}
	}

	switch {
	case recording != nil:
		menu.Icon = IconRecording
		menu.Timer = elapsed(now.Sub(recording.CreatedAt))
		menu.Status.Title = "Идёт запись · " + menu.Timer
		stoppingSince := status.Stop.Since
		if status.Stop.SessionID != recording.SessionID {
			stoppingSince = time.Time{}
		}
		if status.Call != nil && status.Call.Stopping && stoppingSince.IsZero() {
			stoppingSince = status.Call.StoppingSince
		}
		stopping := !stoppingSince.IsZero() || status.Call != nil && status.Call.Stopping
		if stopping {
			if !stoppingSince.IsZero() {
				menu.Timer = elapsed(stoppingSince.Sub(recording.CreatedAt))
			}
			menu.Status.Title = "Запись останавливается · " + menu.Timer
		}
		menu.Indicator = IndicatorRed
		if stopping {
			menu.Indicator = IndicatorOrange
			menu.Icon = IconStopping
		}
		menu.Status.URL = transcriptURL(config.SessionsURL, recording.SessionID)
		menu.Hint.Title = sessionTitle(recording)
		if platform := callPlatform(recording.CallURL); platform != "" {
			menu.Hint.Title += " · " + platform
		}
		// Без канала остановить запись из трея нельзя: команду некому передать.
		if status.Call != nil && status.Call.Recording && !stopping {
			menu.Live = command("Показать live-транскрипт", "Панель поверх звонка", calls.CommandLive)
			menu.Primary = command("Остановить запись", "Вкладка дошлёт хвост записи и разметку", calls.CommandStop)
		}
	case status.Call != nil && !status.Call.Recording && status.Engine != EngineFailed:
		menu.Status.Title = "Открыт созвон"
		if platform := callPlatform(status.Call.URL); platform != "" {
			menu.Status.Title = "Созвон в " + locative(platform)
		}
		menu.Indicator = IndicatorBlue
		menu.Hint.Title = "Запись не идёт"
		if status.CallFolder != "" {
			menu.Hint.Title = "Папка «" + shorten(status.CallFolder) + "» · запись не идёт"
		}
		menu.Primary = command("Начать запись", "Запись начнётся во вкладке созвона", calls.CommandStart)
	case processing != nil:
		menu.Icon = IconProcessing
		menu.Status.Title = "Расшифровка"
		if processing.ChunksCount > 0 {
			progress := min(processing.ChunksCount, max(0, processing.ProcessedChunks)) * 100 / processing.ChunksCount
			menu.Status.Title += fmt.Sprintf(" · %d%%", progress)
		}
		menu.Indicator = IndicatorBlue
		menu.Status.URL = transcriptURL(config.SessionsURL, processing.SessionID)
		menu.Hint.Title = sessionTitle(processing)
	case status.Engine == EngineFailed:
		menu.Status.Title = "Не удалось запустить"
		menu.Indicator = IndicatorOrange
		menu.Hint.Title = status.Detail
		menu.Status.URL = ""
		menu.Status.ShowFiles = true
	case status.Engine == EngineStarting || status.Engine == "":
		menu.Status.Title = "Готовится к работе…"
		menu.Indicator = IndicatorGray
		menu.Hint.Title = ""
	case status.LastExtension.IsZero() && len(sessions) == 0:
		// У расширения нет heartbeat: давний контакт сам по себе не означает отключение.
		menu.Status.Title = "Расширение не подключено"
		menu.Indicator = IndicatorOrange
		menu.Status.URL = config.OnboardingURL
		menu.Hint.Title = "Без него записывать созвоны нельзя"
		menu.Primary = link("Подключить расширение…", "Настроить расширение", config.OnboardingURL)
	default:
		if latestFinished != nil && now.Sub(*latestFinished.FinishedAt) <= recentWindow {
			menu.Primary = link("Открыть «"+shorten(sessionTitle(latestFinished))+"»", sessionTitle(latestFinished), transcriptURL(config.SessionsURL, latestFinished.SessionID))
		}
	}
	menu.Hint.Visible = menu.Hint.Title != ""
	menu.Status.Enabled = config.SessionsURL != "" && (menu.Status.ShowFiles || menu.Status.URL != "")
	return menu
}

func link(title, tooltip, target string) Item {
	return Item{Title: title, Tooltip: tooltip, URL: target, Enabled: target != "", Visible: true}
}

func command(title, tooltip string, value calls.Command) Item {
	return Item{Title: title, Tooltip: tooltip, Command: value, Enabled: true, Visible: true}
}

func transcriptURL(base, id string) string {
	if base == "" {
		return ""
	}
	return strings.TrimRight(base, "/") + "/transcript.html?sessionId=" + url.QueryEscape(id)
}

func sessionTitle(session *domain.Session) string {
	if title := strings.TrimSpace(session.Title); title != "" {
		return title
	}
	return "Созвон"
}

func sessionState(status domain.SessionStatus) string {
	switch status {
	case domain.StatusCompleted:
		return "готово"
	case domain.StatusError:
		return "ошибка"
	case domain.StatusRecording:
		return "идёт запись"
	default:
		return "идёт обработка"
	}
}

func elapsed(duration time.Duration) string {
	seconds := max(0, int(duration.Seconds()))
	if seconds >= 3600 {
		return fmt.Sprintf("%d:%02d:%02d", seconds/3600, seconds%3600/60, seconds%60)
	}
	return fmt.Sprintf("%02d:%02d", seconds/60, seconds%60)
}

func shorten(text string) string {
	const limit = 60
	runes := []rune(strings.Join(strings.Fields(text), " "))
	if len(runes) <= limit {
		return string(runes)
	}
	return string(runes[:limit]) + "…"
}

func locative(platform string) string {
	if platform == "Телемост" {
		return "Телемосте"
	}
	return platform
}

func callPlatform(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	switch strings.ToLower(parsed.Hostname()) {
	case "telemost.yandex.ru":
		return "Телемост"
	case "stream.wb.ru":
		return "WB Stream"
	case "meet.google.com":
		return "Google Meet"
	default:
		return ""
	}
}
