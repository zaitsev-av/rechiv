//go:build !darwin

package tray

import "sync"

var (
	stopped = make(chan struct{})
	once    sync.Once
)

func Run(Options) { <-stopped }

func Quit() { once.Do(func() { close(stopped) }) }
