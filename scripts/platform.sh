#!/bin/sh
# Платформа сборки в терминах prefetch.lock: darwin-arm64 или linux-x86_64.

set -eu

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) echo darwin-arm64 ;;
  Linux-x86_64) echo linux-x86_64 ;;
  *) printf 'error: сборка для %s-%s не поддерживается\n' "$(uname -s)" "$(uname -m)" >&2; exit 1 ;;
esac
