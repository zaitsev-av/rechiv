//go:build linux

package tray

import (
	"os/exec"

	"fyne.io/systray"
)

func prepare([]byte) {}

func setIndicator(item *systray.MenuItem, icon []byte) {
	if len(icon) > 0 {
		item.SetIcon(icon)
	}
}

func openCommand(target string, _ bool) *exec.Cmd {
	return exec.Command("xdg-open", target)
}
