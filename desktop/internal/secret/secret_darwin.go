//go:build darwin

package secret

import (
	"bytes"
	"encoding/hex"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

const (
	keychainService = "Rechiv LLM API key"
	keychainAccount = "default"
	// errSecItemNotFound в коде выхода утилиты security.
	notFoundExit = 44
)

func Default(string) Store {
	return Keychain{Service: keychainService, Account: keychainAccount}
}

type Keychain struct {
	Service string
	Account string
}

func (k Keychain) Get() (string, error) {
	cmd := exec.Command("/usr/bin/security", "find-generic-password", "-s", k.Service, "-a", k.Account, "-g")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()

	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == notFoundExit {
		return "", nil
	}

	if err != nil {
		return "", fmt.Errorf("keychain: %w", err)
	}

	return parsePassword(stderr.String())
}

func parsePassword(output string) (string, error) {
	for line := range strings.SplitSeq(output, "\n") {
		value, ok := strings.CutPrefix(line, "password: ")
		if !ok {
			continue
		}

		if encoded, ok := strings.CutPrefix(value, "0x"); ok {
			encoded, _, _ = strings.Cut(encoded, " ")
			raw, err := hex.DecodeString(encoded)
			if err != nil {
				return "", fmt.Errorf("keychain: %w", err)
			}

			return string(raw), nil
		}

		if value == "" {
			return "", nil
		}

		if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
			return value[1 : len(value)-1], nil
		}
	}

	return "", errors.New("keychain: неожиданный ответ утилиты security")
}

func (k Keychain) Set(value string) error {
	command := fmt.Sprintf("add-generic-password -U -s %q -a %q -X %s\n", k.Service, k.Account, hex.EncodeToString([]byte(value)))
	cmd := exec.Command("/usr/bin/security", "-i")
	cmd.Stdin = strings.NewReader(command)

	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("keychain: %w: %s", err, strings.TrimSpace(stderr.String()))
	}

	if stderr.Len() > 0 {
		return fmt.Errorf("keychain: %s", strings.TrimSpace(stderr.String()))
	}

	return nil
}

func (k Keychain) Delete() error {
	err := exec.Command("/usr/bin/security", "delete-generic-password", "-s", k.Service, "-a", k.Account).Run()

	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == notFoundExit {
		return nil
	}

	if err != nil {
		return fmt.Errorf("keychain: %w", err)
	}

	return nil
}
