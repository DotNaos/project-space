#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <destination-directory>" >&2
  exit 64
fi

destination_directory=$1
if [[ $destination_directory != /* ]]; then
  echo "The Codex runtime destination must be an absolute path." >&2
  exit 64
fi

for command in curl install sha256sum tar; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is unavailable: $command" >&2
    exit 69
  fi
done

codex_version=0.145.0
codex_release=rust-v0.145.0
codex_asset=codex-x86_64-unknown-linux-musl.tar.gz
codex_member=codex-x86_64-unknown-linux-musl
codex_archive_sha256=bfaf13c9ba34f2ad764e4a916c49cf7177aeba329cf0f719e2227566fc8d662a
codex_binary_sha256=a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14
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

curl --fail --location --proto '=https' --tlsv1.2 \
  --output "$archive_path" "$codex_url"
printf '%s  %s\n' "$codex_archive_sha256" "$archive_path" |
  sha256sum --check --strict

archive_members=$(tar -tzf "$archive_path")
if [[ $archive_members != "$codex_member" ]]; then
  echo "The pinned Codex archive contains unexpected members." >&2
  exit 65
fi
tar -xOzf "$archive_path" "$codex_member" > "$runtime_path"
chmod 0755 "$runtime_path"
printf '%s  %s\n' "$codex_binary_sha256" "$runtime_path" |
  sha256sum --check --strict
if [[ $("$runtime_path" --version) != "codex-cli ${codex_version}" ]]; then
  echo "The pinned Codex runtime does not report the expected version." >&2
  exit 65
fi

curl --fail --location --proto '=https' --tlsv1.2 \
  --output "$license_path" "$license_url"
printf '%s  %s\n' "$codex_license_sha256" "$license_path" |
  sha256sum --check --strict
curl --fail --location --proto '=https' --tlsv1.2 \
  --output "$notice_path" "$notice_url"
printf '%s  %s\n' "$codex_notice_sha256" "$notice_path" |
  sha256sum --check --strict

mkdir -p -- "$destination_directory"
install -m 0755 -- "$runtime_path" "${destination_directory}/codex"
install -m 0644 -- "$license_path" "${destination_directory}/CODEX-LICENSE"
install -m 0644 -- "$notice_path" "${destination_directory}/CODEX-NOTICE"
printf '%s\n' "$codex_version" > "${destination_directory}/CODEX-VERSION"

printf 'Prepared pinned Codex runtime %s in %s\n' \
  "$codex_version" "$destination_directory"
