package controller

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"rechiv/desktop/internal/domain"
	"rechiv/desktop/internal/engine"
	"rechiv/desktop/internal/store"
)

const MaxQueueDepth = 64

const initialQueueCapacity = 10

// ErrQueueBusy очередь переполнена, клиенту стоит повторить позже
var ErrQueueBusy = errors.New("transcription queue is full")

type Controller struct {
	store     *store.Store
	engine    engine.Engine
	converter AudioConverter
	logger    *log.Logger

	now         func() time.Time
	retentionMu sync.Mutex

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	queueMu   sync.Mutex
	queueCond *sync.Cond
	queued    []*Job
	closed    bool

	jobsMu    sync.Mutex
	jobsCache map[string]map[string]*Job

	engineMu     sync.RWMutex
	engineState  EngineState
	engineDetail string
	warmingUp    bool
	warmedUp     bool

	mu         sync.Mutex
	pending    map[string]int
	finishing  map[string]bool
	finalizing map[string]bool

	KeepAudio bool
}

type EngineState string

const (
	EngineStarting EngineState = "starting"
	EngineReady    EngineState = "ready"
	EngineFailed   EngineState = "error"
)

const engineProbeTimeout = 3 * time.Minute

const engineWarmupTimeout = 20 * time.Minute

const liveCatchUpThreshold = 2

func New(sessionStore *store.Store, inference engine.Engine, converter AudioConverter, logger *log.Logger) *Controller {
	if logger == nil {
		logger = log.Default()
	}

	ctx, cancel := context.WithCancel(context.Background())
	controller := &Controller{
		now:    time.Now,
		ctx:    ctx,
		cancel: cancel,
		logger: logger,

		store:     sessionStore,
		engine:    inference,
		converter: converter,

		queued:     make([]*Job, 0, initialQueueCapacity),
		jobsCache:  make(map[string]map[string]*Job),
		pending:    make(map[string]int),
		finishing:  make(map[string]bool),
		finalizing: make(map[string]bool),
	}
	controller.queueCond = sync.NewCond(&controller.queueMu)
	return controller
}

func (c *Controller) Start() error {
	c.engineState = EngineStarting
	c.RunRetention("")
	c.wg.Go(func() {
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		c.retentionLoop(ticker.C)
	})

	c.wg.Add(1)
	go c.workerLoop()

	c.wg.Add(1)
	go c.probeEngine()

	return c.recoverJobs()
}

func (c *Controller) probeEngine() {
	defer c.wg.Done()
	ctx, cancel := context.WithTimeout(c.ctx, engineProbeTimeout)
	defer cancel()

	err := c.engine.Ping(ctx)
	if c.ctx.Err() != nil {
		return
	}

	c.engineMu.Lock()
	defer c.engineMu.Unlock()

	if err != nil {
		c.engineState = EngineFailed
		c.engineDetail = err.Error()
		c.logger.Printf("engine is not ready: %v", err)
		return
	}

	c.engineState = EngineReady
	c.engineDetail = ""
	c.logger.Printf("Engine worker is ready")
}

func (c *Controller) EngineStatus() (EngineState, string) {
	c.engineMu.RLock()
	defer c.engineMu.RUnlock()

	return c.engineState, c.engineDetail
}

func (c *Controller) Close() error {
	c.cancel()
	c.queueMu.Lock()
	c.closed = true
	c.queueMu.Unlock()
	c.queueCond.Broadcast()
	c.wg.Wait()

	return c.engine.Close()
}

func (c *Controller) Store() *store.Store {
	return c.store
}

func (c *Controller) CreateSession(callURL string) (*domain.Session, error) {
	session, err := c.store.Create(callURL)
	if err != nil {
		return nil, err
	}
	session, err = c.store.ApplyFolderRule(session.SessionID)
	if err != nil {
		return nil, err
	}
	// Прогрев во время записи избавляет первый фрагмент от ожидания загрузки модели
	c.warmUpEngine()

	return session, nil
}

