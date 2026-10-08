# Rechiv

[English](README.md) · **Русский**

Rechiv — локальная запись, транскрибация и анализ онлайн-созвонов для macOS и Linux.

Поддерживаются созвоны в Яндекс Телемосте (`telemost.yandex.ru`) и WB Stream
(`stream.wb.ru`); архитектура позволяет добавлять другие платформы независимо
от локального движка и хранилища.

Расширение Rechiv записывает WebRTC-аудио созвона (в WB Stream — отдельно по участникам,
в Телемосте — общим потоком собеседников и отдельно свой микрофон), Go-приложение
управляет сессиями и очередью, а долгоживущий Python/GigaAM worker распознаёт речь.
Транскрипты и аудио не отправляются во внешний STT-сервис.

## Возможности

- имя говорящего для каждой реплики: по отдельным потокам или по сигналингу площадки;
- live-транскрипт во время созвона;
- перемещаемая и изменяемая live-панель поверх страницы;
- история локальных записей;
- редактирование и экспорт транскрипта;
- саммари через настраиваемый OpenAI-совместимый LLM API с ручным редактированием и сохранением правок, доступных MCP-агентам;
- светлая и тёмная темы;
- восстановление незавершённых задач после перезапуска.

## Требования

- macOS на Apple Silicon или современный Linux x86-64/ARM64;
- Go 1.27.0 (версия зафиксирована в `.tool-versions`, ставится через
  [asdf](https://asdf-vm.com/): `asdf install`);
- Python 3.10–3.13;
- Node.js 22+;
- [Task](https://taskfile.dev/);
- FFmpeg;
- Chrome.

Собранное приложение содержит модель GigaAM, сеть для распознавания не нужна. Для разработки
модель один раз собирается командой `task model`: она скачивает веса GigaAM, экспортирует их в ONNX
и квантует в int8 в `build/onnx-int8`.

## Запуск для разработки

Все команды выполняются из корня проекта:

```bash
task doctor
task setup
task run
```

`task setup` создаёт `service/.venv` и устанавливает зависимости расширения.
`task run` запускает локальное Go-приложение на `127.0.0.1:9876`.

Для разработки расширения и Go-приложения одновременно:

```bash
task dev
```

После первой сборки откройте `chrome://extensions`, включите режим разработчика и
выберите «Загрузить распакованное расширение» → `extension/dist`.

## Сборка для Linux

Linux amd64 и расширение:

```bash
task setup
task build:linux
```

Результат:

```text
build/rechiv-linux-amd64
extension/dist/
```

Бинарник сам находит интерпретатор из `service/.venv` — рядом с собой и выше по
дереву проекта. Если venv лежит в другом месте, укажите его явно:

```bash
build/rechiv-linux-amd64 -python /path/to/venv/bin/python
```

Готовность движка видна сразу после старта: `GET /health` возвращает поле
`engine` со статусом `starting`, `ready` или `error` и причиной ошибки.

Для Linux ARM64:

```bash
task build:linux LINUX_ARCH=arm64
```

`task build` собирает сразу macOS arm64, Linux amd64 и расширение.

## Использование

1. Откройте созвон в Телемосте или WB Stream.
2. Нажмите иконку расширения и начните запись.
3. При необходимости откройте перемещаемую live-панель.
4. Завершите запись после звонка.
5. Откройте транскрипт из истории расширения.

Расширение закрывает аудиофрагмент по паузе в речи, а 20 секунд остаются лишь
страховочным потолком для непрерывного монолога. Поэтому первая live-реплика
появляется вскоре после того, как говорящий сделает паузу.

Фрагменты, в которых участник молчал, на распознавание не отправляются, а модель
GigaAM загружается сразу при старте записи — к первому фрагменту она уже готова.

## Архитектура

```text
Телемост / WB Stream
    │ WebRTC-аудио
    ▼
Rechiv Extension
    │ WebM/Opus фрагменты
    ▼
Go API · 127.0.0.1:9876
    │ FFmpeg → WAV 16 kHz mono
    ▼
Последовательная очередь Go
    │ JSON Lines через stdin/stdout
    ▼
Python worker · GigaAM
    │ сегменты текста и таймкоды
    ▼
Go storage → live/result/summary
```

Go отвечает за HTTP API, безопасность, сессии, файлы, очередь, повторы,
финализацию и восстановление. Python отвечает только за загрузку GigaAM и
распознавание подготовленного WAV-файла.

Подробности протокола описаны в [`desktop/README.ru.md`](desktop/README.ru.md).

## Локальные данные и токены

Данные хранятся в:

```text
macOS: ~/Library/Application Support/Rechiv
Linux: ~/.rechiv
```

API слушает только loopback-интерфейс. Все рабочие методы защищены локальным
Bearer-токеном установки, который расширение получает автоматически.

Для ручной диагностики:

```bash
task desktop:token

curl -H "Authorization: Bearer $(task --silent desktop:token)" \
  http://127.0.0.1:9876/sessions
```

Локальный токен приложения не является токеном внешнего LLM. Токен для саммари
указывается отдельно в настройках расширения. При первой проверке, сохранении или генерации
Chrome спросит доступ к адресу LLM: расширение запрашивает только указанный вами хост.

## Основные команды

```bash
task doctor          # проверить инструменты
task setup           # установить Python- и Node.js-зависимости
task run             # запустить приложение
task dev             # приложение + watch-сборка расширения
task test            # запустить все тесты
task lint            # запустить проверки кода
task build           # собрать macOS, Linux и расширение
task build:macos     # собрать macOS arm64 и расширение
task build:linux     # собрать Linux amd64 и расширение
task icons           # пересобрать иконки из SVG
task check           # lint + test + build
task clean           # удалить сборки и кэши
task clean:all       # удалить также .venv и node_modules
task --list          # показать все команды
```

Параметры запуска можно переопределять:

```bash
task run DEVICE=mps THREADS=8
task run DEVICE=cuda THREADS=8
task setup PYTHON=python3.12
task run LISTEN=127.0.0.1:9876
task build:linux LINUX_ARCH=arm64
```

## Структура репозитория

```text
rechiv/
├── desktop/
│   ├── assets/                 # SVG, PNG и macOS iconset
│   ├── cmd/                    
│   ├── engine/worker.py        # JSONL worker для GigaAM
│   └── internal/               # API, очередь, storage, security
├── extension/
│   ├── src/background/         # service worker
│   ├── src/content/            # WebRTC capture, имена, live-панель
│   ├── src/pages/              # история и транскрипт
│   ├── src/popup/              # popup и настройки
│   └── tests/
├── service/
│   ├── rechiv_engine/
│   │   └── models/transcriber.py
│   ├── tests/
│   └── pyproject.toml
├── .github/workflows/
│   └── ci.yml                  # тесты расширения и Go
└── Taskfile.yml
```

## API

Основные endpoints:

- `GET /health`;
- `GET /auth/token`;
- `POST /sessions`;
- `GET /sessions` и `GET /sessions/{id}`;
- `POST /sessions/{id}/chunks`;
- `POST /sessions/{id}/speakers`;
- `PUT /sessions/{id}/title`;
- `POST /sessions/{id}/finish`;
- `GET /sessions/{id}/live`;
- `GET|PUT /sessions/{id}/transcript`;
- `GET|PUT /sessions/{id}/summary`;
- `DELETE /sessions/{id}`.

## MCP: подключение агента

Сервер читает локальные записи через stdio и работает без запущенного приложения.
Подключение в Claude Code:

```bash
claude mcp add rechiv -- "/Applications/Rechiv.app/Contents/MacOS/rechiv" mcp
```

Для другого расположения укажите путь к бинарю. Каталог записей можно задать
через `mcp -data-dir /путь/к/данным`; по умолчанию используется каталог приложения.

- `rechiv_list_calls` — найти созвон по дате, названию или участнику;
- `rechiv_get_summary` — прочитать саммари отдельно;
- `rechiv_get_transcript` — получить фрагмент по таймкодам `HH:MM:SS` или
  `offset`/`limit` (до 200 сегментов, продолжение через `next_offset`);
- `rechiv_search` — найти текст без учёта регистра и ё/е; каждое совпадение содержит
  ID, название и дату созвона, таймкод, говорящего, текст и индекс сегмента.

MCP только читает записи. Добавляя сервер в конфиг агента, вы открываете ему доступ
к саммари и транскриптам: агент отправляет прочитанные фрагменты своей LLM,
в том числе внешнему провайдеру.

## Ограничения

- поддерживается только Chrome Manifest V3;
- имена участников зависят от DOM и сигналинга площадки; в Телемосте все собеседники
  приходят одним аудиопотоком, и говорящий определяется по сигналингу;
- без MPS или CUDA распознавание может быть заметно медленнее;
- `.app` для macOS собирается командой `task desktop:app`; `.dmg`, `.deb`, `.rpm`
  и AppImage пока не собираются;
- для генерации саммари требуется доступ к внешнему LLM API.

## Документация

Документация ведётся на двух языках; правила — в [CONTRIBUTING.md](CONTRIBUTING.md).

## Лицензия

[MIT](LICENSE).

Редактор саммари использует [Tiptap](https://github.com/ueberdosis/tiptap) (MIT), включая официальное расширение Markdown.
