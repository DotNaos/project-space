#!/bin/sh
set -eu

case "${SSH_ORIGINAL_COMMAND:-}" in
  apply|destroy|reap) command_name=$SSH_ORIGINAL_COMMAND;;
  *) printf '%s\n' 'Preview SSH key permits only apply, destroy, or reap.' >&2; exit 77;;
esac

exec /usr/bin/env -i \
  HOME=/nonexistent \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  /opt/platform/share/project-space-preview/preview-runner.sh "$command_name"
