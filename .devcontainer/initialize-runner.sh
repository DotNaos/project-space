#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly repository_root
readonly initializer="${repository_root}/.devcontainer/initialize-runner.sh"
readonly state_root="${XDG_STATE_HOME:-${HOME}/.local/state}/project-space/codespace-runner"
readonly pid_file="${state_root}/initializer.pid"
readonly initializer_log="${state_root}/initializer.log"

if [[ -z "${CODESPACE_NAME:-}" ]]; then
  echo 'Project Space runner initialization is only enabled inside GitHub Codespaces.' >&2
  exit 0
fi

run_initializer() {
  cleanup() {
    rm -f -- "${pid_file}"
  }
  trap cleanup EXIT

  for attempt in 1 2 3; do
    if bash "${repository_root}/.devcontainer/bootstrap.sh" &&
      bash "${repository_root}/.devcontainer/start-runner.sh"; then
      exit 0
    fi

    printf 'Runner initialization attempt %s failed. Retrying in 15 seconds.\n' \
      "${attempt}" >&2
    sleep 15
  done

  echo 'Project Space runner initialization failed after three attempts.' >&2
  exit 1
}

if [[ "${1:-}" == '--run' ]]; then
  run_initializer
fi

umask 077
mkdir -p -- "${state_root}"
chmod 0700 "${state_root}"
touch -- "${initializer_log}"
chmod 0600 "${initializer_log}"

if [[ -f "${pid_file}" ]]; then
  existing_pid="$(tr -d '\r\n' < "${pid_file}" 2>/dev/null || true)"
  if [[ "${existing_pid}" =~ ^[1-9][0-9]*$ ]] &&
    kill -0 "${existing_pid}" 2>/dev/null; then
    existing_command="$(ps -p "${existing_pid}" -o command= 2>/dev/null || true)"
    if [[ "${existing_command}" == *"${initializer}"*'--run'* ]]; then
      exit 0
    fi
    echo 'Refusing to replace a runner initializer PID owned by another process.' >&2
    exit 1
  fi
  rm -f -- "${pid_file}"
fi

nohup bash "${initializer}" --run >> "${initializer_log}" 2>&1 </dev/null &
initializer_pid=$!
printf '%s\n' "${initializer_pid}" > "${pid_file}"
chmod 0600 "${pid_file}"

sleep 0.1
if ! kill -0 "${initializer_pid}" 2>/dev/null; then
  echo 'The Project Space runner initializer did not stay running.' >&2
  exit 1
fi