func (c *Controller) warmUpEngine() {
	c.engineMu.Lock()
	if c.warmingUp || c.warmedUp {
		c.engineMu.Unlock()
		return
	}

	c.warmingUp = true
	c.engineMu.Unlock()

	c.wg.Go(func() {
		ctx, cancel := context.WithTimeout(c.ctx, engineWarmupTimeout)
		defer cancel()

		err := c.engine.Warmup(ctx)

		c.engineMu.Lock()
		c.warmingUp = false
		c.warmedUp = err == nil
		c.engineMu.Unlock()

		switch {
		case c.ctx.Err() != nil:
			return
		case err != nil:
			c.logger.Printf("engine warmup failed: %v", err)
		default:
			c.logger.Printf("Engine model is ready")
		}
	})
}

func (c *Controller) DeleteSession(sessionID string) error {
	if err := c.store.Delete(sessionID); err != nil {
		return err
	}

	c.forgetJobs(sessionID)

	return nil
}

func (c *Controller) UploadChunk(ctx context.Context, sessionID, speakerID, attributedTo string, offset float64, source io.Reader) (int, error) {
	if c.QueueDepth() >= MaxQueueDepth {
		return 0, ErrQueueBusy
	}

	index, err := c.store.ReserveChunk(sessionID, speakerID)
	if err != nil {
		return 0, err
	}

	base := chunkBaseName(speakerID, index)
	sessionDir := c.store.SessionDir(sessionID)
	webmPath := filepath.Join(sessionDir, "chunks", base+".webm")
	wavPath := filepath.Join(sessionDir, "chunks", base+".wav")
	jobPath := filepath.Join(sessionDir, "jobs", base+".json")

	file, err := os.OpenFile(webmPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		_ = c.store.CancelChunk(sessionID, speakerID, index)
		return 0, err
	}

	written, copyErr := io.Copy(file, io.LimitReader(source, 32*1024*1024+1))
	closeErr := file.Close()

	if copyErr != nil {
		_ = c.store.CancelChunk(sessionID, speakerID, index)
		_ = os.Remove(webmPath)
		return 0, copyErr
	}

	if closeErr != nil {
		_ = c.store.CancelChunk(sessionID, speakerID, index)
		_ = os.Remove(webmPath)
		return 0, closeErr
	}

	if written > 32*1024*1024 {
		_ = c.store.CancelChunk(sessionID, speakerID, index)
		_ = os.Remove(webmPath)
		return 0, fmt.Errorf("audio chunk exceeds 32 MB")
	}

	convertStarted := time.Now()
	duration, err := c.converter.Convert(ctx, webmPath, wavPath)
	if err != nil {
		_ = c.store.CancelChunk(sessionID, speakerID, index)
		_ = os.Remove(webmPath)
		_ = os.Remove(wavPath)
		return 0, err
	}

	c.logTiming("convert", sessionID, speakerID, index, duration, time.Since(convertStarted), -1)
	job := &Job{
		SessionID:    sessionID,
		SpeakerID:    speakerID,
		AttributedTo: attributedTo,
		ChunkIndex:   index,
		Offset:       offset,
		Duration:     duration,
		WebMPath:     webmPath,
		WAVPath:      wavPath,
		Status:       JobQueued,
		MetadataPath: jobPath,
	}
	if err := c.saveJob(job); err != nil {
		_ = c.store.CancelChunk(sessionID, speakerID, index)
		_ = os.Remove(webmPath)
		_ = os.Remove(wavPath)
		return 0, err
	}

	c.enqueueLive(job)

	return index, nil
}

func (c *Controller) FinishSession(sessionID string) error {
	if _, err := c.store.Get(sessionID); err != nil {
		return err
	}

	if err := c.store.SetStatus(sessionID, domain.StatusProcessing, ""); err != nil {
		return err
	}

	c.mu.Lock()
	c.finishing[sessionID] = true
	ready := c.pending[sessionID] == 0
	c.mu.Unlock()
	if ready {
		c.startFinalize(sessionID)
	}

	return nil
}

func (c *Controller) RetryFailed(sessionID string) error {
	session, err := c.store.Get(sessionID)
	if err != nil {
		return err
	}

	if session.Status != domain.StatusError {
		return fmt.Errorf("session is not in error state")
	}

	jobs, err := c.loadJobs(sessionID)
	if err != nil {
		return err
	}

	retried := 0
	for _, job := range jobs {
		if job.Status != JobError || job.WAVPath == "" {
			continue
		}
		job.Status = JobQueued
		job.Attempts = 0
		job.Error = ""
		job.Segments = nil
		if err := c.saveJob(job); err != nil {
			return err
		}
		c.enqueue(job)
		retried++
	}

	if retried == 0 {
		return fmt.Errorf("no retryable chunks")
	}

	if err := c.store.SetStatus(sessionID, domain.StatusProcessing, ""); err != nil {
		return err
	}

	c.mu.Lock()
	c.finishing[sessionID] = true
	c.mu.Unlock()

	return nil
}

