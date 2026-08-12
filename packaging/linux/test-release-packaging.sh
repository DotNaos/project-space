#!/usr/bin/env bash
set -euo pipefail

unset PROJECT_SPACE_MACHINE_TOOLS_SERVICE_MODE

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
temporary_root=$(mktemp -d)
trap 'rm -rf -- "$temporary_root"' EXIT
systemctl_log="$temporary_root/systemctl.log"
mkdir -p -- "$temporary_root/fake-bin"
cat > "$temporary_root/fake-bin/systemctl" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "${PROJECT_FIXTURE_SYSTEMCTL_LOG:?}"
if [ "$*" = '--user stop project-space-machine-connector-supervisor.service' ]; then
  if [ -n "${PROJECT_FIXTURE_POINTER_ON_STOP:-}" ]; then
    pointer_temp="${PROJECT_FIXTURE_POINTER_ON_STOP}.fixture-next"
    ln -s -- "${PROJECT_FIXTURE_POINTER_TARGET:?}" "$pointer_temp"
    mv -Tf -- "$pointer_temp" "$PROJECT_FIXTURE_POINTER_ON_STOP"
  fi
  if [ -n "${PROJECT_FIXTURE_MAINTENANCE_MARKER_ON_STOP:-}" ]; then
    mkdir -p -- "$(dirname -- "$PROJECT_FIXTURE_MAINTENANCE_MARKER_ON_STOP")"
    printf '{}\n' > "$PROJECT_FIXTURE_MAINTENANCE_MARKER_ON_STOP"
  fi
  exit 0
fi
case "$*" in
  '--user is-active --quiet project-space-machine-connector-supervisor.service'|\
  '--user is-active --quiet project-space-connector.service'|\
  '--user stop project-space-connector.service') exit 0 ;;
esac
exit 1
EOF
chmod 0755 "$temporary_root/fake-bin/systemctl"
export PATH="$temporary_root/fake-bin:$PATH"
export PROJECT_FIXTURE_SYSTEMCTL_LOG="$systemctl_log"
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
cat > "$temporary_root/source/project-codex-host" <<EOF
#!/bin/sh
if [ "\${1:-}" = --version ]; then
  printf 'project-codex-host %s\n' "\${PROJECT_FIXTURE_CONNECTOR_VERSION:-$version}"
  exit 0
fi
printf 'connector fixture\n'
EOF
chmod 0755 "$temporary_root/source/project" "$temporary_root/source/project-codex-host"
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
expected_members=$'CODEX-LICENSE\nCODEX-NOTICE\nCODEX-VERSION\nSHA256SUMS.txt\nVERSION\ncodex\nconnector-command-signing-public-key.pem\ninstall.sh\nproject\nproject-codex-host\nrelease-manifest-signing-public-key.pem'
actual_members=$(find "$bundle_root" -mindepth 1 -maxdepth 1 -type f -printf '%f\n' | sort)
if [[ $actual_members != "$expected_members" ]]; then
  echo "Unexpected archive members:" >&2
  printf '%s\n' "$actual_members" >&2
  exit 1
fi

install_root="$temporary_root/installed"
service_log="$temporary_root/service.log"
mkdir -p "$install_root"
ln -s '.project-space-machine-tools/current/project-space-connector' \
  "$install_root/project-space-connector"
PROJECT_FIXTURE_SERVICE_LOG="$service_log" \
  "$bundle_root/install.sh" --install-dir "$install_root" >/dev/null
