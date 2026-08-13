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
  cat > "$path" <<EOF
#!/bin/bash
if [[ "\${1:-}" == --version ]]; then
  printf '%s\n' 'project $version'
  exit 0
fi
printf '%s\n' '$label'
EOF
  chmod 0755 "$path"
}

write_trust_roots() {
  local directory=$1
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
  cat > "$directory/project-codex-host" <<EOF
#!/bin/bash
if [[ "\${1:-}" == --version ]]; then
  printf 'project-codex-host %s\n' "\${PROJECT_FIXTURE_CODEX_HOST_VERSION:-$version}"
  exit 0
fi
printf '%s\n' 'codex host $label'
EOF
  chmod 0755 "$directory/project-codex-host"
  write_trust_roots "$directory"
}

write_source "$temporary_root/source-v1" v1
mkdir -p "$temporary_root/first" "$temporary_root/second"
SOURCE_DATE_EPOCH=0 "$script_directory/build-machine-tools.sh" "$version" "$temporary_root/source-v1" "$temporary_root/first" >/dev/null
SOURCE_DATE_EPOCH=0 "$script_directory/build-machine-tools.sh" "$version" "$temporary_root/source-v1" "$temporary_root/second" >/dev/null
archive="project-space-machine-tools-darwin-arm64-v${version}.tar.gz"
cmp "$temporary_root/first/$archive" "$temporary_root/second/$archive"
(cd "$temporary_root/first" && shasum -a 256 -c "${archive}.sha256")
mkdir "$temporary_root/extracted-v1"
gtar -xzf "$temporary_root/first/$archive" -C "$temporary_root/extracted-v1"
bundle_v1="$temporary_root/extracted-v1/project-space-machine-tools-darwin-arm64-v${version}"
expected_members=$'SHA256SUMS.txt\nVERSION\ninstall.sh\nproject\nproject-codex-host\nrelease-manifest-signing-public-key.pem'
actual_members=$(find "$bundle_v1" -mindepth 1 -maxdepth 1 -type f -print | sed 's#.*/##' | sort)
[[ $actual_members == "$expected_members" ]]

home="$temporary_root/home"
install_root="$home/.local/bin"
service_log="$temporary_root/service.log"
launchctl_log="$temporary_root/launchctl.log"
mkdir -p "$home/.config/project-space" "$home/Library/Application Support/Project Space" "$temporary_root/fake-bin"
mkdir -p "$install_root"
ln -s '.project-space-machine-tools/current/project-space-connector' \
  "$install_root/project-space-connector"
: > "$service_log"
: > "$launchctl_log"
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
[[ -L $install_root/project && -L $install_root/project-codex-host ]]
[[ ! -e $install_root/project-space-connector && ! -L $install_root/project-space-connector ]]
[[ ! -e $install_root/project-approval-signer && ! -L $install_root/project-approval-signer ]]
first_current=$(readlink "$install_root/.project-space-machine-tools/current")
[[ $first_current == versions/${version}-* ]]

# On the affected macOS build, cmp was killed while comparing the large
# standalone Codex host binary. Reinstalling an identical release must use a
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
# retired service is changed.
installed_connector="$install_root/.project-space-machine-tools/current/project-codex-host"
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
install -m 0755 -- "$bundle_v1/project-codex-host" "$installed_connector"
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

# An unrelated file at the retired helper path remains user-owned, while a
# managed legacy link is removed during the one-way cleanup.
printf 'user-owned\n' > "$install_root/project-approval-signer"
"$bundle_v1/install.sh" --install-dir "$install_root" >/dev/null
grep -Fx 'user-owned' "$install_root/project-approval-signer"
rm -f -- "$install_root/project-approval-signer"
ln -s -- ".project-space-machine-tools/current/project-approval-signer" \
  "$install_root/project-approval-signer"

legacy_plist="$home/Library/LaunchAgents/net.os-home.project-space-connector.plist"
printf 'legacy\n' > "$legacy_plist"
"$bundle_v2/install.sh" --install-dir "$install_root" >/dev/null
[[ $($install_root/project) == v2 ]]
[[ $($install_root/project-codex-host) == 'codex host v2' ]]
[[ ! -e $install_root/project-approval-signer && ! -L $install_root/project-approval-signer ]]
[[ ! -e $install_root/project-space-connector && ! -L $install_root/project-space-connector ]]
[[ ! -e $legacy_plist && ! -e $modern_plist ]]
second_current=$(readlink "$install_root/.project-space-machine-tools/current")
[[ $second_current != "$first_current" ]]
grep -Fx "bootout gui/$(id -u)/net.os-home.project-space-connector" "$launchctl_log"
grep -Fx "bootout gui/$(id -u)/net.os-home.project-space.machine-connector-supervisor" "$launchctl_log"
if grep -F 'bootstrap ' "$launchctl_log" || grep -F 'kickstart ' "$launchctl_log"; then
  echo 'The installer restarted a retired Connector service.' >&2
  exit 1
fi

# A pair that does not report one matching version fails before commit and
# restores the previous current pointer.
version_failure_log="$temporary_root/version-failure.log"
set +e
PROJECT_FIXTURE_CODEX_HOST_VERSION=0.4.7 \
  "$bundle_v2/install.sh" --install-dir "$install_root" \
  >/dev/null 2>"$version_failure_log"
version_failure_status=$?
set -e
[[ $version_failure_status -eq 70 ]]
grep -Fx 'The installed project-codex-host does not report the bundled version.' "$version_failure_log"
[[ $(readlink "$install_root/.project-space-machine-tools/current") == "$second_current" ]]

printf 'tampered\n' >> "$bundle_v1/project"
if "$bundle_v1/install.sh" --install-dir "$temporary_root/tampered" >/dev/null 2>&1; then
  echo 'Installer accepted a tampered bundle.' >&2
  exit 1
fi
[[ ! -e $temporary_root/tampered/project ]]
grep -Fx 'identity-stays' "$home/.config/project-space/machine-credential.json"
grep -Fx 'config-stays' "$home/.config/project-space/connector.json"
echo 'macOS release packaging checks passed.'
