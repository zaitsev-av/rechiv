#!/bin/sh

set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
TAG="model-gigaam-v3-e2e-ctc-int8"
MODEL_DIR="$ROOT_DIR/build/onnx-int8"

BUILD_DIR="$ROOT_DIR/build" "$ROOT_DIR/scripts/prefetch.sh" >/dev/null

gh release create "$TAG" \
  "$MODEL_DIR/v3_e2e_ctc.int8.onnx" \
  "$MODEL_DIR/v3_e2e_ctc.json" \
  --title "Модель GigaAM v3 e2e CTC, int8" \
  --notes "ONNX-экспорт GigaAM v3 (MIT) с квантованием int8 для сборки Rechiv.app. Собрано командой task model; sha256 — в scripts/prefetch.lock." \
  --latest=false
