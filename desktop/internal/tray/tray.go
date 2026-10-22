package tray

import (
	"log"
	"time"

	"rechiv/desktop/internal/calls"
	"rechiv/desktop/internal/domain"
)

type Status struct {
	Engine        string
	Detail        string
	Sessions      []*domain.Session
	LastExtension time.Time
	Call          *calls.Call
	Stop          calls.Stop
	CallFolder    string
}

type Config struct {
	Version       string
	SessionsURL   string
	OnboardingURL string
	Model         string
	Engine        string
}

type Options struct {
	Config
	Icon           []byte
	RecordingIcon  []byte
	ProcessingIcon []byte
	StoppingIcon   []byte
	IndicatorIcons map[Indicator][]byte
	DataDir        string
	Status         func() Status
	Command        func(calls.Command)
	Logger         *log.Logger
}

const (
	EngineReady    = "ready"
	EngineStarting = "starting"
	EngineFailed   = "error"
)
