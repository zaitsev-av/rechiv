package api

import (
	"fmt"
	"net/http"
	"time"
)

const (
	eventsPing = 20 * time.Second
	// Во время записи хранилище меняется на каждом чанке; страница всё равно перечитывает список целиком.
	eventsCoalesce = 300 * time.Millisecond
)

// events сообщает страницам «Созвоны», что список изменился; данных в событии нет,
// поэтому поток отдаётся без токена — EventSource не умеет передавать заголовок Authorization.
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	controller := http.NewResponseController(w)
	// Поток живёт дольше WriteTimeout сервера.
	if err := controller.SetWriteDeadline(time.Time{}); err != nil {
		s.internalError(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	send := func(text string) bool {
		if _, err := fmt.Fprint(w, text); err != nil {
			return false
		}
		return controller.Flush() == nil
	}
	if !send("retry: 3000\n\n") {
		return
	}
	ping := time.NewTicker(eventsPing)
	defer ping.Stop()
	store := s.controller.Store()
	changes := store.Changes()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.done:
			return
		case <-ping.C:
			if !send(": ping\n\n") {
				return
			}
		case <-changes:
			select {
			case <-time.After(eventsCoalesce):
			case <-r.Context().Done():
				return
			case <-s.done:
				return
			}
			changes = store.Changes()
			if !send("event: sessions\ndata: {}\n\n") {
				return
			}
		}
	}
}

// Close отпускает потоки событий, иначе остановка сервера ждала бы их до таймаута.
func (s *Server) Close() {
	s.closeOnce.Do(func() { close(s.done) })
}
