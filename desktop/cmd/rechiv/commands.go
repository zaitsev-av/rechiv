package main

import (
	"fmt"
	"runtime"
	"strings"
)

const commandHelp = `Использование: rechiv [команда] [флаги]

Доступные команды:
  без команды  Запустить приложение
  mcp          Запустить MCP-сервер через stdio
  help         Показать справку (-h, --help)

Флаги приложения: -listen, -data-dir, -engine и другие.
Флаги MCP: rechiv mcp -h
`

func parseCommand(args []string) (string, []string, error) {
	if runtime.GOOS == "darwin" && len(args) > 0 && strings.HasPrefix(args[0], "-psn_") {
		args = args[1:]
	}

	if len(args) == 0 {
		return "", args, nil
	}

	switch args[0] {
	case "mcp":
		return "mcp", args[1:], nil
	case "-h", "--help", "help":
		return "help", args[1:], nil
	default:
		if strings.HasPrefix(args[0], "-") {
			return "", args, nil
		}
		return "", nil, unknownCommand(args[0])
	}
}

func unknownCommand(name string) error {
	return fmt.Errorf("неизвестная команда %q\n%s", name, commandHelp)
}
