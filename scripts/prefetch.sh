#!/bin/sh
# Скачивает исходники сборки .app по scripts/prefetch.lock и сверяет sha256.
# Уже скачанный файл с верной суммой не перекачивается.
#
#   MODEL_BASE_URL=https://github.com/<owner>/rechiv/releases/download/model-gigaam-v3-e2e-ctc-int8 \
#     scripts/prefetch.sh
#
# Без MODEL_BASE_URL модель не качается, но уже лежащая в build/onnx-int8 проверяется.

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="${BUILD_DIR:-$ROOT_DIR/build}"
LOCK="$SCRIPT_DIR/prefetch.lock"
MODEL_BASE_URL="${MODEL_BASE_URL:-}"

sha256() { shasum -a 256 "$1" | awk '{print $1}'; }

failed=0
grep -v '^#' "$LOCK" | grep -v '^[[:space:]]*$' | while read -r path url expected; do
  target="$BUILD_DIR/$path"
  if [ -f "$target" ] && [ "$(sha256 "$target")" = "$expected" ]; then
    printf 'ok      %s\n' "$path"
    continue
  fi

  case "$url" in
    "{model}"*)
      if [ -z "$MODEL_BASE_URL" ]; then
        printf 'error: нет %s, задай MODEL_BASE_URL или собери модель: task model\n' "$path" >&2
        exit 1
      fi
      url="$MODEL_BASE_URL${url#\{model\}}"
      ;;
  esac

  mkdir -p "$(dirname "$target")"
  printf 'скачиваю %s\n' "$path"
  curl -fsSL --retry 3 -o "$target.part" "$url"
  actual="$(sha256 "$target.part")"
  if [ "$actual" != "$expected" ]; then
    rm -f "$target.part"
    printf 'error: sha256 %s не совпал: %s, ожидали %s\n' "$path" "$actual" "$expected" >&2
    exit 1
  fi
  mv "$target.part" "$target"
done || failed=1

[ "$failed" -eq 0 ] || exit 1
