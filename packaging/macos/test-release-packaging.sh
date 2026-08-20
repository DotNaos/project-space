#!/usr/bin/env bash
set -euo pipefail

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repository_root=$(cd -- "$script_directory/../.." && pwd -P)
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
bash "$script_directory/../release/validate-machine-tools-bundle.sh" \
  "$temporary_root/first/$archive" darwin-arm64 "$version" >/dev/null

mkdir "$temporary_root/extracted-v1"
gtar -xzf "$temporary_root/first/$archive" -C "$temporary_root/extracted-v1"
bundle_v1="$temporary_root/extracted-v1/project-space-machine-tools-darwin-arm64-v${version}"

expected_members=$'CODEX-LICENSE\nCODEX-NOTICE\nCODEX-VERSION\nSHA256SUMS.txt\nVERSION\ncodex\ninstall.sh\nproject\nproject-codex-host\nrelease-manifest-signing-public-key.pem'
actual_members=$(find "$bundle_v1" -mindepth 1 -maxdepth 1 -type f -print | sed 's#.*/##' | sort)
[[ $actual_members == "$expected_members" ]]

# v0.21.23's updater used this ten-member contract for both Unix targets.
# Keep the generated macOS archive compatible with that old validator while
# the current updater continues to accept the modern six-member shape too.
legacy_contract_members=$'CODEX-LICENSE\nCODEX-NOTICE\nCODEX-VERSION\nSHA256SUMS.txt\nVERSION\ncodex\ninstall.sh\nproject\nproject-codex-host\nrelease-manifest-signing-public-key.pem'
[[ $actual_members == "$legacy_contract_members" ]]

# The published v0.27.2 shape had the same six modern members but omitted the
# four legacy members above. Recreate that exact contract from the archive
# emitted by the real builder and ensure publication validation rejects it.
legacy_incomplete_staging="$temporary_root/legacy-incomplete-staging"
mkdir -p "$legacy_incomplete_staging"
cp -R "$bundle_v1" "$legacy_incomplete_staging/"
legacy_incomplete_bundle="$legacy_incomplete_staging/project-space-machine-tools-darwin-arm64-v${version}"
rm -f -- "$legacy_incomplete_bundle/CODEX-LICENSE" \
  "$legacy_incomplete_bundle/CODEX-NOTICE" \
  "$legacy_incomplete_bundle/CODEX-VERSION" \
  "$legacy_incomplete_bundle/codex"
(
  cd "$legacy_incomplete_bundle"
  shasum -a 256 project project-codex-host release-manifest-signing-public-key.pem \
    install.sh VERSION > SHA256SUMS.txt
)
legacy_incomplete_archive="$temporary_root/legacy-incomplete.tar.gz"
gtar -cf - -C "$legacy_incomplete_staging" \
  "project-space-machine-tools-darwin-arm64-v${version}" | gzip -n > "$legacy_incomplete_archive"
if bash "$script_directory/../release/validate-machine-tools-bundle.sh" \
  "$legacy_incomplete_archive" darwin-arm64 "$version" >/dev/null 2>&1; then
  echo 'Release validator accepted the published v0.27.2 macOS bundle shape.' >&2
  exit 1
fi

# Compile the exact tagged v0.21.23 updater in an isolated module, then drive
# its real Apply path against both archives. The protected harness executes the
# extracted candidate install.sh with temporary HOME and installation roots.
legacy_updater_commit='bba0c549fde9903f877d8c478489ec2931926773'
if [[ $(git -C "$repository_root" rev-parse 'v0.21.23^{commit}' 2>/dev/null) != "$legacy_updater_commit" ]]; then
  echo 'The exact v0.21.23 updater source is unavailable or moved.' >&2
  exit 66
fi
legacy_updater_root="$temporary_root/v0.21.23-updater"
mkdir -p "$legacy_updater_root"
git -C "$repository_root" archive v0.21.23 -- \
  go.mod go.sum \
  internal/selfupdate/archive.go \
  internal/selfupdate/install_source.go \
  internal/selfupdate/manifest.go \
  internal/selfupdate/release-manifest-signing-public-key.pem \
  internal/selfupdate/release_source.go \
  internal/selfupdate/types.go | \
  gtar -x -C "$legacy_updater_root"
install -m 0644 \
  "$script_directory/testdata/v0.21.23-updater-contract_test.go" \
  "$legacy_updater_root/internal/selfupdate/v0.21.23-updater-contract_test.go"
