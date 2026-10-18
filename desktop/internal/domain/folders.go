package domain

import (
	"fmt"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

type FolderRule struct {
	URL string `json:"url"`
}
type FolderSettings struct {
	TitleTemplate string `json:"titleTemplate,omitempty"`
	RetentionDays int    `json:"retentionDays,omitempty"`
}

type Folder struct {
	ID       string         `json:"id"`
	Name     string         `json:"name"`
	Color    int            `json:"color"`
	Rules    []FolderRule   `json:"rules"`
	Settings FolderSettings `json:"settings"`
}

func NormalizeCallURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.ContainsAny(raw, " \t\r\n") {
		return ""
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + strings.TrimPrefix(raw, "//")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return ""
	}
	host := strings.TrimPrefix(strings.ToLower(u.Host), "www.")
	if !strings.Contains(u.Hostname(), ".") && u.Hostname() != "localhost" && !strings.Contains(u.Hostname(), ":") {
		return ""
	}
	path := u.EscapedPath()
	if u.RawPath != "" {
		path = u.RawPath
	}
	return host + strings.TrimRight(path, "/")
}

func ValidateTitleTemplate(template string) (string, error) {
	template = strings.TrimSpace(template)
	if utf8.RuneCountInString(template) > 200 {
		return "", fmt.Errorf("шаблон длиннее 200 символов")
	}
	rest := template
	for _, token := range []string{"{date}", "{time}", "{weekday}"} {
		if strings.Count(rest, token) > 1 {
			return "", fmt.Errorf("подстановка %s повторяется", token)
		}
		rest = strings.ReplaceAll(rest, token, "")
	}
	if strings.ContainsAny(rest, "{}") {
		return "", fmt.Errorf("неизвестная или незакрытая подстановка")
	}
	return template, nil
}

func RenderTitleTemplate(template string, createdAt time.Time) string {
	local := createdAt.In(time.Local)
	weekdays := [...]string{"воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"}
	return strings.NewReplacer(
		"{date}", local.Format("02.01.2006"),
		"{time}", local.Format("15:04"),
		"{weekday}", weekdays[local.Weekday()],
	).Replace(template)
}
