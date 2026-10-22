package llm

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"rechiv/desktop/internal/secret"
)

func TestSettings(t *testing.T) {
	dir := t.TempDir()
	keyStore := secret.File{Path: filepath.Join(dir, "key")}
	settings := NewSettings(dir, keyStore)
	key := func(value string) *string { return &value }

	config, err := settings.Load()
	require.NoError(t, err)
	assert.False(t, config.Configured())

	_, err = settings.Save("https://llm.example/v1", "", key("sk"))
	require.ErrorIs(t, err, ErrInvalid)
	_, err = settings.Save("llm.example", "m", key("sk"))
	require.ErrorIs(t, err, ErrInvalid)

	config, err = settings.Save(" https://llm.example/v1/ ", " m ", key(" sk "))
	require.NoError(t, err)
	assert.Equal(t, Config{URL: "https://llm.example/v1", Model: "m", APIKey: "sk"}, config)
	raw, err := os.ReadFile(filepath.Join(dir, "llm.json"))
	require.NoError(t, err)
	assert.NotContains(t, string(raw), "sk", "ключ не попадает в файл настроек")

	config, err = settings.Save("https://llm.example/v1", "m2", nil)
	require.NoError(t, err)
	assert.Equal(t, "sk", config.APIKey, "без нового ключа сохранённый остаётся")

	config, err = NewSettings(dir, keyStore).Load()
	require.NoError(t, err)
	assert.Equal(t, Config{URL: "https://llm.example/v1", Model: "m2", APIKey: "sk"}, config)

	config, err = settings.Save("", "", key(""))
	require.NoError(t, err)
	assert.False(t, config.Configured())
	stored, err := keyStore.Get()
	require.NoError(t, err)
	assert.Empty(t, stored)
	_, err = os.Stat(filepath.Join(dir, "llm.json"))
	assert.ErrorIs(t, err, os.ErrNotExist)
}
