# Contributing

**English** · Русский ниже

## Documentation in two languages

Every document exists in English and Russian: `README.md` / `README.ru.md`,
`desktop/README.md` / `desktop/README.ru.md`. Each file starts with a language switcher.

- Change both versions in the same commit or pull request. A change that touches only
  one language is incomplete.
- Keep the same sections in the same order, so the versions are easy to compare.
- A new document gets both versions from the start.

## Checks

Before opening a pull request run from the repository root:

```bash
task check
```

CI (`.github/workflows/ci.yml`) runs lint, tests and builds for the extension and the
Go application.

## Privacy

Never commit recordings, transcripts, call logs or real participant names. Call
diagnostics belong in `.logs/`, which is ignored by git. Use made-up names in tests.

---

## Документация на двух языках

Каждый документ существует на английском и русском: `README.md` / `README.ru.md`,
`desktop/README.md` / `desktop/README.ru.md`. В начале каждого файла — переключатель языков.

- Меняйте обе версии в одном коммите или pull request. Изменение только одного языка
  считается незавершённым.
- Держите одинаковые разделы в одном порядке, чтобы версии было легко сверить.
- Новый документ сразу получает обе версии.

## Проверки

Перед pull request выполните из корня репозитория:

```bash
task check
```

CI (`.github/workflows/ci.yml`) запускает линтер, тесты и сборку расширения
и Go-приложения.

## Приватность

Не коммитьте записи, транскрипты, логи созвонов и настоящие имена участников.
Диагностика созвонов кладётся в `.logs/`, который исключён из git. В тестах используйте
вымышленные имена.
