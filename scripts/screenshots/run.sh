#!/bin/sh
# Скриншоты для README: настоящее приложение на вымышленных данных во временном каталоге,
# светлая и тёмная тема. Результат — docs/images/*.png.
#
#   task docs:screenshots
#
# Нужны собранный веб-интерфейс (task extension:build:web), service/.venv и модель
# build/onnx-int8, как для task run. Пока идёт съёмка, в строке меню виден второй значок Rechiv.

set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
OUT_DIR="$ROOT_DIR/docs/images"
LISTEN="127.0.0.1:${SCREENSHOTS_PORT:-9877}"
BINARY="$ROOT_DIR/build/rechiv-screenshots"
WIDTH="${SCREENSHOTS_WIDTH:-1600}"

fail() { printf 'error: %s\n' "$1" >&2; exit 1; }

[ -f "$ROOT_DIR/build/webui/index.html" ] || fail "нет веб-интерфейса, собери: task extension:build:web"
[ -x "$ROOT_DIR/service/.venv/bin/python" ] || fail "нет service/.venv, выполни: task setup"

DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rechiv-screenshots.XXXXXX")"
APP_PID=""
cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null && wait "$APP_PID" 2>/dev/null
  rm -rf -- "$DATA_DIR" "$BINARY"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

SESSION_ID="$(python3 "$ROOT_DIR/scripts/screenshots/seed.py" "$DATA_DIR")"

(cd "$ROOT_DIR/desktop" && go build -o "$BINARY" ./cmd/rechiv)
"$BINARY" \
  -listen "$LISTEN" \
  -data-dir "$DATA_DIR" \
  -python "$ROOT_DIR/service/.venv/bin/python" \
  -engine-worker "$ROOT_DIR/desktop/engine/worker.py" \
  -service-dir "$ROOT_DIR/service" \
  -onnx-model-dir "$ROOT_DIR/build/onnx-int8" \
  > "$DATA_DIR/app.log" 2>&1 &
APP_PID=$!

for _ in $(seq 1 100); do
  curl -fs "http://$LISTEN/health" >/dev/null 2>&1 && break
  sleep 0.2
done
curl -fs "http://$LISTEN/health" >/dev/null || { cat "$DATA_DIR/app.log" >&2; fail "приложение не поднялось"; }
TOKEN="$(cat "$DATA_DIR/api_token")"

mkdir -p "$OUT_DIR"
BASE="http://rechiv.localhost:${LISTEN##*:}"
for theme in light dark; do
  curl -fs -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"theme\":\"$theme\",\"palette\":\"graphite\"}" "http://$LISTEN/settings/appearance" >/dev/null
  node "$ROOT_DIR/scripts/screenshots/capture.mjs" "$BASE" "$SESSION_ID" "$theme" "$OUT_DIR"
done

# Съёмка в 2×, для README хватает ширины 1600 px.
for file in "$OUT_DIR"/*.png; do
  sips --resampleWidth "$WIDTH" "$file" >/dev/null
done
du -ch "$OUT_DIR"/*.png | tail -n 1
