#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly repository_root
readonly bun_version="1.3.14"
readonly node_gyp_version="13.0.1"
readonly project_version="0.10.6"
readonly archive="project-space-machine-tools-linux-x64-v${project_version}.tar.gz"
readonly archive_sha256="ecc6f972a65dad1cfdae48ee4be84263d5a7239b76a0b6519fe02767c200ad64"

export PATH="${HOME}/.local/bin:${HOME}/.bun/bin:${PATH}"
cd -- "${repository_root}"

temporary_root=""
cleanup() {
  if [[ -n "${temporary_root}" && -d "${temporary_root}" ]]; then
    rm -r -- "${temporary_root}"
  fi
}
trap cleanup EXIT

if [[ "$(bun --version 2>/dev/null || true)" != "${bun_version}" ]]; then
  curl --fail --location --proto '=https' --tlsv1.2 https://bun.sh/install |
    bash -s "bun-v${bun_version}"
fi
current_node_gyp_version="$(node-gyp --version 2>/dev/null | sed 's/^v//' || true)"
if [[ "${current_node_gyp_version}" != "${node_gyp_version}" ]]; then
  bun add --global "node-gyp@${node_gyp_version}"
fi
bun install --frozen-lockfile

current_project_version="$(project --version 2>/dev/null | awk '{print $NF}' || true)"
current_connector_version="$(project-space-connector --version 2>/dev/null | awk '{print $NF}' || true)"
if [[ "${current_project_version}" != "${project_version}" ||
  "${current_connector_version}" != "${project_version}" ]]; then
  temporary_root="$(mktemp -d)"
  archive_path="${temporary_root}/${archive}"
  curl --fail --location --proto '=https' --tlsv1.2 \
    --output "${archive_path}" \
    "https://github.com/DotNaos/project-space/releases/download/v${project_version}/${archive}"
  printf '%s  %s\n' "${archive_sha256}" "${archive_path}" |
    sha256sum --check --strict
  tar --extract --gzip --no-same-owner --file "${archive_path}" --directory "${temporary_root}"
  "${temporary_root}/project-space-machine-tools-linux-x64-v${project_version}/install.sh"
fi

bash .devcontainer/verify-runner.sh
bash .devcontainer/start-runner.sh
