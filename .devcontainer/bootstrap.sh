#!/usr/bin/env bash
set -euo pipefail

readonly expected_bun_version="1.3.14"
readonly expected_codex_version="0.146.1"

export PATH="${HOME}/.bun/bin:${PATH}"

current_bun_version="$(bun --version 2>/dev/null || true)"
if [[ "${current_bun_version}" != "${expected_bun_version}" ]]; then
  curl -fsSL https://bun.sh/install | bash -s "bun-v${expected_bun_version}"
fi

bun install --frozen-lockfile

current_codex_version="$(codex --version 2>/dev/null | awk '{print $NF}' || true)"
if [[ "${current_codex_version}" != "${expected_codex_version}" ]]; then
  curl -fsSL https://chatgpt.com/codex/install.sh |
    env       CODEX_RELEASE="${expected_codex_version}"       CODEX_NON_INTERACTIVE=true       CODEX_INSTALL_DIR="${HOME}/.bun/bin"       sh
fi

bash .devcontainer/verify.sh
