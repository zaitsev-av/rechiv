#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$ROOT_DIR/build"
ARCHIVE="$BUILD_DIR/prefetch/cpython-arm64-darwin.tar.gz"
WHEEL_DIR="$BUILD_DIR/prefetch/wheels"
RUNTIME_DIR="$BUILD_DIR/python"

if [ ! -f "$ARCHIVE" ]; then
  printf 'Python archive not found: %s\n' "$ARCHIVE" >&2
  exit 1
fi
if [ ! -d "$WHEEL_DIR" ]; then
  printf 'Wheel directory not found: %s\n' "$WHEEL_DIR" >&2
  exit 1
fi

mkdir -p "$BUILD_DIR"
STAGING_DIR="$(mktemp -d "$BUILD_DIR/.python-runtime.XXXXXX")"
cleanup() {
  rm -rf -- "$STAGING_DIR"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

tar -xzf "$ARCHIVE" -C "$STAGING_DIR"
STAGED_RUNTIME="$STAGING_DIR/python"
PYTHON="$STAGED_RUNTIME/bin/python3"
STDLIB="$STAGED_RUNTIME/lib/python3.13"
SITE_PACKAGES="$STDLIB/site-packages"

if [ ! -x "$PYTHON" ]; then
  printf 'Archive does not contain python/bin/python3: %s\n' "$ARCHIVE" >&2
  exit 1
fi

# Isolated mode prevents local packages from masking missing prefetched wheels.
PIP_CONFIG_FILE=/dev/null \
PIP_DISABLE_PIP_VERSION_CHECK=1 \
PIP_NO_CACHE_DIR=1 \
  "$PYTHON" -I -B -m pip install \
    --no-index \
    --find-links "$WHEEL_DIR" \
    --only-binary=:all: \
    --no-compile \
    --no-warn-script-location \
    numpy onnxruntime

BEFORE_KIB="$(du -sk "$STAGED_RUNTIME" | awk '{print $1}')"
BEFORE_HUMAN="$(du -sh "$STAGED_RUNTIME" | awk '{print $1}')"

remove_paths() {
  for path in "$@"; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      rm -rf -- "$path"
    fi
  done
}

remove_paths \
  "$STAGED_RUNTIME/include" \
  "$STAGED_RUNTIME/share" \
  "$STAGED_RUNTIME/lib/pkgconfig" \
  "$STAGED_RUNTIME/lib/libpython3.13.dylib" \
  "$STDLIB/config-3.13-darwin" \
  "$STDLIB/ensurepip" \
  "$SITE_PACKAGES/pip" \
  "$SITE_PACKAGES"/pip-*.dist-info \
  "$SITE_PACKAGES/setuptools" \
  "$SITE_PACKAGES"/setuptools-*.dist-info \
  "$SITE_PACKAGES/pkg_resources" \
  "$SITE_PACKAGES/_distutils_hack" \
  "$SITE_PACKAGES/distutils-precedence.pth"

remove_paths \
  "$STAGED_RUNTIME/bin/idle3" \
  "$STAGED_RUNTIME/bin/idle3.13" \
  "$STAGED_RUNTIME/bin/pip" \
  "$STAGED_RUNTIME/bin/pip3" \
  "$STAGED_RUNTIME/bin/pip3.13" \
  "$STAGED_RUNTIME/bin/pydoc3" \
  "$STAGED_RUNTIME/bin/pydoc3.13" \
  "$STAGED_RUNTIME/bin/python3-config" \
  "$STAGED_RUNTIME/bin/python3.13-config" \
  "$STAGED_RUNTIME/bin/2to3" \
  "$STAGED_RUNTIME/bin/2to3-3.13" \
  "$STAGED_RUNTIME/bin/f2py" \
  "$STAGED_RUNTIME/bin/numpy-config" \
  "$STAGED_RUNTIME/bin/onnxruntime_test"

remove_paths \
  "$STDLIB/test" \
  "$STDLIB/tests" \
  "$STDLIB/idlelib" \
  "$STDLIB/tkinter" \
  "$STDLIB/lib2to3" \
  "$STDLIB/turtledemo" \
  "$STDLIB/turtle.py" \
  "$STDLIB/pydoc.py" \
  "$STDLIB/pydoc_data" \
  "$STDLIB/lib-dynload/_tkinter.cpython-313-darwin.so" \
  "$STAGED_RUNTIME/lib/tcl9" \
  "$STAGED_RUNTIME/lib/tcl9.0" \
  "$STAGED_RUNTIME/lib/tk9.0" \
  "$STAGED_RUNTIME/lib/itcl4.3.5" \
  "$STAGED_RUNTIME/lib/thread3.0.4" \
  "$STAGED_RUNTIME/lib/libtcl9.0.dylib" \
  "$STAGED_RUNTIME/lib/libtcl9tk9.0.dylib"

# Inference needs neither NumPy development files nor ONNX model tooling.
# ONNX Runtime's standalone C API dylib is not linked by the Python extension.
find "$SITE_PACKAGES" -type d \( -name test -o -name tests \) -prune -exec rm -rf -- {} +
remove_paths \
  "$SITE_PACKAGES/numpy/f2py" \
  "$SITE_PACKAGES/numpy/testing" \
  "$SITE_PACKAGES/numpy/_pyinstaller" \
  "$SITE_PACKAGES/onnxruntime/backend" \
  "$SITE_PACKAGES/onnxruntime/datasets" \
  "$SITE_PACKAGES/onnxruntime/quantization" \
  "$SITE_PACKAGES/onnxruntime/tools" \
  "$SITE_PACKAGES/onnxruntime/transformers" \
  "$SITE_PACKAGES/onnxruntime/capi/libonnxruntime.1.28.0.dylib"
find "$SITE_PACKAGES" -type f \( \
  -name '*.h' -o -name '*.pxd' -o -name '*.pyi' \
\) -delete
find "$STAGED_RUNTIME" -type d -name __pycache__ -prune -exec rm -rf -- {} +
find "$STAGED_RUNTIME" -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete

"$PYTHON" -I -B -c \
  'import numpy, onnxruntime; print(numpy.__version__, onnxruntime.__version__)'

AFTER_KIB="$(du -sk "$STAGED_RUNTIME" | awk '{print $1}')"
AFTER_HUMAN="$(du -sh "$STAGED_RUNTIME" | awk '{print $1}')"

rm -rf -- "$RUNTIME_DIR"
mv "$STAGED_RUNTIME" "$RUNTIME_DIR"

printf 'Python runtime built at %s\n' "$RUNTIME_DIR"
printf 'Size before cleanup: %s (%s KiB)\n' "$BEFORE_HUMAN" "$BEFORE_KIB"
printf 'Size after cleanup:  %s (%s KiB)\n' "$AFTER_HUMAN" "$AFTER_KIB"
