# Rechiv

**English** · [Русский](README.ru.md)

Rechiv records, transcribes and analyses online calls locally on macOS and Linux.

Supported platforms are Yandex Telemost (`telemost.yandex.ru`), WB Stream
(`stream.wb.ru`) and Google Meet (`meet.google.com`); the architecture lets you add other platforms independently of the
local engine and storage.

The Rechiv extension captures the call's WebRTC audio (per participant in WB Stream
and Google Meet; in Telemost, one mixed stream of the other participants plus your own
microphone),
a Go application manages sessions and the queue, and a long-lived Python/GigaAM worker
recognises speech. Audio and transcripts are never sent to an external STT service.

## Features

- speaker name for every line: from separate streams or from the platform's signalling;
- live transcript during the call;
- a movable, resizable live panel on top of the page;
- history of local recordings;
- transcript editing and export;
- summaries via a configurable OpenAI-compatible LLM API, with manual editing and saved changes available to MCP agents;
- light and dark themes;
- recovery of unfinished jobs after a restart.

## Requirements

- macOS on Apple Silicon or a modern Linux x86-64/ARM64;
- Go 1.27.0 (pinned in `.tool-versions`, install with
  [asdf](https://asdf-vm.com/): `asdf install`);
- Python 3.10–3.13;
- Node.js 22+;
- [Task](https://taskfile.dev/);
- FFmpeg;
- Chrome.

The app ships with the GigaAM model and needs no network for recognition. For development, build
the model once with `task model`: it downloads the GigaAM weights, exports them to ONNX and
quantizes them to int8 in `build/onnx-int8`.

## Development

Run all commands from the repository root:

```bash
task doctor
task setup
task run
```

`task setup` creates `service/.venv` and installs the extension dependencies.
`task run` starts the local Go application on `127.0.0.1:9876`. Its pages open at
`http://rechiv.localhost:9876/`: browsers resolve any `*.localhost` name to this computer.

To develop the extension and the Go application at the same time:

```bash
task dev
```

After the first build open `chrome://extensions`, enable developer mode and choose
“Load unpacked” → `extension/dist`.

## Building for Linux

Linux amd64 and the extension:

```bash
task setup
task build:linux
```

Output:

```text
build/rechiv-linux-amd64
extension/dist/
```

The binary finds the interpreter from `service/.venv` next to itself or higher up the
project tree. If the venv lives elsewhere, pass it explicitly:

```bash
build/rechiv-linux-amd64 -python /path/to/venv/bin/python
```

Engine readiness is visible right after start: `GET /health` returns an `engine`
field with the status `starting`, `ready` or `error` and the error reason.

For Linux ARM64:

```bash
task build:linux LINUX_ARCH=arm64
```

`task build` builds macOS arm64, Linux amd64 and the extension at once.

## Usage

1. Open a call in Telemost, WB Stream or Google Meet.
2. Start recording from the Rechiv menu bar item (“Start recording” appears while the call tab
   is open) or from the extension popup. A folder can also start recording automatically.
3. Open the movable live panel if you need it — from the menu bar item or the popup.
4. Stop the recording after the call.
5. Open the transcript from the menu bar item or the “Sessions” page served by the desktop app;
   the extension's own links redirect there.

The extension closes an audio chunk on a pause in speech; 20 seconds is only a safety
cap for an uninterrupted monologue. That is why the first live line appears soon after
the speaker pauses.

Chunks in which a participant stayed silent are not sent for recognition, and the
GigaAM model is loaded as soon as recording starts, so it is ready for the first chunk.

## Architecture

```text
Telemost / WB Stream / Google Meet
    │ WebRTC audio
    ▼
Rechiv Extension
    │ WebM/Opus chunks
    ▼
Go API · 127.0.0.1:9876
    │ FFmpeg → WAV 16 kHz mono
    ▼
Sequential Go queue
    │ JSON Lines over stdin/stdout
    ▼
Python worker · GigaAM
    │ text segments and timestamps
    ▼
Go storage → live/result/summary
```

Go is responsible for the HTTP API, security, sessions, files, the queue, retries,
finalisation and recovery. Python only loads GigaAM and recognises a prepared WAV file.

Protocol details are in [`desktop/README.md`](desktop/README.md).

## Local data and tokens

Data is stored in:

```text
macOS: ~/Library/Application Support/Rechiv
Linux: ~/.rechiv
```

The API listens on the loopback interface only. Every working endpoint is protected
by a local per-installation Bearer token that the extension obtains automatically.

For manual diagnostics:

```bash
task desktop:token

curl -H "Authorization: Bearer $(task --silent desktop:token)" \
  http://127.0.0.1:9876/sessions
```

The local application token is not an external LLM token. The LLM address, model and token
are set in the Rechiv settings and stored by the desktop application: the token goes to the
macOS Keychain (a file readable only by the owner on other systems), and the desktop app makes
all LLM requests itself. Settings saved by older extension versions are moved to the desktop app
once and erased from the browser.

## Main commands

```bash
task doctor          # check tools
task setup           # install Python and Node.js dependencies
task run             # run the application
task dev             # application + extension watch build
task test            # run all tests
task lint            # run code checks
task build           # build macOS, Linux and the extension
task build:macos     # build macOS arm64 and the extension
task build:linux     # build Linux amd64 and the extension
task icons           # rebuild icons from SVG
task check           # lint + test + build
task clean           # remove builds and caches
task clean:all       # also remove .venv and node_modules
task --list          # list all commands
```

Run parameters can be overridden:

```bash
task run DEVICE=mps THREADS=8
task run DEVICE=cuda THREADS=8
task setup PYTHON=python3.12
task run LISTEN=127.0.0.1:9876
task build:linux LINUX_ARCH=arm64
```

## Repository layout

```text
rechiv/
├── desktop/
│   ├── assets/                 # SVG, PNG and macOS iconset
│   ├── cmd/
│   ├── engine/worker.py        # JSONL worker for GigaAM
│   └── internal/               # API, queue, storage, security
├── extension/
│   ├── src/background/         # service worker
│   ├── src/content/            # WebRTC capture, names, live panel
│   ├── src/pages/              # sessions, transcript, settings (served by desktop)
│   ├── src/popup/              # popup: status and recording
│   └── tests/
├── service/
│   ├── rechiv_engine/
│   │   └── models/transcriber.py
│   ├── tests/
│   └── pyproject.toml
├── .github/workflows/
│   └── ci.yml                  # extension and Go tests
└── Taskfile.yml
```

## API

Main endpoints:

- `GET /health`;
- `GET /auth/token`;
- `POST /sessions`;
- `GET /sessions` and `GET /sessions/{id}`;
- `POST /sessions/{id}/chunks`;
- `POST /sessions/{id}/speakers`;
- `PUT /sessions/{id}/title`;
- `POST /sessions/{id}/finish`;
- `GET /sessions/{id}/live`;
- `GET|PUT /sessions/{id}/transcript`;
- `GET|PUT /sessions/{id}/summary`;
- `POST /sessions/{id}/summary/generate`;
- `GET|PUT /settings/llm`, `POST /settings/llm/check`;
- `POST /calls/poll`;
- `GET /events`;
- `DELETE /sessions/{id}`.

## MCP: connecting an agent

The server reads local recordings over stdio and works without the application running.
Connecting it in Claude Code:

```bash
claude mcp add rechiv -- "/Applications/Rechiv.app/Contents/MacOS/rechiv" mcp
```

For another location, pass the path to the binary. The recordings directory can be set
with `mcp -data-dir /path/to/data`; by default the application's directory is used.

Calls can be organized into virtual folders without moving files on disk. In a call’s ⋯ menu, move it to a folder and enable a rule for its call link. The rule applies to new calls; a dialog offers to move matching past calls. Deleting a folder returns its calls to Inbox. The MCP `folder` filter matches part of a folder name (case-insensitive, ё/е equivalent); `inbox` or `Входящие` selects calls without a folder. List results include the folder name as `folder`.

Folder settings (⋯ in the folder header) offer a title template with `{date}`, `{time}` and `{weekday}` in the machine’s local time. It applies to new calls routed by a link rule and, after confirmation, to existing automatic titles; manual titles and manual moves are preserved. Optional retention deletes calls older than the selected number of days at startup, hourly and immediately after saving, excluding recording and processing calls.

With an LLM connected, `{topic}` adds a short Russian call topic after the transcript is ready; until then, the title omits the topic and its separators. Folder settings can also enable automatic summaries. The desktop app makes one attempt after the transcript is ready, preserves existing summaries (including manual edits), resumes unfinished processing after a restart, and the extension reports the result in the ready notification; summaries can still be generated manually on the transcript page. Without a connected LLM the topic chip and summary toggle are disabled, while saved folder values are preserved.

- `rechiv_list_calls` — find a call by date, title, participant or `folder`;
- `rechiv_get_summary` — read the summary on its own;
- `rechiv_get_transcript` — get a fragment by `HH:MM:SS` timestamps or
  `offset`/`limit` (up to 200 segments, continue with `next_offset`);
- `rechiv_search` — find text ignoring case and ё/е; every match contains the call's
  ID, title and date, the timestamp, the speaker, the text and the segment index.

MCP only reads recordings. By adding the server to an agent's config you give the agent
access to summaries and transcripts: the agent sends what it reads to its LLM, including
an external provider.

## Limitations

- only Chrome Manifest V3 is supported;
- participant names depend on the platform's DOM and signalling; in Telemost all other
  participants arrive as one audio stream and the speaker is determined from signalling;
- in Google Meet the extension decodes the other participants' audio frames itself and
  splits them by source; calls with five or more participants have not been tested yet;
- recognition can be noticeably slower without MPS or CUDA;
- the macOS `.app` is built with `task desktop:app`; `.dmg`, `.deb`, `.rpm` and AppImage
  are not built yet;
- summaries require access to an external LLM API.

## Documentation

Documentation is kept in two languages; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE).

The summary editor uses [Tiptap](https://github.com/ueberdosis/tiptap) (MIT), including its official Markdown extension.