func (c *Controller) TranscriptPath(sessionID string) string {
	return filepath.Join(c.store.SessionDir(sessionID), "result.json")
}

func (c *Controller) SummaryPath(sessionID string) string {
	return filepath.Join(c.store.SessionDir(sessionID), "summary.json")
}

// Transcript подставляет текущие имена из метаданных сессии:
// в result.json они зафиксированы на момент финализации
func (c *Controller) Transcript(sessionID string) (domain.Transcript, error) {
	session, err := c.store.Get(sessionID)
	if err != nil {
		return domain.Transcript{}, err
	}
	var transcript domain.Transcript
	if err := ReadJSON(c.TranscriptPath(sessionID), &transcript); err != nil {
		return domain.Transcript{}, err
	}
	timeline, err := c.readVADTimeline(sessionID)
	if err != nil {
		return domain.Transcript{}, err
	}
	domain.ApplySpeakerNames(session, timeline, &transcript)
	return transcript, nil
}

func (c *Controller) LiveTranscript(sessionID string) (*domain.LiveTranscript, error) {
	session, err := c.store.Get(sessionID)
	if err != nil {
		return nil, err
	}

	isFinal := session.Status == domain.StatusCompleted || session.Status == domain.StatusError
	var transcript domain.Transcript
	if isFinal {
		if err := ReadJSON(c.TranscriptPath(sessionID), &transcript); err == nil {
			timeline, timelineErr := c.readVADTimeline(sessionID)
			if timelineErr != nil {
				return nil, timelineErr
			}
			domain.ApplySpeakerNames(session, timeline, &transcript)
			return &domain.LiveTranscript{
				Transcript:      transcript,
				Status:          session.Status,
				IsFinal:         true,
				ProcessedChunks: session.ProcessedChunks,
				TotalChunks:     session.ChunksCount,
			}, nil
		}
	}

	jobs, err := c.loadJobs(sessionID)
	if err != nil {
		return nil, err
	}
	transcript, _ = buildTranscript(session, jobs, nil)
	return &domain.LiveTranscript{
		Transcript:      transcript,
		Status:          session.Status,
		IsFinal:         isFinal,
		ProcessedChunks: session.ProcessedChunks,
		TotalChunks:     session.ChunksCount,
	}, nil
}

func (c *Controller) enqueueLive(job *Job) {
	job.Live = true
	c.enqueue(job)
}

func (c *Controller) enqueue(job *Job) {
	c.mu.Lock()
	c.pending[job.SessionID]++
	c.mu.Unlock()

	c.queueMu.Lock()
	c.queued = append(c.queued, job)
	c.queueMu.Unlock()
	c.queueCond.Signal()
}

func (c *Controller) QueueDepth() int {
	c.queueMu.Lock()
	defer c.queueMu.Unlock()

	return len(c.queued)
}

func (c *Controller) dequeue() (*Job, bool) {
	c.queueMu.Lock()
	defer c.queueMu.Unlock()
	for len(c.queued) == 0 && !c.closed {
		c.queueCond.Wait()
	}
	if c.closed {
		return nil, false
	}
	index := c.nextIndexLocked()
	job := c.queued[index]
	last := len(c.queued) - 1
	copy(c.queued[index:], c.queued[index+1:])
	c.queued[last] = nil
	c.queued = c.queued[:last]

	return job, true
}

func (c *Controller) nextIndexLocked() int {
	if len(c.queued) <= liveCatchUpThreshold {
		return 0
	}
	freshest := -1
	for index, job := range c.queued {
		if !job.Live {
			continue
		}
		if freshest == -1 || job.Offset > c.queued[freshest].Offset {
			freshest = index
		}
	}
	if freshest == -1 {
		return 0
	}
	return freshest
}

func (c *Controller) workerLoop() {
	defer c.wg.Done()
	for {
		job, ok := c.dequeue()
		if !ok {
			return
		}
		c.processJob(job)
	}
}

