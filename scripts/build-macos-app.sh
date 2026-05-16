#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_name="Project Space"
bundle="$root/dist/$app_name.app"
contents="$bundle/Contents"
macos="$contents/MacOS"
resources="$contents/Resources"

rm -rf "$bundle"
mkdir -p "$macos" "$resources"

cd "$root"
bun run web:build
bun run backend:build

cd "$root/desktop/macos"
swift build -c release

cp ".build/release/project_spaceApp" "$macos/project-space"
chmod +x "$macos/project-space"
cp "$root/dist/project-space" "$resources/project-space"
chmod +x "$resources/project-space"
cp -R "$root/apps/web/dist" "$resources/apps-web-dist"
mkdir -p "$resources/apps/web"
cp -R "$root/apps/web/dist" "$resources/apps/web/dist"

if command -v sips >/dev/null && command -v iconutil >/dev/null; then
  iconset="$root/tmp/project-space.iconset"
  rm -rf "$iconset"
  mkdir -p "$iconset"
  for size in 16 32 128 256 512; do
    sips -s format png -z "$size" "$size" "$root/assets/app-icon.svg" --out "$iconset/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -s format png -z "$double" "$double" "$root/assets/app-icon.svg" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$iconset" -o "$resources/AppIcon.icns"
fi

cat > "$contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>project-space</string>
  <key>CFBundleIdentifier</key>
  <string>com.dotnaos.project-space</string>
  <key>CFBundleName</key>
  <string>Project Space</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleShortVersionString</key>
  <string>0.3.0</string>
  <key>CFBundleVersion</key>
  <string>0.3.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
</dict>
</plist>
PLIST

echo "$bundle"
