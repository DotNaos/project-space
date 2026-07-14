#!/usr/bin/env bash
set -euo pipefail

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
temporary_root=$(mktemp -d)
trap 'rm -rf -- "$temporary_root"' EXIT
version=${1:-}
if [[ -z $version ]]; then
  repository_root=$(cd -- "${script_directory}/../.." && pwd -P)
  version=$(bun -e 'console.log(require(process.argv[1]).version)' "${repository_root}/package.json")
fi
if [[ ! $version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "Invalid packaging test version: $version" >&2
  exit 64
fi

write_project_fixture() {
  local path=$1
  local label=$2
  local fail_start=${3:-0}
  cat > "$path" <<EOF
#!/bin/sh
if [ "\${1:-}" = connector ] && [ "\${2:-}" = service ]; then
  if [ -n "\${PROJECT_FIXTURE_SERVICE_LOG:-}" ]; then
    printf '%s:%s\\n' '$label' "\$*" >> "\$PROJECT_FIXTURE_SERVICE_LOG"
  fi
  if [ "\${3:-}" = start-if-connected ] && \
    { [ '$fail_start' = 1 ] || [ "\${PROJECT_FIXTURE_FAIL_START_LABEL:-}" = '$label' ]; }; then
    exit 1
  fi
  exit 0
fi
printf '%s\\n' '$label'
EOF
  chmod 0755 "$path"
}

write_trust_roots() {
  local directory=$1
  cat > "$directory/connector-command-signing-public-key.pem" <<'EOF'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAUIg0xh2Ct72E0oH+zXpiBUKZUnWMzFZh+3JIgPBFqDA=
-----END PUBLIC KEY-----
EOF
  cat > "$directory/release-manifest-signing-public-key.pem" <<'EOF'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAZ6dwH3rgOZmzwfnAtimmzeo3aiSbJ7G9o43xh6aTDFQ=
-----END PUBLIC KEY-----
EOF
}

mkdir -p -- "$temporary_root/source" "$temporary_root/first" "$temporary_root/second"
write_project_fixture "$temporary_root/source/project" 'project fixture v1'
printf '#!/bin/sh\nprintf "connector fixture\\n"\n' > "$temporary_root/source/project-space-connector"
chmod 0755 "$temporary_root/source/project" "$temporary_root/source/project-space-connector"
write_trust_roots "$temporary_root/source"

SOURCE_DATE_EPOCH=0 "$script_directory/build-machine-tools.sh" \
  "$version" "$temporary_root/source" "$temporary_root/first" >/dev/null
sleep 1
SOURCE_DATE_EPOCH=0 "$script_directory/build-machine-tools.sh" \
  "$version" "$temporary_root/source" "$temporary_root/second" >/dev/null

archive_name="project-space-machine-tools-linux-x64-v${version}.tar.gz"
first_archive="$temporary_root/first/$archive_name"
second_archive="$temporary_root/second/$archive_name"
cmp -- "$first_archive" "$second_archive"
(
  cd -- "$temporary_root/first"
  sha256sum --check --strict "${archive_name}.sha256"
)

mkdir -p -- "$temporary_root/extracted"
tar -xzf "$first_archive" -C "$temporary_root/extracted"
bundle_root="$temporary_root/extracted/project-space-machine-tools-linux-x64-v${version}"
expected_members=$'SHA256SUMS.txt\nVERSION\nconnector-command-signing-public-key.pem\ninstall.sh\nproject\nproject-space-connector\nrelease-manifest-signing-public-key.pem'
actual_members=$(find "$bundle_root" -mindepth 1 -maxdepth 1 -type f -printf '%f\n' | sort)
if [[ $actual_members != "$expected_members" ]]; then
  echo "Unexpected archive members:" >&2
  printf '%s\n' "$actual_members" >&2
  exit 1
fi

install_root="$temporary_root/installed"
service_log="$temporary_root/service.log"
PROJECT_FIXTURE_SERVICE_LOG="$service_log" \
  "$bundle_root/install.sh" --install-dir "$install_root" >/dev/null
[[ $($install_root/project) == 'project fixture v1' ]]
[[ $($install_root/project-space-connector) == 'connector fixture' ]]
[[ $(stat -c '%a' "$install_root") == 700 ]]
[[ $(stat -Lc '%a' "$install_root/project") == 755 ]]
[[ $(stat -Lc '%a' "$install_root/project-space-connector") == 755 ]]
[[ -L $install_root/project ]]
[[ -L $install_root/project-space-connector ]]
[[ $(readlink "$install_root/project") == '.project-space-machine-tools/current/project' ]]
[[ $(readlink "$install_root/project-space-connector") == '.project-space-machine-tools/current/project-space-connector' ]]
cmp "$temporary_root/source/connector-command-signing-public-key.pem" \
  "$install_root/.project-space-machine-tools/current/connector-command-signing-public-key.pem"
cmp "$temporary_root/source/release-manifest-signing-public-key.pem" \
  "$install_root/.project-space-machine-tools/current/release-manifest-signing-public-key.pem"
first_current=$(readlink "$install_root/.project-space-machine-tools/current")
[[ $first_current == versions/${version}-* ]]
grep -Fx 'project fixture v1:connector service start-if-connected' "$service_log"

# An upgrade stops the old service and starts the new paired release only after
# the single current pointer has switched.
upgrade_source="$temporary_root/upgrade-source"
upgrade_output="$temporary_root/upgrade-output"
upgrade_extracted="$temporary_root/upgrade-extracted"
mkdir -p "$upgrade_source" "$upgrade_output" "$upgrade_extracted"
write_project_fixture "$upgrade_source/project" 'project fixture v2'
cp "$temporary_root/source/project-space-connector" "$upgrade_source/project-space-connector"
write_trust_roots "$upgrade_source"
SOURCE_DATE_EPOCH=0 "$script_directory/build-machine-tools.sh" \
  "$version" "$upgrade_source" "$upgrade_output" >/dev/null
tar -xzf "$upgrade_output/$archive_name" -C "$upgrade_extracted"
upgrade_bundle="$upgrade_extracted/project-space-machine-tools-linux-x64-v${version}"
PROJECT_FIXTURE_SERVICE_LOG="$service_log" \
  "$upgrade_bundle/install.sh" --install-dir "$install_root" >/dev/null
[[ $($install_root/project) == 'project fixture v2' ]]
second_current=$(readlink "$install_root/.project-space-machine-tools/current")
[[ $second_current == versions/${version}-* ]]
[[ $second_current != "$first_current" ]]
grep -Fx 'project fixture v1:connector service stop' "$service_log"
grep -Fx 'project fixture v2:connector service start-if-connected' "$service_log"

# If the new service cannot start, the pointer rolls back to the complete old
# pair and the old service is restarted.
failing_source="$temporary_root/failing-source"
failing_output="$temporary_root/failing-output"
failing_extracted="$temporary_root/failing-extracted"
mkdir -p "$failing_source" "$failing_output" "$failing_extracted"
write_project_fixture "$failing_source/project" 'project fixture v3' 1
cp "$temporary_root/source/project-space-connector" "$failing_source/project-space-connector"
write_trust_roots "$failing_source"
SOURCE_DATE_EPOCH=0 "$script_directory/build-machine-tools.sh" \
  "$version" "$failing_source" "$failing_output" >/dev/null
tar -xzf "$failing_output/$archive_name" -C "$failing_extracted"
failing_bundle="$failing_extracted/project-space-machine-tools-linux-x64-v${version}"
if PROJECT_FIXTURE_SERVICE_LOG="$service_log" \
  "$failing_bundle/install.sh" --install-dir "$install_root" >/dev/null 2>&1; then
  echo "Installer accepted a release whose connector service could not start." >&2
  exit 1
fi
[[ $(readlink "$install_root/.project-space-machine-tools/current") == "$second_current" ]]
[[ $($install_root/project) == 'project fixture v2' ]]
grep -Fx 'project fixture v2:connector service stop' "$service_log"
grep -Fx 'project fixture v3:connector service start-if-connected' "$service_log"
[[ $(grep -Fxc 'project fixture v2:connector service start-if-connected' "$service_log") == 2 ]]

# A failed new start followed by a failed restored start must remain visible as
# a distinct recovery-required failure. The old complete release still wins the
# pointer rollback, but the installer cannot honestly claim it restarted.
rollback_failure_log="$temporary_root/rollback-failure.log"
set +e
PROJECT_FIXTURE_SERVICE_LOG="$service_log" \
PROJECT_FIXTURE_FAIL_START_LABEL='project fixture v2' \
  "$failing_bundle/install.sh" --install-dir "$install_root" \
  >/dev/null 2>"$rollback_failure_log"
rollback_failure_status=$?
set -e
[[ $rollback_failure_status -eq 71 ]]
grep -Fx 'The new connector could not be started; the previous machine-tools release was restored.' \
  "$rollback_failure_log"
grep -Fx 'The previous connector service could not be restarted after rollback.' \
  "$rollback_failure_log"
grep -Fx 'The installation failed with status 70 and rollback could not restore the previous connector service. Manual recovery is required.' \
  "$rollback_failure_log"
[[ $(readlink "$install_root/.project-space-machine-tools/current") == "$second_current" ]]
[[ $($install_root/project) == 'project fixture v2' ]]

printf 'tampered\n' >> "$bundle_root/project"
if "$bundle_root/install.sh" --install-dir "$temporary_root/tampered-install" >/dev/null 2>&1; then
  echo "Installer accepted a tampered bundle." >&2
  exit 1
fi
if [[ -e $temporary_root/tampered-install/project ]]; then
  echo "Installer changed state before rejecting a tampered bundle." >&2
  exit 1
fi

echo 'Linux release packaging checks passed.'