func (c *Controller) logTiming(
	stage, sessionID, speakerID string,
	chunkIndex int,
	audioSeconds float64,
	elapsed time.Duration,
	queueDepth int,
) {
	speed := 0.0
	if elapsed > 0 {
		speed = audioSeconds / elapsed.Seconds()
	}
	queue := ""
	if queueDepth >= 0 {
		queue = fmt.Sprintf(" queue=%d", queueDepth)
	}
	c.logger.Printf(
		"timing stage=%s chunk=%s/%s/%d audio=%.1fs wall=%.2fs speed=%.1fx%s",
		stage, sessionID, speakerID, chunkIndex, audioSeconds, elapsed.Seconds(), speed, queue,
	)
}

func (c *Controller) processJob(job *Job) {
	job.Status = JobProcessing
	job.Attempts++
	job.Error = ""
	_ = c.saveJob(job)

	ctx, cancel := context.WithTimeout(c.ctx, 15*time.Minute)
	started := time.Now()
	segments, err := c.engine.Transcribe(ctx, job.WAVPath)
	elapsed := time.Since(started)
	cancel()

	if err == nil {
		c.logTiming("inference", job.SessionID, job.SpeakerID, job.ChunkIndex, job.Duration, elapsed, c.QueueDepth())
	}

	if c.ctx.Err() != nil {
		job.Status = JobQueued
		job.Error = ""
		_ = c.saveJob(job)
		c.finishPendingJob(job.SessionID, false)
		return
	}

	if err != nil && job.Attempts < 2 && c.ctx.Err() == nil {
		c.logger.Printf("retrying chunk %s/%s/%d: %v", job.SessionID, job.SpeakerID, job.ChunkIndex, err)
		job.Status = JobQueued
		job.Error = err.Error()
		_ = c.saveJob(job)
		time.Sleep(250 * time.Millisecond)
		c.processJob(job)
		return
	}

	if err != nil {
		job.Status = JobError
		job.Error = err.Error()
		job.Segments = nil
	} else {
		job.Status = JobCompleted
		job.Error = ""
		job.Segments = make([]JobSegment, 0, len(segments))
		for _, segment := range segments {
			job.Segments = append(job.Segments, JobSegment{
				Text:  segment.Text,
				Start: segment.Start,
				End:   segment.End,
			})
		}
	}

	if writeErr := c.saveJob(job); writeErr != nil {
		c.logger.Printf("save job result: %v", writeErr)
	}

	if progressErr := c.reconcileProgress(job.SessionID); progressErr != nil {
		c.logger.Printf("reconcile progress: %v", progressErr)
	}

	c.finishPendingJob(job.SessionID, true)
}

func (c *Controller) finishPendingJob(sessionID string, allowFinalize bool) {
	c.mu.Lock()
	c.pending[sessionID]--
	ready := allowFinalize && c.pending[sessionID] == 0 && c.finishing[sessionID]
	c.mu.Unlock()
	if ready {
		c.startFinalize(sessionID)
	}
}

func (c *Controller) startFinalize(sessionID string) {
	c.mu.Lock()
	if c.finalizing[sessionID] {
		c.mu.Unlock()
		return
	}
	c.finalizing[sessionID] = true
	c.mu.Unlock()

	c.wg.Go(func() {
		defer func() {
			c.mu.Lock()
			delete(c.finalizing, sessionID)
			delete(c.finishing, sessionID)
			c.mu.Unlock()
		}()
		if err := c.finalize(sessionID); err != nil {
			c.logger.Printf("finalize session %s: %v", sessionID, err)
			_ = c.store.SetStatus(sessionID, domain.StatusError, err.Error())
		}
	})
}

func (c *Controller) finalize(sessionID string) error {
	session, err := c.store.Get(sessionID)
	if err != nil {
		return err
	}
	jobs, err := c.loadJobs(sessionID)
	if err != nil {
		return err
	}

	timeline, err := c.readVADTimeline(sessionID)
	if err != nil {
		return err
	}
	if timeline == nil {
		c.logger.Printf("finalize %s: разметка речи не приехала, спикеры остаются по потокам", sessionID)
	} else {
		c.logger.Printf(
			"finalize %s: разметка речи на %d участников, %d событий, %d состояний микрофонов",
			sessionID, len(timeline.Participants), len(timeline.Events), len(timeline.MicEvents),
		)
	}
	transcript, failed := buildTranscript(session, jobs, timeline)
	transcript.Segments = mergeSegments(transcript.Segments, transcript.Participants)
	if err := writeJSONAtomic(c.TranscriptPath(sessionID), transcript); err != nil {
		return err
	}

	defer c.forgetJobs(sessionID)
	if failed > 0 {
		return c.store.SetStatus(
			sessionID,
			domain.StatusError,
			fmt.Sprintf("Не удалось распознать фрагментов: %d", failed),
		)
	}

	if err := c.store.SetStatus(sessionID, domain.StatusCompleted, ""); err != nil {
		return err
	}

	if !c.KeepAudio {
		for _, job := range jobs {
			_ = os.Remove(job.WebMPath)
			_ = os.Remove(job.WAVPath)
		}
	}

	return nil
}

