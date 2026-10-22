// Package autoprocess делает саммари и тему созвона по настройкам папки, когда транскрипт готов.
package autoprocess

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"strings"
	"sync"

	"rechiv/desktop/internal/domain"
	"rechiv/desktop/internal/llm"
	"rechiv/desktop/internal/store"
)

type LLM interface {
	Summary(ctx context.Context, config llm.Config, transcript []byte) (llm.Summary, error)
	Topic(ctx context.Context, config llm.Config, source string) (string, error)
}

type Files interface {
	TranscriptPath(sessionID string) string
	SummaryPath(sessionID string) string
	WriteSummary(sessionID string, summary any, onlyIfAbsent bool) (bool, error)
}

type Processor struct {
	store    *store.Store
	files    Files
	settings *llm.Settings
	client   LLM
	logger   *log.Logger
	ctx      context.Context
	wg       sync.WaitGroup
	mu       sync.Mutex
	running  map[string]bool
}

func New(ctx context.Context, sessions *store.Store, files Files, settings *llm.Settings, client LLM, logger *log.Logger) *Processor {
	return &Processor{store: sessions, files: files, settings: settings, client: client, logger: logger, ctx: ctx, running: map[string]bool{}}
}

type plan struct {
	summary bool
	topic   bool
}

func (p *Processor) plan(session *domain.Session) plan {
	if session.FolderID == "" {
		return plan{}
	}
	config, err := p.settings.Load()
	if err != nil || !config.Configured() {
		return plan{}
	}
	var folder *domain.Folder
	for _, candidate := range p.store.Folders() {
		if candidate.ID == session.FolderID {
			folder = &candidate
			break
		}
	}
	if folder == nil {
		return plan{}
	}
	_, statErr := os.Stat(p.files.SummaryPath(session.SessionID))
	return plan{
		summary: folder.Settings.AutoSummary && errors.Is(statErr, os.ErrNotExist),
		topic:   strings.Contains(folder.Settings.TitleTemplate, "{topic}") && session.TitleAuto && strings.TrimSpace(session.Topic) == "",
	}
}

func (p *Processor) Needed(session *domain.Session) bool {
	work := p.plan(session)
	return work.summary || work.topic
}

func (p *Processor) Start(sessionID string) {
	p.wg.Go(func() { p.run(sessionID) })
}

// Resume продолжает автообработку и саммари по кнопке, прерванные выходом из приложения.
func (p *Processor) Resume() {
	for _, session := range p.store.List() {
		if session.AutoProcessing != nil && session.AutoProcessing.Pending {
			p.Start(session.SessionID)
		}
		if session.SummaryJob != nil && session.SummaryJob.Running {
			p.startSummary(session.SessionID)
		}
	}
}

// GenerateSummary запускает саммари по кнопке; false — оно уже идёт.
func (p *Processor) GenerateSummary(sessionID string) (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.running[sessionID] {
		return false, nil
	}
	if err := p.store.SetSummaryJob(sessionID, &domain.SummaryJob{Running: true}); err != nil {
		return false, err
	}
	p.startSummaryLocked(sessionID)
	return true, nil
}

func (p *Processor) startSummary(sessionID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.running[sessionID] {
		p.startSummaryLocked(sessionID)
	}
}

func (p *Processor) startSummaryLocked(sessionID string) {
	p.running[sessionID] = true
	p.wg.Go(func() {
		err := p.summary(sessionID)
		p.mu.Lock()
		delete(p.running, sessionID)
		p.mu.Unlock()
		if p.ctx.Err() != nil {
			return
		}
		var job *domain.SummaryJob
		if err != nil {
			p.logger.Printf("summary %s: %v", sessionID, err)
			job = &domain.SummaryJob{Error: err.Error()}
		}
		if err := p.store.SetSummaryJob(sessionID, job); err != nil {
			p.logger.Printf("summary %s: %v", sessionID, err)
		}
	})
}

func (p *Processor) summary(sessionID string) error {
	config, err := p.settings.Load()
	if err != nil {
		return err
	}
	if !config.Configured() {
		return errors.New("LLM не подключён: укажите его в настройках Rechiv")
	}
	transcript, err := os.ReadFile(p.files.TranscriptPath(sessionID))
	if err != nil {
		return err
	}
	summary, err := p.client.Summary(p.ctx, config, transcript)
	if err != nil {
		return err
	}
	_, err = p.files.WriteSummary(sessionID, summary, false)
	return err
}

func (p *Processor) Wait() {
	p.wg.Wait()
}

func (p *Processor) run(sessionID string) {
	result := domain.AutoProcessing{}
	defer func() {
		// Выход из приложения — не ошибка: pending останется, и Resume доделает при следующем запуске.
		if p.ctx.Err() != nil {
			return
		}
		if err := p.store.SetAutoProcessing(sessionID, result); err != nil {
			p.logger.Printf("autoprocess %s: %v", sessionID, err)
		}
	}()
	session, err := p.store.Get(sessionID)
	if err != nil {
		return
	}
	work := p.plan(session)
	config, err := p.settings.Load()
	if err != nil {
		p.logger.Printf("autoprocess %s: llm settings: %v", sessionID, err)
		result.SummaryFailed, result.TopicFailed = work.summary, work.topic
		return
	}
	transcript, err := os.ReadFile(p.files.TranscriptPath(sessionID))
	if err != nil {
		p.logger.Printf("autoprocess %s: transcript: %v", sessionID, err)
		result.SummaryFailed, result.TopicFailed = work.summary, work.topic
		return
	}

	var summaryText string
	if work.summary {
		summary, err := p.client.Summary(p.ctx, config, transcript)
		if err == nil {
			// За время генерации пользователь мог сохранить свою версию — её не трогаем.
			_, err = p.files.WriteSummary(sessionID, summary, true)
		}
		if err != nil {
			p.logger.Printf("autoprocess %s: summary: %v", sessionID, err)
			result.SummaryFailed = true
		} else {
			result.SummaryReady = true
		}
	}
	if raw, err := os.ReadFile(p.files.SummaryPath(sessionID)); err == nil {
		var saved struct {
			Content string `json:"content"`
		}
		if json.Unmarshal(raw, &saved) == nil {
			summaryText = saved.Content
		}
	}

	if work.topic {
		source := summaryText
		if source == "" {
			source = string(transcript)
		}
		topic, err := p.client.Topic(p.ctx, config, source)
		if err == nil {
			latest, getErr := p.store.Get(sessionID)
			if getErr == nil && latest.TitleAuto && strings.TrimSpace(latest.Topic) == "" && latest.FolderID == session.FolderID {
				_, err = p.store.SetTopic(sessionID, topic)
			} else {
				err = getErr
			}
		}
		if err != nil {
			p.logger.Printf("autoprocess %s: topic: %v", sessionID, err)
			result.TopicFailed = true
		}
	}
}
