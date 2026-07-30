#!/bin/sh
set -eu

case "${SSH_ORIGINAL_COMMAND:-}" in
  status-all) ;;
  *) printf '%s\n' 'Preview status key permits only status-all.' >&2; exit 77;;
esac

current_assets=/opt/platform/share/project-space-preview-current
asset_root=$(readlink -f "$current_assets") || {
  printf '%s\n' 'Trusted Preview assets are not installed.' >&2
  exit 78
}
case "$asset_root" in
  /opt/platform/share/project-space-preview-releases/*) ;;
  *) printf '%s\n' 'Trusted Preview asset link resolves outside its release root.' >&2; exit 78;;
esac

exec /usr/bin/env -i \
  HOME=/nonexistent \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  PROJECT_SPACE_PREVIEW_ASSET_ROOT="$asset_root" \
  "$asset_root/preview-runner.sh" status-all
