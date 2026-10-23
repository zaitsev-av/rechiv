#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$ROOT/build"
APP="${APP:-$BUILD/Rechiv.app}"
VERSION="${VERSION:-$(tr -d '[:space:]' < "$ROOT/VERSION")}"

RUNTIME="$BUILD/python"
FFMPEG="$BUILD/ffmpeg"
MODEL="${MODEL:-$BUILD/onnx-int8}"
WEBUI="$BUILD/webui"
EXTENSION="$ROOT/extension/dist"

fail() { printf 'error: %s\n' "$1" >&2; exit 1; }

[ -x "$RUNTIME/bin/python3" ] || fail "нет Python-рантайма, собери: task desktop:python-runtime"
[ -x "$FFMPEG" ]              || fail "нет ffmpeg, собери: task desktop:ffmpeg"
[ -d "$MODEL" ]               || fail "нет модели в $MODEL, собери: task model"
# Без веб-интерфейса трей не сможет показать список созвонов.
[ -f "$WEBUI/index.html" ]    || fail "нет веб-интерфейса, собери: cd extension && npm run build:web"
[ -f "$EXTENSION/manifest.json" ] || fail "нет собранного расширения, собери: task extension:build"

# /health ожидает ту же версию расширения, иначе онбординг ошибочно объявит его устаревшим.
MANIFEST="$EXTENSION/manifest.json"
MANIFEST_VERSION="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MANIFEST")"
[ -n "$MANIFEST_VERSION" ] || fail "не нашёл версию в $MANIFEST"
[ "$MANIFEST_VERSION" = "$VERSION" ] || \
  fail "версии разошлись: приложение $VERSION, расширение $MANIFEST_VERSION — поправь $MANIFEST"

CONTENTS="$APP/Contents"
RESOURCES="$CONTENTS/Resources"

# Удаляем бандл целиком, чтобы не оставить файлы прежней сборки.
rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$RESOURCES"

printf 'Собираю бинарник…\n'
# CGO обязателен: строка меню — это Cocoa.
( cd "$ROOT/desktop" && CGO_ENABLED=1 GOOS=darwin GOARCH=arm64 \
    go build -trimpath -ldflags "-X main.version=$VERSION" \
    -o "$CONTENTS/MacOS/rechiv" ./cmd/rechiv )

printf 'Копирую Python-рантайм…\n'
cp -R "$RUNTIME" "$RESOURCES/python"

# Копируем чистый Python в site-packages: pip удалён из рантайма.
SITE_PACKAGES="$(echo "$RESOURCES"/python/lib/python*/site-packages)"
[ -d "$SITE_PACKAGES" ] || fail "не нашёл site-packages в рантайме"
cp -R "$ROOT/service/rechiv_engine" "$SITE_PACKAGES/rechiv_engine"
find "$SITE_PACKAGES/rechiv_engine" -name __pycache__ -type d -prune -exec rm -rf {} +

printf 'Копирую движок, модель, ffmpeg, интерфейс и расширение…\n'
mkdir -p "$RESOURCES/engine"
cp "$ROOT/desktop/engine/worker.py" "$RESOURCES/engine/worker.py"
cp -R "$MODEL" "$RESOURCES/model"
cp "$FFMPEG" "$RESOURCES/ffmpeg"
cp -R "$WEBUI" "$RESOURCES/webui"
cp -R "$EXTENSION" "$RESOURCES/extension"

if command -v iconutil >/dev/null 2>&1 && [ -d "$ROOT/desktop/assets/Rechiv.iconset" ]; then
  printf 'Собираю иконку…\n'
  iconutil -c icns "$ROOT/desktop/assets/Rechiv.iconset" -o "$RESOURCES/Rechiv.icns"
fi

cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>              <string>Rechiv</string>
	<key>CFBundleDisplayName</key>       <string>Rechiv</string>
	<key>CFBundleIdentifier</key>        <string>app.rechiv</string>
	<key>CFBundleExecutable</key>        <string>rechiv</string>
	<key>CFBundleIconFile</key>          <string>Rechiv</string>
	<key>CFBundlePackageType</key>       <string>APPL</string>
	<key>CFBundleShortVersionString</key><string>$VERSION</string>
	<key>CFBundleVersion</key>           <string>$VERSION</string>
	<key>LSMinimumSystemVersion</key>    <string>11.0</string>
	<key>NSHighResolutionCapable</key>   <true/>
	<!-- LSUIElement скрывает иконку в доке: приложение работает в строке меню. -->
	<key>LSUIElement</key>               <true/>
</dict>
</plist>
PLIST

# Apple Silicon требует подпись бинарников; для распространения вместо ad-hoc нужен Developer ID.
printf 'Подписываю ad-hoc…\n'
codesign --force --deep --sign - "$APP" 2>&1 | sed 's/^/  /' || fail "подпись не прошла"
codesign --verify --deep "$APP" || fail "подпись не проверяется"

printf '\nГотово: %s\n' "$APP"
du -sh "$APP" | awk '{printf "Размер: %s\n", $1}'
printf 'Состав:\n'
du -sh "$RESOURCES"/* "$CONTENTS/MacOS/rechiv" 2>/dev/null | sort -rh | sed 's/^/  /'
