#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 6 ]]; then
  echo 'Usage: create-publish-handoff.sh <version> <source-sha> <source-ref> <platform-assets> <manifest> <output>' >&2
  exit 64
fi

version=$1
source_sha=$2
source_ref=$3
platform_root=$4
manifest_path=$5
output_root=$6
if [[ ! $version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ||
      ! $source_sha =~ ^[0-9a-f]{40}$ || $source_ref != "v${version}" ]]; then
  echo 'Release handoff metadata is invalid.' >&2
  exit 64
fi

platform_assets=(
  DotNaos.Project.installer.yaml
  DotNaos.Project.locale.en-US.yaml
  DotNaos.Project.yaml
  SHA256SUMS.txt
  "project-space-machine-tools-darwin-arm64-v${version}.tar.gz"
  "project-space-machine-tools-darwin-arm64-v${version}.tar.gz.sha256"
  "project-space-machine-tools-linux-x64-v${version}.tar.gz"
  "project-space-machine-tools-linux-x64-v${version}.tar.gz.sha256"
  project-space-machine-tools-windows-x64-setup.exe
)
expected=$(printf '%s\n' "${platform_assets[@]}" | LC_ALL=C sort)
actual=$(find "$platform_root" -mindepth 1 -maxdepth 1 -type f -print | sed "s#^$platform_root/##" | LC_ALL=C sort)
if [[ $actual != "$expected" || -n $(find "$platform_root" -mindepth 1 \( -type l -o ! -type f \) -print -quit) ]]; then
  echo 'Normalized platform asset inventory is invalid.' >&2
  exit 66
fi
if [[ ! -f $manifest_path || -L $manifest_path || $(stat -c %h "$manifest_path") -ne 1 ]]; then
  echo 'Signed release manifest is not a single regular file.' >&2
  exit 66
fi

rm -rf "$output_root"
mkdir -p "$output_root"
for asset in "${platform_assets[@]}"; do
  install -m 0644 "$platform_root/$asset" "$output_root/$asset"
done
install -m 0644 "$manifest_path" "$output_root/project-space-release-manifest.json"
cat > "$output_root/RELEASE-RECEIPT.txt" <<RECEIPT
schema=project-space.github-release/v1
source-sha=$source_sha
source-ref=$source_ref
version=$version
asset-count=10
RECEIPT

checksum_files=(
  DotNaos.Project.installer.yaml
  DotNaos.Project.locale.en-US.yaml
  DotNaos.Project.yaml
  RELEASE-RECEIPT.txt
  SHA256SUMS.txt
  "project-space-machine-tools-darwin-arm64-v${version}.tar.gz"
  "project-space-machine-tools-darwin-arm64-v${version}.tar.gz.sha256"
  "project-space-machine-tools-linux-x64-v${version}.tar.gz"
  "project-space-machine-tools-linux-x64-v${version}.tar.gz.sha256"
  project-space-machine-tools-windows-x64-setup.exe
  project-space-release-manifest.json
)
(
  cd "$output_root"
  sha256sum "${checksum_files[@]}" > PUBLISH-SHA256SUMS.txt
)
