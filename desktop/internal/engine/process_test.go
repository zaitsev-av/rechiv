package engine

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProcessProtocol(t *testing.T) {
	process, err := NewProcess(
		[]string{os.Args[0], "-test.run=TestProcessHelper", "--", "engine-helper"},
		log.New(io.Discard, "", 0),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer process.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	segments, err := process.Transcribe(ctx, "/tmp/audio.wav")
	if err != nil {
		t.Fatal(err)
	}
	if len(segments) != 1 || segments[0].Text != "готово" {
		t.Fatalf("segments = %#v", segments)
	}
}

func TestProcessPing(t *testing.T) {
	process, err := NewProcess(
		[]string{os.Args[0], "-test.run=TestProcessHelper", "--", "engine-helper"},
		log.New(io.Discard, "", 0),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer process.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := process.Ping(ctx); err != nil {
		t.Fatalf("Ping() = %v", err)
	}
}

func TestProcessPingFailsWhenWorkerCannotStart(t *testing.T) {
	process, err := NewProcess(
		[]string{filepath.Join(t.TempDir(), "missing-python"), "worker.py"},
		log.New(io.Discard, "", 0),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer process.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := process.Ping(ctx); err == nil {
		t.Fatal("Ping() succeeded with a missing interpreter")
	}
}

func TestProcessFailureIncludesWorkerStderr(t *testing.T) {
	process, err := NewProcess(
		[]string{os.Args[0], "-test.run=TestProcessFailingHelper", "--", "engine-failing-helper"},
		log.New(io.Discard, "", 0),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer process.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pingErr := process.Ping(ctx)
	if pingErr == nil {
		t.Fatal("Ping() succeeded with a failing worker")
	}
	// Голое «EOF» не объясняет пользователю, что сломано окружение Python.
	if !strings.Contains(pingErr.Error(), "No module named 'torch'") {
		t.Fatalf("Ping() = %v, want the worker stderr in the message", pingErr)
	}
}

func TestProcessFailingHelper(t *testing.T) {
	if len(os.Args) == 0 || os.Args[len(os.Args)-1] != "engine-failing-helper" {
		return
	}
	fmt.Fprintln(os.Stderr, "Traceback (most recent call last):")
	fmt.Fprintln(os.Stderr, "ModuleNotFoundError: No module named 'torch'")
	os.Exit(1)
}

func TestProcessHelper(t *testing.T) {
	if len(os.Args) == 0 || os.Args[len(os.Args)-1] != "engine-helper" {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var request processRequest
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			os.Exit(2)
		}
		response := processResponse{
			ID: request.ID,
			Segments: []Segment{{
				Text: "готово", Start: 0.2, End: 0.8,
			}},
		}
		if err := json.NewEncoder(os.Stdout).Encode(response); err != nil {
			os.Exit(3)
		}
	}
	os.Exit(0)
}
