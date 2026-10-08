#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$ROOT_DIR/build"
ARCHIVE="$BUILD_DIR/prefetch/ffmpeg-source.tar.xz"
OUTPUT="$BUILD_DIR/ffmpeg"

if [ "$(uname -s)" != "Darwin" ]; then
  printf 'This script builds the macOS ffmpeg bundle binary.\n' >&2
  exit 1
fi
if [ ! -f "$ARCHIVE" ]; then
  printf 'FFmpeg source archive not found: %s\n' "$ARCHIVE" >&2
  exit 1
fi
if ! command -v xcrun >/dev/null 2>&1; then
  printf 'xcrun not found; install the Xcode Command Line Tools.\n' >&2
  exit 1
fi

mkdir -p "$BUILD_DIR"
STAGING_DIR="$(mktemp -d "$BUILD_DIR/.ffmpeg-build.XXXXXX")"
cleanup() {
  rm -rf -- "$STAGING_DIR"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

tar -xJf "$ARCHIVE" -C "$STAGING_DIR"
SOURCE_DIR="$STAGING_DIR/ffmpeg-8.1.1"
if [ ! -x "$SOURCE_DIR/configure" ]; then
  printf 'Archive does not contain ffmpeg-8.1.1/configure: %s\n' "$ARCHIVE" >&2
  exit 1
fi

CC="$(xcrun --find clang)"
MACOS_SDK="$(xcrun --sdk macosx --show-sdk-path)"

cd "$SOURCE_DIR"
if ! ./configure \
  --cc="$CC" \
  --sysroot="$MACOS_SDK" \
  --host-cflags="-isysroot $MACOS_SDK" \
  --host-ldflags="-isysroot $MACOS_SDK" \
  --disable-everything \
  --disable-autodetect \
  --enable-static \
  --disable-shared \
  --disable-gpl \
  --disable-nonfree \
  --disable-network \
  --disable-doc \
  --disable-ffplay \
  --disable-ffprobe \
  --disable-avdevice \
  --disable-swscale \
  --disable-debug \
  --disable-runtime-cpudetect \
  --enable-small \
  --enable-pthreads \
  --enable-ffmpeg \
  --enable-protocol=file \
  --enable-demuxer=matroska \
  --enable-decoder=opus \
  --enable-parser=opus \
  --enable-muxer=wav \
  --enable-encoder=pcm_s16le \
  --enable-filter=aresample; then
  printf '\nLast lines from ffbuild/config.log:\n' >&2
  tail -n 80 ffbuild/config.log >&2
  exit 1
fi

BUILD_JOBS="${FFMPEG_BUILD_JOBS:-}"
if [ -z "$BUILD_JOBS" ]; then
  BUILD_JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '1\n')"
fi
case "$BUILD_JOBS" in
  ''|*[!0-9]*|0)
    printf 'FFMPEG_BUILD_JOBS must be a positive integer: %s\n' "$BUILD_JOBS" >&2
    exit 1
    ;;
esac

make -j "$BUILD_JOBS" ffmpeg
xcrun strip ffmpeg

if [ ! -x ffmpeg ]; then
  printf 'FFmpeg build did not produce an executable.\n' >&2
  exit 1
fi
./ffmpeg -hide_banner -version >/dev/null

mv -f -- ffmpeg "$OUTPUT"

printf 'FFmpeg built at %s\n' "$OUTPUT"
printf 'Size: %s\n' "$(du -h "$OUTPUT" | awk '{print $1}')"