func liveSpeaker(job *Job, fallback string, speakerNames map[string]string) string {
	if job.AttributedTo == "" {
		return fallback
	}

	if _, known := speakerNames[job.AttributedTo]; !known {
		return fallback
	}

	return job.AttributedTo
}

func buildTranscript(
	session *domain.Session,
	jobs []*Job,
	timeline *VADTimeline,
) (domain.Transcript, int) {
	var speakerNames map[string]string
	var participants []*domain.Participant
	if timeline == nil {
		speakerNames, participants = domain.ResolveSpeakers(session)
	} else {
		speakerNames, participants = domain.ResolveVADSpeakers(session, timeline, false)
	}

	segments := make([]domain.Segment, 0)
	duration := 0.0
	failed := 0
	unknownUsed := false
	for _, job := range jobs {
		jobEnd := job.Offset + job.Duration
		if jobEnd > duration {
			duration = jobEnd
		}
		if job.Status != JobCompleted && job.Status != JobError {
			continue
		}
		if job.Status == JobError {
			failed++
			speakerID := job.SpeakerID
			if timeline != nil && speakerID != "local" {
				speakerID = UnknownSpeakerID
				unknownUsed = true
			}
			segments = append(segments, domain.Segment{
				Speaker:   speakerNames[speakerID],
				SpeakerID: speakerID,
				Start:     formatDuration(job.Offset),
				End:       formatDuration(jobEnd),
				Text:      "",
				Error:     true,
				StartSec:  job.Offset,
				EndSec:    jobEnd,
			})
			continue
		}
		for _, item := range job.Segments {
			start := job.Offset + item.Start
			end := job.Offset + item.End
			speakerID := job.SpeakerID
			if timeline != nil && speakerID != "local" {
				if attributed, ok := attributeVADSpeaker(start, end, timeline, speakerNames); ok {
					speakerID = attributed
				} else {
					speakerID = UnknownSpeakerID
					unknownUsed = true
				}
			} else if timeline == nil && speakerID != "local" {
				speakerID = liveSpeaker(job, speakerID, speakerNames)
			}
			if end > duration {
				duration = end
			}
			segments = append(segments, domain.Segment{
				Speaker:   speakerNames[speakerID],
				SpeakerID: speakerID,
				Start:     formatDuration(start),
				End:       formatDuration(end),
				Text:      item.Text,
				StartSec:  start,
				EndSec:    end,
			})
		}
	}
	if unknownUsed {
		speakerNames[UnknownSpeakerID] = UnknownSpeakerName
		participants = append(participants, &domain.Participant{
			SpeakerID: UnknownSpeakerID,
			Name:      UnknownSpeakerName,
		})
		for index := range segments {
			if segments[index].SpeakerID == UnknownSpeakerID {
				segments[index].Speaker = UnknownSpeakerName
			}
		}
	}
	if session.Status == domain.StatusRecording {
		elapsed := time.Since(session.CreatedAt).Seconds()
		if elapsed > duration {
			duration = elapsed
		}
	}
	sort.SliceStable(segments, func(i, j int) bool {
		return segments[i].StartSec < segments[j].StartSec
	})

	transcript := domain.Transcript{
		SessionID:        session.SessionID,
		Date:             session.CreatedAt.Format("2006-01-02"),
		CallURL:          session.CallURL,
		RecordingStarted: session.CreatedAt.Format(time.RFC3339Nano),
		Duration:         formatDuration(duration),
		Participants:     participants,
		Segments:         segments,
	}

	return transcript, failed
}

