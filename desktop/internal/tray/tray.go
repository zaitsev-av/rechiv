package tray

import "log"

type Status struct {
	Engine string
	Detail string
}

type Options struct {
	Icon          []byte
	Version       string
	SessionsURL   string
	OnboardingURL string
	DataDir       string
	Status        func() Status
	Logger        *log.Logger
}

const (
	EngineReady    = "ready"
	EngineStarting = "starting"
	EngineFailed   = "error"
)

func statusLine(status Status) string {
	switch status.Engine {
	case EngineReady:
		return "Готов к записи"
	case EngineStarting:
		return "Готовится к работе…"
	case EngineFailed:
		if status.Detail != "" {
			return "Не удалось запустить: " + shorten(status.Detail)
		}
		return "Не удалось запустить"
	default:
		return "Состояние неизвестно"
	}
}

func shorten(text string) string {
	const limit = 60
	if len(text) <= limit {
		return text
	}
	trimmed := text[:limit]
	for i := len(trimmed) - 1; i > limit/2; i-- {
		if trimmed[i] == ' ' {
			return trimmed[:i] + "…"
		}
	}
	return trimmed + "…"
}
