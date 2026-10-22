//go:build !darwin && !linux

package tray

import "sync"

var (
	stopped = make(chan struct{})
	once    sync.Once
)

// Трей Windows ждёт иконки в формате ICO.
func Run(Options) { <-stopped }

func Quit() { once.Do(func() { close(stopped) }) }
