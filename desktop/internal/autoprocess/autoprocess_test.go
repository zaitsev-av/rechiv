package autoprocess

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"rechiv/desktop/internal/domain"
	"rechiv/desktop/internal/llm"
	"rechiv/desktop/internal/secret"
	"rechiv/desktop/internal/store"
)

type files struct{ dir string }

func (f files) TranscriptPath(id string) string { return filepath.Join(f.dir, id+"-transcript.json") }
func (f files) SummaryPath(id string) string    { return filepath.Join(f.dir, id+"-summary.json") }
func (f files) WriteSummary(id string, summary any, onlyIfAbsent bool) (bool, error) {
	if _, err := os.Stat(f.SummaryPath(id)); onlyIfAbsent && err == nil {
		return false, nil
	}
	raw, _ := json.Marshal(summary)
	return true, os.WriteFile(f.SummaryPath(id), raw, 0o600)
}

type fakeLLM struct {
	summaryErr  error
	topicErr    error
	topicSource string
}

func (f *fakeLLM) Summary(context.Context, llm.Config, []byte) (llm.Summary, error) {
	return llm.Summary{Content: "# Итоги"}, f.summaryErr
}

func (f *fakeLLM) Topic(_ context.Context, _ llm.Config, source string) (string, error) {
	f.topicSource = source
	return "Планирование релиза", f.topicErr
}

type fixture struct {
	store     *store.Store
	files     files
	settings  *llm.Settings
	client    *fakeLLM
	processor *Processor
	folder    domain.Folder
}

func setup(t *testing.T, settings domain.FolderSettings) fixture {
	dir := t.TempDir()
	sessions, err := store.New(dir)
	require.NoError(t, err)
	folder, err := sessions.CreateFolder("Дейли")
	require.NoError(t, err)
	_, _, err = sessions.AddFolderRule(folder.ID, "https://telemost.yandex.ru/j/1")
	require.NoError(t, err)
	folder, err = sessions.SetFolderSettings(folder.ID, settings)
	require.NoError(t, err)
	llmSettings := llm.NewSettings(dir, secret.File{Path: filepath.Join(dir, "key")})
	key := "sk"
	_, err = llmSettings.Save("https://llm.example/v1", "m", &key)
	require.NoError(t, err)
	client := &fakeLLM{}
	f := files{dir}
	return fixture{sessions, f, llmSettings, client, New(context.Background(), sessions, f, llmSettings, client, log.New(io.Discard, "", 0)), folder}
}

func (f fixture) session(t *testing.T) *domain.Session {
	session, err := f.store.Create("https://telemost.yandex.ru/j/1")
	require.NoError(t, err)
	session, err = f.store.ApplyFolderRule(session.SessionID)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(f.files.TranscriptPath(session.SessionID), []byte(`{"segments":[]}`), 0o600))
	return session
}

func (f fixture) complete(t *testing.T, session *domain.Session) *domain.Session {
	pending := f.processor.Needed(session)
	require.NoError(t, f.store.Complete(session.SessionID, pending))
	if pending {
		f.processor.Start(session.SessionID)
		f.processor.Wait()
	}
	result, err := f.store.Get(session.SessionID)
	require.NoError(t, err)
	return result
}

func TestSummaryAndTopic(t *testing.T) {
	f := setup(t, domain.FolderSettings{AutoSummary: true, TitleTemplate: "Дейли — {topic}"})
	done := f.complete(t, f.session(t))

	assert.Equal(t, &domain.AutoProcessing{SummaryReady: true}, done.AutoProcessing)
	assert.Equal(t, "Планирование релиза", done.Topic)
	assert.Equal(t, "Дейли — Планирование релиза", done.Title)
	assert.Equal(t, "# Итоги", f.client.topicSource, "тема берётся из готового саммари")
}

func TestNotNeeded(t *testing.T) {
	f := setup(t, domain.FolderSettings{TitleTemplate: "Дейли {date}"})
	session := f.session(t)
	assert.False(t, f.processor.Needed(session))
	assert.Nil(t, f.complete(t, session).AutoProcessing)

	f = setup(t, domain.FolderSettings{AutoSummary: true})
	_, err := f.settings.Save("", "", nil)
	require.NoError(t, err)
	assert.False(t, f.processor.Needed(f.session(t)), "без LLM автообработки нет")
}

func TestKeepsUserSummary(t *testing.T) {
	f := setup(t, domain.FolderSettings{AutoSummary: true})
	session := f.session(t)
	require.NoError(t, os.WriteFile(f.files.SummaryPath(session.SessionID), []byte(`{"content":"моё"}`), 0o600))
	assert.False(t, f.processor.Needed(session))
}

func TestFailuresAreReported(t *testing.T) {
	f := setup(t, domain.FolderSettings{AutoSummary: true, TitleTemplate: "{topic}"})
	f.client.summaryErr = errors.New("Неверный API-токен")
	f.client.topicErr = errors.New("LLM вернул некорректную тему")
	done := f.complete(t, f.session(t))

	assert.Equal(t, &domain.AutoProcessing{SummaryFailed: true, TopicFailed: true}, done.AutoProcessing)
	assert.Equal(t, `{"segments":[]}`, f.client.topicSource, "без саммари тема — по транскрипту")
}

func TestResume(t *testing.T) {
	f := setup(t, domain.FolderSettings{AutoSummary: true})
	session := f.session(t)
	require.NoError(t, f.store.Complete(session.SessionID, true))

	f.processor.Resume()
	f.processor.Wait()
	done, err := f.store.Get(session.SessionID)
	require.NoError(t, err)
	assert.Equal(t, &domain.AutoProcessing{SummaryReady: true}, done.AutoProcessing)
}

func TestGenerateSummary(t *testing.T) {
	f := setup(t, domain.FolderSettings{})
	session := f.session(t)
	require.NoError(t, os.WriteFile(f.files.SummaryPath(session.SessionID), []byte(`{"content":"старое"}`), 0o600))

	started, err := f.processor.GenerateSummary(session.SessionID)
	require.NoError(t, err)
	assert.True(t, started)
	f.processor.Wait()

	raw, err := os.ReadFile(f.files.SummaryPath(session.SessionID))
	require.NoError(t, err)
	assert.JSONEq(t, `{"content":"# Итоги","createdAt":"","model":"","chunked":false}`, string(raw), "перегенерация заменяет саммари")
	done, err := f.store.Get(session.SessionID)
	require.NoError(t, err)
	assert.Nil(t, done.SummaryJob)

	f.client.summaryErr = errors.New("Неверный API-токен")
	_, err = f.processor.GenerateSummary(session.SessionID)
	require.NoError(t, err)
	f.processor.Wait()
	done, err = f.store.Get(session.SessionID)
	require.NoError(t, err)
	assert.Equal(t, &domain.SummaryJob{Error: "Неверный API-токен"}, done.SummaryJob)
}

func TestResumeSummary(t *testing.T) {
	f := setup(t, domain.FolderSettings{})
	session := f.session(t)
	require.NoError(t, f.store.SetSummaryJob(session.SessionID, &domain.SummaryJob{Running: true}))

	f.processor.Resume()
	f.processor.Wait()
	done, err := f.store.Get(session.SessionID)
	require.NoError(t, err)
	assert.Nil(t, done.SummaryJob, "прерванное выходом саммари доделывается")
	_, err = os.Stat(f.files.SummaryPath(session.SessionID))
	assert.NoError(t, err)
}
