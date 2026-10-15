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

## Adding a platform

- Add `id`, `name`, `hosts`, optional `callPath` or `callPathPattern` (regular expression)
  and `capabilities.audio` (`mixed`, `per-participant` or `slots`) to `extension/src/platforms.json`.
  Set `capabilities.localAudio` to `sender` when the platform processes the microphone itself:
  the local track is then recorded from the outgoing sender. Both extension
  builds generate manifest permissions and matches from this registry.
- Create `content/platforms/<id>/page.ts` and `dom.ts` and register their factories
  in `content/platforms/registry.ts`. Generic DOM guesses can be inherited.
- `PageAdapter` requires `id`, `getSpeakerMap`, `isLocalMuted`,
  `syncMuteSubscription`, and `teardown`. Speaker maps must be reliable: DOM never
  overwrites them. Signaling installation, remote-track tracking, VAD capture and
  chunk attribution are optional (see `platforms/types.ts`). `DomAdapter` requires
  `findParticipantName`, `getAllParticipantNames`, and `getLocalParticipantName`.
- Test host/capability and adapter selection, platform DOM fixtures (including
  cameras off and the local participant), speaker mapping and mute behavior.
  Update `allowedPageOrigins` in `desktop/internal/api/server.go`; the adjacent
  registry test checks it against the JSON. Run the checks above.

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

## Как добавить площадку

- Добавьте `id`, `name`, `hosts`, необязательный `callPath` или `callPathPattern` (регулярное
  выражение) и `capabilities.audio` (`mixed`, `per-participant` или `slots`) в `extension/src/platforms.json`.
  Укажите `capabilities.localAudio: sender`, если площадка сама обрабатывает микрофон: тогда свой
  голос пишется с отправляемого трека. Обе сборки
  расширения генерируют разрешения и matches манифеста из этого реестра.
- Создайте `content/platforms/<id>/page.ts` и `dom.ts`, зарегистрируйте их фабрики
  в `content/platforms/registry.ts`. Общие DOM-догадки можно унаследовать.
- В `PageAdapter` обязательны `id`, `getSpeakerMap`, `isLocalMuted`,
  `syncMuteSubscription` и `teardown`. Маппинг потоков должен быть надёжным: DOM его
  не перезаписывает. Установка перехвата сигналинга, учёт удалённых треков, захват VAD
  и атрибуция чанков необязательны (см. `platforms/types.ts`). В `DomAdapter` обязательны
  `findParticipantName`, `getAllParticipantNames` и `getLocalParticipantName`.
- Добавьте тесты выбора по хосту, возможностей и адаптеров, DOM площадки (включая
  выключенные камеры и локального участника), маппинга и мьюта. Обновите
  `allowedPageOrigins` в `desktop/internal/api/server.go`: соседний тест сверяет его
  с JSON. Выполните проверки выше.

## Приватность

Не коммитьте записи, транскрипты, логи созвонов и настоящие имена участников.
Диагностика созвонов кладётся в `.logs/`, который исключён из git. В тестах используйте
вымышленные имена.
