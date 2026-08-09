#!/usr/bin/env bash
set -euo pipefail

readonly managed_codex="${HOME}/.local/bin/.project-space-machine-tools/current/codex"
readonly standalone_root="${HOME}/.codex/packages/standalone/current"
readonly standalone_codex="${standalone_root}/codex"

if [[ ! -x "${managed_codex}" ]]; then
  echo 'The checksum-pinned managed Codex runtime is missing.' >&2
  exit 1
fi

umask 077
install -d -m 0700 -- "${standalone_root}"
if [[ ! -x "${standalone_codex}" ]] || ! cmp -s -- "${managed_codex}" "${standalone_codex}"; then
  temporary_codex="${standalone_root}/.codex.$$"
  trap 'rm -f -- "${temporary_codex:-}"' EXIT
  install -m 0755 -- "${managed_codex}" "${temporary_codex}"
  mv -f -- "${temporary_codex}" "${standalone_codex}"
  trap - EXIT
fi

"${standalone_codex}" app-server daemon start
