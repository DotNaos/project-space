#!/usr/bin/env bash
set -euo pipefail

export PATH="${HOME}/.local/bin:${HOME}/.bun/bin:${PATH}"

for command_name in bun docker gh git go node node-gyp npm project project-space-connector sshd; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Required Codespace runner tool is missing: ${command_name}." >&2
    exit 1
  fi
done

project_version="$(project --version | awk '{print $NF}')"
connector_version="$(project-space-connector --version | awk '{print $NF}')"
if [[ -z "${project_version}" || "${project_version}" != "${connector_version}" ]]; then
  echo 'Project CLI and connector versions do not match.' >&2
  exit 1
fi

managed_codex="${HOME}/.local/bin/.project-space-machine-tools/current/codex"
if [[ ! -x "${managed_codex}" ]]; then
  echo 'The checksum-pinned managed Codex runtime is missing.' >&2
  exit 1
fi

if env | grep -Eq '^(OPENAI_API_KEY|AZURE_OPENAI_API_KEY|CODEX_API_KEY)='; then
  echo 'API-key environment variables are forbidden in the subscription runner.' >&2
  exit 1
fi
