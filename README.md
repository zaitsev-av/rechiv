# Rechiv

**English** · [Русский](README.ru.md)

Rechiv records, transcribes and analyses online calls locally on macOS and Linux.
The app lives in the menu bar, a browser extension captures the call audio, and speech
is recognised on your computer by the GigaAM model.

Supported platforms are Yandex Telemost (`telemost.yandex.ru`), WB Stream
(`stream.wb.ru`) and Google Meet (`meet.google.com`); the architecture lets you add other platforms independently of the
local engine and storage.

The Rechiv extension captures the call's WebRTC audio (per participant in WB Stream
and Google Meet; in Telemost, one mixed stream of the other participants plus your own
microphone),
a Go application manages sessions and the queue, and a long-lived Python worker
recognises speech with GigaAM (ONNX, int8, on CPU). Audio and transcripts are never sent to an external STT service.

## Features

- a menu bar app: recording status, start and stop recording of the open call;
- speaker name for every line: from separate streams or from the platform's signalling;
- live transcript during the call;
- a movable, resizable live panel on top of the page;
- call history with virtual folders, call-link rules and retention;
- transcript editing and export;
- summaries via a configurable OpenAI-compatible LLM API: on demand or automatically
  for a folder, with manual editing; generation continues even if you close the page;
- call titles from a folder template, with a topic from the LLM;
- an MCP server so agents can read recordings;
- light and dark themes, three palettes;
- recovery of unfinished jobs after a restart.

## Installation

