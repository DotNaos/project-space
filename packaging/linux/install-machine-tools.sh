#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: ./install.sh [--install-dir <absolute-path>]

Installs the Project CLI and its bundled connector for the current user.
EOF
}

install_directory="${HOME}/.local/bin"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir)
      if [[ $# -lt 2 ]]; then
        usage
        exit 64
      fi
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

if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  echo "This bundle supports Linux x86_64 only." >&2
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
  SHA256SUMS.txt VERSION project project-space-connector \
  connector-command-signing-public-key.pem release-manifest-signing-public-key.pem; do
  if [[ ! -f ${bundle_root}/${required} ]]; then
    echo "The release bundle is incomplete: $required is missing." >&2
    exit 66
  fi
done
if ! (cd -- "$bundle_root" && sha256sum --check --strict SHA256SUMS.txt); then
  echo "The release bundle failed its integrity check; nothing was installed." >&2
  exit 65
fi

version=$(tr -d '\r\n' < "${bundle_root}/VERSION")
if [[ ! $version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "The release bundle contains an invalid version." >&2
  exit 65
fi

umask 077
if [[ ! -d $install_directory ]]; then
  mkdir -m 0700 -p -- "$install_directory"
fi

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

bundle_digest=$(sha256sum "${bundle_root}/SHA256SUMS.txt" | awk '{print $1}')
release_id="${version}-${bundle_digest:0:16}"
release_directory="${versions_root}/${release_id}"
transaction_root=$(mktemp -d "${tools_root}/.install.XXXXXX")
backup_root="${transaction_root}/backups"
mkdir -m 0700 -- "$backup_root"

previous_current_target=""
if [[ -L $current_link ]]; then
  previous_current_target=$(readlink -- "$current_link")
fi
stopped_existing=0
installation_started=0
committed=0
changed_entries=()

restore_entry() {
  local name=$1
  local destination="${install_directory}/${name}"
  local backup="${backup_root}/${name}"
  rm -f -- "$destination"
  if [[ -e $backup || -L $backup ]]; then
    mv -T -- "$backup" "$destination"
  fi
}

rollback_installation() {
  local rollback_pointer="${transaction_root}/current.rollback"
  if [[ -n $previous_current_target ]]; then
    rm -f -- "$rollback_pointer"
    ln -s -- "$previous_current_target" "$rollback_pointer"
    mv -Tf -- "$rollback_pointer" "$current_link"
  else
    rm -f -- "$current_link"
  fi
  local index
  for ((index=${#changed_entries[@]} - 1; index >= 0; index--)); do
    restore_entry "${changed_entries[$index]}"
  done
  if [[ $stopped_existing -eq 1 ]]; then
    if [[ ! -x ${install_directory}/project ]] || \
      ! "${install_directory}/project" connector service start-if-connected; then
      echo "The previous connector service could not be restarted after rollback." >&2
      return 1
    fi
  fi
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
install -m 0755 -- "${bundle_root}/project" "${staged_release}/project"
install -m 0755 -- "${bundle_root}/project-space-connector" "${staged_release}/project-space-connector"
install -m 0644 -- "${bundle_root}/connector-command-signing-public-key.pem" \
  "${staged_release}/connector-command-signing-public-key.pem"
install -m 0644 -- "${bundle_root}/release-manifest-signing-public-key.pem" \
  "${staged_release}/release-manifest-signing-public-key.pem"
install -m 0600 -- "${bundle_root}/VERSION" "${staged_release}/VERSION"

if [[ -d $release_directory ]]; then
  for member in \
    project project-space-connector \
    connector-command-signing-public-key.pem release-manifest-signing-public-key.pem \
    VERSION; do
    if ! cmp -s -- "${staged_release}/${member}" "${release_directory}/${member}"; then
      echo "The existing machine-tools release directory does not match this bundle." >&2
      exit 73
    fi
  done
else
  mv -T -- "$staged_release" "$release_directory"
fi

for name in project project-space-connector; do
  destination="${install_directory}/${name}"
  if [[ -d $destination && ! -L $destination ]]; then
    echo "Refusing to replace a directory: $destination" >&2
    exit 73
  fi
done

existing_project="${install_directory}/project"
installation_started=1
if [[ -x $existing_project ]]; then
  # Treat the old service as needing restoration before stopping it. This also
  # keeps a partial stop failure fail-safe: rollback retries the idempotent start.
  stopped_existing=1
  "$existing_project" connector service stop
fi
assert_connector_maintenance_idle

for name in project project-space-connector; do
  destination="${install_directory}/${name}"
  expected_target=".project-space-machine-tools/current/${name}"
  if [[ -L $destination && $(readlink -- "$destination") == "$expected_target" ]]; then
    continue
  fi
  if [[ -e $destination || -L $destination ]]; then
    mv -T -- "$destination" "${backup_root}/${name}"
  fi
  link_temp="${transaction_root}/${name}.link"
  ln -s -- "$expected_target" "$link_temp"
  mv -Tf -- "$link_temp" "$destination"
  changed_entries+=("$name")
done

next_current="${transaction_root}/current.next"
ln -s -- "versions/${release_id}" "$next_current"
mv -Tf -- "$next_current" "$current_link"

if ! "${install_directory}/project" connector service start-if-connected; then
  echo "The new connector could not be started; the previous machine-tools release was restored." >&2
  exit 70
fi

committed=1
rm -rf -- "$transaction_root"
trap - EXIT

printf 'Installed Project Space machine tools %s in %s\n' "$version" "$install_directory"
printf 'Next: run %s/project connect\n' "$install_directory"
