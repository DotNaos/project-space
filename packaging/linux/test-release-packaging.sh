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
if [ "\${1:-}" = --version ]; then
  printf '%s\n' 'project $version'
  exit 0
fi
if [ "\${1:-}" = connector ] && [ "\${2:-}" = service ]; then
  if [ -n "\${PROJECT_FIXTURE_SERVICE_LOG:-}" ]; then
    printf '%s:%s\\n' '$label' "\$*" >> "\$PROJECT_FIXTURE_SERVICE_LOG"
  fi
  if [ "\${3:-}" = start-if-connected ] && \
    { [ '$fail_start' = 1 ] || [ "\${PROJECT_FIXTURE_FAIL_START_LABEL:-}" = '$label' ]; }; then
    exit 1
  fi
  if [ "\${3:-}" = stop ] && [ -n "\${PROJECT_FIXTURE_POINTER_ON_STOP:-}" ]; then
    pointer_temp="\${PROJECT_FIXTURE_POINTER_ON_STOP}.fixture-next"
    ln -s -- "\${PROJECT_FIXTURE_POINTER_TARGET:?}" "\$pointer_temp"
    mv -Tf -- "\$pointer_temp" "\$PROJECT_FIXTURE_POINTER_ON_STOP"
  fi
  if [ "\${3:-}" = stop ] && [ -n "\${PROJECT_FIXTURE_MAINTENANCE_MARKER_ON_STOP:-}" ]; then
    mkdir -p -- "\$(dirname -- "\$PROJECT_FIXTURE_MAINTENANCE_MARKER_ON_STOP")"
    printf '{}\\n' > "\$PROJECT_FIXTURE_MAINTENANCE_MARKER_ON_STOP"
  fi
  exit 0
fi
printf '%s\\n' '$label'
EOF
  chmod 0755 "$path"
}

