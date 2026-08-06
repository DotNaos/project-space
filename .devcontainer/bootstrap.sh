#!/usr/bin/env bash
set -euo pipefail

readonly repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly expected_bun_version="1.3.14"
readonly expected_node_version="v24.15.0"
readonly expected_node_gyp_version="v13.0.1"
readonly expected_codex_version="0.146.1"
readonly expected_project_version="0.4.61"
readonly expected_managed_codex_version="0.145.0"
readonly project_archive="project-space-machine-tools-linux-x64-v${expected_project_version}.tar.gz"
readonly project_archive_sha256="f84c1c79f7924375ceb828e8ac85f502da18494a4612d0a6b3031dadbe6c6c4a"

export PATH="${HOME}/.local/bin:${HOME}/.bun/bin:${PATH}"
cd -- "${repository_root}"

temporary_root=""
cleanup() {
  if [[ -n "${temporary_root}" && -d "${temporary_root}" ]]; then
    rm -r -- "${temporary_root}"
  fi
}
trap cleanup EXIT

current_bun_version="$(bun --version 2>/dev/null || true)"
if [[ "${current_bun_version}" != "${expected_bun_version}" ]]; then
  curl --fail --location --proto '=https' --tlsv1.2 https://bun.sh/install |
    bash -s "bun-v${expected_bun_version}"
fi

actual_node_version="$(node --version 2>/dev/null || true)"
if [[ "${actual_node_version}" != "${expected_node_version}" ]]; then
  echo "Expected Node ${expected_node_version}, found ${actual_node_version:-missing}." >&2
  exit 1
fi

if ! python3 -c 'import shlex' >/dev/null 2>&1; then
  echo "Expected a complete Python 3 standard library with shlex." >&2
  exit 1
fi

actual_node_gyp_version="$(node-gyp --version 2>/dev/null | tr -d '\r\n' || true)"
if [[ "${actual_node_gyp_version}" != "${expected_node_gyp_version}" ]]; then
  bun add --global "node-gyp@${expected_node_gyp_version#v}"
  actual_node_gyp_version="$(node-gyp --version 2>/dev/null | tr -d '\r\n' || true)"
fi
if [[ "${actual_node_gyp_version}" != "${expected_node_gyp_version}" ]]; then
  echo "Expected node-gyp ${expected_node_gyp_version}, found ${actual_node_gyp_version:-missing}." >&2
  exit 1
fi

bun install --frozen-lockfile

current_codex_version="$(codex --version 2>/dev/null | awk '{print $NF}' || true)"
if [[ "${current_codex_version}" != "${expected_codex_version}" ]]; then
  curl --fail --location --proto '=https' --tlsv1.2 https://chatgpt.com/codex/install.sh |
    env \
      CODEX_RELEASE="${expected_codex_version}" \
      CODEX_NON_INTERACTIVE=true \
      CODEX_INSTALL_DIR="${HOME}/.bun/bin" \
      sh
fi

codex_home="${CODEX_HOME:-${HOME}/.codex}"
codex_config_source="${repository_root}/.codex/config.toml"
codex_config_target="${codex_home}/config.toml"
codex_config_marker="${codex_home}/.project-space-config.sha256"
codex_config_sha256="$(sha256sum "${codex_config_source}" | awk '{print $1}')"
mkdir -m 0700 -p -- "${codex_home}"
if [[ ! -e "${codex_config_target}" && ! -L "${codex_config_target}" ]]; then
  install -m 0600 -- "${codex_config_source}" "${codex_config_target}"
  printf '%s\n' "${codex_config_sha256}" > "${codex_config_marker}"
  chmod 0600 "${codex_config_marker}"
elif [[ -f "${codex_config_target}" && ! -L "${codex_config_target}" &&
  -f "${codex_config_marker}" ]]; then
  installed_codex_config_sha256="$(tr -d '\r\n' < "${codex_config_marker}")"
  current_codex_config_sha256="$(sha256sum "${codex_config_target}" | awk '{print $1}')"
  if [[ "${current_codex_config_sha256}" == "${installed_codex_config_sha256}" &&
    "${current_codex_config_sha256}" != "${codex_config_sha256}" ]]; then
    install -m 0600 -- "${codex_config_source}" "${codex_config_target}"
    printf '%s\n' "${codex_config_sha256}" > "${codex_config_marker}"
    chmod 0600 "${codex_config_marker}"
  fi
fi

current_project_version="$(project --version 2>/dev/null | awk '{print $NF}' || true)"
current_connector_version="$(project-space-connector --version 2>/dev/null | awk '{print $NF}' || true)"
current_managed_codex_version="$(
  "${HOME}/.local/bin/.project-space-machine-tools/current/codex" --version 2>/dev/null |
    awk '{print $NF}' || true
)"
if [[ "${current_project_version}" != "${expected_project_version}" ||
  "${current_connector_version}" != "${expected_project_version}" ||
  "${current_managed_codex_version}" != "${expected_managed_codex_version}" ]]; then
  temporary_root="$(mktemp -d)"
  archive_path="${temporary_root}/${project_archive}"
  release_url="https://github.com/DotNaos/project-space/releases/download/v${expected_project_version}/${project_archive}"
  curl --fail --location --proto '=https' --tlsv1.2 \
    --output "${archive_path}" \
    "${release_url}"
  printf '%s  %s\n' "${project_archive_sha256}" "${archive_path}" |
    sha256sum --check --strict
  tar --extract --gzip --no-same-owner --file "${archive_path}" --directory "${temporary_root}"
  "${temporary_root}/project-space-machine-tools-linux-x64-v${expected_project_version}/install.sh"
fi

bash .devcontainer/verify.sh
