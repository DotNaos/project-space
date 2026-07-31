#!/bin/sh
set -eu

fail() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

[ "$#" -eq 2 ] || fail 'usage: install-preview-assets.sh SOURCE_DIR FULL_MAIN_SHA' 64

source_dir=$1
commit=$2
platform_root=${PROJECT_SPACE_PREVIEW_PLATFORM_ROOT:-/opt/platform}

printf '%s' "$commit" | grep -Eq '^[0-9a-f]{40}$' ||
  fail 'Preview asset commit must be a full lowercase Git SHA.' 64
[ -d "$source_dir" ] && [ ! -L "$source_dir" ] ||
  fail 'Preview asset source must be a real directory.' 64

if [ "$platform_root" = /opt/platform ] && [ "$(id -u)" -ne 0 ]; then
  fail 'Preview assets must be installed as root.' 77
fi

asset_files='preview-runner.sh preview-reaper.sh preview-runtime-verification.sh preview-storage-policy.sh preview-ssh-entrypoint.sh preview-status-entrypoint.sh preview.compose.yml'
for asset in $asset_files; do
  [ -f "$source_dir/$asset" ] && [ ! -L "$source_dir/$asset" ] ||
    fail "Preview asset is missing or unsafe: $asset" 64
done
for script in preview-runner.sh preview-reaper.sh preview-runtime-verification.sh preview-storage-policy.sh preview-ssh-entrypoint.sh preview-status-entrypoint.sh; do
  sh -n "$source_dir/$script" ||
    fail "Preview asset has invalid shell syntax: $script" 64
done

share_root=$platform_root/share
release_root=$share_root/project-space-preview-releases
release_dir=$release_root/$commit
current_link=$share_root/project-space-preview-current
entrypoint_root=$share_root/project-space-preview

install -d -m 0755 "$share_root" "$release_root" "$entrypoint_root"

next_dir=$(mktemp -d "$release_root/.next.$commit.XXXXXX")
next_link=
cleanup() {
  [ ! -d "$next_dir" ] || rm -rf -- "$next_dir"
  [ -z "$next_link" ] || [ ! -L "$next_link" ] || rm -f -- "$next_link"
}
trap cleanup EXIT INT TERM HUP

install -m 0755 "$source_dir/preview-runner.sh" "$next_dir/preview-runner.sh"
install -m 0755 "$source_dir/preview-reaper.sh" "$next_dir/preview-reaper.sh"
install -m 0755 "$source_dir/preview-runtime-verification.sh" "$next_dir/preview-runtime-verification.sh"
install -m 0755 "$source_dir/preview-storage-policy.sh" "$next_dir/preview-storage-policy.sh"
install -m 0755 "$source_dir/preview-ssh-entrypoint.sh" "$next_dir/preview-ssh-entrypoint.sh"
install -m 0755 "$source_dir/preview-status-entrypoint.sh" "$next_dir/preview-status-entrypoint.sh"
install -m 0644 "$source_dir/preview.compose.yml" "$next_dir/preview.compose.yml"
printf '%s\n' "$commit" > "$next_dir/asset-commit"
chmod 0644 "$next_dir/asset-commit"
chmod 0755 "$next_dir"

if [ -e "$release_dir" ] || [ -L "$release_dir" ]; then
  [ -d "$release_dir" ] && [ ! -L "$release_dir" ] ||
    fail 'Existing Preview asset release is unsafe.' 78
  for asset in $asset_files asset-commit; do
    cmp -s "$next_dir/$asset" "$release_dir/$asset" ||
      fail 'Existing Preview asset release does not match exact main.' 78
  done
  rm -rf -- "$next_dir"
else
  mv "$next_dir" "$release_dir"
fi

[ ! -e "$current_link" ] || [ -L "$current_link" ] ||
  fail 'Trusted Preview current asset path is not a symlink.' 78
next_link=$share_root/.project-space-preview-current.$$
ln -s "$release_dir" "$next_link"
if mv -T "$next_link" "$current_link" 2>/dev/null; then
  :
elif mv -h "$next_link" "$current_link" 2>/dev/null; then
  :
else
  fail 'Could not atomically activate trusted Preview assets.' 78
fi
next_link=

for entrypoint in preview-ssh-entrypoint.sh preview-status-entrypoint.sh; do
  next_entrypoint=$entrypoint_root/.$entrypoint.$$
  install -m 0755 "$release_dir/$entrypoint" "$next_entrypoint"
  mv "$next_entrypoint" "$entrypoint_root/$entrypoint"
done

printf 'PROJECT_SPACE_PREVIEW_ASSETS=%s\n' "$commit"