A ready build for macOS on Apple Silicon is in
[Releases](https://github.com/zaitsev-av/rechiv/releases): download
`Rechiv-<version>-arm64.dmg` and drag `Rechiv.app` to Applications. A `.sha256` file
next to it lets you verify the download.

The app is signed without a Developer ID, so on first launch macOS warns that it cannot
verify the developer. Open it via the context menu → “Open” or allow it in
“System Settings → Privacy & Security”.

On first launch Rechiv shows how to connect the extension: it lives in the app's data
folder and is loaded into the browser as an unpacked extension in developer mode.
Chrome, Edge, Brave, Vivaldi and other Chromium browsers work. For summaries, set the
address, model and token of an OpenAI-compatible LLM in the settings.

## Development requirements

- macOS on Apple Silicon or a modern Linux x86-64/ARM64;
- Go — the version from `desktop/go.mod` (currently 1.27.0);
- Python 3.10–3.13;
- Node.js 22+;
- [Task](https://taskfile.dev/);
- FFmpeg;
- a Chromium browser.

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

## Building Rechiv.app

`Rechiv.app` for macOS on Apple Silicon bundles the Python runtime, the model, ffmpeg, the web
interface and the extension:

```bash
task prefetch          # download sources from scripts/prefetch.lock, verifying sha256
task desktop:python-runtime
task desktop:ffmpeg
task desktop:app       # build/Rechiv.app
task desktop:package   # build/dist/Rechiv-<version>-arm64.dmg and .sha256
```

`task prefetch` takes the model from the `model-gigaam-v3-e2e-ctc-int8` release
(`MODEL_BASE_URL=https://github.com/zaitsev-av/rechiv/releases/download/model-gigaam-v3-e2e-ctc-int8`);
alternatively build it locally with `task model`.

The app version lives in `VERSION`; `task version` checks it against the extension, and
`task version:set -- 1.2.3` writes a new one to every file. A `v1.2.3` tag runs
`.github/workflows/release.yml`, which builds on a macOS runner and publishes a release with the
`.dmg`; a tag with a suffix (`v1.2.3-rc1`) creates a pre-release.

## Usage

1. Open a call in Telemost, WB Stream or Google Meet.
2. Start recording from the Rechiv menu bar item (“Start recording” appears while the call tab
   is open) or from the extension popup. A folder with a call-link rule can also start
   recording automatically.
3. Open the movable live panel if you need it — from the menu bar item or the popup.
4. Stop the recording after the call.
5. Open the transcript from the menu bar item or the “Sessions” page served by the desktop app;
   the extension's own links redirect there.

The extension closes an audio chunk on a pause in speech; 20 seconds is only a safety
cap for an uninterrupted monologue. That is why the first live line appears soon after
the speaker pauses.

Chunks in which a participant stayed silent are not sent for recognition, and the
GigaAM model is loaded as soon as recording starts, so it is ready for the first chunk.

### Folders

Calls can be organized into virtual folders without moving files on disk. In a call’s ⋯ menu, move it to a folder and enable a rule for its call link. The rule applies to new calls; a dialog offers to move matching past calls. Deleting a folder returns its calls to Inbox.

Folder settings (⋯ in the folder header) offer a title template with `{date}`, `{time}` and `{weekday}` in the machine’s local time, retention in days, and a “Record automatically” switch that starts recording when you join a call by the folder's link. The template applies to new calls routed by a link rule and, after confirmation, to existing automatic titles; manual titles and manual moves are preserved. Optional retention deletes calls older than the selected number of days at startup, hourly and immediately after saving, excluding recording and processing calls.

With an LLM connected, `{topic}` adds a short Russian call topic after the transcript is ready; until then, the title omits the topic and its separators. Folder settings can also enable automatic summaries. The desktop app makes one attempt after the transcript is ready, preserves existing summaries (including manual edits), resumes unfinished processing after a restart, and the extension reports the result in the ready notification; summaries can still be generated manually on the transcript page. Without a connected LLM the topic chip and summary toggle are disabled, while saved folder values are preserved.

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
task prefetch        # download the .app build sources
task desktop:app     # build Rechiv.app
task desktop:package # package the .app into a .dmg
task version         # check the app and extension versions
task icons           # rebuild icons from SVG
task check           # lint + test + build
task clean           # remove builds and caches
task clean:all       # also remove .venv and node_modules
task --list          # list all commands
```

Run parameters can be overridden:

```bash
task run THREADS=8
task run ENGINE=torch DEVICE=mps   # GigaAM on torch instead of ONNX; needs torch in service/.venv
task setup PYTHON=python3.12
task run LISTEN=127.0.0.1:9876
task build:linux LINUX_ARCH=arm64
```

## Repository layout

```text
rechiv/
├── desktop/
│   ├── assets/                 # SVG, PNG and macOS iconset
│   ├── cmd/rechiv/             # the app and the mcp command
│   ├── engine/worker.py        # JSONL worker for GigaAM
│   └── internal/               # API, queue, storage, security
├── extension/
│   ├── src/background/         # service worker
│   ├── src/content/            # WebRTC capture, platform adapters, live panel
│   ├── src/pages/              # sessions, transcript, settings (served by desktop)
│   ├── src/popup/              # popup: status and recording
│   └── tests/
├── service/
│   ├── rechiv_engine/models/   # GigaAM on ONNX and torch, splitting by pauses
│   ├── tools/                  # model export to ONNX and quantization
│   ├── tests/
│   └── pyproject.toml
├── scripts/                    # runtime, ffmpeg, .app and .dmg builds, versioning
├── .github/workflows/
│   ├── ci.yml                  # extension and Go tests
│   └── release.yml             # .dmg release on a tag
├── VERSION
└── Taskfile.yml
```

## API

Main endpoints:

- `GET /health`, `GET /auth/token`;
- `POST /sessions`, `GET /sessions`, `GET|DELETE /sessions/{id}`;
- `POST /sessions/{id}/chunks`, `/speakers`, `/vad`, `/finish`, `/retry`;
- `PUT /sessions/{id}/title`, `/topic`, `/folder`;
- `GET /sessions/{id}/live`;
- `GET|PUT /sessions/{id}/transcript`;
- `GET|PUT /sessions/{id}/summary`, `POST /sessions/{id}/summary/generate`;
- `GET|POST /folders`, `PATCH|DELETE /folders/{id}`, `PUT /folders/{id}/settings`,
  folder rules, titles and retention;
- `GET|PUT /settings/llm`, `POST /settings/llm/check`, `GET|PUT /settings/appearance`;
- `GET /onboarding/state`;
- `POST /calls/poll`;
- `GET /events`.

## MCP: connecting an agent

The server reads local recordings over stdio and works without the application running.
Connecting it in Claude Code:

```bash
claude mcp add rechiv -- "/Applications/Rechiv.app/Contents/MacOS/rechiv" mcp
```

For another location, pass the path to the binary. The recordings directory can be set
with `mcp -data-dir /path/to/data`; by default the application's directory is used.

The `folder` filter matches part of a folder name (case-insensitive, ё/е equivalent);
`inbox` or `Входящие` selects calls without a folder. List results include the folder name
as `folder`.

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

- only Chromium browsers (Manifest V3) are supported; the extension is installed unpacked
  in developer mode;
- participant names depend on the platform's DOM and signalling; in Telemost all other
  participants arrive as one audio stream and the speaker is determined from signalling;
- in Google Meet the extension decodes the other participants' audio frames itself and
  splits them by source; calls with five or more participants have not been tested yet;
- a ready build exists only for macOS on Apple Silicon; it is signed without a Developer ID
  and not notarized; there are no automatic updates yet — download new versions from Releases;
- on Linux only the binary is built; `.deb`, `.rpm` and AppImage packages are not;
- summaries require access to an external LLM API.

## Documentation

Documentation is kept in two languages; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE).

The summary editor uses [Tiptap](https://github.com/ueberdosis/tiptap) (MIT), including its official Markdown extension.
