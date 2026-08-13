#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly repository_root

if [[ -z "${CODESPACE_NAME:-}" ]]; then
  echo 'Project Space runner startup is only enabled inside GitHub Codespaces.' >&2
  exit 0
fi

export PATH="${HOME}/.local/bin:${HOME}/.bun/bin:${PATH}"
bash "${repository_root}/.devcontainer/verify-runner.sh"
bash "${repository_root}/.devcontainer/start-codex-daemon.sh"
