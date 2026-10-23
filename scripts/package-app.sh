#!/bin/sh
# Упаковывает build/Rechiv.app в build/dist/Rechiv-<версия>-arm64.dmg и пишет рядом sha256.

set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/build"
APP="${APP:-$BUILD_DIR/Rechiv.app}"
VERSION="${VERSION:-$(tr -d '[:space:]' < "$ROOT_DIR/VERSION")}"
DIST="$BUILD_DIR/dist"
DMG="$DIST/Rechiv-$VERSION-arm64.dmg"

fail() { printf 'error: %s\n' "$1" >&2; exit 1; }

[ -d "$APP" ] || fail "нет $APP, собери: task desktop:app"
codesign --verify --deep "$APP" || fail "подпись $APP не проверяется"

STAGING="$(mktemp -d "$BUILD_DIR/.dmg.XXXXXX")"
trap 'rm -rf -- "$STAGING"' EXIT

# ditto сохраняет подпись и атрибуты бандла, cp -R может их потерять.
ditto "$APP" "$STAGING/Rechiv.app"
ln -s /Applications "$STAGING/Applications"

mkdir -p "$DIST"
rm -f "$DMG" "$DMG.sha256"
hdiutil create -quiet -volname "Rechiv $VERSION" -srcfolder "$STAGING" \
  -fs HFS+ -format UDZO -imagekey zlib-level=9 "$DMG"

(cd "$DIST" && shasum -a 256 "$(basename "$DMG")" > "$(basename "$DMG").sha256")
printf 'Готово: %s\n' "$DMG"
du -h "$DMG" | awk '{printf "Размер: %s\n", $1}'
