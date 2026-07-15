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
  SHA256SUMS.txt VERSION project project-space-connector project-approval-signer \
  connector-command-signing-public-key.pem release-manifest-signing-public-key.pem; do
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
  for binary in project project-space-connector; do
    if ! output=$("${install_directory}/${binary}" --version 2>&1) ||
      [[ ! $output =~ (^|[[:space:]])v?${version_pattern}($|[[:space:]]) ]]; then
      echo "The installed ${binary} does not report the bundled version." >&2
      return 1
    fi
  done
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

maintenance_root="${tools_root}/maintenance"
assert_connector_maintenance_idle() {
  if [[ -L $maintenance_root || ( -e $maintenance_root && ! -d $maintenance_root ) ]]; then
    echo "The connector maintenance path is unsafe: $maintenance_root" >&2
    return 73
  fi
  local maintenance_marker marker_path
  for maintenance_marker in state.json control.json decision.json; do
    marker_path="${maintenance_root}/${maintenance_marker}"
    if [[ -e $marker_path || -L $marker_path ]]; then
      echo "Connector maintenance is still active or unresolved; recover it before installing." >&2
      return 75
    fi
  done
}
assert_connector_maintenance_idle

legacy_plist="${HOME}/Library/LaunchAgents/net.os-home.project-space-connector.plist"
modern_plist="${HOME}/Library/LaunchAgents/net.os-home.project-space.machine-connector-supervisor.plist"
if [[ -L $legacy_plist || -L $modern_plist ]]; then
  echo "Refusing to migrate a connector LaunchAgent through a symbolic link." >&2
  exit 73
fi
service_mode=none
[[ ! -f $legacy_plist ]] || service_mode=legacy
[[ ! -f $modern_plist ]] || service_mode=managed
migrate_legacy_service=0
if [[ -f $legacy_plist && -f $modern_plist ]]; then
  migrate_legacy_service=1
fi
launch_domain="gui/$(id -u)"
legacy_service="${launch_domain}/net.os-home.project-space-connector"
existing_project="${install_directory}/project"
previous_managed_project=""
if [[ $service_mode == managed && ! -x $existing_project ]]; then
  previous_managed_project=$(
    /usr/bin/plutil -extract ProgramArguments.0 raw -o - "$modern_plist" 2>/dev/null || true
  )
  if [[ $previous_managed_project != /* || ! -f $previous_managed_project ||
    ! -x $previous_managed_project || $previous_managed_project == *$'\n'* ||
    $previous_managed_project == *$'\r'* ]]; then
    echo "The existing managed connector executable could not be preserved." >&2
    exit 73
  fi
fi

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
legacy_was_running=0
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

start_connector() {
  if [[ $service_mode == legacy ]]; then
    launchctl bootstrap "$launch_domain" "$legacy_plist"
    launchctl kickstart -k "$legacy_service"
  else
    "${install_directory}/project" connector service start-if-connected
  fi
}

restart_previous_connector() {
  local restart_failed=0
  if [[ $service_mode == legacy ]]; then
    launchctl bootstrap "$launch_domain" "$legacy_plist" || restart_failed=1
    launchctl kickstart -k "$legacy_service" || restart_failed=1
  elif [[ $service_mode == managed && -n $previous_managed_project ]]; then
    "$previous_managed_project" connector service start-if-connected || restart_failed=1
  elif [[ $service_mode == managed && -x $existing_project ]]; then
    "$existing_project" connector service start-if-connected || restart_failed=1
  fi
  if [[ $migrate_legacy_service -eq 1 && $legacy_was_running -eq 1 ]]; then
    launchctl bootstrap "$launch_domain" "$legacy_plist" || restart_failed=1
    launchctl kickstart -k "$legacy_service" || restart_failed=1
  fi
  return "$restart_failed"
}

rollback_installation() {
  local rollback_pointer="${transaction_root}/current.rollback"
  local rollback_failed=0
  if [[ $pointer_switched -eq 1 ]]; then
    if [[ $service_mode != legacy && -x ${install_directory}/project ]]; then
      if ! "${install_directory}/project" connector service stop; then
        echo "The attempted connector service could not be stopped before rollback." >&2
        rollback_failed=1
      fi
    fi
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
  if ! restart_previous_connector; then
    echo "The previous connector service could not be restarted after rollback." >&2
    rollback_failed=1
  fi
  return "$rollback_failed"
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
    echo "The installation failed with status $status and rollback could not restore the previous connector service. Manual recovery is required." >&2
    exit 71
  fi
  exit "$status"
}
trap cleanup EXIT

staged_release="${transaction_root}/${release_id}"
mkdir -m 0700 -- "$staged_release"
for name in project project-space-connector project-approval-signer; do
  install -m 0755 -- "${bundle_root}/${name}" "${staged_release}/${name}"
done
for name in connector-command-signing-public-key.pem release-manifest-signing-public-key.pem; do
  install -m 0644 -- "${bundle_root}/${name}" "${staged_release}/${name}"
done
install -m 0600 -- "${bundle_root}/VERSION" "${staged_release}/VERSION"
if [[ -d $release_directory ]]; then
  for member in \
    project project-space-connector project-approval-signer \
    connector-command-signing-public-key.pem release-manifest-signing-public-key.pem \
    VERSION; do
    if ! cmp -s -- "${staged_release}/${member}" "${release_directory}/${member}"; then
      echo "The existing machine-tools release directory does not match this bundle." >&2
      exit 73
    fi
  done
else
  mv -- "$staged_release" "$release_directory"
fi

for name in project project-space-connector project-approval-signer; do
  destination="${install_directory}/${name}"
  if [[ -d $destination && ! -L $destination ]]; then
    echo "Refusing to replace a directory: $destination" >&2
    exit 73
  fi
done

installation_started=1
if [[ $migrate_legacy_service -eq 1 ]] && launchctl print "$legacy_service" >/dev/null 2>&1; then
  legacy_was_running=1
  launchctl bootout "$legacy_service"
fi
if [[ $service_mode == legacy ]]; then
  if launchctl print "$legacy_service" >/dev/null 2>&1; then
    launchctl bootout "$legacy_service"
  fi
elif [[ $service_mode == managed ]]; then
  "$release_directory/project" connector service stop
fi
assert_connector_maintenance_idle
[[ ! -L $current_link ]] || previous_current_target=$(readlink "$current_link")

for name in project project-space-connector project-approval-signer; do
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
next_current="${transaction_root}/current.next"
ln -s -- "versions/${release_id}" "$next_current"
mv -h -f -- "$next_current" "$current_link"
pointer_switched=1

if ! verify_installed_pair; then
  echo "The new machine-tools pair could not be verified; the installation was rolled back." >&2
  exit 70
fi

if ! start_connector; then
  echo "The new connector could not be started; the previous machine-tools release was restored." >&2
  exit 70
fi
if [[ $migrate_legacy_service -eq 1 ]]; then
  rm -f -- "$legacy_plist"
fi
committed=1
rm -rf -- "$transaction_root"
trap - EXIT
printf 'Installed Project Space machine tools %s in %s\n' "$version" "$install_directory"
