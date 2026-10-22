package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"rechiv/desktop/internal/controller"
)

type appearance struct {
	Theme   string `json:"theme"`
	Palette string `json:"palette"`
}

func (s *Server) appearancePath() string {
	return filepath.Join(filepath.Dir(s.controller.Store().SessionsDir()), "appearance.json")
}

func (s *Server) readAppearance() (appearance, error) {
	var value appearance
	err := controller.ReadJSON(s.appearancePath(), &value)
	if os.IsNotExist(err) {
		return appearance{}, nil
	}
	return value, err
}

func (s *Server) getAppearance(w http.ResponseWriter, _ *http.Request) {
	s.appearanceMu.Lock()
	defer s.appearanceMu.Unlock()
	value, err := s.readAppearance()
	if err != nil {
		s.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, value)
}

func (s *Server) putAppearance(w http.ResponseWriter, r *http.Request) {
	var value appearance
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		writeError(w, http.StatusBadRequest, "Некорректный JSON")
		return
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "Ожидается один объект JSON")
		return
	}
	if (value.Theme != "light" && value.Theme != "dark") ||
		(value.Palette != "graphite" && value.Palette != "stone" && value.Palette != "amber") {
		writeError(w, http.StatusUnprocessableEntity, "Недопустимая тема или палитра")
		return
	}
	s.appearanceMu.Lock()
	defer s.appearanceMu.Unlock()
	if err := controller.WriteJSON(s.appearancePath(), value); err != nil {
		s.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, value)
}
