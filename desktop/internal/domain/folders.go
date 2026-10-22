package domain

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

type FolderRule struct {
	URL string `json:"url"`
}
type FolderSettings struct {
	AutoRecord    bool   `json:"autoRecord,omitempty"`
	LivePanel     bool   `json:"livePanel,omitempty"`
	AutoSummary   bool   `json:"autoSummary,omitempty"`
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
	for _, token := range []string{"{date}", "{time}", "{weekday}", "{topic}"} {
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

var topicBefore = regexp.MustCompile(`(?:^|\s)[—-]\s*$|[:,]\s*$`)
var topicAfter = regexp.MustCompile(`^\s*(?:[—-](?:\s+|$)|[:,]\s*)`)

func RenderTitleTemplate(template string, createdAt time.Time, topic string) string {
	if topic == "" {
		if before, after, found := strings.Cut(template, "{topic}"); found {
			left, right := topicBefore.ReplaceAllString(before, ""), topicAfter.ReplaceAllString(after, "")
			template = left + right
			if left != before || right != after {
				template = left + " " + right
			}
		}
	}
	local := createdAt.In(time.Local)
	weekdays := [...]string{"воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"}
	rendered := strings.NewReplacer(
		"{topic}", topic,
		"{date}", local.Format("02.01.2006"),
		"{time}", local.Format("15:04"),
		"{weekday}", weekdays[local.Weekday()],
	).Replace(template)
	return strings.Join(strings.Fields(rendered), " ")
}
