#!/bin/sh
# Упаковывает build/Rechiv.app в build/dist/Rechiv-<версия>-arm64.dmg и пишет рядом sha256.
# Рядом кладёт уведомления о лицензиях и исходники ffmpeg: LGPL требует отдавать их с бинарником.

set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/build"
APP="${APP:-$BUILD_DIR/Rechiv.app}"
VERSION="${VERSION:-$(tr -d '[:space:]' < "$ROOT_DIR/VERSION")}"
DIST="$BUILD_DIR/dist"
DMG="$DIST/Rechiv-$VERSION-arm64.dmg"

fail() { printf 'error: %s\n' "$1" >&2; exit 1; }

[ -d "$APP" ] || fail "нет $APP, собери: task desktop:app"
[ -f "$APP/Contents/Resources/THIRD_PARTY_NOTICES.txt" ] || fail "в $APP нет THIRD_PARTY_NOTICES.txt"
FFMPEG_SOURCE="$BUILD_DIR/prefetch/ffmpeg-source.tar.xz"
FFMPEG_NAME="$(sed -n 's|^prefetch/ffmpeg-source.tar.xz .*/\(ffmpeg-[0-9.]*\.tar\.xz\) .*|\1|p' "$ROOT_DIR/scripts/prefetch.lock")"
[ -f "$FFMPEG_SOURCE" ] && [ -n "$FFMPEG_NAME" ] || fail "нет исходников ffmpeg, выполни scripts/prefetch.sh"
codesign --verify --deep "$APP" || fail "подпись $APP не проверяется"

STAGING="$(mktemp -d "$BUILD_DIR/.dmg.XXXXXX")"
trap 'rm -rf -- "$STAGING"' EXIT

# ditto сохраняет подпись и атрибуты бандла, cp -R может их потерять.
ditto "$APP" "$STAGING/Rechiv.app"
ln -s /Applications "$STAGING/Applications"
cp "$APP/Contents/Resources/THIRD_PARTY_NOTICES.txt" "$STAGING/THIRD_PARTY_NOTICES.txt"

mkdir -p "$DIST"
rm -f "$DMG" "$DMG.sha256" "$DIST"/ffmpeg-*.tar.xz
cp "$APP/Contents/Resources/THIRD_PARTY_NOTICES.txt" "$DIST/THIRD_PARTY_NOTICES.txt"
cp "$FFMPEG_SOURCE" "$DIST/$FFMPEG_NAME"
hdiutil create -quiet -volname "Rechiv $VERSION" -srcfolder "$STAGING" \
  -fs HFS+ -format UDZO -imagekey zlib-level=9 "$DMG"

(cd "$DIST" && shasum -a 256 "$(basename "$DMG")" > "$(basename "$DMG").sha256")
printf 'Готово: %s\n' "$DMG"
du -h "$DMG" | awk '{printf "Размер: %s\n", $1}'
