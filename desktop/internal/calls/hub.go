package calls

import (
	"context"
	"sync"
	"time"
)

type Command string

const (
	CommandStart Command = "start"
	CommandStop  Command = "stop"
	CommandLive  Command = "live"
)

type Call struct {
	Platform  string `json:"platform"`
	URL       string `json:"url"`
	Title     string `json:"title"`
	Recording bool   `json:"recording"`
	// Joined — во вкладке уже пришёл звук собеседника: это вход в созвон, а не проверка устройств.
	Joined bool `json:"joined,omitempty"`
	// Stopping — вкладка дописывает хвост записи после остановки.
	Stopping  bool   `json:"stopping,omitempty"`
	SessionID string `json:"sessionId,omitempty"`
	// StoppingSince — когда остановку попросили; на нём замирает таймер трея.
	StoppingSince time.Time `json:"-"`
}

// Stop — остановка записи сессии. Переживает закрытие вкладки: хвост записи
// дописывается и без неё, а трей не должен снова показать «Идёт запись».
type Stop struct {
	SessionID string
	Since     time.Time
}

const (
	// Расширение опрашивает не реже раза в 25 с; без опроса созвон считаем закрытым.
	callTTL = 45 * time.Second
	// Команда для уснувшего расширения устаревает: запись не должна начаться через минуту.
	commandTTL = 15 * time.Second
)

type Hub struct {
	mu        sync.Mutex
	call      *Call
	seenAt    time.Time
	command   Command
	commandAt time.Time
	wake      chan struct{}
	closed    bool
	autoURL   string
	stop      Stop
	now       func() time.Time
}

func NewHub() *Hub {
	return &Hub{wake: make(chan struct{}), now: time.Now}
}

// Report обновляет состояние; nil означает, что вкладки созвона больше нет.
func (h *Hub) Report(call *Call) {
	h.mu.Lock()
	defer h.mu.Unlock()
	// Созвон по той же ссылке завтра — новый созвон, даже если о закрытии вкладки мы не узнали.
	if call == nil || call.URL != h.autoURL || h.now().Sub(h.seenAt) > callTTL {
		h.autoURL = ""
	}
	if call == nil {
		if h.call != nil && (h.call.Recording || h.call.Stopping) {
			h.markStop(h.call.SessionID)
		}
		h.call = nil
		h.command = ""
		return
	}
	switch {
	case call.Stopping:
		h.markStop(call.SessionID)
	case !call.Recording:
		h.stop = Stop{}
	case h.stop.SessionID != "" && call.SessionID != "" && call.SessionID != h.stop.SessionID:
		h.stop = Stop{}
	}
	copied := *call
	h.call = &copied
	h.seenAt = h.now()
}

func (h *Hub) Current() *Call {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.call == nil || h.now().Sub(h.seenAt) > callTTL {
		return nil
	}
	copied := *h.call
	// Трей отмечает остановку сразу по клику, не дожидаясь ответа вкладки.
	if !h.stop.Since.IsZero() && (copied.Recording || copied.Stopping) {
		copied.Stopping = true
		copied.StoppingSince = h.stop.Since
	}
	return &copied
}

// Send ставит команду в очередь из одного места: новая заменяет недоставленную.
func (h *Hub) Send(command Command) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.call == nil || h.now().Sub(h.seenAt) > callTTL {
		return false
	}
	h.command = command
	h.commandAt = h.now()
	if command == CommandStop {
		h.markStop(h.call.SessionID)
	}
	h.notify()
	return true
}

// Stopping — последняя остановка; сессию закрывает её статус в хранилище, а не вкладка.
func (h *Hub) Stopping() Stop {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.stop
}

func (h *Hub) markStop(sessionID string) {
	if h.stop.Since.IsZero() {
		h.stop.Since = h.now()
	}
	if h.stop.SessionID == "" {
		h.stop.SessionID = sessionID
	}
}

// ClaimAutoStart разрешает автозапись один раз на созвон: после ручной остановки она не повторяется.
func (h *Hub) ClaimAutoStart(url string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if url == "" || h.autoURL == url {
		return false
	}
	h.autoURL = url
	return true
}

// Wait ждёт команду не дольше timeout; пустая строка — команды нет.
func (h *Hub) Wait(ctx context.Context, timeout time.Duration) Command {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		h.mu.Lock()
		if h.command != "" {
			command := h.command
			fresh := h.now().Sub(h.commandAt) <= commandTTL
			h.command = ""
			h.mu.Unlock()
			if fresh {
				return command
			}
			continue
		}
		if h.closed {
			h.mu.Unlock()
			return ""
		}
		wake := h.wake
		h.mu.Unlock()
		select {
		case <-wake:
		case <-timer.C:
			return ""
		case <-ctx.Done():
			return ""
		}
	}
}

// Close отпускает ждущие запросы, чтобы остановка сервера не ждала таймаута опроса.
func (h *Hub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closed = true
	h.notify()
}

func (h *Hub) notify() {
	close(h.wake)
	h.wake = make(chan struct{})
}
