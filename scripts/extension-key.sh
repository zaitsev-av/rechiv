#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY_PATH="$ROOT/build/extension-key.pem"

usage() {
  printf 'Использование: %s [--generate [путь-к-ключу] | путь-к-ключу]\n' "$0" >&2
  exit 2
}

if [[ "${1:-}" == "--generate" ]]; then
  [[ $# -le 2 ]] || usage
  KEY_PATH="${2:-$KEY_PATH}"
  if [[ -e "$KEY_PATH" ]]; then
    printf 'Ключ уже существует: %s\n' "$KEY_PATH" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$KEY_PATH")"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$KEY_PATH"
elif [[ $# -gt 1 ]]; then
  usage
elif [[ $# -eq 1 ]]; then
  KEY_PATH="$1"
fi

if [[ ! -s "$KEY_PATH" ]]; then
  printf 'Ключ не найден: %s\n' "$KEY_PATH" >&2
  exit 1
fi

PUBLIC_KEY="$({ openssl pkey -in "$KEY_PATH" -pubout -outform DER 2>/dev/null; } | openssl base64 -A)"
HEX_ID="$({ openssl pkey -in "$KEY_PATH" -pubout -outform DER 2>/dev/null; } | openssl dgst -sha256 -binary | od -An -tx1 | tr -d '[:space:]' | cut -c1-32)"

# Chromium берёт первые 128 бит SHA-256 от DER SubjectPublicKeyInfo и заменяет
# hex-цифры 0..f на a..p, чтобы ID всегда был допустимой частью имени хоста.
EXTENSION_ID="$(printf '%s' "$HEX_ID" | tr '0123456789abcdef' 'abcdefghijklmnop')"

printf 'key: %s\n' "$PUBLIC_KEY"
printf 'id:  %s\n' "$EXTENSION_ID"