(
  cd "$legacy_updater_root"
  GOWORK=off \
    PROJECT_CANDIDATE_ARCHIVE="$temporary_root/first/$archive" \
    PROJECT_CANDIDATE_VERSION="$version" \
    PROJECT_V0272_SHAPE_ARCHIVE="$legacy_incomplete_archive" \
    go test -count=1 -run '^TestV02123DarwinUpdaterAgainstCurrentPackage$' -v ./internal/selfupdate
)

incomplete_staging="$temporary_root/incomplete-staging"
mkdir -p "$incomplete_staging"
cp -R "$bundle_v1" "$incomplete_staging/"
rm "$incomplete_staging/project-space-machine-tools-darwin-arm64-v${version}/project-codex-host"
incomplete_archive="$temporary_root/incomplete.tar.gz"
gtar -cf - -C "$incomplete_staging" \
  "project-space-machine-tools-darwin-arm64-v${version}" | gzip -n > "$incomplete_archive"
if bash "$script_directory/../release/validate-machine-tools-bundle.sh" \
  "$incomplete_archive" darwin-arm64 "$version" >/dev/null 2>&1; then
  echo 'Release validator accepted an incomplete macOS bundle.' >&2
  exit 1
fi

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

# Model the actual managed installation layout left by v0.21.23: the public
# launchers point at a versioned release through the current symlink.
legacy_release_id='0.21.23-48a5e5cbadc3e1eb'
legacy_release="$install_root/.project-space-machine-tools/versions/$legacy_release_id"
mkdir -p "$legacy_release"
cat > "$legacy_release/project" <<'EOF'
#!/bin/bash
if [[ "${1:-}" == --version ]]; then
  printf '%s\n' 'project 0.21.23'
  exit 0
fi
printf '%s\n' 'legacy project'
EOF
cat > "$legacy_release/project-codex-host" <<'EOF'
#!/bin/bash
if [[ "${1:-}" == --version ]]; then
  printf '%s\n' 'project-codex-host 0.21.23'
  exit 0
fi
printf '%s\n' 'legacy codex host'
EOF
chmod 0755 "$legacy_release/project" "$legacy_release/project-codex-host"
printf '0.21.23\n' > "$legacy_release/VERSION"
chmod 0600 "$legacy_release/VERSION"
cp "$temporary_root/source-v1/release-manifest-signing-public-key.pem" \
  "$legacy_release/release-manifest-signing-public-key.pem"
chmod 0644 "$legacy_release/release-manifest-signing-public-key.pem"
ln -s "versions/$legacy_release_id" \
  "$install_root/.project-space-machine-tools/current"
ln -s '.project-space-machine-tools/current/project' "$install_root/project"
ln -s '.project-space-machine-tools/current/project-codex-host' \
  "$install_root/project-codex-host"
previous_current=$(readlink "$install_root/.project-space-machine-tools/current")
[[ $previous_current == "versions/$legacy_release_id" ]]

# A failed candidate install must preserve that real prior release and its
# current pointer. This is the rollback path that the published v0.27.2
# failure exercised in Production.
legacy_failure_log="$temporary_root/legacy-failure.log"
set +e
PROJECT_FIXTURE_CODEX_HOST_VERSION=0.4.7 \
  "$bundle_v1/install.sh" --install-dir "$install_root" \
  >/dev/null 2>"$legacy_failure_log"
legacy_failure_status=$?
set -e
[[ $legacy_failure_status -eq 70 ]]
grep -Fx 'The installed project-codex-host does not report the bundled version.' \
  "$legacy_failure_log"
[[ $(readlink "$install_root/.project-space-machine-tools/current") == "$previous_current" ]]
[[ $($install_root/project) == 'legacy project' ]]
[[ $($install_root/project-codex-host) == 'legacy codex host' ]]
[[ $(<"$legacy_release/VERSION") == '0.21.23' ]]

"$bundle_v1/install.sh" --install-dir "$install_root" >/dev/null
[[ $($install_root/project) == v1 ]]
[[ -L $install_root/project && -L $install_root/project-codex-host ]]
[[ ! -e $install_root/project-space-connector && ! -L $install_root/project-space-connector ]]
[[ ! -e $install_root/project-approval-signer && ! -L $install_root/project-approval-signer ]]
first_current=$(readlink "$install_root/.project-space-machine-tools/current")
[[ $first_current == versions/${version}-* ]]
[[ $first_current != "$previous_current" ]]
[[ $(<"$legacy_release/VERSION") == '0.21.23' ]]

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
