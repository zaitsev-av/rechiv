# Rechiv Desktop

**English** · [Русский](README.ru.md)

The local Rechiv component for macOS and Linux, written in Go. It receives audio chunks
from the Chrome extension, stores session state, manages the queue and keeps one
Python/GigaAM worker in memory.

## Development

Requirements:

- macOS Apple Silicon or Linux amd64/arm64
- Go 1.27.0 (`asdf install` in the repository root)
- Python 3.10–3.13 with the dependencies from `service/`
- ffmpeg

From the project root:

```bash
task setup
task run
```

Other commands are available via `task --list`, for example `task desktop:test`,
`task desktop:test:race`, `task desktop:build` and `task dev`. To force an accelerator,
use `task run DEVICE=mps` on macOS or `task run DEVICE=cuda` on Linux.

By default data is stored in:

```text
macOS: ~/Library/Application Support/Rechiv
Linux: ~/.rechiv
```

Linux amd64 build:

```bash
task desktop:build:linux
```

Linux ARM64 build:

```bash
task desktop:build:linux LINUX_ARCH=arm64
```

The application icon source is `desktop/assets/icon.svg`. The Linux PNG and the full
macOS iconset can be rebuilt from the repository root:

```bash
task desktop:icons:macos
```

The API listens on `127.0.0.1:9876` only. Every endpoint except `/health` and the
bootstrap `/auth/token` is protected by a unique per-installation Bearer token.

The extension obtains this token automatically. For manual diagnostics print it with
`task desktop:token` and pass it in the `Authorization: Bearer <token>` header. It is not
an external LLM token.

The recognition queue is sequential, so when it falls behind, the worker takes the
freshest chunk of the recording: the live panel is for the current conversation, and the
backlog is still processed before finalisation. While the queue is short it is strict FIFO.

The Python engine additionally splits the received WAV on pauses and recognises every
speech interval separately. This gives real timestamps instead of one mark per chunk,
and silence never reaches the model.

On start the application checks the worker with a `ping` command and logs the chosen
interpreter and `worker.py`. The result is available in `GET /health` in the `engine`
field (`starting`, `ready`, `error`). Without this check a broken Python environment
would only show up on the first recognition — tens of seconds into a recording.

The default interpreter comes from `service/.venv`: it is looked up next to the binary
and higher up the project tree, and only then in `PATH`. Override it with the `-python`
flag.

Recognition is sequential, so the queue is bounded. When it is full,
`POST /sessions/{id}/chunks` answers `503` with a `Retry-After` header: the chunk is
neither accepted nor lost, and the extension retries the upload.

During a recording every finished audio chunk goes straight into the shared live
transcript. The extension polls `GET /sessions/{id}/live` every two seconds; the response
contains the recognised segments, the session status and the chunk progress. After the
recording ends the same screen switches to the final `result.json`, where editing and
summaries are available.

## Go/Python boundary

Go is responsible for the application lifecycle, the HTTP API, security, sessions, the
queue, progress, recovery and finalisation. The Python worker receives the path to a
WAV file and returns recognition segments as JSON Lines over stdin/stdout.
