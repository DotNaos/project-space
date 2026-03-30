#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHANNEL="${RELEASE_CHANNEL:-local}"
DEFAULT_SOURCE_ICON="$ROOT_DIR/assets/app_icon.icon/Assets/icon.png"
EXPORTS_DIR="$ROOT_DIR/assets/app_icon Exports"
BUILD_DIR="$ROOT_DIR/build"
ICONSET_DIR="$BUILD_DIR/icon.iconset"
ICNS_PATH="$BUILD_DIR/icon.icns"
RUNTIME_ICON_DIR="$BUILD_DIR/runtime-icons"
PADDED_SOURCE_ICON="$BUILD_DIR/padded-source.png"
PADDED_LIGHT_ICON="$RUNTIME_ICON_DIR/light.png"
PADDED_DARK_ICON="$RUNTIME_ICON_DIR/dark.png"

select_icon_source() {
  local tone="$1"

  case "$CHANNEL:$tone" in
    stable:dark)
      echo "$EXPORTS_DIR/app_icon-iOS-Dark-1024x1024@1x.png"
      ;;
    stable:light)
      echo "$EXPORTS_DIR/app_icon-iOS-Default-1024x1024@1x.png"
      ;;
    dev:dark)
      echo "$EXPORTS_DIR/app_icon-iOS-TintedDark-1024x1024@1x.png"
      ;;
    dev:light)
      echo "$EXPORTS_DIR/app_icon-iOS-TintedLight-1024x1024@1x.png"
      ;;
    canary:dark)
      echo "$EXPORTS_DIR/app_icon-iOS-ClearDark-1024x1024@1x.png"
      ;;
    canary:light)
      echo "$EXPORTS_DIR/app_icon-iOS-ClearLight-1024x1024@1x.png"
      ;;
    local:dark)
      echo "$EXPORTS_DIR/app_icon-iOS-TintedDark-1024x1024@1x.png"
      ;;
    local:light)
      echo "$EXPORTS_DIR/app_icon-iOS-TintedLight-1024x1024@1x.png"
      ;;
    *)
      echo "$DEFAULT_SOURCE_ICON"
      ;;
  esac
}

pad_icon() {
  local source_icon="$1"
  local output_icon="$2"
  magick "$source_icon" -background none -gravity center -resize 78% -extent 1024x1024 "$output_icon"
}

SOURCE_ICON="$(select_icon_source dark)"
LIGHT_SOURCE_ICON="$(select_icon_source light)"
if [[ ! -f "$LIGHT_SOURCE_ICON" ]]; then
  LIGHT_SOURCE_ICON="$SOURCE_ICON"
fi

if [[ ! -f "$SOURCE_ICON" ]]; then
  SOURCE_ICON="$DEFAULT_SOURCE_ICON"
fi

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
rm -rf "$RUNTIME_ICON_DIR"
mkdir -p "$ICONSET_DIR"
mkdir -p "$RUNTIME_ICON_DIR"

pad_icon "$SOURCE_ICON" "$PADDED_SOURCE_ICON"
pad_icon "$LIGHT_SOURCE_ICON" "$PADDED_LIGHT_ICON"
pad_icon "$SOURCE_ICON" "$PADDED_DARK_ICON"

make_icon() {
  local size="$1"
  local output="$2"
  sips -z "$size" "$size" "$PADDED_SOURCE_ICON" --out "$ICONSET_DIR/$output" >/dev/null
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
cp "$PADDED_SOURCE_ICON" "$ICONSET_DIR/icon_512x512@2x.png"

mkdir -p "$BUILD_DIR"
iconutil -c icns "$ICONSET_DIR" -o "$ICNS_PATH" >/dev/null
echo "Created $ICNS_PATH"