[[ $($install_root/project) == 'project fixture v1' ]]
[[ $($install_root/project-codex-host) == 'connector fixture' ]]
[[ $(stat -c '%a' "$install_root") == 700 ]]
[[ $(stat -Lc '%a' "$install_root/project") == 755 ]]
[[ $(stat -Lc '%a' "$install_root/project-codex-host") == 755 ]]
[[ $(stat -Lc '%a' "$install_root/.project-space-machine-tools/current/codex") == 755 ]]
[[ -L $install_root/project ]]
[[ -L $install_root/project-codex-host ]]
[[ ! -e $install_root/project-space-connector && ! -L $install_root/project-space-connector ]]
[[ ! -e $install_root/codex && ! -L $install_root/codex ]]
[[ $(readlink "$install_root/project") == '.project-space-machine-tools/current/project' ]]
[[ $(readlink "$install_root/project-codex-host") == '.project-space-machine-tools/current/project-codex-host' ]]
[[ $("$install_root/.project-space-machine-tools/current/codex" --version) == 'codex-cli 0.145.0' ]]
cmp "$temporary_root/source/connector-command-signing-public-key.pem" \
  "$install_root/.project-space-machine-tools/current/connector-command-signing-public-key.pem"
cmp "$temporary_root/source/release-manifest-signing-public-key.pem" \
  "$install_root/.project-space-machine-tools/current/release-manifest-signing-public-key.pem"
first_current=$(readlink "$install_root/.project-space-machine-tools/current")
[[ $first_current == versions/${version}-* ]]
[[ ! -e $service_log ]]
grep -Fx -- '--user stop project-space-machine-connector-supervisor.service' "$systemctl_log"
grep -Fx -- '--user stop project-space-connector.service' "$systemctl_log"

# Containers such as GitHub Codespaces own the foreground connector lifecycle.
# Installing there must switch the verified tools without touching systemd.
external_root="$temporary_root/external-installed"
external_service_log="$temporary_root/external-service.log"
PROJECT_FIXTURE_SERVICE_LOG="$external_service_log" \
  "$bundle_root/install.sh" --install-dir "$external_root" \
  --external-connector-supervisor >/dev/null
[[ $($external_root/project) == 'project fixture v1' ]]
[[ $($external_root/project-codex-host) == 'connector fixture' ]]
[[ ! -e $external_service_log ]]

# An upgrade stops the retired service and never starts it again.
upgrade_source="$temporary_root/upgrade-source"
upgrade_output="$temporary_root/upgrade-output"
upgrade_extracted="$temporary_root/upgrade-extracted"
mkdir -p "$upgrade_source" "$upgrade_output" "$upgrade_extracted"
write_project_fixture "$upgrade_source/project" 'project fixture v2'
cp "$temporary_root/source/project-codex-host" "$upgrade_source/project-codex-host"
write_codex_fixture "$upgrade_source"
write_trust_roots "$upgrade_source"
SOURCE_DATE_EPOCH=0 "$script_directory/build-machine-tools.sh" \
  "$version" "$upgrade_source" "$upgrade_output" >/dev/null
tar -xzf "$upgrade_output/$archive_name" -C "$upgrade_extracted"
upgrade_bundle="$upgrade_extracted/project-space-machine-tools-linux-x64-v${version}"

# A missing top-level convenience link must not hide a managed service. The
# previous tools are restored on failure, while the retired service stays off.
missing_link_root="$temporary_root/missing-link-installed"
"$bundle_root/install.sh" --install-dir "$missing_link_root" >/dev/null
missing_link_current=$(readlink "$missing_link_root/.project-space-machine-tools/current")
rm -f -- "$missing_link_root/project"
set +e
PROJECT_FIXTURE_CONNECTOR_VERSION=0.4.7 \
  "$upgrade_bundle/install.sh" --install-dir "$missing_link_root" >/dev/null 2>&1
missing_link_failure_status=$?
set -e
[[ $missing_link_failure_status -eq 70 ]]
[[ ! -e $missing_link_root/project && ! -L $missing_link_root/project ]]
[[ $(readlink "$missing_link_root/.project-space-machine-tools/current") == "$missing_link_current" ]]
[[ ! -e $service_log ]]
"$upgrade_bundle/install.sh" --install-dir "$missing_link_root" >/dev/null
[[ -L $missing_link_root/project ]]
[[ $($missing_link_root/project) == 'project fixture v2' ]]

