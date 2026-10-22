package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeLLM struct {
	mu       sync.Mutex
	models   string
	status   int
	answer   func(system, user string) string
	requests []map[string]any
}

func (f *fakeLLM) server(t *testing.T) *httptest.Server {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/models":
			_, _ = w.Write([]byte(f.models))
		case "/chat/completions":
			var body map[string]any
			require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
			f.mu.Lock()
			f.requests = append(f.requests, body)
			f.mu.Unlock()
			if f.status != 0 {
				w.WriteHeader(f.status)
				return
			}
			messages := body["messages"].([]any)
			system := messages[0].(map[string]any)["content"].(string)
			user := messages[1].(map[string]any)["content"].(string)
			_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": f.answer(system, user)}}}})
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func newClient() *Client {
	client := NewClient()
	client.now = func() time.Time { return time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC) }
	return client
}

func TestCheck(t *testing.T) {
	fake := &fakeLLM{models: `{"data":[{"id":"Qwen-72B"}]}`}
	server := fake.server(t)
	client := newClient()
	ctx := context.Background()

	assert.Equal(t, CheckResult{"ok", "Модель «Qwen-72B» доступна"}, client.Check(ctx, Config{URL: server.URL, Model: "qwen-72b", APIKey: "key"}))
	assert.Equal(t, "warning", client.Check(ctx, Config{URL: server.URL, Model: "other", APIKey: "key"}).State)
	assert.Equal(t, CheckResult{"error", "Токен не принят: сервис вернул отказ в доступе"}, client.Check(ctx, Config{URL: server.URL, Model: "x", APIKey: "bad"}))
	assert.Equal(t, "error", client.Check(ctx, Config{URL: "http://127.0.0.1:1", Model: "x", APIKey: "key"}).State)

	fake.models = `{"object":"list"}`
	assert.Equal(t, "Адрес и токен приняты, список моделей сервис не отдаёт", client.Check(ctx, Config{URL: server.URL, Model: "x", APIKey: "key"}).Detail)
}

func TestSummaryFitsContext(t *testing.T) {
	fake := &fakeLLM{models: `{"data":[{"id":"Qwen","max_model_len":100000}]}`, answer: func(_, _ string) string { return "# Итоги" }}
	server := fake.server(t)

	summary, err := newClient().Summary(context.Background(), Config{URL: server.URL, Model: "qwen", APIKey: "key"}, []byte(`{"date": "2026-10-19", "segments": [{"text": "привет"}]}`))
	require.NoError(t, err)
	assert.Equal(t, Summary{Content: "# Итоги", CreatedAt: "2026-10-19T12:00:00.000Z", Model: "Qwen"}, summary)
	require.Len(t, fake.requests, 1)
	assert.Equal(t, "Qwen", fake.requests[0]["model"], "имя модели берётся из списка сервиса")
	assert.NotContains(t, fake.requests[0], "max_tokens")
	user := fake.requests[0]["messages"].([]any)[1].(map[string]any)["content"]
	assert.Equal(t, `{"date":"2026-10-19","segments":[{"text":"привет"}]}`, user, "транскрипт уходит компактным JSON")
}

func TestSummaryMapReduce(t *testing.T) {
	// Окно меньше транскрипта: реплики делятся на части, затем части сводятся.
	window := estimateTokens(promptMap) + outputReserve + 20
	fake := &fakeLLM{
		models: `{"data":[{"id":"m","max_model_len":` + jsonInt(window) + `}]}`,
		answer: func(system, user string) string {
			if system == promptMap {
				return "часть"
			}
			return "итог: " + user
		},
	}
	server := fake.server(t)
	segments := make([]string, 6)
	for i := range segments {
		segments[i] = `{"text":"` + strings.Repeat("слово ", 5) + `"}`
	}
	transcript := `{"date":"2026-10-19","segments":[` + strings.Join(segments, ",") + `]}`

	summary, err := newClient().Summary(context.Background(), Config{URL: server.URL, Model: "m", APIKey: "key"}, []byte(transcript))
	require.NoError(t, err)
	assert.True(t, summary.Chunked)
	assert.True(t, strings.HasPrefix(summary.Content, "итог: --- Часть 1 из "))
	assert.Greater(t, len(fake.requests), 2)
	for _, request := range fake.requests[:len(fake.requests)-1] {
		user := request["messages"].([]any)[1].(map[string]any)["content"].(string)
		assert.Contains(t, user, `"date":"2026-10-19"`, "каждая часть сохраняет поля транскрипта")
	}
}

func TestSummaryErrors(t *testing.T) {
	fake := &fakeLLM{models: `{"data":[]}`, status: http.StatusTooManyRequests}
	server := fake.server(t)
	_, err := newClient().Summary(context.Background(), Config{URL: server.URL, Model: "m", APIKey: "key"}, []byte(`{"segments":[]}`))
	require.EqualError(t, err, "Слишком много запросов, попробуйте позже")

	_, err = newClient().Summary(context.Background(), Config{URL: server.URL, Model: "m", APIKey: "bad"}, []byte(`{"segments":[]}`))
	require.EqualError(t, err, "Неверный API-токен")

	_, err = newClient().Summary(context.Background(), Config{URL: server.URL, Model: "m", APIKey: "key"}, []byte(`{`))
	require.ErrorContains(t, err, "транскрипт повреждён")
}

func TestTopic(t *testing.T) {
	answer := "«Планирование релиза.»"
	fake := &fakeLLM{models: `{"data":[]}`, answer: func(_, _ string) string { return answer }}
	server := fake.server(t)
	config := Config{URL: server.URL, Model: "m", APIKey: "key"}

	topic, err := newClient().Topic(context.Background(), config, "текст")
	require.NoError(t, err)
	assert.Equal(t, "Планирование релиза", topic)
	assert.EqualValues(t, 128, fake.requests[0]["max_tokens"])

	answer = "две\nстроки"
	_, err = newClient().Topic(context.Background(), config, "текст")
	require.EqualError(t, err, "LLM вернул некорректную тему")
}

func jsonInt(value int) string {
	raw, _ := json.Marshal(value)
	return string(raw)
}
