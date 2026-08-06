#!/usr/bin/env bash
set -euo pipefail

readonly expected_bun_version="1.3.14"
readonly expected_go_prefix="go1.26."
readonly expected_codex_version="0.146.1"
readonly expected_project_version="0.4.61"
readonly expected_managed_codex_version="0.145.0"

actual_bun_version="$(bun --version)"
if [[ "${actual_bun_version}" != "${expected_bun_version}" ]]; then
  echo "Expected Bun ${expected_bun_version}, found ${actual_bun_version}." >&2
  exit 1
fi

actual_go_version="$(go version)"
if [[ "${actual_go_version}" != *"${expected_go_prefix}"* ]]; then
  echo "Expected Go ${expected_go_prefix}x, found ${actual_go_version}." >&2
  exit 1
fi

docker_ready=false
for _ in {1..30}; do
  if docker info >/dev/null 2>&1; then
    docker_ready=true
    break
  fi
  sleep 1
done
if [[ "${docker_ready}" != "true" ]]; then
  echo "Docker daemon is not ready." >&2
  exit 1
fi

actual_codex_version="$(codex --version | awk '{print $NF}')"
if [[ "${actual_codex_version}" != "${expected_codex_version}" ]]; then
  echo "Expected Codex ${expected_codex_version}, found ${actual_codex_version}." >&2
  exit 1
fi

actual_project_version="$(project --version | awk '{print $NF}')"
if [[ "${actual_project_version}" != "${expected_project_version}" ]]; then
  echo "Expected Project ${expected_project_version}, found ${actual_project_version}." >&2
  exit 1
fi

actual_connector_version="$(project-space-connector --version | awk '{print $NF}')"
if [[ "${actual_connector_version}" != "${expected_project_version}" ]]; then
  echo "Expected Project Space connector ${expected_project_version}, found ${actual_connector_version}." >&2
  exit 1
fi

actual_managed_codex_version="$(
  "${HOME}/.local/bin/.project-space-machine-tools/current/codex" --version |
    awk '{print $NF}'
)"
if [[ "${actual_managed_codex_version}" != "${expected_managed_codex_version}" ]]; then
  echo "Expected managed Codex ${expected_managed_codex_version}, found ${actual_managed_codex_version}." >&2
  exit 1
fi

bun run check:package-manager

printf 'Codespace readiness passed: Bun %s, %s, Codex %s, Project %s, Docker ready.\n' \
  "${actual_bun_version}" \
  "${actual_go_version}" \
  "${actual_codex_version}" \
  "${actual_project_version}"
