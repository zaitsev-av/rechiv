#!/bin/sh
#   scripts/version.sh check [v1.2.3]   сверить файлы, а с аргументом — ещё и тег (v1.2.3-rc1 тоже)
#   scripts/version.sh set 1.2.3        записать версию во все файлы

set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
VERSION_FILE="$ROOT_DIR/VERSION"
FILES="extension/package.json extension/package-lock.json extension/src/manifest.json"

fail() { printf 'error: %s\n' "$1" >&2; exit 1; }

# Первое поле "version" в файле — версия самого пакета, а не зависимостей.
file_version() {
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT_DIR/$1" | head -n 1
}

case "${1:-}" in
  check)
    version="$(tr -d '[:space:]' < "$VERSION_FILE")"
    [ -n "$version" ] || fail "VERSION пуст"
    for file in $FILES; do
      actual="$(file_version "$file")"
      [ "$actual" = "$version" ] || fail "$file: $actual, в VERSION $version — выполни scripts/version.sh set $version"
    done
    if [ -n "${2:-}" ]; then
      # Суффикс пробной сборки (v1.2.3-rc1) к версии не относится.
      tag="${2#v}"
      [ "${tag%%-*}" = "$version" ] || fail "тег $2 не совпадает с VERSION $version"
    fi
    printf '%s\n' "$version"
    ;;
  set)
    version="${2:-}"
    printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "нужна версия вида 1.2.3"
    printf '%s\n' "$version" > "$VERSION_FILE"
    (cd "$ROOT_DIR/extension" && npm version "$version" --no-git-tag-version --allow-same-version >/dev/null)
    manifest="$ROOT_DIR/extension/src/manifest.json"
    sed -i.bak "s/^\([[:space:]]*\"version\"[[:space:]]*:[[:space:]]*\"\)[^\"]*\"/\1$version\"/" "$manifest"
    rm -f "$manifest.bak"
    "$0" check
    ;;
  *)
    fail "использование: $0 check [тег] | set <версия>"
    ;;
esac
