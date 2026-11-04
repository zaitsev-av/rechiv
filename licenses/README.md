# Лицензии сторонних компонентов

Тексты, которых нет в самой сборке. Остальные `scripts/third-party-notices.py` берёт из того,
что попадает в бандл: колёса Python, модули Go, пакеты npm, исходники ffmpeg.

| Каталог | Откуда |
| --- | --- |
| `python-build-standalone/` | `python/licenses/` из `cpython-3.13.14+20260728-aarch64-apple-darwin-pgo+lto-full.tar.zst` (sha256 `85c6b957…d20b`) — только компоненты, которые вшиты в рантайм по `PYTHON.json`: ncurses, libedit и zlib на macOS системные, Tcl/Tk вырезаны |
| `gigaam/` | `LICENSE` из [salute-developers/GigaAM](https://github.com/salute-developers/GigaAM) @ `7447938` |
| `flatbuffers/` | `LICENSE` из [google/flatbuffers](https://github.com/google/flatbuffers) @ `f58d576`: в колесе его нет |

При смене релиза Python в `scripts/prefetch.lock` сверьте список с `PYTHON.json` нового релиза.
