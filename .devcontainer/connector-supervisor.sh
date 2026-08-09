#!/usr/bin/env bash
set -euo pipefail

export PATH="${HOME}/.local/bin:${HOME}/.bun/bin:${PATH}"
readonly codespace_name="${CODESPACE_NAME:?CODESPACE_NAME is required}"
readonly state_root="${XDG_STATE_HOME:-${HOME}/.local/state}/project-space/codespace-runner"
readonly connector_log="${state_root}/connector.log"

umask 077
mkdir -p -- "${state_root}"
chmod 0700 "${state_root}"
touch -- "${connector_log}"
chmod 0600 "${connector_log}"

while true; do
  printf '%s starting Project Space connector for %s\n' "$(date -u +%FT%TZ)" "${codespace_name}" >> "${connector_log}"
  env \
    -u AZURE_OPENAI_API_KEY \
    -u CODEX_API_KEY \
    -u OPENAI_API_KEY \
    project connect \
      --connector-mode foreground \
      --json \
      --name "${codespace_name}" \
      --no-open >> "${connector_log}" 2>&1 || true
  printf '%s connector stopped; retrying in five seconds\n' "$(date -u +%FT%TZ)" >> "${connector_log}"
  sleep 5
done
