#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 14 ]]; then
  echo "Usage: $0 <version> <source-sha> <workflow-run-id> <runtime-artifact-id> <runtime-artifact-digest> <signing-artifact-id> <signing-artifact-digest> <runtime-dir> <signing-dir> <signed-dir> <trust-dir> <staging-dir> <output-dir> <repository-root>" >&2
  exit 64
fi

version=$1
source_sha=$2
workflow_run_id=$3
runtime_artifact_id=$4
runtime_artifact_digest=$5
signing_artifact_id=$6
signing_artifact_digest=$7
runtime_directory=$8
signing_directory=$9
signed_directory=${10}
trust_directory=${11}
staging_directory=${12}
output_directory=${13}
repository_root=${14}

[[ $version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
[[ $source_sha =~ ^[0-9a-f]{40}$ ]]
[[ $workflow_run_id =~ ^[1-9][0-9]*$ ]]
[[ $runtime_artifact_id =~ ^[1-9][0-9]*$ ]]
[[ $runtime_artifact_digest =~ ^[0-9a-f]{64}$ ]]
[[ $signing_artifact_id =~ ^[1-9][0-9]*$ ]]
[[ $signing_artifact_digest =~ ^[0-9a-f]{64}$ ]]
[[ ! -e $staging_directory && ! -e $output_directory ]]

current_uid=$(/usr/bin/id -u)
assert_safe_file() {
  local path=$1 maximum_size=$2 size
  [[ -f $path && ! -L $path ]]
  [[ $(/usr/bin/stat -f '%l' "$path") == 1 ]]
  [[ $(/usr/bin/stat -f '%u' "$path") == "$current_uid" ]]
  size=$(/usr/bin/stat -f '%z' "$path")
  [[ $size =~ ^[1-9][0-9]*$ && $size -le $maximum_size ]]
}

assert_exact_files() {
  local directory=$1
  shift
  local actual_count expected_count=$# descriptor name maximum_size
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
    maximum_size=${descriptor##*:}
    assert_safe_file "$directory/$name" "$maximum_size"
  done
}

temporary_root=$(/usr/bin/mktemp -d)
trap '/bin/rm -rf "$temporary_root"' EXIT

assert_exact_files "$runtime_directory" \
  project-space-connector:157286400 RUNTIME-RECEIPT.txt:4096 SHA256SUMS.txt:4096
assert_exact_files "$signing_directory" \
  project-approval-signer:20971520 SIGNING-INPUT-RECEIPT.txt:4096 SHA256SUMS.txt:4096
assert_exact_files "$signed_directory" \
  project-approval-signer:20971520 SIGNED-RECEIPT.txt:4096 SHA256SUMS.txt:4096
assert_exact_files "$trust_directory" \
  connector-command-signing-public-key.pem:8192 \
  release-manifest-signing-public-key.pem:8192

runtime_connector_sha=$(/usr/bin/shasum -a 256 "$runtime_directory/project-space-connector")
runtime_connector_sha=${runtime_connector_sha%% *}
/usr/bin/printf '%s\n' \
  'schema=project-space-macos-runtime-v1' \
  "source_sha=$source_sha" \
  "version=$version" \
  "connector_sha256=$runtime_connector_sha" \
  > "$temporary_root/expected-runtime-receipt"
/usr/bin/cmp "$temporary_root/expected-runtime-receipt" \
  "$runtime_directory/RUNTIME-RECEIPT.txt"
runtime_receipt_sha=$(/usr/bin/shasum -a 256 "$runtime_directory/RUNTIME-RECEIPT.txt")
runtime_receipt_sha=${runtime_receipt_sha%% *}
/usr/bin/printf '%s  %s\n' \
  "$runtime_connector_sha" project-space-connector \
  "$runtime_receipt_sha" RUNTIME-RECEIPT.txt \
  > "$temporary_root/expected-runtime-checksums"
/usr/bin/cmp "$temporary_root/expected-runtime-checksums" "$runtime_directory/SHA256SUMS.txt"
(
  cd "$runtime_directory"
  /usr/bin/shasum -a 256 -c SHA256SUMS.txt
)

unsigned_signer_sha=$(/usr/bin/shasum -a 256 "$signing_directory/project-approval-signer")
unsigned_signer_sha=${unsigned_signer_sha%% *}
/usr/bin/printf '%s\n' \
  'schema=project-space-macos-signing-input-v1' \
  "source_sha=$source_sha" \
  "version=$version" \
  "approval_signer_sha256=$unsigned_signer_sha" \
  > "$temporary_root/expected-signing-receipt"
/usr/bin/cmp "$temporary_root/expected-signing-receipt" \
  "$signing_directory/SIGNING-INPUT-RECEIPT.txt"
signing_receipt_sha=$(/usr/bin/shasum -a 256 "$signing_directory/SIGNING-INPUT-RECEIPT.txt")
signing_receipt_sha=${signing_receipt_sha%% *}
/usr/bin/printf '%s  %s\n' \
  "$unsigned_signer_sha" project-approval-signer \
  "$signing_receipt_sha" SIGNING-INPUT-RECEIPT.txt \
  > "$temporary_root/expected-signing-checksums"
/usr/bin/cmp "$temporary_root/expected-signing-checksums" "$signing_directory/SHA256SUMS.txt"
(
  cd "$signing_directory"
  /usr/bin/shasum -a 256 -c SHA256SUMS.txt
)

signing_requirement='=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "R72P4M9WMS" and identifier "com.dotnaos.project.approval-signer"'
requirement_sha=$(/usr/bin/printf '%s' "$signing_requirement" | /usr/bin/shasum -a 256)
requirement_sha=${requirement_sha%% *}
signed_signer_sha=$(/usr/bin/shasum -a 256 "$signed_directory/project-approval-signer")
signed_signer_sha=${signed_signer_sha%% *}
/usr/bin/printf '%s\n' \
  'schema=project-space-macos-signed-v1' \
  "source_sha=$source_sha" \
  "version=$version" \
  "workflow_run_id=$workflow_run_id" \
  "signing_input_artifact_id=$signing_artifact_id" \
  "signing_input_artifact_digest=$signing_artifact_digest" \
  "unsigned_approval_signer_sha256=$unsigned_signer_sha" \
  "signed_approval_signer_sha256=$signed_signer_sha" \
  "signing_requirement_sha256=$requirement_sha" \
  > "$temporary_root/expected-signed-receipt"
/usr/bin/cmp "$temporary_root/expected-signed-receipt" "$signed_directory/SIGNED-RECEIPT.txt"
signed_receipt_sha=$(/usr/bin/shasum -a 256 "$signed_directory/SIGNED-RECEIPT.txt")
signed_receipt_sha=${signed_receipt_sha%% *}
/usr/bin/printf '%s  %s\n' \
  "$signed_signer_sha" project-approval-signer \
  "$signed_receipt_sha" SIGNED-RECEIPT.txt \
  > "$temporary_root/expected-signed-checksums"
/usr/bin/cmp "$temporary_root/expected-signed-checksums" "$signed_directory/SHA256SUMS.txt"
(
  cd "$signed_directory"
  /usr/bin/shasum -a 256 -c SHA256SUMS.txt
)
/usr/bin/codesign --verify --strict --test-requirement "$signing_requirement" \
  "$signed_directory/project-approval-signer"

command_root_sha=$(/usr/bin/shasum -a 256 "$trust_directory/connector-command-signing-public-key.pem")
command_root_sha=${command_root_sha%% *}
release_root_sha=$(/usr/bin/shasum -a 256 "$trust_directory/release-manifest-signing-public-key.pem")
release_root_sha=${release_root_sha%% *}
[[ $command_root_sha == 502f8b9dbbabec58aa8d2c794c7c052d5974215e2180f9e47ed4d7cff4ee45c1 ]]
[[ $release_root_sha == aff71d44e194f87e7e958296306059d3d5b55d7c369963b61d57627e03f4a451 ]]

/bin/mkdir -m 0700 "$staging_directory"
/usr/bin/install -m 0755 "$runtime_directory/project-space-connector" \
  "$staging_directory/project-space-connector"
/usr/bin/install -m 0755 "$signed_directory/project-approval-signer" \
  "$staging_directory/project-approval-signer"
/usr/bin/install -m 0644 "$trust_directory/connector-command-signing-public-key.pem" \
  "$staging_directory/connector-command-signing-public-key.pem"
/usr/bin/install -m 0644 "$trust_directory/release-manifest-signing-public-key.pem" \
  "$staging_directory/release-manifest-signing-public-key.pem"

(
  cd "$repository_root"
  CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 /usr/bin/env go build \
    -trimpath \
    -ldflags="-s -w -X main.projectMachineClientVersion=$version -X main.projectMachineClientReleaseID=v$version -X main.projectMachineClientBuildID=$source_sha -X github.com/DotNaos/project-space/internal/approvalsigner.expectedHelperSHA256=$signed_signer_sha" \
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
  project:157286400 project-space-connector:157286400 project-approval-signer:20971520 \
  connector-command-signing-public-key.pem:8192 release-manifest-signing-public-key.pem:8192 \
  install.sh:1048576 VERSION:128 SHA256SUMS.txt:4096
[[ $(<"$bundle_root/VERSION") == "$version" ]]
(
  cd "$bundle_root"
  /usr/bin/shasum -a 256 -c SHA256SUMS.txt
)
/usr/bin/cmp "$staging_directory/project" "$bundle_root/project"
/usr/bin/cmp "$staging_directory/project-space-connector" "$bundle_root/project-space-connector"
/usr/bin/cmp "$staging_directory/project-approval-signer" "$bundle_root/project-approval-signer"
/usr/bin/cmp "$staging_directory/connector-command-signing-public-key.pem" \
  "$bundle_root/connector-command-signing-public-key.pem"
/usr/bin/cmp "$staging_directory/release-manifest-signing-public-key.pem" \
  "$bundle_root/release-manifest-signing-public-key.pem"
/usr/bin/codesign --verify --strict --test-requirement "$signing_requirement" \
  "$bundle_root/project-approval-signer"
