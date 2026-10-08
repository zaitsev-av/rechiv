package store

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"rechiv/desktop/internal/domain"
)

func TestStorePersistsSessionAndProgress(t *testing.T) {
	dataDir := t.TempDir()
	first, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	session, err := first.Create("https://stream.wb.ru/room/test")
	if err != nil {
		t.Fatal(err)
	}
	if session.UploadToken == "" {
		t.Fatal("upload token was not generated")
	}
	if _, err := first.ReserveChunk(session.SessionID, "speaker-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := first.UpdateSpeaker(session.SessionID, "speaker-1", "Анна"); err != nil {
		t.Fatal(err)
	}
	if err := first.SetProgress(session.SessionID, 1, 0); err != nil {
		t.Fatal(err)
	}
	if err := first.SetStatus(session.SessionID, domain.StatusProcessing, ""); err != nil {
		t.Fatal(err)
	}

	second, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := second.Get(session.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Status != domain.StatusProcessing {
		t.Fatalf("status = %q", restored.Status)
	}
	if restored.ChunksCount != 1 || restored.ProcessedChunks != 1 {
		t.Fatalf("unexpected progress: %+v", restored)
	}
	if got := restored.Participants["speaker-1"].Name; got != "Анна" {
		t.Fatalf("speaker name = %q", got)
	}
}

func TestSetProgressSkipsUnchangedSession(t *testing.T) {
	sessionStore, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	session, err := sessionStore.Create("https://telemost.yandex.ru/j/test")
	if err != nil {
		t.Fatal(err)
	}
	if err := sessionStore.SetProgress(session.SessionID, 2, 1); err != nil {
		t.Fatal(err)
	}
	meta := filepath.Join(sessionStore.SessionDir(session.SessionID), "meta.json")
	past := time.Now().Add(-time.Hour).Truncate(time.Second)
	if err := os.Chtimes(meta, past, past); err != nil {
		t.Fatal(err)
	}

	if err := sessionStore.SetProgress(session.SessionID, 2, 1); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(meta)
	if err != nil {
		t.Fatal(err)
	}
	if !info.ModTime().Equal(past) {
		t.Fatalf("meta.json rewritten: mtime %v, want %v", info.ModTime(), past)
	}
}

func TestDeleteUnknownSession(t *testing.T) {
	sessionStore, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := sessionStore.Delete("missing"); err != ErrNotFound {
		t.Fatalf("got %v, want ErrNotFound", err)
	}
}

func TestCancelChunkRollsBackReservation(t *testing.T) {
	sessionStore, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	session, err := sessionStore.Create("https://stream.wb.ru/room/test")
	if err != nil {
		t.Fatal(err)
	}
	index, err := sessionStore.ReserveChunk(session.SessionID, "local")
	if err != nil {
		t.Fatal(err)
	}
	if err := sessionStore.CancelChunk(session.SessionID, "local", index); err != nil {
		t.Fatal(err)
	}
	next, err := sessionStore.ReserveChunk(session.SessionID, "local")
	if err != nil {
		t.Fatal(err)
	}
	if next != index {
		t.Fatalf("next index = %d, want %d", next, index)
	}
	restored, err := sessionStore.Get(session.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if restored.ChunksCount != 1 {
		t.Fatalf("chunks count = %d", restored.ChunksCount)
	}
}