write_codex_fixture() {
  local directory=$1
  cat > "$directory/codex" <<'EOF'
#!/bin/sh
if [ "${1:-}" = --version ]; then
  printf '%s\n' 'codex-cli 0.145.0'
  exit 0
fi
printf '%s\n' 'codex fixture'
EOF
  chmod 0755 "$directory/codex"
  printf '%s\n' 'Apache License fixture' > "$directory/CODEX-LICENSE"
  printf '%s\n' 'OpenAI notice fixture' > "$directory/CODEX-NOTICE"
  printf '%s\n' '0.145.0' > "$directory/CODEX-VERSION"
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
cat > "$temporary_root/source/project-space-connector" <<EOF
#!/bin/sh
if [ "\${1:-}" = --version ]; then
  printf 'project-space-connector %s\n' "\${PROJECT_FIXTURE_CONNECTOR_VERSION:-$version}"
  exit 0
fi
printf 'connector fixture\n'
EOF
chmod 0755 "$temporary_root/source/project" "$temporary_root/source/project-space-connector"
write_codex_fixture "$temporary_root/source"
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
expected_members=$'CODEX-LICENSE\nCODEX-NOTICE\nCODEX-VERSION\nSHA256SUMS.txt\nVERSION\ncodex\nconnector-command-signing-public-key.pem\ninstall.sh\nproject\nproject-space-connector\nrelease-manifest-signing-public-key.pem'
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
[[ $(stat -Lc '%a' "$install_root/.project-space-machine-tools/current/codex") == 755 ]]
[[ -L $install_root/project ]]
[[ -L $install_root/project-space-connector ]]
[[ ! -e $install_root/codex && ! -L $install_root/codex ]]
[[ $(readlink "$install_root/project") == '.project-space-machine-tools/current/project' ]]
[[ $(readlink "$install_root/project-space-connector") == '.project-space-machine-tools/current/project-space-connector' ]]
[[ $("$install_root/.project-space-machine-tools/current/codex" --version) == 'codex-cli 0.145.0' ]]
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
write_codex_fixture "$upgrade_source"
write_trust_roots "$upgrade_source"
SOURCE_DATE_EPOCH=0 "$script_directory/build-machine-tools.sh" \
  "$version" "$upgrade_source" "$upgrade_output" >/dev/null
tar -xzf "$upgrade_output/$archive_name" -C "$upgrade_extracted"
upgrade_bundle="$upgrade_extracted/project-space-machine-tools-linux-x64-v${version}"

# A missing top-level convenience link must not hide a managed service. Stop it
# through the staged release, and restart the preserved current release if the
# upgrade rolls back before recreating the link.
missing_link_root="$temporary_root/missing-link-installed"
missing_link_log="$temporary_root/missing-link-service.log"
PROJECT_FIXTURE_SERVICE_LOG="$missing_link_log" \
  "$bundle_root/install.sh" --install-dir "$missing_link_root" >/dev/null
missing_link_current=$(readlink "$missing_link_root/.project-space-machine-tools/current")
rm -f -- "$missing_link_root/project"
set +e
PROJECT_FIXTURE_SERVICE_LOG="$missing_link_log" \
PROJECT_FIXTURE_FAIL_START_LABEL='project fixture v2' \
  "$upgrade_bundle/install.sh" --install-dir "$missing_link_root" >/dev/null 2>&1
missing_link_failure_status=$?
set -e
[[ $missing_link_failure_status -eq 70 ]]
[[ ! -e $missing_link_root/project && ! -L $missing_link_root/project ]]
[[ $(readlink "$missing_link_root/.project-space-machine-tools/current") == "$missing_link_current" ]]
grep -Fx 'project fixture v2:connector service stop' "$missing_link_log"
[[ $(grep -Fxc 'project fixture v1:connector service start-if-connected' "$missing_link_log") == 2 ]]
PROJECT_FIXTURE_SERVICE_LOG="$missing_link_log" \
  "$upgrade_bundle/install.sh" --install-dir "$missing_link_root" >/dev/null
[[ -L $missing_link_root/project ]]
[[ $($missing_link_root/project) == 'project fixture v2' ]]

# An installer must never switch the managed pointer while a named maintenance
# operation or its unresolved result is still present.
maintenance_root="$install_root/.project-space-machine-tools/maintenance"
mkdir -m 0700 -p -- "$maintenance_root"
maintenance_current_before=$(readlink "$install_root/.project-space-machine-tools/current")
maintenance_versions_before=$(find "$install_root/.project-space-machine-tools/versions" -mindepth 1 -maxdepth 1 -type d | wc -l)
maintenance_service_lines_before=$(wc -l < "$service_log")
for maintenance_marker in state.json control.json decision.json; do
  printf '{}\n' > "$maintenance_root/$maintenance_marker"
  maintenance_error="$temporary_root/${maintenance_marker}.error"
  set +e
  PROJECT_FIXTURE_SERVICE_LOG="$service_log" \
    "$upgrade_bundle/install.sh" --install-dir "$install_root" \
    >/dev/null 2>"$maintenance_error"
  maintenance_status=$?
  set -e
  [[ $maintenance_status -eq 75 ]]
  grep -Fx 'Connector maintenance is still active or unresolved; recover it before installing.' \
    "$maintenance_error"
  rm -f -- "$maintenance_root/$maintenance_marker"
  [[ $(readlink "$install_root/.project-space-machine-tools/current") == "$maintenance_current_before" ]]
  [[ $(find "$install_root/.project-space-machine-tools/versions" -mindepth 1 -maxdepth 1 -type d | wc -l) == "$maintenance_versions_before" ]]
  [[ $(wc -l < "$service_log") == "$maintenance_service_lines_before" ]]
done

# Repeat the guard after stopping the old service so a maintenance operation
# that races the initial preflight cannot reach the pointer switch.
maintenance_race_error="$temporary_root/maintenance-race.error"
raced_release="$install_root/.project-space-machine-tools/versions/raced-release"
mkdir -m 0700 -- "$raced_release"
cp -- "$temporary_root/source/project" "$raced_release/project"
cp -- "$temporary_root/source/project-space-connector" "$raced_release/project-space-connector"
cp -- "$temporary_root/source/codex" "$raced_release/codex"
cp -- "$temporary_root/source/CODEX-LICENSE" "$raced_release/CODEX-LICENSE"
cp -- "$temporary_root/source/CODEX-NOTICE" "$raced_release/CODEX-NOTICE"
cp -- "$temporary_root/source/CODEX-VERSION" "$raced_release/CODEX-VERSION"
set +e
PROJECT_FIXTURE_SERVICE_LOG="$service_log" \
PROJECT_FIXTURE_MAINTENANCE_MARKER_ON_STOP="$maintenance_root/control.json" \
PROJECT_FIXTURE_POINTER_ON_STOP="$install_root/.project-space-machine-tools/current" \
PROJECT_FIXTURE_POINTER_TARGET='versions/raced-release' \
  "$upgrade_bundle/install.sh" --install-dir "$install_root" \
  >/dev/null 2>"$maintenance_race_error"
maintenance_race_status=$?
set -e
[[ $maintenance_race_status -eq 75 ]]
grep -Fx 'Connector maintenance is still active or unresolved; recover it before installing.' \
  "$maintenance_race_error"
rm -f -- "$maintenance_root/control.json"
[[ $(readlink "$install_root/.project-space-machine-tools/current") == 'versions/raced-release' ]]
grep -Fx 'project fixture v2:connector service stop' "$service_log"
[[ $(grep -Fxc 'project fixture v1:connector service start-if-connected' "$service_log") == 2 ]]
pointer_restore="$temporary_root/current.restore"
ln -s -- "$maintenance_current_before" "$pointer_restore"
mv -Tf -- "$pointer_restore" "$install_root/.project-space-machine-tools/current"

# If a racing update finishes and removes its marker before the second check,
# a later installer failure must roll back to that newly completed pointer.
completed_race_starts_before=$(grep -Fxc 'project fixture v1:connector service start-if-connected' "$service_log")
set +e
PROJECT_FIXTURE_SERVICE_LOG="$service_log" \
PROJECT_FIXTURE_FAIL_START_LABEL='project fixture v2' \
PROJECT_FIXTURE_POINTER_ON_STOP="$install_root/.project-space-machine-tools/current" \
PROJECT_FIXTURE_POINTER_TARGET='versions/raced-release' \
  "$upgrade_bundle/install.sh" --install-dir "$install_root" >/dev/null 2>&1
completed_race_status=$?
set -e
[[ $completed_race_status -eq 70 ]]
[[ $(readlink "$install_root/.project-space-machine-tools/current") == 'versions/raced-release' ]]
[[ $(grep -Fxc 'project fixture v1:connector service start-if-connected' "$service_log") == $((completed_race_starts_before + 1)) ]]
ln -s -- "$maintenance_current_before" "$pointer_restore"
mv -Tf -- "$pointer_restore" "$install_root/.project-space-machine-tools/current"
rm -rf -- "$raced_release"

PROJECT_FIXTURE_SERVICE_LOG="$service_log" \
  "$upgrade_bundle/install.sh" --install-dir "$install_root" >/dev/null
[[ $($install_root/project) == 'project fixture v2' ]]
second_current=$(readlink "$install_root/.project-space-machine-tools/current")
[[ $second_current == versions/${version}-* ]]
[[ $second_current != "$first_current" ]]
grep -Fx 'project fixture v2:connector service stop' "$service_log"
grep -Fx 'project fixture v2:connector service start-if-connected' "$service_log"

# A pair that does not report one matching version fails before commit and
# restores the previous current pointer and service.
version_failure_starts_before=$(grep -Fxc 'project fixture v2:connector service start-if-connected' "$service_log")
version_failure_log="$temporary_root/version-failure.log"
set +e
PROJECT_FIXTURE_CONNECTOR_VERSION=0.4.7 \
PROJECT_FIXTURE_SERVICE_LOG="$service_log" \
  "$upgrade_bundle/install.sh" --install-dir "$install_root" \
  >/dev/null 2>"$version_failure_log"
version_failure_status=$?
set -e
[[ $version_failure_status -eq 70 ]]
grep -Fx 'The installed project-space-connector does not report the bundled version.' "$version_failure_log"
[[ $(readlink "$install_root/.project-space-machine-tools/current") == "$second_current" ]]
[[ $(grep -Fxc 'project fixture v2:connector service start-if-connected' "$service_log") == $((version_failure_starts_before + 1)) ]]

# If the new service cannot start, the pointer rolls back to the complete old
# pair and the old service is restarted.
failing_source="$temporary_root/failing-source"
failing_output="$temporary_root/failing-output"
failing_extracted="$temporary_root/failing-extracted"
mkdir -p "$failing_source" "$failing_output" "$failing_extracted"
write_project_fixture "$failing_source/project" 'project fixture v3' 1
cp "$temporary_root/source/project-space-connector" "$failing_source/project-space-connector"
write_codex_fixture "$failing_source"
write_trust_roots "$failing_source"
SOURCE_DATE_EPOCH=0 "$script_directory/build-machine-tools.sh" \
  "$version" "$failing_source" "$failing_output" >/dev/null
tar -xzf "$failing_output/$archive_name" -C "$failing_extracted"
failing_bundle="$failing_extracted/project-space-machine-tools-linux-x64-v${version}"
v2_start_count_before_failure=$(grep -Fxc 'project fixture v2:connector service start-if-connected' "$service_log")
if PROJECT_FIXTURE_SERVICE_LOG="$service_log" \
  "$failing_bundle/install.sh" --install-dir "$install_root" >/dev/null 2>&1; then
  echo "Installer accepted a release whose connector service could not start." >&2
  exit 1
fi
[[ $(readlink "$install_root/.project-space-machine-tools/current") == "$second_current" ]]
[[ $($install_root/project) == 'project fixture v2' ]]
grep -Fx 'project fixture v3:connector service stop' "$service_log"
grep -Fx 'project fixture v3:connector service start-if-connected' "$service_log"
[[ $(grep -Fxc 'project fixture v2:connector service start-if-connected' "$service_log") == $((v2_start_count_before_failure + 1)) ]]

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

if grep -Eq '/latest/|releases/latest' "$script_directory/prepare-codex-runtime.sh"; then
  echo "Managed Codex preparation must not use a floating release." >&2
  exit 1
fi
grep -Fq 'codex_version=0.145.0' "$script_directory/prepare-codex-runtime.sh"
grep -Fq 'codex_archive_sha256=bfaf13c9ba34f2ad764e4a916c49cf7177aeba329cf0f719e2227566fc8d662a' \
  "$script_directory/prepare-codex-runtime.sh"
grep -Fq 'codex_notice_sha256=9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915' \
  "$script_directory/prepare-codex-runtime.sh"

echo 'Linux release packaging checks passed.'
