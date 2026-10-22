//go:build darwin

package secret

import (
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

// Пишет в настоящий Keychain, поэтому только по явному запросу.
func TestKeychain(t *testing.T) {
	if os.Getenv("RECHIV_KEYCHAIN_TEST") == "" {
		t.Skip("RECHIV_KEYCHAIN_TEST=1 включает проверку на настоящем Keychain")
	}
	store := Keychain{Service: "Rechiv test", Account: t.Name()}
	t.Cleanup(func() { _ = store.Delete() })

	value, err := store.Get()
	require.NoError(t, err)
	require.Empty(t, value)
	require.NoError(t, store.Set(`ключ "с кавычками" \ и пробелами`))
	value, err = store.Get()
	require.NoError(t, err)
	require.Equal(t, `ключ "с кавычками" \ и пробелами`, value)
	require.NoError(t, store.Set("sk-2"))
	value, err = store.Get()
	require.NoError(t, err)
	require.Equal(t, "sk-2", value)
	require.NoError(t, store.Delete())
	require.NoError(t, store.Delete())
}

func TestParsePassword(t *testing.T) {
	for _, tt := range []struct{ output, want string }{
		{"keychain: \"x\"\npassword: \"sk-1 \"q\" x\"\n", `sk-1 "q" x`},
		{"password: 0xD0BA  \"\\320\\272\"\n", "к"},
		{"password: \n", ""},
	} {
		got, err := parsePassword(tt.output)
		require.NoError(t, err)
		require.Equal(t, tt.want, got)
	}
	_, err := parsePassword("nothing")
	require.Error(t, err)
}
