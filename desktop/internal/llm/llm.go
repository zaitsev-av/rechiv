// Package llm обращается к OpenAI-совместимому сервису: проверка доступа, саммари и тема созвона.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	outputReserve         = 8192
	fallbackContextWindow = 128000
	shortRequestTimeout   = 120 * time.Second
	modelsTimeout         = 10 * time.Second
)

type Config struct {
	URL    string `json:"url"`
	Model  string `json:"model"`
	APIKey string `json:"-"`
}

func (c Config) Configured() bool {
	return c.URL != "" && c.Model != "" && c.APIKey != ""
}

type Summary struct {
	Content   string `json:"content"`
	CreatedAt string `json:"createdAt"`
	Model     string `json:"model"`
	Chunked   bool   `json:"chunked"`
}

type CheckResult struct {
	State  string `json:"state"`
	Detail string `json:"detail"`
}

type Client struct {
	HTTP *http.Client
	now  func() time.Time
}

func NewClient() *Client {
	return &Client{HTTP: &http.Client{}, now: time.Now}
}

type modelList struct {
	Data []struct {
		ID          string `json:"id"`
		MaxModelLen int    `json:"max_model_len"`
	} `json:"data"`
}

// Check различает «не отвечает», «не тот токен» и «нет модели».
func (c *Client) Check(ctx context.Context, config Config) CheckResult {
	response, err := c.models(ctx, config)
	if err != nil {
		return CheckResult{"error", "Адрес " + config.URL + " не отвечает"}
	}
	defer response.Body.Close()
	switch {
	case response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden:
		return CheckResult{"error", "Токен не принят: сервис вернул отказ в доступе"}
	case response.StatusCode < 200 || response.StatusCode >= 300:
		return CheckResult{"error", fmt.Sprintf("Сервис ответил ошибкой %d", response.StatusCode)}
	}
	var raw struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&raw); err != nil {
		return CheckResult{"warning", "Адрес и токен приняты, но список моделей нечитаем"}
	}
	var models []struct {
		ID string `json:"id"`
	}
	if len(raw.Data) == 0 || json.Unmarshal(raw.Data, &models) != nil {
		return CheckResult{"warning", "Адрес и токен приняты, список моделей сервис не отдаёт"}
	}
	for _, model := range models {
		if strings.EqualFold(model.ID, config.Model) {
			return CheckResult{"ok", "Модель «" + model.ID + "» доступна"}
		}
	}
	return CheckResult{"warning", fmt.Sprintf("Адрес и токен приняты, но модели «%s» нет в списке из %d", config.Model, len(models))}
}

func (c *Client) models(ctx context.Context, config Config) (*http.Response, error) {
	ctx, cancel := context.WithTimeout(ctx, modelsTimeout)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, config.URL+"/models", nil)
	if err != nil {
		cancel()
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+config.APIKey)
	response, err := c.HTTP.Do(request)
	if err != nil {
		cancel()
		return nil, err
	}
	response.Body = cancelOnClose{response.Body, cancel}
	return response, nil
}

type cancelOnClose struct {
	body   io.ReadCloser
	cancel context.CancelFunc
}

func (c cancelOnClose) Read(p []byte) (int, error) { return c.body.Read(p) }
func (c cancelOnClose) Close() error {
	defer c.cancel()
	return c.body.Close()
}

// prepare уточняет имя модели и окно контекста; без ответа сервиса — значения по умолчанию.
func (c *Client) prepare(ctx context.Context, config Config) (string, int) {
	response, err := c.models(ctx, config)
	if err != nil {
		return config.Model, fallbackContextWindow
	}
	defer response.Body.Close()
	var list modelList
	if response.StatusCode != http.StatusOK || json.NewDecoder(response.Body).Decode(&list) != nil {
		return config.Model, fallbackContextWindow
	}
	for _, model := range list.Data {
		if strings.EqualFold(model.ID, config.Model) {
			window := model.MaxModelLen
			if window <= 0 {
				window = fallbackContextWindow
			}
			return model.ID, window
		}
	}
	return config.Model, fallbackContextWindow
}

func estimateTokens(text string) int {
	return (utf8.RuneCountInString(text) + 2) / 3
}

