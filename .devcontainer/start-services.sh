#!/usr/bin/env bash
set -euo pipefail

readonly repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly connector_socket="project-space-agent"
readonly connector_session="connector"

export PATH="${HOME}/.local/bin:${HOME}/.bun/bin:${PATH}"
cd -- "${repository_root}"

bash .devcontainer/verify.sh

codex_source="${HOME}/.local/bin/.project-space-machine-tools/current/codex"
codex_home="${CODEX_HOME:-${HOME}/.codex}"
codex_target="${codex_home}/packages/standalone/current/codex"

if [[ ! -x "${codex_source}" ]]; then
  echo "The pinned managed Codex runtime is unavailable at ${codex_source}." >&2
  exit 1
fi
if [[ -L "${codex_target}" || (-e "${codex_target}" && ! -f "${codex_target}") ]]; then
  echo "The managed Codex daemon target is unsafe: ${codex_target}." >&2
  exit 1
fi
mkdir -m 0700 -p -- "$(dirname -- "${codex_target}")"
if ! cmp --silent -- "${codex_source}" "${codex_target}" 2>/dev/null; then
  install -m 0755 -- "${codex_source}" "${codex_target}"
fi
"${codex_target}" app-server daemon enable-remote-control >/dev/null
"${codex_target}" app-server daemon start >/dev/null

project_status="$(project status --json 2>/dev/null || true)"
if ! grep -Eq '"configured"[[:space:]]*:[[:space:]]*true' <<<"${project_status}"; then
  exit 0
fi

state_home="${XDG_STATE_HOME:-${HOME}/.local/state}"
connector_state="${state_home}/project-space/codespace-agent"
connector_log="${connector_state}/connector.log"
mkdir -m 0700 -p -- "${connector_state}"
if tmux -L "${connector_socket}" has-session -t "=${connector_session}" 2>/dev/null; then
  exit 0
fi

connector_command="umask 077; exec project connector run >>\"${connector_log}\" 2>&1"
tmux -L "${connector_socket}" new-session -d -s "${connector_session}" \
  -c "${repository_root}" "${connector_command}"
