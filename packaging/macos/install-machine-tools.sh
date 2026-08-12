#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: ./install.sh [--install-dir <absolute-path>]" >&2
}

install_directory="${HOME}/.local/bin"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir)
      [[ $# -ge 2 ]] || { usage; exit 64; }
      install_directory=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 64
      ;;
  esac
done

if [[ $(uname -s) != Darwin || $(uname -m) != arm64 ]]; then
  echo "This bundle supports macOS arm64 only." >&2
  exit 69
fi
if [[ $EUID -eq 0 ]]; then
  echo "Run this per-user installer without sudo." >&2
  exit 77
fi
if [[ $install_directory != /* || $install_directory == *$'\n'* || $install_directory == *$'\r'* ]]; then
  echo "The install directory must be an absolute path without line breaks." >&2
  exit 64
fi
if [[ -L $install_directory ]]; then
  echo "Refusing to install through a symbolic-link directory: $install_directory" >&2
  exit 73
fi

bundle_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
for required in \
  SHA256SUMS.txt VERSION project project-codex-host \
  release-manifest-signing-public-key.pem; do
  if [[ ! -f ${bundle_root}/${required} ]]; then
    echo "The release bundle is incomplete: $required is missing." >&2
    exit 66
  fi
done
if ! (cd -- "$bundle_root" && shasum -a 256 -c SHA256SUMS.txt); then
  echo "The release bundle failed its integrity check; nothing was installed." >&2
  exit 65
fi
version=$(tr -d '\r\n' < "${bundle_root}/VERSION")
if [[ ! $version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "The release bundle contains an invalid version." >&2
  exit 65
fi

verify_installed_pair() {
  local binary output version_pattern
  version_pattern=${version//./\\.}
  for binary in project project-codex-host; do
    if ! output=$("${install_directory}/${binary}" --version 2>&1) ||
      [[ ! $output =~ (^|[[:space:]])v?${version_pattern}($|[[:space:]]) ]]; then
      echo "The installed ${binary} does not report the bundled version." >&2
      return 1
    fi
  done
}

files_match() {
  local left=$1
  local right=$2
  local left_digest right_digest
  if [[ ! -f $left || -L $left || ! -f $right || -L $right ]]; then
    return 1
  fi
  left_digest=$(shasum -a 256 "$left" | awk '{print $1}') || return 1
  right_digest=$(shasum -a 256 "$right" | awk '{print $1}') || return 1
  [[ -n $left_digest && $left_digest == "$right_digest" ]]
}

umask 077
[[ -d $install_directory ]] || mkdir -m 0700 -p -- "$install_directory"
tools_root="${install_directory}/.project-space-machine-tools"
versions_root="${tools_root}/versions"
current_link="${tools_root}/current"
mkdir -m 0700 -p -- "$versions_root"
if [[ -e $current_link && ! -L $current_link ]]; then
  echo "The machine-tools current pointer is not a symbolic link: $current_link" >&2
  exit 73
fi

legacy_plist="${HOME}/Library/LaunchAgents/net.os-home.project-space-connector.plist"
modern_plist="${HOME}/Library/LaunchAgents/net.os-home.project-space.machine-connector-supervisor.plist"
if [[ -L $legacy_plist || -L $modern_plist ]]; then
  echo "Refusing to migrate a connector LaunchAgent through a symbolic link." >&2
  exit 73
fi
launch_domain="gui/$(id -u)"
legacy_service="${launch_domain}/net.os-home.project-space-connector"
modern_service="${launch_domain}/net.os-home.project-space.machine-connector-supervisor"
bundle_digest=$(shasum -a 256 "${bundle_root}/SHA256SUMS.txt" | awk '{print $1}')
release_id="${version}-${bundle_digest:0:16}"
release_directory="${versions_root}/${release_id}"
transaction_root=$(mktemp -d "${tools_root}/.install.XXXXXX")
backup_root="${transaction_root}/backups"
mkdir -m 0700 -- "$backup_root"
previous_current_target=""
installation_started=0
committed=0
pointer_switched=0
changed_entries=()

restore_entry() {
  local name=$1
  local destination="${install_directory}/${name}"
  local backup="${backup_root}/${name}"
  rm -f -- "$destination"
  if [[ -e $backup || -L $backup ]]; then
    mv -h -f -- "$backup" "$destination"
  fi
}

rollback_installation() {
  local rollback_pointer="${transaction_root}/current.rollback"
  if [[ $pointer_switched -eq 1 ]]; then
    if [[ -n $previous_current_target ]]; then
      rm -f -- "$rollback_pointer"
      ln -s -- "$previous_current_target" "$rollback_pointer"
      mv -h -f -- "$rollback_pointer" "$current_link"
    else
      rm -f -- "$current_link"
    fi
  fi
  local index
  for ((index=${#changed_entries[@]} - 1; index >= 0; index--)); do
    restore_entry "${changed_entries[$index]}"
  done
}

cleanup() {
  local status=$?
  local rollback_failed=0
  trap - EXIT
  if [[ $status -ne 0 && $installation_started -eq 1 && $committed -eq 0 ]]; then
    if ! rollback_installation; then
      rollback_failed=1
    fi
  fi
  rm -rf -- "$transaction_root"
  if [[ $rollback_failed -eq 1 ]]; then
    echo "The installation failed with status $status and the previous machine tools could not be restored. Manual recovery is required." >&2
    exit 71
  fi
  exit "$status"
}
trap cleanup EXIT

staged_release="${transaction_root}/${release_id}"
mkdir -m 0700 -- "$staged_release"
for name in project project-codex-host; do
  install -m 0755 -- "${bundle_root}/${name}" "${staged_release}/${name}"
done
for name in release-manifest-signing-public-key.pem; do
  install -m 0644 -- "${bundle_root}/${name}" "${staged_release}/${name}"
done
install -m 0600 -- "${bundle_root}/VERSION" "${staged_release}/VERSION"
if [[ -d $release_directory ]]; then
  for member in \
    project project-codex-host \
    release-manifest-signing-public-key.pem \
    VERSION; do
    if ! files_match "${staged_release}/${member}" "${release_directory}/${member}"; then
      echo "The existing machine-tools release directory does not match this bundle." >&2
      exit 73
    fi
  done
else
  mv -- "$staged_release" "$release_directory"
fi

for name in project project-codex-host; do
  destination="${install_directory}/${name}"
  if [[ -d $destination && ! -L $destination ]]; then
    echo "Refusing to replace a directory: $destination" >&2
    exit 73
  fi
done

installation_started=1
if launchctl print "$legacy_service" >/dev/null 2>&1; then
  launchctl bootout "$legacy_service"
fi
if launchctl print "$modern_service" >/dev/null 2>&1; then
  launchctl bootout "$modern_service"
fi
[[ ! -L $current_link ]] || previous_current_target=$(readlink "$current_link")

for name in project project-codex-host; do
  destination="${install_directory}/${name}"
  expected_target=".project-space-machine-tools/current/${name}"
  if [[ -L $destination && $(readlink "$destination") == "$expected_target" ]]; then
    continue
  fi
  if [[ -e $destination || -L $destination ]]; then
    mv -h -f -- "$destination" "${backup_root}/${name}"
  fi
  link_temp="${transaction_root}/${name}.link"
  ln -s -- "$expected_target" "$link_temp"
  mv -h -f -- "$link_temp" "$destination"
  changed_entries+=("$name")
done
obsolete_connector="${install_directory}/project-space-connector"
if [[ -L $obsolete_connector &&
  $(readlink "$obsolete_connector") == '.project-space-machine-tools/current/project-space-connector' ]]; then
  mv -h -f -- "$obsolete_connector" "${backup_root}/project-space-connector"
  changed_entries+=("project-space-connector")
fi
obsolete_signer="${install_directory}/project-approval-signer"
if [[ -L $obsolete_signer && $(readlink "$obsolete_signer") == ".project-space-machine-tools/current/project-approval-signer" ]]; then
  mv -h -f -- "$obsolete_signer" "${backup_root}/project-approval-signer"
  changed_entries+=("project-approval-signer")
fi
next_current="${transaction_root}/current.next"
ln -s -- "versions/${release_id}" "$next_current"
mv -h -f -- "$next_current" "$current_link"
pointer_switched=1

if ! verify_installed_pair; then
  echo "The new machine-tools pair could not be verified; the installation was rolled back." >&2
  exit 70
fi

rm -f -- "$legacy_plist" "$modern_plist"
committed=1
rm -rf -- "$transaction_root"
trap - EXIT
printf 'Installed Project Space machine tools %s in %s\n' "$version" "$install_directory"
printf 'Next: run %s/project environment list --format json\n' "$install_directory"
printf 'Then launch a pinned Runtime with project environment bootstrap.\n'