# An installer must never switch the managed pointer while a named maintenance
# operation or its unresolved result is still present.
maintenance_root="$install_root/.project-space-machine-tools/maintenance"
mkdir -m 0700 -p -- "$maintenance_root"
maintenance_current_before=$(readlink "$install_root/.project-space-machine-tools/current")
maintenance_versions_before=$(find "$install_root/.project-space-machine-tools/versions" -mindepth 1 -maxdepth 1 -type d | wc -l)
maintenance_systemctl_lines_before=$(wc -l < "$systemctl_log")
for maintenance_marker in state.json control.json decision.json; do
  printf '{}\n' > "$maintenance_root/$maintenance_marker"
  maintenance_error="$temporary_root/${maintenance_marker}.error"
  set +e
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
  [[ $(wc -l < "$systemctl_log") == "$maintenance_systemctl_lines_before" ]]
done

# Repeat the guard after stopping the old service so a maintenance operation
# that races the initial preflight cannot reach the pointer switch.
maintenance_race_error="$temporary_root/maintenance-race.error"
raced_release="$install_root/.project-space-machine-tools/versions/raced-release"
mkdir -m 0700 -- "$raced_release"
cp -- "$temporary_root/source/project" "$raced_release/project"
cp -- "$temporary_root/source/project-codex-host" "$raced_release/project-codex-host"
cp -- "$temporary_root/source/codex" "$raced_release/codex"
cp -- "$temporary_root/source/CODEX-LICENSE" "$raced_release/CODEX-LICENSE"
cp -- "$temporary_root/source/CODEX-NOTICE" "$raced_release/CODEX-NOTICE"
cp -- "$temporary_root/source/CODEX-VERSION" "$raced_release/CODEX-VERSION"
set +e
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
grep -Fx -- '--user stop project-space-machine-connector-supervisor.service' "$systemctl_log"
pointer_restore="$temporary_root/current.restore"
ln -s -- "$maintenance_current_before" "$pointer_restore"
mv -Tf -- "$pointer_restore" "$install_root/.project-space-machine-tools/current"

# If a racing update finishes before the second check, a later verification
# failure must roll back to that newly completed pointer without restarting the
# retired service.
set +e
PROJECT_FIXTURE_CONNECTOR_VERSION=0.4.7 \
PROJECT_FIXTURE_POINTER_ON_STOP="$install_root/.project-space-machine-tools/current" \
PROJECT_FIXTURE_POINTER_TARGET='versions/raced-release' \
  "$upgrade_bundle/install.sh" --install-dir "$install_root" >/dev/null 2>&1
completed_race_status=$?
set -e
[[ $completed_race_status -eq 70 ]]
[[ $(readlink "$install_root/.project-space-machine-tools/current") == 'versions/raced-release' ]]
[[ ! -e $service_log ]]
ln -s -- "$maintenance_current_before" "$pointer_restore"
mv -Tf -- "$pointer_restore" "$install_root/.project-space-machine-tools/current"
rm -rf -- "$raced_release"

"$upgrade_bundle/install.sh" --install-dir "$install_root" >/dev/null
[[ $($install_root/project) == 'project fixture v2' ]]
second_current=$(readlink "$install_root/.project-space-machine-tools/current")
[[ $second_current == versions/${version}-* ]]
[[ $second_current != "$first_current" ]]
[[ ! -e $service_log ]]

# A pair that does not report one matching version fails before commit and
# restores the previous current pointer without restarting the retired service.
version_failure_log="$temporary_root/version-failure.log"
set +e
PROJECT_FIXTURE_CONNECTOR_VERSION=0.4.7 \
  "$upgrade_bundle/install.sh" --install-dir "$install_root" \
  >/dev/null 2>"$version_failure_log"
version_failure_status=$?
set -e
[[ $version_failure_status -eq 70 ]]
grep -Fx 'The installed project-codex-host does not report the bundled version.' "$version_failure_log"
[[ $(readlink "$install_root/.project-space-machine-tools/current") == "$second_current" ]]
[[ ! -e $service_log ]]

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
