//go:build darwin || linux

package tray

import (
	"sync/atomic"
	"time"

	"fyne.io/systray"
)

const statusInterval = time.Second

func Run(options Options) {
	done := make(chan struct{})
	systray.Run(func() { setup(options, done) }, func() { close(done) })
}

func Quit() {
	systray.Quit()
}

type renderedItem struct {
	item     *systray.MenuItem
	previous Item
	action   atomic.Value
}

func newRenderedItem(item *systray.MenuItem, options Options, done <-chan struct{}) *renderedItem {
	rendered := &renderedItem{item: item, previous: Item{Visible: true, Enabled: true}}
	rendered.action.Store(Item{})
	// Обработчик живёт всё время: тикер меняет только адрес, без гонки с кликом.
	onClick(item, done, func() {
		current := rendered.action.Load().(Item)
		if !current.Enabled {
			return
		}
		if current.Command != "" && options.Command != nil {
			options.Command(current.Command)
		} else if current.ShowFiles {
			launch(options, "файлы", options.DataDir, true)
		} else if current.URL != "" {
			launch(options, "браузер", current.URL, false)
		}
	})
	return rendered
}

func (item *renderedItem) update(current Item) {
	previous := item.previous
	if current == previous {
		return
	}
	item.action.Store(current)
	if current.Title != previous.Title {
		item.item.SetTitle(current.Title)
	}
	if current.Tooltip != previous.Tooltip {
		item.item.SetTooltip(current.Tooltip)
	}
	if current.Enabled != previous.Enabled {
		if current.Enabled {
			item.item.Enable()
		} else {
			item.item.Disable()
		}
	}
	if current.Visible != previous.Visible {
		if current.Visible {
			item.item.Show()
		} else {
			item.item.Hide()
		}
	}
	item.previous = current
}

func onClick(item *systray.MenuItem, done <-chan struct{}, action func()) {
	go func() {
		for {
			select {
			case <-done:
				return
			case <-item.ClickedCh:
				action()
			}
		}
	}()
}

func setup(options Options, done <-chan struct{}) {
	menu := BuildMenu(options.Status(), options.Config, time.Now())
	prepare(options.IndicatorIcons[menu.Indicator])
	systray.SetTooltip("Rechiv " + options.Version)

	status := newRenderedItem(systray.AddMenuItem("", ""), options, done)
	hint := newRenderedItem(systray.AddMenuItem("", ""), options, done)
	live := newRenderedItem(systray.AddMenuItem("", ""), options, done)
	primary := newRenderedItem(systray.AddMenuItem("", ""), options, done)
	systray.AddSeparator()

	recent := systray.AddMenuItem("Последние созвоны", "")
	var slots [recentLimit]*renderedItem
	for i := range slots {
		slots[i] = newRenderedItem(recent.AddSubMenuItem("", ""), options, done)
	}
	empty := newRenderedItem(recent.AddSubMenuItem("", ""), options, done)
	recent.AddSeparator()
	allRecent := recent.AddSubMenuItem("Все созвоны…", menu.AllSessions.Tooltip)
	onClick(allRecent, done, func() { launch(options, "браузер", options.SessionsURL, false) })
	if !menu.AllSessions.Enabled {
		allRecent.Disable()
	}
	all := newRenderedItem(systray.AddMenuItem("", ""), options, done)
	all.update(menu.AllSessions)
	files := systray.AddMenuItem("Показать файлы", "Записи, транскрипты и лог приложения")
	onClick(files, done, func() { launch(options, "файлы", options.DataDir, true) })

	systray.AddSeparator()
	model := systray.AddMenuItem(menu.ModelTitle, "")
	model.AddSubMenuItem("Распознавание речи", "").Disable()
	for _, choice := range menu.Models {
		model.AddSubMenuItemCheckbox(choice.Title, choice.Tooltip, choice.Checked).Disable()
	}
	model.AddSubMenuItem("Язык созвона", "").Disable()
	for _, choice := range menu.Languages {
		model.AddSubMenuItemCheckbox(choice.Title, choice.Tooltip, choice.Checked).Disable()
	}
	model.AddSeparator()
	modelStatus := newRenderedItem(model.AddSubMenuItem("", ""), options, done)
	quit := systray.AddMenuItem("Выйти из Rechiv", "")
	onClick(quit, done, systray.Quit)

	previousIndicator := menu.Indicator
	setIndicator(status.item, options.IndicatorIcons[previousIndicator])
	var previousIcon Icon
	previousTimer := ""
	render := func(menu Menu) {
		status.update(menu.Status)
		hint.update(menu.Hint)
		if menu.Indicator != previousIndicator {
			setIndicator(status.item, options.IndicatorIcons[menu.Indicator])
			previousIndicator = menu.Indicator
		}
		live.update(menu.Live)
		primary.update(menu.Primary)
		for i := range slots {
			slots[i].update(menu.Recent[i])
		}
		empty.update(menu.Empty)
		modelStatus.update(Item{Title: menu.ModelStatus, Visible: true})
		if menu.Icon != previousIcon {
			icon := options.Icon
			switch menu.Icon {
			case IconRecording:
				icon = options.RecordingIcon
			case IconProcessing:
				icon = options.ProcessingIcon
			case IconStopping:
				icon = options.StoppingIcon
			}
			// macOS перекрашивает template PNG для светлой и тёмной темы, цветные точки записи остаются цветными.
			if menu.Icon == IconRecording || menu.Icon == IconStopping {
				systray.SetIcon(icon)
			} else {
				systray.SetTemplateIcon(icon, icon)
			}
			previousIcon = menu.Icon
		}
		if menu.Timer != previousTimer {
			systray.SetTitle(menu.Timer)
			previousTimer = menu.Timer
		}
	}
	render(menu)

	go func() {
		ticker := time.NewTicker(statusInterval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				render(BuildMenu(options.Status(), options.Config, time.Now()))
			}
		}
	}()
}

func launch(options Options, what, target string, folder bool) {
	go func() {
		if options.Logger != nil {
			options.Logger.Printf("tray: opening %s (%s)", what, target)
		}
		if err := openCommand(target, folder).Run(); err != nil && options.Logger != nil {
			options.Logger.Printf("tray: failed to open %s: %v", what, err)
		}
	}()
}
