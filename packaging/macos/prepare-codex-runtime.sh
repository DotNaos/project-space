#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <absolute-destination-directory>" >&2
  exit 64
fi

destination_directory=$1
if [[ $destination_directory != /* || $destination_directory == *$'\n'* || $destination_directory == *$'\r'* ]]; then
  echo "The Codex runtime destination must be an absolute path without line breaks." >&2
  exit 64
fi

for command in curl gtar shasum; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is unavailable: $command" >&2
    exit 69
  fi
done

codex_version=0.145.0
codex_release=rust-v0.145.0
codex_asset=codex-aarch64-apple-darwin.tar.gz
codex_member=codex-aarch64-apple-darwin
codex_archive_sha256=072a30a65f05666735889ef0f60b56db186adbdde9d5c5cc1a64be0b598530fe
codex_binary_sha256=1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590
codex_source_commit=25af12f7e61572b0bc18ddb1008be543b91519b0
codex_license_sha256=d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc
codex_notice_sha256=9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915
codex_url="https://github.com/openai/codex/releases/download/${codex_release}/${codex_asset}"
license_url="https://raw.githubusercontent.com/openai/codex/${codex_source_commit}/LICENSE"
notice_url="https://raw.githubusercontent.com/openai/codex/${codex_source_commit}/NOTICE"

temporary_root=$(mktemp -d)
trap 'rm -rf -- "$temporary_root"' EXIT
archive_path="${temporary_root}/${codex_asset}"
runtime_path="${temporary_root}/codex"
license_path="${temporary_root}/CODEX-LICENSE"
notice_path="${temporary_root}/CODEX-NOTICE"

curl --fail --location --silent --show-error --output "$archive_path" "$codex_url"
printf '%s  %s\n' "$codex_archive_sha256" "$archive_path" |
  shasum -a 256 --check --strict
archive_members=$(gtar -tzf "$archive_path")
if [[ $archive_members != "$codex_member" ]]; then
  echo "The pinned Codex archive contains unexpected members." >&2
  exit 65
fi
gtar -xOzf "$archive_path" "$codex_member" > "$runtime_path"
chmod 0755 "$runtime_path"
printf '%s  %s\n' "$codex_binary_sha256" "$runtime_path" |
  shasum -a 256 --check --strict
if [[ $("$runtime_path" --version) != "codex-cli ${codex_version}" ]]; then
  echo "The pinned Codex runtime does not report the expected version." >&2
  exit 65
fi
curl --fail --location --silent --show-error --output "$license_path" "$license_url"
curl --fail --location --silent --show-error --output "$notice_path" "$notice_url"
printf '%s  %s\n' "$codex_license_sha256" "$license_path" |
  shasum -a 256 --check --strict
printf '%s  %s\n' "$codex_notice_sha256" "$notice_path" |
  shasum -a 256 --check --strict

mkdir -p -- "$destination_directory"
install -m 0755 -- "$runtime_path" "$destination_directory/codex"
install -m 0644 -- "$license_path" "$destination_directory/CODEX-LICENSE"
install -m 0644 -- "$notice_path" "$destination_directory/CODEX-NOTICE"
printf '%s\n' "$codex_version" > "$destination_directory/CODEX-VERSION"
printf 'Prepared pinned Codex runtime %s in %s\n' "$codex_version" "$destination_directory"
