#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly repository_root
readonly supervisor="${repository_root}/.devcontainer/connector-supervisor.sh"
readonly state_root="${XDG_STATE_HOME:-${HOME}/.local/state}/project-space/codespace-runner"
readonly pid_file="${state_root}/supervisor.pid"
readonly supervisor_log="${state_root}/supervisor.log"

if [[ -z "${CODESPACE_NAME:-}" ]]; then
  echo 'Project Space runner startup is only enabled inside GitHub Codespaces.' >&2
  exit 0
fi

export PATH="${HOME}/.local/bin:${HOME}/.bun/bin:${PATH}"
bash "${repository_root}/.devcontainer/verify-runner.sh"
umask 077
mkdir -p -- "${state_root}"
chmod 0700 "${state_root}"
touch -- "${supervisor_log}"
chmod 0600 "${supervisor_log}"

if [[ -f "${pid_file}" ]]; then
  existing_pid="$(tr -d '\r\n' < "${pid_file}")"
  if [[ "${existing_pid}" =~ ^[1-9][0-9]*$ ]] && kill -0 "${existing_pid}" 2>/dev/null; then
    existing_command="$(ps -p "${existing_pid}" -o command= 2>/dev/null || true)"
    if [[ "${existing_command}" == *"${supervisor}"* ]]; then
      exit 0
    fi
    echo 'Refusing to replace a runner PID file owned by another process.' >&2
    exit 1
  fi
  rm -- "${pid_file}"
fi

nohup bash "${supervisor}" >> "${supervisor_log}" 2>&1 </dev/null &
supervisor_pid=$!
printf '%s\n' "${supervisor_pid}" > "${pid_file}"
chmod 0600 "${pid_file}"

sleep 1
if ! kill -0 "${supervisor_pid}" 2>/dev/null; then
  echo 'The Project Space Codespace runner did not stay running.' >&2
  exit 1
fi
