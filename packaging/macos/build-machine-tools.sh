#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <version> <source-directory> <output-directory>" >&2
  exit 64
fi

version=$1
source_directory=$2
output_directory=$3
if [[ ! $version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "Invalid release version: $version" >&2
  exit 64
fi
for command in gzip gtar shasum; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is unavailable: $command" >&2
    exit 69
  fi
done

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
source_directory=$(cd -- "$source_directory" && pwd -P)
mkdir -p -- "$output_directory"
output_directory=$(cd -- "$output_directory" && pwd -P)
bundle_name="project-space-machine-tools-darwin-arm64-v${version}"
archive_path="${output_directory}/${bundle_name}.tar.gz"
checksum_path="${archive_path}.sha256"
staging_root=$(mktemp -d)
trap 'rm -rf -- "$staging_root"' EXIT
bundle_root="${staging_root}/${bundle_name}"
mkdir -p -- "$bundle_root"

for binary in project project-space-connector codex; do
  source_path="${source_directory}/${binary}"
  if [[ ! -f $source_path || ! -x $source_path ]]; then
    echo "Required executable is missing: $source_path" >&2
    exit 66
  fi
  install -m 0755 -- "$source_path" "${bundle_root}/${binary}"
done
for metadata in CODEX-LICENSE CODEX-NOTICE CODEX-VERSION; do
  source_path="${source_directory}/${metadata}"
  if [[ ! -f $source_path || -L $source_path ]]; then
    echo "Required Codex metadata is missing or unsafe: $source_path" >&2
    exit 66
  fi
  install -m 0644 -- "$source_path" "${bundle_root}/${metadata}"
done
legacy_approval_marker="${source_directory}/project-approval-signer"
if [[ -e $legacy_approval_marker || -L $legacy_approval_marker ]]; then
  if [[ ! -f $legacy_approval_marker || -L $legacy_approval_marker || -s $legacy_approval_marker ]]; then
    echo "The legacy approval compatibility marker must be an empty regular file: $legacy_approval_marker" >&2
    exit 66
  fi
  install -m 0755 -- "$legacy_approval_marker" "${bundle_root}/project-approval-signer"
fi
for trust_root in connector-command-signing-public-key.pem release-manifest-signing-public-key.pem; do
  source_path="${source_directory}/${trust_root}"
  if [[ ! -f $source_path || -L $source_path ]]; then
    echo "Required trust root is missing or unsafe: $source_path" >&2
    exit 66
  fi
  install -m 0644 -- "$source_path" "${bundle_root}/${trust_root}"
done
install -m 0755 -- "${script_directory}/install-machine-tools.sh" "${bundle_root}/install.sh"
printf '%s\n' "$version" > "${bundle_root}/VERSION"
checksum_members=(
  project project-space-connector codex
  CODEX-LICENSE CODEX-NOTICE CODEX-VERSION
  connector-command-signing-public-key.pem
  release-manifest-signing-public-key.pem
  install.sh VERSION
)
if [[ -f ${bundle_root}/project-approval-signer ]]; then
  checksum_members+=(project-approval-signer)
fi
(
  cd -- "$bundle_root"
  shasum -a 256 "${checksum_members[@]}" > SHA256SUMS.txt
)

archive_epoch=${SOURCE_DATE_EPOCH:-0}
COPYFILE_DISABLE=1 gtar \
  --sort=name \
  --mtime="@${archive_epoch}" \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  --pax-option=delete=atime,delete=ctime \
  -cf - \
  -C "$staging_root" \
  "$bundle_name" | gzip -n > "$archive_path"
(
  cd -- "$output_directory"
  shasum -a 256 "$(basename -- "$archive_path")" > "$(basename -- "$checksum_path")"
)

printf '%s\n%s\n' "$archive_path" "$checksum_path"
