package api

import (
	"errors"
	"net/http"
	"strconv"

	"rechiv/desktop/internal/domain"
	"rechiv/desktop/internal/store"
)

func (s *Server) folderError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrInvalid) {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	s.storeError(w, err)
}

func folderBody(w http.ResponseWriter, r *http.Request, body any) bool {
	if err := decodeJSON(r, body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return false
	}
	return true
}

func (s *Server) listFolders(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.controller.Store().Folders())
}

func (s *Server) createFolder(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if !folderBody(w, r, &body) {
		return
	}
	f, err := s.controller.Store().CreateFolder(body.Name)
	if err != nil {
		s.folderError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, f)
}

func (s *Server) renameFolder(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if !folderBody(w, r, &body) {
		return
	}
	f, err := s.controller.Store().RenameFolder(r.PathValue("id"), body.Name)
	if err != nil {
		s.folderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, f)
}

func (s *Server) deleteFolder(w http.ResponseWriter, r *http.Request) {
	if err := s.controller.Store().DeleteFolder(r.PathValue("id")); err != nil {
		s.folderError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) addFolderRule(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL string `json:"url"`
	}
	if !folderBody(w, r, &body) {
		return
	}
	f, matching, err := s.controller.Store().AddFolderRule(r.PathValue("id"), body.URL)
	if err != nil {
		s.folderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"folder": f, "matching": matching})
}

func (s *Server) deleteFolderRule(w http.ResponseWriter, r *http.Request) {
	if err := s.controller.Store().DeleteFolderRule(r.PathValue("id"), r.URL.Query().Get("url")); err != nil {
		s.folderError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) moveSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		FolderID string `json:"folderId"`
	}
	if !folderBody(w, r, &body) {
		return
	}
	st := s.controller.Store()
	if err := st.MoveSessions([]string{r.PathValue("id")}, body.FolderID, false); err != nil {
		s.folderError(w, err)
		return
	}
	session, err := st.Get(r.PathValue("id"))
	if err != nil {
		s.folderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.sessionView(session))
}

func (s *Server) moveFolderSessions(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SessionIDs []string `json:"sessionIds"`
		ByRule     bool     `json:"byRule"`
	}
	if !folderBody(w, r, &body) {
		return
	}
	st := s.controller.Store()
	found := false
	for _, f := range st.Folders() {
		if f.ID == r.PathValue("id") {
			found = true
		}
	}
	if !found {
		s.folderError(w, store.ErrNotFound)
		return
	}
	if err := st.MoveSessions(body.SessionIDs, r.PathValue("id"), body.ByRule); err != nil {
		s.folderError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) setFolderSettings(w http.ResponseWriter, r *http.Request) {
	var settings domain.FolderSettings
	if !folderBody(w, r, &settings) {
		return
	}
	folder, err := s.controller.SetFolderSettings(r.PathValue("id"), settings)
	if err != nil {
		s.folderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, folder)
}

func (s *Server) previewFolderTitles(w http.ResponseWriter, r *http.Request) {
	result, err := s.controller.Store().PreviewFolderTitles(r.PathValue("id"))
	if err != nil {
		s.folderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) applyFolderTitles(w http.ResponseWriter, r *http.Request) {
	count, err := s.controller.Store().ApplyFolderTitles(r.PathValue("id"))
	if err != nil {
		s.folderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"renamed": count})
}

func (s *Server) previewFolderRetention(w http.ResponseWriter, r *http.Request) {
	days, err := strconv.Atoi(r.URL.Query().Get("days"))
	if err != nil {
		s.folderError(w, store.ErrInvalid)
		return
	}
	sessions, err := s.controller.PreviewFolderRetention(r.PathValue("id"), days)
	if err != nil {
		s.folderError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": sessions})
}
