#!/bin/sh
set -eu

case "${SSH_ORIGINAL_COMMAND:-}" in
  status-all) ;;
  *) printf '%s\n' 'Preview status key permits only status-all.' >&2; exit 77;;
esac

exec /usr/bin/env -i \
  HOME=/nonexistent \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  /opt/platform/share/project-space-preview/preview-runner.sh status-all
