#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 5 ]]; then
  echo 'Usage: normalize-platform-artifacts.sh <version> <windows-root> <linux-root> <macos-root> <output-root>' >&2
  exit 64
fi

version=$1
windows_root=$2
linux_root=$3
macos_root=$4
output_root=$5
if [[ ! $version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "Invalid release version: $version" >&2
  exit 64
fi

windows_files=(
  windows/project-space-machine-tools-windows-x64-setup.exe
  windows/SHA256SUMS.txt
  "winget/manifests/d/DotNaos/Project/$version/DotNaos.Project.installer.yaml"
  "winget/manifests/d/DotNaos/Project/$version/DotNaos.Project.locale.en-US.yaml"
  "winget/manifests/d/DotNaos/Project/$version/DotNaos.Project.yaml"
)
linux_files=(
  "project-space-machine-tools-linux-x64-v${version}.tar.gz"
  "project-space-machine-tools-linux-x64-v${version}.tar.gz.sha256"
)
macos_files=(
  "project-space-machine-tools-darwin-arm64-v${version}.tar.gz"
  "project-space-machine-tools-darwin-arm64-v${version}.tar.gz.sha256"
)

validate_files() {
  local root=$1
  shift
  local expected actual relative path
  expected=$(printf '%s\n' "$@" | LC_ALL=C sort)
  actual=$(find "$root" -mindepth 1 -type f -print | sed "s#^$root/##" | LC_ALL=C sort)
  if [[ $actual != "$expected" ]]; then
    echo "Release artifact inventory is invalid under $root." >&2
    diff -u <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") >&2 || true
    exit 66
  fi
  if [[ -n $(find "$root" -mindepth 1 \( -type l -o ! -type f -a ! -type d \) -print -quit) ]]; then
    echo "Release artifact tree contains a link or special file: $root" >&2
    exit 66
  fi
  for relative in "$@"; do
    path="$root/$relative"
    if [[ ! -f $path || -L $path || $(stat -c %h "$path") -ne 1 ]]; then
      echo "Release artifact is not a single regular file: $relative" >&2
      exit 66
    fi
  done
}

validate_files "$windows_root" "${windows_files[@]}"
validate_files "$linux_root" "${linux_files[@]}"
validate_files "$macos_root" "${macos_files[@]}"

(
  cd "$windows_root/windows"
  sha256sum --check --strict SHA256SUMS.txt
)
(
  cd "$linux_root"
  sha256sum --check --strict "${linux_files[1]}"
)
(
  cd "$macos_root"
  sha256sum --check --strict "${macos_files[1]}"
)

rm -rf "$output_root"
mkdir -p "$output_root"
for relative in "${windows_files[@]}"; do
  install -m 0644 "$windows_root/$relative" "$output_root/$(basename "$relative")"
done
for relative in "${linux_files[@]}"; do
  install -m 0644 "$linux_root/$relative" "$output_root/$(basename "$relative")"
done
for relative in "${macos_files[@]}"; do
  install -m 0644 "$macos_root/$relative" "$output_root/$(basename "$relative")"
done

expected_count=9
actual_count=$(find "$output_root" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d ' ')
if [[ $actual_count -ne $expected_count ]]; then
  echo "Expected $expected_count normalized platform assets, found $actual_count." >&2
  exit 66
fi
