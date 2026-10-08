package engine

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os/exec"
	"strings"
	"sync"
	"time"
)

type processRequest struct {
	ID        string `json:"id"`
	Action    string `json:"action"`
	AudioPath string `json:"audioPath"`
}

type processResponse struct {
	ID       string    `json:"id"`
	Segments []Segment `json:"segments"`
	Error    string    `json:"error,omitempty"`
}

type Process struct {
	mu      sync.Mutex
	command []string
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	stdout  *bufio.Reader
	logger  *log.Logger
	nextID  uint64

	stderrMu   sync.Mutex
	stderrLast string
	stderrDone chan struct{}
}

func NewProcess(command []string, logger *log.Logger) (*Process, error) {
	if len(command) == 0 {
		return nil, errors.New("engine command is empty")
	}

	if logger == nil {
		logger = log.Default()
	}

	return &Process{command: append([]string(nil), command...), logger: logger}, nil
}

func (p *Process) Transcribe(ctx context.Context, audioPath string) ([]Segment, error) {
	return p.call(ctx, "transcribe", audioPath)
}

func (p *Process) Ping(ctx context.Context) error {
	_, err := p.call(ctx, "ping", "")

	return err
}

func (p *Process) Warmup(ctx context.Context) error {
	_, err := p.call(ctx, "warmup", "")

	return err
}

func (p *Process) call(ctx context.Context, action, audioPath string) ([]Segment, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	var lastErr error
	for attempt := range 2 {
		if err := p.startLocked(); err != nil {
			return nil, err
		}

		segments, err := p.requestLocked(ctx, action, audioPath)
		if err == nil {
			return segments, nil
		}

		lastErr = err
		p.logger.Printf("engine request failed (attempt %d): %v", attempt+1, err)
		p.stopLocked()
		if ctx.Err() != nil {
			// Повтор перезапустил бы worker и заново грузил модель
			break
		}
	}

	return nil, p.describeFailure(lastErr)
}

func (p *Process) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.stopLocked()
}

func (p *Process) startLocked() error {
	if p.cmd != nil && p.cmd.Process != nil {
		return nil
	}

	cmd := exec.Command(p.command[0], p.command[1:]...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}

	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start engine: %w", err)
	}

	p.cmd = cmd
	p.stdin = stdin
	p.stdout = bufio.NewReaderSize(stdout, 1024*1024)
	p.setLastStderr("")
	done := make(chan struct{})
	p.stderrDone = done

	go func() {
		defer close(done)
		scanner := bufio.NewScanner(stderr)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			p.logger.Printf("[engine] %s", line)
			if strings.TrimSpace(line) != "" {
				p.setLastStderr(line)
			}
		}
	}()

	return nil
}

func (p *Process) setLastStderr(line string) {
	p.stderrMu.Lock()
	defer p.stderrMu.Unlock()
	p.stderrLast = strings.TrimSpace(line)
}

// Дополняет ошибку строкой stderr: голое «EOF» ничего не объясняет.
func (p *Process) describeFailure(err error) error {
	p.stderrMu.Lock()
	detail := p.stderrLast
	p.stderrMu.Unlock()
	if detail == "" {
		return err
	}

	return fmt.Errorf("%w (worker: %s)", err, detail)
}

func (p *Process) requestLocked(ctx context.Context, action, audioPath string) ([]Segment, error) {
	p.nextID++
	id := fmt.Sprintf("job-%d-%d", time.Now().UnixNano(), p.nextID)
	raw, err := json.Marshal(processRequest{ID: id, Action: action, AudioPath: audioPath})
	if err != nil {
		return nil, err
	}

	raw = append(raw, '\n')
	stdin := p.stdin
	stdout := p.stdout

	type result struct {
		response processResponse
		err      error
	}

	done := make(chan result, 1)
	go func() {
		if _, err := stdin.Write(raw); err != nil {
			done <- result{err: fmt.Errorf("write engine request: %w", err)}
			return
		}

		line, err := stdout.ReadBytes('\n')
		if err != nil {
			done <- result{err: fmt.Errorf("read engine response: %w", err)}
			return
		}

		var response processResponse
		if err := json.Unmarshal(line, &response); err != nil {
			done <- result{err: fmt.Errorf("decode engine response: %w", err)}
			return
		}

		done <- result{response: response}
	}()

	select {
	case <-ctx.Done():
		if p.cmd != nil && p.cmd.Process != nil {
			_ = p.cmd.Process.Kill()
		}

		return nil, ctx.Err()

	case output := <-done:
		if output.err != nil {
			return nil, output.err
		}

		if output.response.ID != id {
			return nil, fmt.Errorf("engine response id mismatch: got %q, want %q", output.response.ID, id)
		}

		if output.response.Error != "" {
			return nil, errors.New(output.response.Error)
		}

		return output.response.Segments, nil
	}
}

func (p *Process) stopLocked() error {
	if p.cmd == nil {
		return nil
	}
	_ = p.stdin.Close()
	if p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
	// Wait закроет пайп, поэтому дочитываем stderr до конца заранее.
	if p.stderrDone != nil {
		<-p.stderrDone
		p.stderrDone = nil
	}
	err := p.cmd.Wait()
	p.cmd = nil
	p.stdin = nil
	p.stdout = nil

	if err != nil {
		if errMsg, hasErr := errors.AsType[*exec.ExitError](err); hasErr {
			return errMsg
		}
	}
	return nil
}
