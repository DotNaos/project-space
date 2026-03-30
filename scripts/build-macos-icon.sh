#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_ICON="$ROOT_DIR/assets/app_icon.icon/Assets/icon.png"
BUILD_DIR="$ROOT_DIR/build"
ICONSET_DIR="$BUILD_DIR/icon.iconset"
ICNS_PATH="$BUILD_DIR/icon.icns"

if [[ ! -f "$SOURCE_ICON" ]]; then
  echo "Missing source icon at $SOURCE_ICON" >&2
  exit 1
fi

if ! command -v sips >/dev/null 2>&1; then
  echo "sips is required to build the macOS icon." >&2
  exit 1
fi

if ! command -v iconutil >/dev/null 2>&1; then
  echo "iconutil is required to build the macOS icon." >&2
  exit 1
fi

rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

make_icon() {
  local size="$1"
  local output="$2"
  sips -z "$size" "$size" "$SOURCE_ICON" --out "$ICONSET_DIR/$output" >/dev/null
}

make_icon 16 icon_16x16.png
make_icon 32 icon_16x16@2x.png
make_icon 32 icon_32x32.png
make_icon 64 icon_32x32@2x.png
make_icon 128 icon_128x128.png
make_icon 256 icon_128x128@2x.png
make_icon 256 icon_256x256.png
make_icon 512 icon_256x256@2x.png
make_icon 512 icon_512x512.png
cp "$SOURCE_ICON" "$ICONSET_DIR/icon_512x512@2x.png"

mkdir -p "$BUILD_DIR"
iconutil -c icns "$ICONSET_DIR" -o "$ICNS_PATH" >/dev/null
echo "Created $ICNS_PATH"
