#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly repository_root
readonly bun_version="1.3.14"
readonly node_gyp_version="13.0.1"
readonly project_version="0.10.18"
readonly archive="project-space-machine-tools-linux-x64-v${project_version}.tar.gz"
readonly archive_sha256="056469cbff0cc4ed1d16b446a8223915b01abef08501edc00cac3cb53915b1df"

export PATH="${HOME}/.local/bin:${HOME}/.bun/bin:${PATH}"
cd -- "${repository_root}"

missing_packages=()
command -v g++ >/dev/null 2>&1 || missing_packages+=(g++)
command -v gh >/dev/null 2>&1 || missing_packages+=(gh)
command -v make >/dev/null 2>&1 || missing_packages+=(make)
command -v python3 >/dev/null 2>&1 || missing_packages+=(python3)
command -v sshd >/dev/null 2>&1 || missing_packages+=(openssh-server)
if (( ${#missing_packages[@]} > 0 )); then
  sudo apt-get update
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install \
    --no-install-recommends --yes "${missing_packages[@]}"
  sudo rm -rf /var/lib/apt/lists/*
fi

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

current_project_version="$(project --version 2>/dev/null | awk '{print $NF}' || true)"
release_required=1
if [[ "${current_project_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ &&
  "$(printf '%s\n%s\n' "${project_version}" "${current_project_version}" | sort -V | head -n 1)" == "${project_version}" ]]; then
  release_required=0
fi
if [[ ${release_required} -eq 1 ]]; then
  temporary_root="$(mktemp -d)"
  archive_path="${temporary_root}/${archive}"
  curl --fail --location --proto '=https' --tlsv1.2 \
    --output "${archive_path}" \
    "https://github.com/DotNaos/project-space/releases/download/v${project_version}/${archive}"
  printf '%s  %s\n' "${archive_sha256}" "${archive_path}" |
    sha256sum --check --strict
  tar --extract --gzip --no-same-owner --file "${archive_path}" --directory "${temporary_root}"
  bundle_root="${temporary_root}/project-space-machine-tools-linux-x64-v${project_version}"
  install -m 0700 -- "${repository_root}/packaging/linux/install-machine-tools.sh" \
    "${bundle_root}/install-codespace.sh"
  "${bundle_root}/install-codespace.sh"
fi

if ! project self-update --yes --format json; then
  printf '%s\n' \
    "Signed Project Space self-update was unavailable; continuing with pinned v${project_version}." >&2
fi
