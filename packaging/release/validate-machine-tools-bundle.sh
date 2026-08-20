#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo 'Usage: validate-machine-tools-bundle.sh <archive> <target> <version>' >&2
  exit 64
fi

archive=$1
target=$2
version=$3
if [[ ! -f $archive || -L $archive ]]; then
  echo "Machine-tools archive is missing or unsafe: $archive" >&2
  exit 66
fi
if [[ ! $version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "Invalid machine-tools version: $version" >&2
  exit 64
fi

case $target in
  darwin-arm64)
    expected_members=(
      CODEX-LICENSE CODEX-NOTICE CODEX-VERSION SHA256SUMS.txt VERSION codex
      install.sh project project-codex-host release-manifest-signing-public-key.pem
    )
    ;;
  linux-x64)
    expected_members=(
      CODEX-LICENSE CODEX-NOTICE CODEX-VERSION SHA256SUMS.txt VERSION codex
      install.sh project project-codex-host release-manifest-signing-public-key.pem
    )
    ;;
  *)
    echo "Unsupported machine-tools target: $target" >&2
    exit 64
    ;;
esac

bundle_root="project-space-machine-tools-${target}-v${version}"
expected_archive_members=$(printf '%s\n' "$bundle_root/" "${expected_members[@]/#/$bundle_root/}" | LC_ALL=C sort)
actual_archive_members=$(tar -tzf "$archive" | sed 's#/$#/#' | LC_ALL=C sort)
if [[ $actual_archive_members != "$expected_archive_members" ]]; then
  echo "Machine-tools archive inventory is invalid: $archive" >&2
  diff -u <(printf '%s\n' "$expected_archive_members") <(printf '%s\n' "$actual_archive_members") >&2 || true
  exit 66
fi

temporary_root=$(mktemp -d)
trap 'rm -rf -- "$temporary_root"' EXIT
tar -xzf "$archive" -C "$temporary_root"
bundle_directory="$temporary_root/$bundle_root"
if [[ ! -d $bundle_directory || -L $bundle_directory ]] ||
  [[ -n $(find "$bundle_directory" -mindepth 1 -maxdepth 1 ! -type f -print -quit) ]]; then
  echo "Machine-tools archive contains an unsafe bundle entry: $archive" >&2
  exit 66
fi

if [[ $(<"$bundle_directory/VERSION") != "$version" ]]; then
  echo "Machine-tools archive version does not match: $archive" >&2
  exit 65
fi

checksum_file="$bundle_directory/SHA256SUMS.txt"
expected_checksum_names=$(printf '%s\n' "${expected_members[@]}" | grep -v '^SHA256SUMS\.txt$' | LC_ALL=C sort)
actual_checksum_names=$(sed -E 's/^[0-9a-f]{64}  //' "$checksum_file" | LC_ALL=C sort)
if [[ $actual_checksum_names != "$expected_checksum_names" ]]; then
  echo "Machine-tools checksum inventory is invalid: $archive" >&2
  exit 66
fi

if command -v sha256sum >/dev/null 2>&1; then
  hash_command=(sha256sum)
else
  hash_command=(shasum -a 256)
fi
while IFS= read -r line; do
  if [[ ! $line =~ ^([0-9a-f]{64})[[:space:]][[:space:]](.+)$ ]]; then
    echo "Machine-tools checksum file is invalid: $archive" >&2
    exit 66
  fi
  digest=${BASH_REMATCH[1]}
  name=${BASH_REMATCH[2]}
  actual_digest=$("${hash_command[@]}" "$bundle_directory/$name" | awk '{print $1}')
  if [[ $actual_digest != "$digest" ]]; then
    echo "Machine-tools bundle member failed its checksum: $name" >&2
    exit 65
  fi
done < "$checksum_file"

echo "Validated $target machine-tools bundle v$version."
