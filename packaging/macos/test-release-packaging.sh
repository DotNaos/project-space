#!/usr/bin/env bash
set -euo pipefail

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
temporary_root=$(mktemp -d)
trap 'rm -rf -- "$temporary_root"' EXIT
version=${1:-1.2.3}
[[ $version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]

write_project_fixture() {
  local path=$1
  local label=$2
  local fail_start=${3:-0}
  cat > "$path" <<EOF
#!/bin/bash
if [[ "\${1:-}" == --version ]]; then
  printf '%s\n' 'project $version'
  exit 0
fi
if [[ "\${1:-}" == connector && "\${2:-}" == service ]]; then
  printf '%s:%s\n' '$label' "\$*" >> "\${PROJECT_FIXTURE_SERVICE_LOG:?}"
  if [[ "\${3:-}" == start-if-connected &&
    ( '$fail_start' == 1 || "\${PROJECT_FIXTURE_FAIL_START_LABEL:-}" == '$label' ) ]]; then
    exit 1
  fi
  if [[ "\${3:-}" == stop && -n "\${PROJECT_FIXTURE_POINTER_ON_STOP:-}" ]]; then
    pointer_temp="\${PROJECT_FIXTURE_POINTER_ON_STOP}.fixture-next"
    ln -s -- "\${PROJECT_FIXTURE_POINTER_TARGET:?}" "\$pointer_temp"
    mv -h -f -- "\$pointer_temp" "\$PROJECT_FIXTURE_POINTER_ON_STOP"
  fi
  if [[ "\${3:-}" == stop && -n "\${PROJECT_FIXTURE_MAINTENANCE_MARKER_ON_STOP:-}" ]]; then
    mkdir -p -- "\$(dirname -- "\$PROJECT_FIXTURE_MAINTENANCE_MARKER_ON_STOP")"
    printf '{}\n' > "\$PROJECT_FIXTURE_MAINTENANCE_MARKER_ON_STOP"
  fi
  exit 0
fi
printf '%s\n' '$label'
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

write_source() {
  local directory=$1
  local label=$2
  local fail_start=${3:-0}
  mkdir -p "$directory"
  write_project_fixture "$directory/project" "$label" "$fail_start"
  cat > "$directory/project-space-connector" <<EOF
#!/bin/bash
if [[ "\${1:-}" == --version ]]; then
  printf 'project-space-connector %s\n' "\${PROJECT_FIXTURE_CONNECTOR_VERSION:-$version}"
  exit 0
fi
printf '%s\n' 'connector $label'
EOF
  chmod 0755 "$directory/project-space-connector"
  cat > "$directory/codex" <<EOF
#!/bin/bash
if [[ "\${1:-}" == --version ]]; then
  printf '%s\n' 'codex-cli 0.145.0'
  exit 0
fi
EOF
  chmod 0755 "$directory/codex"
  printf '%s\n' 'codex license' > "$directory/CODEX-LICENSE"
  printf '%s\n' 'codex notice' > "$directory/CODEX-NOTICE"
  printf '%s\n' '0.145.0' > "$directory/CODEX-VERSION"
  write_trust_roots "$directory"
}

write_source "$temporary_root/source-v1" v1
: > "$temporary_root/source-v1/project-approval-signer"
chmod 0755 "$temporary_root/source-v1/project-approval-signer"
mkdir -p "$temporary_root/first" "$temporary_root/second"
SOURCE_DATE_EPOCH=0 "$script_directory/build-machine-tools.sh" "$version" "$temporary_root/source-v1" "$temporary_root/first" >/dev/null
SOURCE_DATE_EPOCH=0 "$script_directory/build-machine-tools.sh" "$version" "$temporary_root/source-v1" "$temporary_root/second" >/dev/null
archive="project-space-machine-tools-darwin-arm64-v${version}.tar.gz"
cmp "$temporary_root/first/$archive" "$temporary_root/second/$archive"
(cd "$temporary_root/first" && shasum -a 256 -c "${archive}.sha256")
mkdir "$temporary_root/extracted-v1"
gtar -xzf "$temporary_root/first/$archive" -C "$temporary_root/extracted-v1"
bundle_v1="$temporary_root/extracted-v1/project-space-machine-tools-darwin-arm64-v${version}"
expected_members=$'CODEX-LICENSE\nCODEX-NOTICE\nCODEX-VERSION\nSHA256SUMS.txt\nVERSION\ncodex\nconnector-command-signing-public-key.pem\ninstall.sh\nproject\nproject-approval-signer\nproject-space-connector\nrelease-manifest-signing-public-key.pem'
actual_members=$(find "$bundle_v1" -mindepth 1 -maxdepth 1 -type f -print | sed 's#.*/##' | sort)
[[ $actual_members == "$expected_members" ]]
[[ ! -s $bundle_v1/project-approval-signer ]]

home="$temporary_root/home"
install_root="$home/.local/bin"
service_log="$temporary_root/service.log"
launchctl_log="$temporary_root/launchctl.log"
mkdir -p "$home/.config/project-space" "$home/Library/Application Support/Project Space" "$temporary_root/fake-bin"
printf 'identity-stays\n' > "$home/.config/project-space/machine-credential.json"
printf 'config-stays\n' > "$home/.config/project-space/connector.json"
cat > "$temporary_root/fake-bin/launchctl" <<'EOF'
#!/bin/bash
printf '%s\n' "$*" >> "${PROJECT_FIXTURE_LAUNCHCTL_LOG:?}"
exit 0
EOF
chmod 0755 "$temporary_root/fake-bin/launchctl"
export HOME="$home"
export PATH="$temporary_root/fake-bin:$PATH"
export PROJECT_FIXTURE_SERVICE_LOG="$service_log"
export PROJECT_FIXTURE_LAUNCHCTL_LOG="$launchctl_log"

"$bundle_v1/install.sh" --install-dir "$install_root" >/dev/null
[[ $($install_root/project) == v1 ]]
[[ -L $install_root/project && -L $install_root/project-space-connector ]]
[[ $($install_root/.project-space-machine-tools/current/codex --version) == 'codex-cli 0.145.0' ]]
[[ ! -e $install_root/project-approval-signer && ! -L $install_root/project-approval-signer ]]
first_current=$(readlink "$install_root/.project-space-machine-tools/current")
[[ $first_current == versions/${version}-* ]]

# On the affected macOS build, cmp was killed while comparing the large
# standalone connector binary. Reinstalling an identical release must use a
# streaming comparison instead.
mkdir "$temporary_root/killed-cmp-bin"
cat > "$temporary_root/killed-cmp-bin/cmp" <<'EOF'
#!/bin/bash
kill -9 $$
EOF
chmod 0755 "$temporary_root/killed-cmp-bin/cmp"
PATH="$temporary_root/killed-cmp-bin:$PATH" \
  "$bundle_v1/install.sh" --install-dir "$install_root" >/dev/null
[[ $(readlink "$install_root/.project-space-machine-tools/current") == "$first_current" ]]

# A real content mismatch must still fail closed before the active release or
# connector service is changed.
installed_connector="$install_root/.project-space-machine-tools/current/project-space-connector"
printf 'tampered\n' >> "$installed_connector"
existing_release_error="$temporary_root/existing-release.error"
existing_release_service_lines=$(wc -l < "$service_log")
set +e
"$bundle_v1/install.sh" --install-dir "$install_root" \
  >/dev/null 2>"$existing_release_error"
existing_release_status=$?
set -e
[[ $existing_release_status -eq 73 ]]
grep -Fx 'The existing machine-tools release directory does not match this bundle.' \
  "$existing_release_error"
install -m 0755 -- "$bundle_v1/project-space-connector" "$installed_connector"
[[ $(readlink "$install_root/.project-space-machine-tools/current") == "$first_current" ]]
[[ $(wc -l < "$service_log") == "$existing_release_service_lines" ]]

# An incomplete existing release is also a mismatch and must leave the active
# release and connector service untouched.
installed_version="$install_root/.project-space-machine-tools/current/VERSION"
rm -f -- "$installed_version"
incomplete_release_error="$temporary_root/incomplete-release.error"
set +e
"$bundle_v1/install.sh" --install-dir "$install_root" \
  >/dev/null 2>"$incomplete_release_error"
incomplete_release_status=$?
set -e
[[ $incomplete_release_status -eq 73 ]]
grep -Fx 'The existing machine-tools release directory does not match this bundle.' \
  "$incomplete_release_error"
install -m 0600 -- "$bundle_v1/VERSION" "$installed_version"
[[ $(readlink "$install_root/.project-space-machine-tools/current") == "$first_current" ]]
[[ $(wc -l < "$service_log") == "$existing_release_service_lines" ]]

cmp "$temporary_root/source-v1/connector-command-signing-public-key.pem" \
  "$install_root/.project-space-machine-tools/current/connector-command-signing-public-key.pem"
cmp "$temporary_root/source-v1/release-manifest-signing-public-key.pem" \
  "$install_root/.project-space-machine-tools/current/release-manifest-signing-public-key.pem"
grep -Fx 'identity-stays' "$home/.config/project-space/machine-credential.json"
grep -Fx 'config-stays' "$home/.config/project-space/connector.json"

mkdir -p "$home/Library/LaunchAgents"
modern_plist="$home/Library/LaunchAgents/net.os-home.project-space.machine-connector-supervisor.plist"
printf 'managed\n' > "$modern_plist"
write_source "$temporary_root/source-v2" v2
mkdir "$temporary_root/output-v2" "$temporary_root/extracted-v2"
SOURCE_DATE_EPOCH=0 "$script_directory/build-machine-tools.sh" "$version" "$temporary_root/source-v2" "$temporary_root/output-v2" >/dev/null
gtar -xzf "$temporary_root/output-v2/$archive" -C "$temporary_root/extracted-v2"
bundle_v2="$temporary_root/extracted-v2/project-space-machine-tools-darwin-arm64-v${version}"

# Upgrading from an approval-enabled release removes only the managed legacy
# helper link. An unrelated file at the same path remains user-owned.
printf 'user-owned\n' > "$install_root/project-approval-signer"
"$bundle_v1/install.sh" --install-dir "$install_root" >/dev/null
grep -Fx 'user-owned' "$install_root/project-approval-signer"
rm -f -- "$install_root/project-approval-signer"
ln -s -- ".project-space-machine-tools/current/project-approval-signer" \
  "$install_root/project-approval-signer"

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
  "$bundle_v2/install.sh" --install-dir "$install_root" \
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
cp -- "$temporary_root/source-v1/project" "$raced_release/project"
cp -- "$temporary_root/source-v1/project-space-connector" "$raced_release/project-space-connector"
set +e
PROJECT_FIXTURE_MAINTENANCE_MARKER_ON_STOP="$maintenance_root/control.json" \
PROJECT_FIXTURE_POINTER_ON_STOP="$install_root/.project-space-machine-tools/current" \
PROJECT_FIXTURE_POINTER_TARGET='versions/raced-release' \
  "$bundle_v2/install.sh" --install-dir "$install_root" \
  >/dev/null 2>"$maintenance_race_error"
maintenance_race_status=$?
set -e
[[ $maintenance_race_status -eq 75 ]]
grep -Fx 'Connector maintenance is still active or unresolved; recover it before installing.' \
  "$maintenance_race_error"
rm -f -- "$maintenance_root/control.json"
[[ $(readlink "$install_root/.project-space-machine-tools/current") == 'versions/raced-release' ]]
grep -Fx 'v2:connector service stop' "$service_log"
[[ $(grep -Fxc 'v1:connector service start-if-connected' "$service_log") == 2 ]]
pointer_restore="$temporary_root/current.restore"
ln -s -- "$maintenance_current_before" "$pointer_restore"
mv -h -f -- "$pointer_restore" "$install_root/.project-space-machine-tools/current"

# If a racing update finishes and removes its marker before the second check,
# a later installer failure must roll back to that newly completed pointer.
completed_race_starts_before=$(grep -Fxc 'v1:connector service start-if-connected' "$service_log")
set +e
PROJECT_FIXTURE_FAIL_START_LABEL=v2 \
PROJECT_FIXTURE_POINTER_ON_STOP="$install_root/.project-space-machine-tools/current" \
PROJECT_FIXTURE_POINTER_TARGET='versions/raced-release' \
  "$bundle_v2/install.sh" --install-dir "$install_root" >/dev/null 2>&1
completed_race_status=$?
set -e
[[ $completed_race_status -eq 70 ]]
[[ $(readlink "$install_root/.project-space-machine-tools/current") == 'versions/raced-release' ]]
[[ $(grep -Fxc 'v1:connector service start-if-connected' "$service_log") == $((completed_race_starts_before + 1)) ]]
[[ -L $install_root/project-approval-signer ]]
[[ $(readlink "$install_root/project-approval-signer") == '.project-space-machine-tools/current/project-approval-signer' ]]
ln -s -- "$maintenance_current_before" "$pointer_restore"
mv -h -f -- "$pointer_restore" "$install_root/.project-space-machine-tools/current"
rm -rf -- "$raced_release"

"$bundle_v2/install.sh" --install-dir "$install_root" >/dev/null
[[ $($install_root/project) == v2 ]]
[[ ! -e $install_root/project-approval-signer && ! -L $install_root/project-approval-signer ]]
second_current=$(readlink "$install_root/.project-space-machine-tools/current")
[[ $second_current != "$first_current" ]]
grep -Fx 'v2:connector service stop' "$service_log"
grep -Fx 'v2:connector service start-if-connected' "$service_log"

# A pair that does not report one matching version fails before commit and
# restores the previous current pointer and service.
version_failure_starts_before=$(grep -Fxc 'v2:connector service start-if-connected' "$service_log")
version_failure_log="$temporary_root/version-failure.log"
set +e
PROJECT_FIXTURE_CONNECTOR_VERSION=0.4.7 \
  "$bundle_v2/install.sh" --install-dir "$install_root" \
  >/dev/null 2>"$version_failure_log"
version_failure_status=$?
set -e
[[ $version_failure_status -eq 70 ]]
grep -Fx 'The installed project-space-connector does not report the bundled version.' "$version_failure_log"
[[ $(readlink "$install_root/.project-space-machine-tools/current") == "$second_current" ]]
[[ $(grep -Fxc 'v2:connector service start-if-connected' "$service_log") == $((version_failure_starts_before + 1)) ]]

# A machine with both services keeps the managed identity, stops the legacy
# process, and removes only the obsolete LaunchAgent after the managed runtime
# has reconnected successfully.
dual_legacy_plist="$home/Library/LaunchAgents/net.os-home.project-space-connector.plist"
printf 'legacy\n' > "$dual_legacy_plist"
"$bundle_v2/install.sh" --install-dir "$install_root" >/dev/null
[[ ! -e $dual_legacy_plist ]]
grep -Fx "bootout gui/$(id -u)/net.os-home.project-space-connector" "$launchctl_log"

write_source "$temporary_root/source-v3" v3 1
mkdir "$temporary_root/output-v3" "$temporary_root/extracted-v3"
SOURCE_DATE_EPOCH=0 "$script_directory/build-machine-tools.sh" "$version" "$temporary_root/source-v3" "$temporary_root/output-v3" >/dev/null
gtar -xzf "$temporary_root/output-v3/$archive" -C "$temporary_root/extracted-v3"
bundle_v3="$temporary_root/extracted-v3/project-space-machine-tools-darwin-arm64-v${version}"
printf 'legacy\n' > "$dual_legacy_plist"
v2_start_count_before_failure=$(grep -Fxc 'v2:connector service start-if-connected' "$service_log")
if "$bundle_v3/install.sh" --install-dir "$install_root" >/dev/null 2>&1; then
  echo 'Installer accepted a release whose connector service could not start.' >&2
  exit 1
fi
[[ $(readlink "$install_root/.project-space-machine-tools/current") == "$second_current" ]]
[[ $($install_root/project) == v2 ]]
[[ -f $dual_legacy_plist ]]
grep -Fx 'v3:connector service stop' "$service_log"
[[ $(grep -Fxc 'v2:connector service start-if-connected' "$service_log") == $((v2_start_count_before_failure + 1)) ]]
grep -Fx "bootstrap gui/$(id -u) $dual_legacy_plist" "$launchctl_log"
grep -Fx "kickstart -k gui/$(id -u)/net.os-home.project-space-connector" "$launchctl_log"

rollback_failure_log="$temporary_root/rollback-failure.log"
set +e
PROJECT_FIXTURE_FAIL_START_LABEL=v2 \
  "$bundle_v3/install.sh" --install-dir "$install_root" >/dev/null 2>"$rollback_failure_log"
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
[[ $($install_root/project) == v2 ]]
[[ -f $dual_legacy_plist ]]

migration_home="$temporary_root/homebrew-migration-home"
migration_install_root="$migration_home/.local/bin"
migration_service_log="$temporary_root/homebrew-migration-service.log"
migration_launchctl_log="$temporary_root/homebrew-migration-launchctl.log"
migration_homebrew_project="$temporary_root/homebrew-project"
mkdir -p "$migration_home/Library/LaunchAgents"
write_project_fixture "$migration_homebrew_project" homebrew
cat > "$migration_home/Library/LaunchAgents/net.os-home.project-space.machine-connector-supervisor.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>net.os-home.project-space.machine-connector-supervisor</string>
  <key>ProgramArguments</key>
  <array>
    <string>$migration_homebrew_project</string>
    <string>connector</string>
    <string>run</string>
  </array>
</dict>
</plist>
EOF
if HOME="$migration_home" \
  PROJECT_FIXTURE_SERVICE_LOG="$migration_service_log" \
  PROJECT_FIXTURE_LAUNCHCTL_LOG="$migration_launchctl_log" \
  "$bundle_v3/install.sh" --install-dir "$migration_install_root" >/dev/null 2>&1; then
  echo 'Installer accepted a failed Homebrew-to-managed migration.' >&2
  exit 1
fi
[[ ! -e $migration_install_root/project && ! -L $migration_install_root/project ]]
[[ ! -e $migration_install_root/.project-space-machine-tools/current ]]
grep -Fx 'v3:connector service stop' "$migration_service_log"
grep -Fx 'homebrew:connector service start-if-connected' "$migration_service_log"
[[ $(grep -Fxc 'v3:connector service stop' "$migration_service_log") == 2 ]]
[[ $(sed -n '1p' "$migration_service_log") == 'v3:connector service stop' ]]

rm -f "$modern_plist"
legacy_plist="$home/Library/LaunchAgents/net.os-home.project-space-connector.plist"
printf 'legacy\n' > "$legacy_plist"
write_source "$temporary_root/source-v4" v4
mkdir "$temporary_root/output-v4" "$temporary_root/extracted-v4"
SOURCE_DATE_EPOCH=0 "$script_directory/build-machine-tools.sh" "$version" "$temporary_root/source-v4" "$temporary_root/output-v4" >/dev/null
gtar -xzf "$temporary_root/output-v4/$archive" -C "$temporary_root/extracted-v4"
bundle_v4="$temporary_root/extracted-v4/project-space-machine-tools-darwin-arm64-v${version}"
"$bundle_v4/install.sh" --install-dir "$install_root" >/dev/null
[[ $($install_root/project) == v4 ]]
grep -F 'bootout gui/' "$launchctl_log"
grep -F "bootstrap gui/$(id -u) $legacy_plist" "$launchctl_log"
grep -F 'kickstart -k gui/' "$launchctl_log"

printf 'tampered\n' >> "$bundle_v1/project"
if "$bundle_v1/install.sh" --install-dir "$temporary_root/tampered" >/dev/null 2>&1; then
  echo 'Installer accepted a tampered bundle.' >&2
  exit 1
fi
[[ ! -e $temporary_root/tampered/project ]]
grep -Fx 'identity-stays' "$home/.config/project-space/machine-credential.json"
grep -Fx 'config-stays' "$home/.config/project-space/connector.json"
echo 'macOS release packaging checks passed.'
