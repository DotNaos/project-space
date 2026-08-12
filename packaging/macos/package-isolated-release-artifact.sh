#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 9 ]]; then
  echo "Usage: $0 <version> <source-sha> <runtime-artifact-id> <runtime-artifact-digest> <runtime-dir> <trust-dir> <staging-dir> <output-dir> <repository-root>" >&2
  exit 64
fi

version=$1
source_sha=$2
runtime_artifact_id=$3
runtime_artifact_digest=$4
runtime_directory=$5
trust_directory=$6
staging_directory=$7
output_directory=$8
repository_root=$9

[[ $version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
[[ $source_sha =~ ^[0-9a-f]{40}$ ]]
[[ $runtime_artifact_id =~ ^[1-9][0-9]*$ ]]
[[ $runtime_artifact_digest =~ ^[0-9a-f]{64}$ ]]
[[ ! -e $staging_directory && ! -e $output_directory ]]

current_uid=$(/usr/bin/id -u)
assert_safe_file() {
  local path=$1 maximum_size=$2 minimum_size=${3:-1} size
  [[ -f $path && ! -L $path ]]
  [[ $(/usr/bin/stat -f '%l' "$path") == 1 ]]
  [[ $(/usr/bin/stat -f '%u' "$path") == "$current_uid" ]]
  size=$(/usr/bin/stat -f '%z' "$path")
  [[ $size =~ ^[0-9]+$ && $size -ge $minimum_size && $size -le $maximum_size ]]
}

assert_exact_files() {
  local directory=$1
  shift
  local actual_count expected_count=$# descriptor limits maximum_size minimum_size name
  [[ -d $directory && ! -L $directory ]]
  actual_count=$(/usr/bin/find "$directory" -mindepth 1 -maxdepth 1 -print | /usr/bin/wc -l)
  actual_count=${actual_count//[[:space:]]/}
  [[ $actual_count == "$expected_count" ]] || {
    echo "Unexpected files in release artifact: $directory" >&2
    exit 65
  }
  [[ -z $(/usr/bin/find "$directory" -mindepth 2 -print -quit) ]]
  for descriptor in "$@"; do
    name=${descriptor%%:*}
    limits=${descriptor#*:}
    maximum_size=${limits%%:*}
    minimum_size=1
    if [[ $limits == *:* ]]; then
      minimum_size=${limits##*:}
    fi
    assert_safe_file "$directory/$name" "$maximum_size" "$minimum_size"
  done
}

temporary_root=$(/usr/bin/mktemp -d)
trap '/bin/rm -rf "$temporary_root"' EXIT

assert_exact_files "$runtime_directory" \
  project-codex-host:157286400 RUNTIME-RECEIPT.txt:4096 SHA256SUMS.txt:4096
assert_exact_files "$trust_directory" \
  connector-command-signing-public-key.pem:8192 \
  release-manifest-signing-public-key.pem:8192

runtime_codex_host_sha=$(/usr/bin/shasum -a 256 "$runtime_directory/project-codex-host")
runtime_codex_host_sha=${runtime_codex_host_sha%% *}
/usr/bin/printf '%s\n' \
  'schema=project-space-macos-runtime-v1' \
  "source_sha=$source_sha" \
  "version=$version" \
  "codex_host_sha256=$runtime_codex_host_sha" \
  > "$temporary_root/expected-runtime-receipt"
/usr/bin/cmp "$temporary_root/expected-runtime-receipt" \
  "$runtime_directory/RUNTIME-RECEIPT.txt"
runtime_receipt_sha=$(/usr/bin/shasum -a 256 "$runtime_directory/RUNTIME-RECEIPT.txt")
runtime_receipt_sha=${runtime_receipt_sha%% *}
/usr/bin/printf '%s  %s\n' \
  "$runtime_codex_host_sha" project-codex-host \
  "$runtime_receipt_sha" RUNTIME-RECEIPT.txt \
  > "$temporary_root/expected-runtime-checksums"
/usr/bin/cmp "$temporary_root/expected-runtime-checksums" "$runtime_directory/SHA256SUMS.txt"
(
  cd "$runtime_directory"
  /usr/bin/shasum -a 256 -c SHA256SUMS.txt
)

command_root_sha=$(/usr/bin/shasum -a 256 "$trust_directory/connector-command-signing-public-key.pem")
command_root_sha=${command_root_sha%% *}
release_root_sha=$(/usr/bin/shasum -a 256 "$trust_directory/release-manifest-signing-public-key.pem")
release_root_sha=${release_root_sha%% *}
[[ $command_root_sha == 502f8b9dbbabec58aa8d2c794c7c052d5974215e2180f9e47ed4d7cff4ee45c1 ]]
[[ $release_root_sha == aff71d44e194f87e7e958296306059d3d5b55d7c369963b61d57627e03f4a451 ]]

/bin/mkdir -m 0700 "$staging_directory"
/usr/bin/install -m 0755 "$runtime_directory/project-codex-host" \
  "$staging_directory/project-codex-host"
/usr/bin/install -m 0644 "$trust_directory/connector-command-signing-public-key.pem" \
  "$staging_directory/connector-command-signing-public-key.pem"
/usr/bin/install -m 0644 "$trust_directory/release-manifest-signing-public-key.pem" \
  "$staging_directory/release-manifest-signing-public-key.pem"

# Published clients before this removal require this exact archive member before
# they can install the new verifier. It is empty, is never installed, and has no
# signing capability; the next release can omit it after clients cross this bridge.
/usr/bin/install -m 0755 /dev/null "$staging_directory/project-approval-signer"

(
  cd "$repository_root"
  CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 /usr/bin/env go build \
    -trimpath \
    -ldflags="-s -w -X main.projectMachineClientVersion=$version -X main.projectMachineClientReleaseID=v$version -X main.projectMachineClientBuildID=$source_sha" \
    -o "$staging_directory/project" ./cmd/project
)

SOURCE_DATE_EPOCH=0 "$repository_root/packaging/macos/build-machine-tools.sh" \
  "$version" "$staging_directory" "$output_directory"

archive_name="project-space-machine-tools-darwin-arm64-v${version}.tar.gz"
archive_path="$output_directory/$archive_name"
checksum_path="$archive_path.sha256"
assert_safe_file "$archive_path" 209715200
assert_safe_file "$checksum_path" 4096
(
  cd "$output_directory"
  /usr/bin/shasum -a 256 -c "${archive_name}.sha256"
)

extracted_root="$temporary_root/extracted"
/bin/mkdir "$extracted_root"
gtar_path=$(command -v gtar)
[[ -n $gtar_path && $gtar_path == /* ]]
"$gtar_path" -xzf "$archive_path" -C "$extracted_root"
bundle_root="$extracted_root/project-space-machine-tools-darwin-arm64-v${version}"
assert_exact_files "$bundle_root" \
  project:157286400 project-codex-host:157286400 project-approval-signer:0:0 \
  connector-command-signing-public-key.pem:8192 release-manifest-signing-public-key.pem:8192 \
  install.sh:1048576 VERSION:128 SHA256SUMS.txt:4096
[[ $(<"$bundle_root/VERSION") == "$version" ]]
(
  cd "$bundle_root"
  /usr/bin/shasum -a 256 -c SHA256SUMS.txt
)
/usr/bin/cmp "$staging_directory/project" "$bundle_root/project"
/usr/bin/cmp "$staging_directory/project-codex-host" "$bundle_root/project-codex-host"
/usr/bin/cmp /dev/null "$bundle_root/project-approval-signer"
/usr/bin/cmp "$staging_directory/connector-command-signing-public-key.pem" \
  "$bundle_root/connector-command-signing-public-key.pem"
/usr/bin/cmp "$staging_directory/release-manifest-signing-public-key.pem" \
  "$bundle_root/release-manifest-signing-public-key.pem"