// Summary принимает транскрипт в том виде, в каком его отдаёт GET /sessions/{id}/transcript.
func (c *Client) Summary(ctx context.Context, config Config, transcript []byte) (Summary, error) {
	model, window := c.prepare(ctx, config)
	config.Model = model
	var compact bytes.Buffer
	if err := json.Compact(&compact, transcript); err != nil {
		return Summary{}, fmt.Errorf("транскрипт повреждён: %w", err)
	}
	result := Summary{Model: model}
	budget := window - estimateTokens(promptMain) - outputReserve
	if estimateTokens(compact.String()) <= budget {
		content, err := c.call(ctx, config, promptMain, compact.String(), 0)
		if err != nil {
			return Summary{}, err
		}
		result.Content = content
	} else {
		parts, err := splitTranscript(compact.Bytes(), window-estimateTokens(promptMap)-outputReserve)
		if err != nil {
			return Summary{}, err
		}
		answers := make([]string, len(parts))
		errs := make([]error, len(parts))
		var wg sync.WaitGroup
		for i, part := range parts {
			wg.Go(func() { answers[i], errs[i] = c.call(ctx, config, promptMap, part, 0) })
		}
		wg.Wait()
		if err := errors.Join(errs...); err != nil {
			return Summary{}, err
		}
		var reduce strings.Builder
		for i, answer := range answers {
			if i > 0 {
				reduce.WriteString("\n\n")
			}
			fmt.Fprintf(&reduce, "--- Часть %d из %d ---\n%s", i+1, len(answers), answer)
		}
		content, err := c.call(ctx, config, promptMain, reduce.String(), 0)
		if err != nil {
			return Summary{}, err
		}
		result.Content = content
		result.Chunked = true
	}
	result.CreatedAt = c.now().UTC().Format("2006-01-02T15:04:05.000Z")
	return result, nil
}

// splitTranscript делит реплики на части по бюджету; остальные поля транскрипта повторяются в каждой.
func splitTranscript(transcript []byte, budget int) ([]string, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(transcript, &fields); err != nil {
		return nil, fmt.Errorf("транскрипт повреждён: %w", err)
	}
	var segments []json.RawMessage
	if raw, ok := fields["segments"]; ok {
		if err := json.Unmarshal(raw, &segments); err != nil {
			return nil, fmt.Errorf("транскрипт повреждён: %w", err)
		}
	}
	var chunks [][]json.RawMessage
	var current []json.RawMessage
	tokens := 0
	for _, segment := range segments {
		size := estimateTokens(string(segment))
		if len(current) > 0 && tokens+size > budget {
			chunks = append(chunks, current)
			current, tokens = nil, 0
		}
		current = append(current, segment)
		tokens += size
	}
	if len(current) > 0 {
		chunks = append(chunks, current)
	}
	parts := make([]string, 0, len(chunks))
	for _, chunk := range chunks {
		raw, err := json.Marshal(chunk)
		if err != nil {
			return nil, err
		}
		fields["segments"] = raw
		part, err := json.Marshal(fields)
		if err != nil {
			return nil, err
		}
		parts = append(parts, string(part))
	}
	return parts, nil
}

var topicTrim = regexp.MustCompile(`^["«“]+|["»”.]+$`)

func (c *Client) Topic(ctx context.Context, config Config, source string) (string, error) {
	model, window := c.prepare(ctx, config)
	config.Model = model
	budget := window - estimateTokens(promptTopic) - 256
	if budget <= 0 {
		return "", errors.New("Недостаточно контекста для темы созвона")
	}
	if runes := []rune(source); len(runes) > budget*3 {
		source = string(runes[:budget*3])
	}
	answer, err := c.call(ctx, config, promptTopic, source, 128)
	if err != nil {
		return "", err
	}
	topic := strings.TrimSpace(topicTrim.ReplaceAllString(strings.TrimSpace(answer), ""))
	if topic == "" || strings.ContainsAny(topic, "\r\n\u0085  ") || utf8.RuneCountInString(topic) > 120 {
		return "", errors.New("LLM вернул некорректную тему")
	}
	return topic, nil
}

func (c *Client) call(ctx context.Context, config Config, system, user string, maxTokens int) (string, error) {
	body := map[string]any{
		"model": config.Model,
		"messages": []map[string]string{
			{"role": "system", "content": system},
			{"role": "user", "content": user},
		},
	}
	// Саммари длинного созвона может идти дольше, лимит только для коротких запросов.
	if maxTokens > 0 {
		body["max_tokens"] = maxTokens
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, shortRequestTimeout)
		defer cancel()
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, config.URL+"/chat/completions", bytes.NewReader(raw))
	if err != nil {
		return "", errors.New("Не удалось подключиться к LLM")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+config.APIKey)
	response, err := c.HTTP.Do(request)
	if err != nil {
		return "", errors.New("Не удалось подключиться к LLM")
	}
	defer response.Body.Close()
	switch {
	case response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden:
		return "", errors.New("Неверный API-токен")
	case response.StatusCode == http.StatusTooManyRequests:
		return "", errors.New("Слишком много запросов, попробуйте позже")
	case response.StatusCode < 200 || response.StatusCode >= 300:
		return "", fmt.Errorf("Ошибка сервера LLM: %d", response.StatusCode)
	}
	var data struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(response.Body).Decode(&data); err != nil {
		return "", errors.New("LLM вернул некорректный ответ")
	}
	if len(data.Choices) == 0 || data.Choices[0].Message.Content == "" {
		return "", errors.New("LLM вернул пустой или некорректный ответ")
	}
	return data.Choices[0].Message.Content, nil
}
