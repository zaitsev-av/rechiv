//go:build darwin

package tray

import (
	"os/exec"
	"time"

	"github.com/energye/systray"
)

const statusInterval = 2 * time.Second

func Run(options Options) {
	systray.Run(func() { setup(options) }, func() {})
}

func Quit() {
	systray.Quit()
}

func setup(options Options) {
	// Template icon перекрашивается macOS, иначе иконка пропадёт в одной из тем.
	systray.SetTemplateIcon(options.Icon, options.Icon)
	systray.SetTooltip("Rechiv " + options.Version)

	status := systray.AddMenuItem(statusLine(options.Status()), "")
	status.Disable()

	systray.AddSeparator()
	if options.SessionsURL != "" {
		sessions := systray.AddMenuItem("Показать созвоны", "Открыть список созвонов в браузере")
		sessions.Click(func() {
			launch(options, "браузер", options.SessionsURL)
		})
		onboarding := systray.AddMenuItem("Настроить расширение", "Открыть инструкцию по установке")
		onboarding.Click(func() {
			launch(options, "онбординг", options.OnboardingURL)
		})
	}
	files := systray.AddMenuItem("Показать файлы", "Записи, транскрипты и лог приложения")
	files.Click(func() {
		launch(options, "Finder", "-a", "Finder", options.DataDir)
	})

	systray.AddSeparator()
	quit := systray.AddMenuItem("Выйти из Rechiv", "")
	quit.Click(func() { systray.Quit() })

	systray.CreateMenu()

	go followStatus(status, options.Status)
}

func launch(options Options, what string, args ...string) {
	go func() {
		if options.Logger != nil {
			options.Logger.Printf("tray: opening %s (%v)", what, args)
		}
		if err := exec.Command("/usr/bin/open", args...).Run(); err != nil && options.Logger != nil {
			options.Logger.Printf("tray: failed to open %s: %v", what, err)
		}
	}()
}

func followStatus(item *systray.MenuItem, read func() Status) {
	ticker := time.NewTicker(statusInterval)
	defer ticker.Stop()

	previous := statusLine(read())
	for range ticker.C {
		current := statusLine(read())
		if current == previous {
			continue
		}
		previous = current
		item.SetTitle(current)
	}
}
