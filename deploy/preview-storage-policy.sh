#!/bin/sh

cleanup_reproducible_storage() {
  docker image prune -af --filter 'label=com.dotnaos.project-space.preview=true' >/dev/null 2>&1 || true
  docker builder prune -af --filter 'label=com.dotnaos.project-space.preview=true' >/dev/null 2>&1 || true
}

preview_image_bytes() {
  {
    docker image ls --filter 'label=com.dotnaos.project-space.preview=true' --format '{{.ID}}' 2>/dev/null
    docker ps -a --filter 'label=com.dotnaos.project-space.preview=true' --format '{{.Image}}' 2>/dev/null |
      while IFS= read -r image; do
        [ -n "$image" ] || continue
        docker image inspect --format '{{.Id}}' "$image" 2>/dev/null || true
      done
  } |
    sort -u |
    while IFS= read -r image_id; do
      [ -n "$image_id" ] || continue
      docker image inspect --format '{{.Size}}' "$image_id" 2>/dev/null || true
    done |
    awk '{sum += $1} END {print sum + 0}'
}

preview_volume_bytes() {
  docker volume ls --filter 'label=com.dotnaos.project-space.preview=true' --format '{{.Name}}' 2>/dev/null |
    while IFS= read -r volume; do
      [ -n "$volume" ] || continue
      mountpoint=$(docker volume inspect --format '{{.Mountpoint}}' "$volume" 2>/dev/null || true)
      [ -n "$mountpoint" ] || continue
      du -sx --bytes "$mountpoint" 2>/dev/null | awk '{print $1}' || true
    done |
    awk '{sum += $1} END {print sum + 0}'
}

preview_container_bytes() {
  docker ps -a --filter 'label=com.dotnaos.project-space.preview=true' --format '{{.ID}}' 2>/dev/null |
    while IFS= read -r container; do
      [ -n "$container" ] || continue
      docker inspect --format '{{.SizeRw}}' "$container" 2>/dev/null || true
    done |
    awk '$1 ~ /^[0-9]+$/ {sum += $1} END {print sum + 0}'
}

preview_global_storage_bytes() {
  preview_image_bytes=$(preview_image_bytes)
  preview_volume_bytes=$(preview_volume_bytes)
  preview_container_bytes=$(preview_container_bytes)
  preview_state_bytes=$(du -sx --bytes "$RUNTIME_ROOT" "$STATE_ROOT" 2>/dev/null | awk '{sum += $1} END {print sum + 0}')
  printf '%s\n' "$((preview_image_bytes + preview_volume_bytes + preview_container_bytes + preview_state_bytes))"
}

preview_record_storage_bytes() {
  preview_runtime_dir=$1
  preview_state_dir=$2
  preview_pr=$3
  shift 3
  preview_image_bytes=$(docker ps -a --filter 'label=com.dotnaos.project-space.preview=true' --filter "label=com.dotnaos.project-space.pr=$preview_pr" --format '{{.Image}}' 2>/dev/null |
    while IFS= read -r image; do
      [ -n "$image" ] || continue
      docker image inspect --format '{{.Id}} {{.Size}}' "$image" 2>/dev/null || true
    done |
    sort -u | awk '{sum += $2} END {print sum + 0}')
  preview_volume_bytes=$(docker volume ls --filter 'label=com.dotnaos.project-space.preview=true' --filter "label=com.dotnaos.project-space.pr=$preview_pr" --format '{{.Name}}' 2>/dev/null |
    while IFS= read -r volume; do
      [ -n "$volume" ] || continue
      mountpoint=$(docker volume inspect --format '{{.Mountpoint}}' "$volume" 2>/dev/null || true)
      [ -n "$mountpoint" ] || continue
      du -sx --bytes "$mountpoint" 2>/dev/null | awk '{print $1}' || true
    done |
    awk '{sum += $1} END {print sum + 0}')
  preview_container_bytes=$(docker ps -a --filter 'label=com.dotnaos.project-space.preview=true' --filter "label=com.dotnaos.project-space.pr=$preview_pr" --format '{{.ID}}' 2>/dev/null |
    while IFS= read -r container; do
      [ -n "$container" ] || continue
      docker inspect --format '{{.SizeRw}}' "$container" 2>/dev/null || true
    done |
    awk '$1 ~ /^[0-9]+$/ {sum += $1} END {print sum + 0}')
  preview_file_bytes=$(du -sx --bytes "$preview_runtime_dir" "$preview_state_dir" 2>/dev/null | awk '{sum += $1} END {print sum + 0}')
  printf '%s\n' "$((preview_image_bytes + preview_volume_bytes + preview_container_bytes + preview_file_bytes))"
}

check_storage_policy() {
  min_free=$(config_value PREVIEW_MIN_FREE_BYTES)
  budget=$(config_value PREVIEW_STORAGE_BUDGET_BYTES)
  printf '%s' "$min_free" | grep -Eq '^[1-9][0-9]*$' || fail 'PREVIEW_MIN_FREE_BYTES is invalid' 78
  printf '%s' "$budget" | grep -Eq '^[1-9][0-9]*$' || fail 'PREVIEW_STORAGE_BUDGET_BYTES is invalid' 78
  free=$(df -Pk "$PLATFORM_ROOT" | awk 'NR==2 {print $4 * 1024}')
  [ "$free" -ge "$min_free" ] || fail 'Preview storage is below the minimum free-space guard' 73
  used=$(preview_global_storage_bytes)
  [ "$used" -le "$budget" ] || fail 'Preview storage budget is exhausted' 73
}

prepare_storage_policy() {
  cleanup_reproducible_storage
  check_storage_policy
}
