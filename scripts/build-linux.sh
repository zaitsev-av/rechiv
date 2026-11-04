#!/usr/bin/env bash
# Собирает Linux-сборку: build/rechiv-<версия>-linux-x86_64/ с бинарником и resources/,
# и упаковывает её в build/dist/Rechiv-<версия>-linux-x86_64.tar.gz с sha256.
# Бинарник сам находит resources/ рядом с собой — так же, как Resources в Rechiv.app.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$ROOT/build"
VERSION="${VERSION:-$(tr -d '[:space:]' < "$ROOT/VERSION")}"
PLATFORM=linux-x86_64
NAME="rechiv-$VERSION-$PLATFORM"
OUT="$BUILD/$NAME"
DIST="$BUILD/dist"
ARCHIVE="$DIST/Rechiv-$VERSION-$PLATFORM.tar.gz"

RUNTIME="$BUILD/python"
FFMPEG="$BUILD/ffmpeg"
MODEL="${MODEL:-$BUILD/onnx-int8}"
WEBUI="$BUILD/webui"
EXTENSION="$ROOT/extension/dist"

fail() { printf 'error: %s\n' "$1" >&2; exit 1; }

[ "$("$ROOT/scripts/platform.sh")" = "$PLATFORM" ] || fail "собирать нужно на $PLATFORM: рантайм и ffmpeg платформенные"
[ -x "$RUNTIME/bin/python3" ]     || fail "нет Python-рантайма, собери: scripts/build-python-runtime.sh"
[ -x "$FFMPEG" ]                  || fail "нет ffmpeg, собери: scripts/build-ffmpeg.sh"
[ -d "$MODEL" ]                   || fail "нет модели в $MODEL, выполни scripts/prefetch.sh"
[ -f "$WEBUI/index.html" ]        || fail "нет веб-интерфейса, собери: task extension:build:web"
[ -f "$EXTENSION/manifest.json" ] || fail "нет собранного расширения, собери: task extension:build"

MANIFEST_VERSION="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$EXTENSION/manifest.json")"
[ "$MANIFEST_VERSION" = "$VERSION" ] || \
  fail "версии разошлись: приложение $VERSION, расширение $MANIFEST_VERSION"

RESOURCES="$OUT/resources"
rm -rf "$OUT"
mkdir -p "$RESOURCES/engine"

printf 'Собираю бинарник…\n'
( cd "$ROOT/desktop" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags "-X main.version=$VERSION" -o "$OUT/rechiv" ./cmd/rechiv )

printf 'Копирую Python-рантайм, движок, модель, ffmpeg, интерфейс и расширение…\n'
cp -R "$RUNTIME" "$RESOURCES/python"
SITE_PACKAGES="$(echo "$RESOURCES"/python/lib/python*/site-packages)"
[ -d "$SITE_PACKAGES" ] || fail "не нашёл site-packages в рантайме"
cp -R "$ROOT/service/rechiv_engine" "$SITE_PACKAGES/rechiv_engine"
find "$SITE_PACKAGES/rechiv_engine" -name __pycache__ -type d -prune -exec rm -rf {} +
cp "$ROOT/desktop/engine/worker.py" "$RESOURCES/engine/worker.py"
cp -R "$MODEL" "$RESOURCES/model"
cp "$FFMPEG" "$RESOURCES/ffmpeg"
cp -R "$WEBUI" "$RESOURCES/webui"
cp -R "$EXTENSION" "$RESOURCES/extension"
cp "$ROOT/desktop/assets/icon-256.png" "$RESOURCES/rechiv.png"

printf 'Собираю уведомления о лицензиях…\n'
python3 "$ROOT/scripts/third-party-notices.py" "$RESOURCES" "$OUT/THIRD_PARTY_NOTICES.txt" "$PLATFORM" \
  || fail "не собрал THIRD_PARTY_NOTICES.txt"

cat > "$OUT/README.txt" <<README
Rechiv $VERSION for Linux x86-64

Run:
  ./rechiv

The tray icon needs a desktop with StatusNotifierItem support (KDE, XFCE, Cinnamon;
on GNOME install the "AppIndicator and KStatusNotifierItem Support" extension).
Data lives in ~/.rechiv. The browser extension is synced to ~/.rechiv/extension:
load it in Chrome/Chromium/Brave via chrome://extensions → Developer mode →
Load unpacked. Onboarding opens on first start.

Third-party licenses: THIRD_PARTY_NOTICES.txt.
README

# Готовая сборка должна запуститься: движок с моделью и ffmpeg — то, что ломается от платформы.
"$RESOURCES/python/bin/python3" -I -B -c \
  'import numpy, onnxruntime; print("python ok", numpy.__version__, onnxruntime.__version__)'
"$RESOURCES/ffmpeg" -hide_banner -version | head -n 1

mkdir -p "$DIST"
rm -f "$ARCHIVE" "$ARCHIVE.sha256"
tar -C "$BUILD" -czf "$ARCHIVE" "$NAME"
( cd "$DIST" && sha256sum "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256" )
cp "$OUT/THIRD_PARTY_NOTICES.txt" "$DIST/THIRD_PARTY_NOTICES-$PLATFORM.txt"

printf '\nГотово: %s\n' "$ARCHIVE"
du -h "$ARCHIVE" | awk '{printf "Размер: %s\n", $1}'
du -sh "$RESOURCES"/* "$OUT/rechiv" | sort -rh | sed 's/^/  /'
