#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "Usage: $0 <version> <source-sha> <connector> <runtime-output>" >&2
  exit 64
fi

version=$1
source_sha=$2
connector=$3
runtime_output=$4

[[ $version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || {
  echo "Invalid release version: $version" >&2
  exit 64
}
[[ $source_sha =~ ^[0-9a-f]{40}$ ]] || {
  echo "Invalid source commit: $source_sha" >&2
  exit 64
}
[[ ! -e $runtime_output ]] || {
  echo 'An unsigned artifact output path already exists.' >&2
  exit 73
}

current_uid=$(/usr/bin/id -u)
assert_build_input() {
  local path=$1 maximum_size=$2 size
  [[ -f $path && ! -L $path && -x $path ]] || {
    echo "Unsigned release input is missing or unsafe: $path" >&2
    exit 66
  }
  [[ $(/usr/bin/stat -f '%l' "$path") == 1 ]]
  [[ $(/usr/bin/stat -f '%u' "$path") == "$current_uid" ]]
  size=$(/usr/bin/stat -f '%z' "$path")
  [[ $size =~ ^[1-9][0-9]*$ && $size -le $maximum_size ]]
  file_description=$(/usr/bin/file -b "$path")
  [[ $file_description == *"Mach-O 64-bit executable arm64"* ]] || {
    echo "Unsigned release input is not an arm64 Mach-O executable: $path" >&2
    exit 65
  }
}
assert_build_input "$connector" 157286400

/bin/mkdir -m 0700 "$runtime_output"
/usr/bin/install -m 0755 "$connector" "$runtime_output/project-space-connector"

connector_sha256=$(/usr/bin/shasum -a 256 "$runtime_output/project-space-connector")
connector_sha256=${connector_sha256%% *}
/usr/bin/printf '%s\n' \
  'schema=project-space-macos-runtime-v1' \
  "source_sha=$source_sha" \
  "version=$version" \
  "connector_sha256=$connector_sha256" \
  > "$runtime_output/RUNTIME-RECEIPT.txt"
runtime_receipt_sha=$(/usr/bin/shasum -a 256 "$runtime_output/RUNTIME-RECEIPT.txt")
runtime_receipt_sha=${runtime_receipt_sha%% *}
/usr/bin/printf '%s  %s\n' \
  "$connector_sha256" project-space-connector \
  "$runtime_receipt_sha" RUNTIME-RECEIPT.txt \
  > "$runtime_output/SHA256SUMS.txt"

(
  cd "$runtime_output"
  /usr/bin/shasum -a 256 -c SHA256SUMS.txt
)