func (c *Controller) recoverJobs() error {
	for _, session := range c.store.List() {
		jobs, err := c.loadJobs(session.SessionID)
		if err != nil {
			return err
		}
		for _, job := range jobs {
			if job.Status == JobQueued || job.Status == JobProcessing {
				job.Status = JobQueued
				if err := c.saveJob(job); err != nil {
					return err
				}
				c.enqueue(job)
			}
		}
		if err := c.reconcileProgress(session.SessionID); err != nil {
			return err
		}
		if session.Status == domain.StatusCompleted || session.Status == domain.StatusError {
			c.forgetJobs(session.SessionID)
		}
		if session.Status == domain.StatusProcessing {
			c.mu.Lock()
			c.finishing[session.SessionID] = true
			ready := c.pending[session.SessionID] == 0
			c.mu.Unlock()
			if ready {
				c.startFinalize(session.SessionID)
			}
		}
	}

	return nil
}

func (c *Controller) saveJob(job *Job) error {
	if err := writeJob(job); err != nil {
		return err
	}
	c.jobsMu.Lock()
	defer c.jobsMu.Unlock()
	if cached, ok := c.jobsCache[job.SessionID]; ok {
		cached[job.MetadataPath] = copyJob(job)
	}

	return nil
}

func (c *Controller) forgetJobs(sessionID string) {
	c.jobsMu.Lock()
	defer c.jobsMu.Unlock()
	delete(c.jobsCache, sessionID)
}

func (c *Controller) loadJobs(sessionID string) ([]*Job, error) {
	c.jobsMu.Lock()
	defer c.jobsMu.Unlock()

	cached, err := c.cachedJobsLocked(sessionID)
	if err != nil {
		return nil, err
	}

	jobs := make([]*Job, 0, len(cached))
	for _, job := range cached {
		jobs = append(jobs, copyJob(job))
	}

	sort.Slice(jobs, func(i, j int) bool {
		if jobs[i].Offset == jobs[j].Offset {
			return jobs[i].ChunkIndex < jobs[j].ChunkIndex
		}
		return jobs[i].Offset < jobs[j].Offset
	})

	return jobs, nil
}

func (c *Controller) cachedJobsLocked(sessionID string) (map[string]*Job, error) {
	if cached, ok := c.jobsCache[sessionID]; ok {
		return cached, nil
	}

	paths, err := filepath.Glob(filepath.Join(c.store.SessionDir(sessionID), "jobs", "*.json"))
	if err != nil {
		return nil, err
	}

	cached := make(map[string]*Job, len(paths))
	for _, path := range paths {
		job, err := readJob(path)
		if err != nil {
			return nil, fmt.Errorf("read job %s: %w", path, err)
		}
		cached[path] = job
	}

	c.jobsCache[sessionID] = cached

	return cached, nil
}

func (c *Controller) reconcileProgress(sessionID string) error {
	c.jobsMu.Lock()
	cached, err := c.cachedJobsLocked(sessionID)
	if err != nil {
		c.jobsMu.Unlock()
		return err
	}

	processed := 0
	failed := 0
	for _, job := range cached {
		if job.Status == JobCompleted || job.Status == JobError {
			processed++
		}
		if job.Status == JobError {
			failed++
		}
	}

	c.jobsMu.Unlock()

	return c.store.SetProgress(sessionID, processed, failed)
}

func copyJob(job *Job) *Job {
	clone := *job
	if job.Segments != nil {
		clone.Segments = append([]JobSegment(nil), job.Segments...)
	}

	return &clone
}

func chunkBaseName(speakerID string, index int) string {
	hash := sha256.Sum256([]byte(speakerID))

	return fmt.Sprintf("%s-%04d", hex.EncodeToString(hash[:6]), index)
}

func formatDuration(seconds float64) string {
	if seconds < 0 {
		seconds = 0
	}

	total := int(seconds)

	return fmt.Sprintf("%02d:%02d:%02d", total/3600, (total%3600)/60, total%60)
}

func writeJSONAtomic(path string, value any) error {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}

	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}

	return os.Rename(tmp, path)
}

func ReadJSON(path string, target any) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}

	return json.Unmarshal(raw, target)
}

func WriteJSON(path string, value any) error {
	return writeJSONAtomic(path, value)
}

func IsNotFound(err error) bool {
	return errors.Is(err, store.ErrNotFound) || errors.Is(err, os.ErrNotExist)
}
