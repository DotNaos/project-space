#!/bin/sh
set -eu

PROJECT_REPOSITORY=DotNaos/project-space
PLATFORM_ROOT=${PROJECT_SPACE_PREVIEW_PLATFORM_ROOT:-/opt/platform}
ASSET_ROOT=${PROJECT_SPACE_PREVIEW_ASSET_ROOT:-$PLATFORM_ROOT/share/project-space-preview}
CONFIG_FILE=${PROJECT_SPACE_PREVIEW_CONFIG_FILE:-$PLATFORM_ROOT/config/project-space-preview.env}
GITHUB_TOKEN_FILE=${PROJECT_SPACE_PREVIEW_GITHUB_TOKEN_FILE:-$PLATFORM_ROOT/secrets/project-space-preview/github-token}
GITHUB_API_BASE=${PROJECT_SPACE_PREVIEW_GITHUB_API_BASE:-https://api.github.com}
STATE_ROOT=$PLATFORM_ROOT/state/project-space-preview
RUNTIME_ROOT=$PLATFORM_ROOT/previews/project-space
LOCK_ROOT=$PLATFORM_ROOT/locks
CAPACITY_LOCK_FILE=$LOCK_ROOT/project-space-preview-capacity.lock
COMPOSE_FILE=$ASSET_ROOT/preview.compose.yml
PREVIEW_RECEIPT_PREFIX=PROJECT_SPACE_PREVIEW_RECEIPT=

fail() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1" 69
}

read_request() {
  request=$(cat)
  printf '%s' "$request" | jq -e 'type == "object"' >/dev/null 2>&1 || fail 'request must be one JSON object' 64
}

json_string() {
  value=$(printf '%s' "$request" | jq -er --arg key "$1" '.[$key] | select(type == "string")') ||
    fail "$1 must be a string" 64
  printf '%s' "$value"
}

json_positive_integer() {
  value=$(printf '%s' "$request" | jq -er --arg key "$1" '.[$key] | select(type == "number" and . == floor and . > 0 and . <= 2147483647)') ||
    fail "$1 must be a positive integer" 64
  printf '%s' "$value"
}

validate_sha() {
  printf '%s' "$1" | grep -Eq '^[0-9a-f]{40}$' || fail 'headSha must be a full lowercase Git SHA' 64
}

validate_image() {
  image=$1
  kind=$2
  printf '%s' "$image" | grep -Eq "^ghcr\\.io/dotnaos/project-space-preview-${kind}@sha256:[0-9a-f]{64}$" ||
    fail "${kind}Image must be an approved immutable GHCR digest" 64
}

config_value() {
  key=$1
  [ -f "$CONFIG_FILE" ] || fail "trusted Preview runner config is missing" 78
  value=$(sed -n "s/^${key}=//p" "$CONFIG_FILE" | tail -n 1)
  [ -n "$value" ] || fail "trusted Preview runner config is missing ${key}" 78
  printf '%s' "$value"
}

prepare_identity() {
  repository=$(json_string repository)
  [ "$repository" = "$PROJECT_REPOSITORY" ] || fail 'repository is not approved for this Preview runner' 64
  pr=$(json_positive_integer prNumber)
  domain="pr-${pr}.projects.os-home.net"
  compose_project="project-space-preview-pr-${pr}"
  runtime_dir="$RUNTIME_ROOT/pr-${pr}"
  state_dir="$STATE_ROOT/pr-${pr}"
  lock_file="$LOCK_ROOT/project-space-preview-pr-${pr}.lock"
  repo_path="$runtime_dir/repository"
  env_file="$runtime_dir/runtime.env"
  runtime_file="$state_dir/runtime.json"
  tombstone_file="$state_dir/tombstone.json"
}

prepare_directories() {
  install -d -m 700 "$RUNTIME_ROOT" "$LOCK_ROOT" "$runtime_dir"
  install -d -m 2750 "$STATE_ROOT" "$state_dir"
  : > "$lock_file"
  chmod 600 "$lock_file"
}

acquire_lock() {
  exec 9>>"$lock_file"
  flock -w 900 9 || fail "Preview lock timeout for PR ${pr}" 73
}

acquire_lifecycle_locks() {
  # Stable order: global online-capacity lock, then the PR-local lock.
  exec 8>>"$CAPACITY_LOCK_FILE"
  chmod 600 "$CAPACITY_LOCK_FILE"
  flock -w 900 8 || fail 'Preview capacity lock timeout' 73
  acquire_lock
}

github_get() {
  endpoint=$1
  if [ -s "$GITHUB_TOKEN_FILE" ]; then
    token=$(cat "$GITHUB_TOKEN_FILE")
    printf 'header = "Authorization: Bearer %s"\n' "$token" |
      curl --config - --fail --silent --show-error --max-time 20 \
        -H 'Accept: application/vnd.github+json' \
        -H 'X-GitHub-Api-Version: 2022-11-28' \
        "$GITHUB_API_BASE$endpoint"
    token=
  else
    curl --fail --silent --show-error --max-time 20 \
      -H 'Accept: application/vnd.github+json' \
      -H 'X-GitHub-Api-Version: 2022-11-28' \
      "$GITHUB_API_BASE$endpoint"
  fi
}

open_pr_is_current() {
  expected_sha=$1
  pr_json=$(github_get "/repos/$PROJECT_REPOSITORY/pulls/$pr") || return 1
  printf '%s' "$pr_json" | jq -e \
    --arg repository "$PROJECT_REPOSITORY" \
    --arg sha "$expected_sha" \
    '.state == "open" and .base.ref == "main" and
     .base.repo.full_name == $repository and .head.repo.full_name == $repository and
     .head.sha == $sha' >/dev/null
}

revalidate_open_pr() {
  open_pr_is_current "$1" ||
    fail 'PR could not be proven open on the requested exact head under lock' 75
}

revalidate_open_pr_for() {
  selected_pr=$1
  expected_sha=$2
  pr_json=$(github_get "/repos/$PROJECT_REPOSITORY/pulls/$selected_pr") || return 1
  printf '%s' "$pr_json" | jq -e \
    --arg repository "$PROJECT_REPOSITORY" \
    --arg sha "$expected_sha" \
    '.state == "open" and .base.ref == "main" and
     .base.repo.full_name == $repository and .head.repo.full_name == $repository and
     .head.sha == $sha' >/dev/null
}

atomic_json_write() {
  target=$1
  body=$2
  tmp=$(mktemp "${target}.tmp.XXXXXX")
  printf '%s\n' "$body" > "$tmp"
  chmod 640 "$tmp"
  mv -f -- "$tmp" "$target"
}

assert_state_transition() {
  target=$1
  next_state=$2
  [ -f "$target" ] || return 0
  current_state=$(jq -er '.state' "$target") || fail 'Preview registry record has no lifecycle state' 75
  case "$current_state:$next_state" in
    building:ready|building:failed|ready:ready|ready:starting|ready:failed|starting:starting|starting:online|starting:failed|online:online|online:stopping|online:failed|update_failed:stopping|stopping:stopping|stopping:ready|stopping:online|stopping:failed|failed:failed|failed:ready|failed:starting|expired:ready|removed:building|removed:ready) ;;
    *) fail "Invalid Preview lifecycle transition $current_state -> $next_state" 75;;
  esac
}

compose() {
  docker compose --env-file "$env_file" -p "$compose_project" -f "$COMPOSE_FILE" "$@"
}

write_runtime_env() {
  target=$1
  sha=$2
  web_image=$3
  docs_image=$4
  gateway_image=$5
  prototype_image=$6
  postgres_password=$7
  gateway_secret=$8
  prototype_access_secret=$9
  verification_secret=$10
  gateway_env_file=$(config_value PREVIEW_GATEWAY_ENV_FILE)
  validate_image "$gateway_image" gateway
  validate_image "$prototype_image" prototype
  case "$gateway_env_file" in "$PLATFORM_ROOT"/secrets/project-space-preview/*) ;; *) fail 'gateway env file is outside the Preview secret root' 78;; esac
  [ -f "$gateway_env_file" ] && [ ! -L "$gateway_env_file" ] ||
    fail 'gateway env file must be a regular non-symlink file' 78
  gateway_env_identity=$(stat -c '%U:%G:%a' "$gateway_env_file") ||
    fail 'could not inspect gateway env file permissions' 78
  [ "$gateway_env_identity" = 'root:preview-deploy:640' ] ||
    fail 'gateway env file must be root:preview-deploy mode 0640' 78
  tmp=$(mktemp "${target}.tmp.XXXXXX")
  umask 077
  cat > "$tmp" <<EOF
PREVIEW_COMPOSE_PROJECT=$compose_project
COMPOSE_PROFILES=prototype
PREVIEW_DOMAIN=$domain
PREVIEW_DOCS_IMAGE=$docs_image
PREVIEW_GATEWAY_ENV_FILE=$gateway_env_file
PREVIEW_GATEWAY_IMAGE=$gateway_image
PREVIEW_GATEWAY_SECRET=$gateway_secret
PREVIEW_HEAD_SHA=$sha
PREVIEW_POSTGRES_PASSWORD=$postgres_password
PREVIEW_PR_NUMBER=$pr
PREVIEW_PROTOTYPE_IMAGE=$prototype_image
PREVIEW_PROTOTYPE_ACCESS_SECRET=$prototype_access_secret
PREVIEW_PROTOTYPE_UPSTREAM_ORIGIN=http://preview-prototype:8080
PREVIEW_REPOSITORY=$repository
PREVIEW_REPOSITORY_PATH=$repo_path
PREVIEW_WEB_IMAGE=$web_image
PROJECT_SPACE_PREVIEW_VERIFIED=0
PROJECT_SPACE_PREVIEW_VERIFICATION_SECRET=$verification_secret
PROJECT_SPACE_PREVIEW_OFFLINE=1
EOF
  chmod 600 "$tmp"
  mv -f -- "$tmp" "$target"
}

prepare_repository() {
  sha=$1
  next="$runtime_dir/repository.next"
  rm -rf -- "$next"
  git clone --no-checkout --filter=blob:none "https://github.com/$PROJECT_REPOSITORY.git" "$next" >/dev/null 2>&1 ||
    fail 'could not clone the approved repository' 70
  git -C "$next" fetch --depth=1 origin "$sha" >/dev/null 2>&1 || fail 'could not fetch the exact PR head' 70
  fetched=$(git -C "$next" rev-parse FETCH_HEAD)
  [ "$fetched" = "$sha" ] || fail 'fetched commit does not match requested PR head' 75
  git -C "$next" checkout --detach "$sha" >/dev/null 2>&1 || fail 'could not check out the exact PR head' 70
  rm -rf -- "$runtime_dir/repository.previous"
  if [ -d "$repo_path" ]; then mv -- "$repo_path" "$runtime_dir/repository.previous"; fi
  mv -- "$next" "$repo_path"
}

check_quota() {
  capacity_error_code=
  capacity_message=
  max_active=$(config_value PREVIEW_MAX_ACTIVE)
  min_free=$(config_value PREVIEW_MIN_FREE_BYTES)
  printf '%s' "$max_active" | grep -Eq '^[1-9][0-9]*$' || fail 'PREVIEW_MAX_ACTIVE is invalid' 78
  printf '%s' "$min_free" | grep -Eq '^[1-9][0-9]*$' || fail 'PREVIEW_MIN_FREE_BYTES is invalid' 78
  files=$(find "$STATE_ROOT" -mindepth 2 -maxdepth 2 -name runtime.json -type f 2>/dev/null | sort)
  if [ -n "$files" ]; then
    active=$(jq -s '[.[] | select(.state == "online" or .capacityBlocked == true)] | length' $files)
  else
    active=0
  fi
  if [ ! -f "$runtime_file" ] && [ "$active" -ge "$max_active" ]; then
    capacity_error_code=preview_quota_full
    capacity_message='Preview capacity is full; production and existing Previews were untouched.'
    return 1
  fi
  free=$(df -Pk "$PLATFORM_ROOT" | awk 'NR==2 {print $4 * 1024}')
  if [ "$free" -lt "$min_free" ]; then
    capacity_error_code=preview_storage_low
    capacity_message='Preview storage reserve is low; production and existing Previews were untouched.'
    return 1
  fi
}

blocked_capacity_record() {
  status=$1
  error_code=$2
  message=$3
  requested_sha=$4
  running_sha=
  if [ -f "$runtime_file" ]; then
    running_sha=$(jq -er '.runningSha // empty' "$runtime_file" 2>/dev/null || true)
  fi
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq -cn \
    --arg status "$status" --arg errorCode "$error_code" --arg message "$message" \
    --arg repository "$repository" --argjson pr "$pr" \
    --arg requestedSha "$requested_sha" --arg runningSha "$running_sha" --arg updatedAt "$now" \
    '{state:$status,errorCode:$errorCode,message:$message,repositoryFullName:$repository,
      pullRequestNumber:$pr,requestedSha:$requestedSha,updatedAt:$updatedAt} |
      if $runningSha != "" then .runningSha=$runningSha | .liveUrl=("https://pr-" + ($pr|tostring) + ".projects.os-home.net") else . end'
}

runtime_record() {
  status=$1
  requested_sha=$2
  running_sha=$3
  web_image=$4
  docs_image=$5
  gateway_image=$6
  prototype_image=$7
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  storage_bytes=$(preview_record_storage_bytes "$runtime_dir" "$state_dir" "$pr" "$web_image" "$docs_image" "$gateway_image" "$prototype_image")
  activity_lease=
  if [ "$status" = online ]; then
    idle_seconds=$(config_value PREVIEW_IDLE_SECONDS)
    printf '%s' "$idle_seconds" | grep -Eq '^[1-9][0-9]*$' || fail 'PREVIEW_IDLE_SECONDS is invalid' 78
    activity_lease=$(date -u -d "@$(( $(date +%s) + idle_seconds ))" +%Y-%m-%dT%H:%M:%SZ)
  fi
  jq -cn \
    --arg status "$status" --arg repository "$repository" --argjson pr "$pr" \
    --arg requestedSha "$requested_sha" --arg runningSha "$running_sha" \
    --arg webImage "$web_image" --arg docsImage "$docs_image" --arg gatewayImage "$gateway_image" \
    --arg prototypeImage "$prototype_image" \
    --arg activityLeaseExpiresAt "$activity_lease" \
    --argjson safeStorageBytes "$storage_bytes" \
    --arg liveUrl "https://$domain" \
    --arg prototypeUrl "https://$domain/prototype/desktop/" --arg verifiedAt "$now" \
    '{state:$status,capacityBlocked:false,repositoryFullName:$repository,pullRequestNumber:$pr,requestedSha:$requestedSha,
      runningSha:$runningSha,webImageDigest:$webImage,docsImageDigest:$docsImage,gatewayImageDigest:$gatewayImage,
      prototypeImageDigest:$prototypeImage,prototypeUrl:$prototypeUrl,prototypeMetaSha:$runningSha,
      safeStorageBytes:$safeStorageBytes,
      prototypeHealthy:true,
      liveUrl:$liveUrl,composeHealthy:true,httpHealthy:true,liveOriginHealthy:true,
      metaSha:$runningSha,verifiedAt:(if $status == "online" or ($status == "ready" and $runningSha != "") then $verifiedAt else null end),updatedAt:$verifiedAt,
      lastActivityAt:(if $status == "online" then $verifiedAt else null end),
      activityLeaseExpiresAt:(if $status == "online" then $activityLeaseExpiresAt else null end)}'
}

inventory_revision() {
  files=$(find "$STATE_ROOT" -mindepth 2 -maxdepth 2 -type f -name runtime.json 2>/dev/null | sort)
  [ -n "$files" ] || { printf '0'; return; }
  jq -s -c 'sort_by([.repositoryFullName, .pullRequestNumber]) |
    map({repositoryFullName, pullRequestNumber,
      requestedSha,
      runningSha:(if .state == "online" and .runningSha != "" then .runningSha else null end),
      state:(if .state == "update_failed" or .state == "failed_initial" or .state == "cleanup_failed" then "failed" else .state end),
      capacityBlocked:(.capacityBlocked // false), updatedAt})' $files |
    tr -d '\n' |
    sha256sum | awk '{print $1}'
}

emit_receipt() {
  record=$1
  compact_record=$(printf '%s' "$record" | jq -ce 'select(type == "object")') ||
    fail 'Preview receipt must be one JSON object' 70
  printf '%s%s\n' "$PREVIEW_RECEIPT_PREFIX" "$compact_record"
}

destroy_resources() {
  if [ -f "$env_file" ]; then compose down --volumes --remove-orphans --timeout 30 >/dev/null 2>&1 || true; fi
  containers=$(docker ps -aq --filter "label=com.dotnaos.project-space.repository=$repository" --filter "label=com.dotnaos.project-space.pr=$pr")
  [ -z "$containers" ] || docker rm -f $containers >/dev/null
  network="${compose_project}_preview-internal"
  volume="${compose_project}_postgres-data"
  docker network inspect "$network" >/dev/null 2>&1 && docker network rm "$network" >/dev/null || true
  docker volume inspect "$volume" >/dev/null 2>&1 && docker volume rm "$volume" >/dev/null || true
}

refuse_superseded_activation() {
  requested_sha=$1
  web_image=$2
  docs_image=$3
  gateway_image=$4
  prototype_image=$5
  destroy_resources
  remove_runtime_tree
  assert_state_transition "$runtime_file" failed
  record=$(runtime_record failed "$requested_sha" "" "$web_image" "$docs_image" "$gateway_image" "$prototype_image" |
    jq '.failureCode="superseded" | .capacityBlocked=false |
      .message="The exact PR head was superseded before activation; all target resources were removed." |
      .runningSha=null | .prototypeMetaSha=null | .metaSha=null | .prototypeHealthy=false |
      .composeHealthy=false | .httpHealthy=false | .liveOriginHealthy=false |
      .prototypeUrl=null | .liveUrl=null | .verifiedAt=null | .lastActivityAt=null')
  atomic_json_write "$runtime_file" "$record"
}

assert_removed() {
  containers=$(docker ps -aq --filter "label=com.dotnaos.project-space.repository=$repository" --filter "label=com.dotnaos.project-space.pr=$pr")
  [ -z "$containers" ] || fail 'Preview containers remain after cleanup' 71
  ! docker network inspect "${compose_project}_preview-internal" >/dev/null 2>&1 || fail 'Preview network remains after cleanup' 71
  ! docker volume inspect "${compose_project}_postgres-data" >/dev/null 2>&1 || fail 'Preview volume remains after cleanup' 71
  route_status=$(curl --silent --output /dev/null --max-time 10 --write-out '%{http_code}' "https://$domain/" || true)
  case "$route_status" in 000|404|410) ;; *) fail "Preview route still responds with HTTP $route_status" 71;; esac
}

assert_runtime_resources_absent_for() {
  selected_pr=$1
  selected_compose_project="project-space-preview-pr-$selected_pr"
  containers=$(docker ps -aq --filter "label=com.dotnaos.project-space.repository=$PROJECT_REPOSITORY" --filter "label=com.dotnaos.project-space.pr=$selected_pr")
  [ -z "$containers" ] || return 1
  ! docker network inspect "${selected_compose_project}_preview-internal" >/dev/null 2>&1 || return 1
}

remove_runtime_tree() {
  case "$runtime_dir" in "$RUNTIME_ROOT"/pr-[1-9]* ) ;; *) fail 'refusing unsafe Preview runtime removal' 71;; esac
  rm -rf -- "$runtime_dir"
  [ ! -e "$runtime_dir" ] || fail 'Preview runtime path remains after cleanup' 71
}

write_tombstone() {
  reason=$1
  requested_sha=${2:-}
  running_sha=${3:-}
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  body=$(jq -n --arg repository "$repository" --argjson pr "$pr" --arg reason "$reason" --arg removedAt "$now" \
    --arg requestedSha "$requested_sha" --arg runningSha "$running_sha" \
    '{repositoryFullName:$repository,pullRequestNumber:$pr,state:"removed",message:$reason,updatedAt:$removedAt,
      cleanup:{containersAbsent:true,networksAbsent:true,volumesAbsent:true,runtimePathAbsent:true,routeAbsent:true}} |
      if $requestedSha != "" then .requestedSha=$requestedSha else . end |
      if $runningSha != "" then .runningSha=$runningSha else . end')
  atomic_json_write "$tombstone_file" "$body"
}

apply_preview() {
  head_sha=$(json_string headSha)
  web_image=$(json_string webImage)
  docs_image=$(json_string docsImage)
  gateway_image=$(json_string gatewayImage)
  prototype_image=$(json_string prototypeImage)
  validate_sha "$head_sha"
  validate_image "$web_image" web
  validate_image "$docs_image" docs
  validate_image "$gateway_image" gateway
  validate_image "$prototype_image" prototype
  [ -f "$COMPOSE_FILE" ] || fail 'trusted Preview Compose asset is missing' 78
  prepare_directories
  acquire_lifecycle_locks
  revalidate_open_pr "$head_sha"
  mode=$(printf '%s' "$request" | jq -r '.mode // "online"')
  if [ "$mode" = register ]; then
    if [ -f "$runtime_file" ] && [ "$(jq -er '.state' "$runtime_file" 2>/dev/null || true)" = online ]; then
      fail 'Cannot register a new build over an online Preview; stop it explicitly first' 73
    fi
    assert_state_transition "$runtime_file" ready
    prepare_storage_policy
    record=$(runtime_record ready "$head_sha" "" "$web_image" "$docs_image" "$gateway_image" "$prototype_image" |
      jq '.verifiedAt=null | .prototypeHealthy=false | .prototypeMetaSha=null | .prototypeUrl=null | .liveUrl=null | .composeHealthy=false | .httpHealthy=false | .liveOriginHealthy=false')
    revalidate_open_pr "$head_sha"
    atomic_json_write "$runtime_file" "$record"
    rm -f -- "$tombstone_file"
    emit_receipt "$record"
    return
  fi
  if ! check_quota; then
    record=$(blocked_capacity_record blocked_capacity "$capacity_error_code" "$capacity_message" "$head_sha")
    atomic_json_write "$state_dir/blocked.json" "$record"
    emit_receipt "$record"
    exit 73
  fi
  rm -f -- "$state_dir/blocked.json"
  prepare_storage_policy
  assert_state_transition "$runtime_file" online
  previous_record=
  previous_env=
  if [ -f "$runtime_file" ] && [ -f "$env_file" ]; then
    previous_record=$(cat "$runtime_file")
    previous_env="$runtime_dir/runtime.env.previous"
    cp -- "$env_file" "$previous_env"
    chmod 600 "$previous_env"
  fi
  prepare_repository "$head_sha"
  postgres_password=$(openssl rand -hex 32)
  gateway_secret=$(openssl rand -hex 32)
  prototype_access_secret=$(openssl rand -hex 32)
  verification_secret=$(openssl rand -hex 32)
  if [ -n "$previous_env" ]; then
    postgres_password=$(sed -n 's/^PREVIEW_POSTGRES_PASSWORD=//p' "$previous_env")
    gateway_secret=$(sed -n 's/^PREVIEW_GATEWAY_SECRET=//p' "$previous_env")
    prototype_access_secret=$(sed -n 's/^PREVIEW_PROTOTYPE_ACCESS_SECRET=//p' "$previous_env")
    [ -n "$prototype_access_secret" ] || prototype_access_secret=$(openssl rand -hex 32)
  fi
  write_runtime_env "$env_file" "$head_sha" "$web_image" "$docs_image" "$gateway_image" \
    "$prototype_image" "$postgres_password" "$gateway_secret" "$prototype_access_secret" "$verification_secret"
  if compose pull --quiet >&2 && check_storage_policy && compose up -d --wait --wait-timeout 240 >&2 &&
    verify_runtime_with_retry "$head_sha"; then
    if ! open_pr_is_current "$head_sha"; then
      refuse_superseded_activation "$head_sha" "$web_image" "$docs_image" "$gateway_image" "$prototype_image"
      fail 'PR head was superseded before Preview activation; target resources were removed' 75
    fi
    sed -e 's/^PROJECT_SPACE_PREVIEW_VERIFIED=.*/PROJECT_SPACE_PREVIEW_VERIFIED=1/' \
      -e 's/^PROJECT_SPACE_PREVIEW_OFFLINE=.*/PROJECT_SPACE_PREVIEW_OFFLINE=0/' \
      "$env_file" > "$env_file.verified"
    chmod 600 "$env_file.verified"
    mv -f -- "$env_file.verified" "$env_file"
    compose up -d --no-deps --force-recreate --wait --wait-timeout 60 gateway >&2 || fail 'Preview gateway activation could not be verified' 72
    record=$(runtime_record online "$head_sha" "$head_sha" "$web_image" "$docs_image" \
      "$gateway_image" "$prototype_image")
    atomic_json_write "$runtime_file" "$record"
    rm -f -- "$tombstone_file" "$previous_env"
    rm -rf -- "$runtime_dir/repository.previous"
    emit_receipt "$record"
    return
  fi
  if [ -n "$previous_record" ] && [ -f "$previous_env" ] && [ -d "$runtime_dir/repository.previous" ]; then
    rm -rf -- "$repo_path"
    mv -- "$runtime_dir/repository.previous" "$repo_path"
    mv -f -- "$previous_env" "$env_file"
    old_sha=$(printf '%s' "$previous_record" | jq -er '.runningSha')
    if compose up -d --wait --wait-timeout 240 >&2 && verify_runtime_with_retry "$old_sha"; then
      failed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      record=$(printf '%s' "$previous_record" | jq --arg requested "$head_sha" --arg updated "$failed_at" \
        '.state="update_failed" | .capacityBlocked=true | .requestedSha=$requested | .updatedAt=$updated | .message="Latest Preview update failed; prior verified SHA remains live."')
      atomic_json_write "$runtime_file" "$record"
      emit_receipt "$record"
      exit 72
    fi
  fi
  destroy_resources
  remove_runtime_tree
  fail 'initial Preview deployment failed and partial resources were removed' 72
}

destroy_preview() {
  reason=$(printf '%s' "$request" | jq -er '.reason // "manual" | select(type == "string")')
  prepare_directories
  acquire_lifecycle_locks
  last_requested=
  last_running=
  if [ -f "$runtime_file" ]; then
    last_requested=$(jq -er '.requestedSha // empty' "$runtime_file" 2>/dev/null || true)
    last_running=$(jq -er '.runningSha // empty' "$runtime_file" 2>/dev/null || true)
  fi
  destroy_resources
  assert_removed
  remove_runtime_tree
  rm -f -- "$runtime_file" "$state_dir/blocked.json"
  install -d -m 700 "$state_dir"
  write_tombstone "$reason" "$last_requested" "$last_running"
  cat "$tombstone_file"
}

stop_selected_runtime() {
  selected_pr=$1
  selected_runtime_dir="$RUNTIME_ROOT/pr-$selected_pr"
  selected_state_dir="$STATE_ROOT/pr-$selected_pr"
  selected_env_file="$selected_runtime_dir/runtime.env"
  selected_runtime_file="$selected_state_dir/runtime.json"
  selected_lock_file="$LOCK_ROOT/project-space-preview-pr-${selected_pr}.lock"
  selected_compose_project="project-space-preview-pr-$selected_pr"
  [ -f "$selected_env_file" ] && [ -f "$selected_runtime_file" ] ||
    fail 'selected replacement Preview has no complete runtime record' 75
  : > "$selected_lock_file"
  chmod 600 "$selected_lock_file"
  exec 10>>"$selected_lock_file"
  flock -w 900 10 || fail "Preview lock timeout for PR ${selected_pr}" 73
  [ "$(jq -er '.state' "$selected_runtime_file")" = online ] ||
    fail 'selected replacement Preview is no longer online' 75
  selected_head_sha=$(jq -er '.requestedSha' "$selected_runtime_file")
  revalidate_open_pr_for "$selected_pr" "$selected_head_sha" ||
    fail 'selected replacement Preview no longer matches an open exact-head PR' 75
  atomic_json_write "$selected_runtime_file" "$(jq --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.state="stopping" | .updatedAt=$now' "$selected_runtime_file")"
  docker compose --env-file "$selected_env_file" -p "$selected_compose_project" \
    -f "$COMPOSE_FILE" down --remove-orphans --timeout 30 >/dev/null 2>&1 ||
    {
      capacity_blocked=true
      assert_runtime_resources_absent_for "$selected_pr" && capacity_blocked=false || true
      assert_state_transition "$selected_runtime_file" failed
      atomic_json_write "$selected_runtime_file" "$(jq --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson capacityBlocked "$capacity_blocked" '.state="failed" | .failureCode="operation_failed" | .capacityBlocked=$capacityBlocked | .message="Selected replacement Preview could not be stopped." | .updatedAt=$now' "$selected_runtime_file")"
      fail 'selected replacement Preview could not be stopped' 72
    }
  assert_runtime_resources_absent_for "$selected_pr" || {
    assert_state_transition "$selected_runtime_file" failed
    atomic_json_write "$selected_runtime_file" "$(jq --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.state="failed" | .failureCode="operation_failed" | .capacityBlocked=true | .message="Selected replacement Preview teardown was not positively confirmed." | .updatedAt=$now' "$selected_runtime_file")"
    fail 'selected replacement Preview teardown was not positively confirmed' 72
  }
  selected_now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  assert_state_transition "$selected_runtime_file" ready
  atomic_json_write "$selected_runtime_file" "$(jq --arg now "$selected_now" \
    '.state="ready" | .capacityBlocked=false | .runningSha=null | .verifiedAt=null | .prototypeHealthy=false |
     .prototypeMetaSha=null | .prototypeUrl=null | .liveUrl=null | .updatedAt=$now |
     .message="Preview is ready offline; runtime resources are stopped."' "$selected_runtime_file")"
}

restore_selected_runtime() {
  selected_pr=$1
  selected_head_sha=$2
  selected_runtime_dir="$RUNTIME_ROOT/pr-$selected_pr"
  selected_state_dir="$STATE_ROOT/pr-$selected_pr"
  selected_env_file="$selected_runtime_dir/runtime.env"
  selected_runtime_file="$selected_state_dir/runtime.json"
  selected_compose_project="project-space-preview-pr-$selected_pr"
  [ -f "$selected_env_file" ] || return 1
  [ "$(jq -er '.state' "$selected_runtime_file" 2>/dev/null || true)" = ready ] || return 1
  revalidate_open_pr_for "$selected_pr" "$selected_head_sha" || return 1
  if ! docker compose --env-file "$selected_env_file" -p "$selected_compose_project" \
    -f "$COMPOSE_FILE" up -d --wait --wait-timeout 240 >&2; then
    docker compose --env-file "$selected_env_file" -p "$selected_compose_project" \
      -f "$COMPOSE_FILE" down --remove-orphans --timeout 30 >/dev/null 2>&1 || true
    capacity_blocked=true
    assert_runtime_resources_absent_for "$selected_pr" && capacity_blocked=false || true
    assert_state_transition "$selected_runtime_file" failed
    atomic_json_write "$selected_runtime_file" "$(jq --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --argjson capacityBlocked "$capacity_blocked" '.state="failed" | .failureCode="operation_failed" | .capacityBlocked=$capacityBlocked | .message="Previous Preview restoration failed before health verification." | .updatedAt=$now' "$selected_runtime_file")"
    return 1
  fi

  saved_pr=$pr; saved_domain=$domain; saved_compose_project=$compose_project
  saved_runtime_dir=$runtime_dir; saved_state_dir=$state_dir; saved_env_file=$env_file
  saved_runtime_file=$runtime_file; saved_repo_path=$repo_path
  pr=$selected_pr; domain="pr-${selected_pr}.projects.os-home.net"
  compose_project=$selected_compose_project; runtime_dir=$selected_runtime_dir
  state_dir=$selected_state_dir; env_file=$selected_env_file
  runtime_file=$selected_runtime_file; repo_path="$selected_runtime_dir/repository"
  if verify_runtime_with_retry "$selected_head_sha"; then
    restored=$(runtime_record online "$selected_head_sha" "$selected_head_sha" \
      "$(sed -n 's/^PREVIEW_WEB_IMAGE=//p' "$selected_env_file")" \
      "$(sed -n 's/^PREVIEW_DOCS_IMAGE=//p' "$selected_env_file")" \
      "$(sed -n 's/^PREVIEW_GATEWAY_IMAGE=//p' "$selected_env_file")" \
      "$(sed -n 's/^PREVIEW_PROTOTYPE_IMAGE=//p' "$selected_env_file")")
    atomic_json_write "$selected_runtime_file" "$restored"
    pr=$saved_pr; domain=$saved_domain; compose_project=$saved_compose_project
    runtime_dir=$saved_runtime_dir; state_dir=$saved_state_dir; env_file=$saved_env_file
    runtime_file=$saved_runtime_file; repo_path=$saved_repo_path
    return 0
  fi
  docker compose --env-file "$selected_env_file" -p "$selected_compose_project" \
    -f "$COMPOSE_FILE" down --remove-orphans --timeout 30 >/dev/null 2>&1 || true
  capacity_blocked=true
  assert_runtime_resources_absent_for "$selected_pr" && capacity_blocked=false || true
  assert_state_transition "$selected_runtime_file" failed
  atomic_json_write "$selected_runtime_file" "$(jq --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson capacityBlocked "$capacity_blocked" '.state="failed" | .failureCode="unhealthy" | .capacityBlocked=$capacityBlocked | .message="Previous Preview restoration failed exact-head health verification." | .updatedAt=$now' "$selected_runtime_file")"
  pr=$saved_pr; domain=$saved_domain; compose_project=$saved_compose_project
  runtime_dir=$saved_runtime_dir; state_dir=$saved_state_dir; env_file=$saved_env_file
  runtime_file=$saved_runtime_file; repo_path=$saved_repo_path
  return 1
}

start_preview() {
  prepare_directories
  acquire_lifecycle_locks
  [ -f "$runtime_file" ] || fail 'Preview is not registered; build it before starting' 74
  state=$(jq -er '.state' "$runtime_file")
  [ "$state" = ready ] || fail "Preview is not startable from state $state" 74
  requested_sha=$(jq -er '.requestedSha' "$runtime_file"); validate_sha "$requested_sha"
  revalidate_open_pr "$requested_sha"
  max_active=$(config_value PREVIEW_MAX_ACTIVE)
  active=$(find "$STATE_ROOT" -mindepth 2 -maxdepth 2 -name runtime.json -type f -print0 2>/dev/null | xargs -0 -r jq -s '[.[] | select(.state == "online" or .capacityBlocked == true)] | length')
  replacement_pr=$(printf '%s' "$request" | jq -er '.selectedReplacementPullRequestNumber // empty | select(type == "number" and . == floor and . > 0)' 2>/dev/null || true)
  replacement_head=$(printf '%s' "$request" | jq -er '.selectedReplacementHeadSha // empty | select(type == "string")' 2>/dev/null || true)
  replacement_repository=$(printf '%s' "$request" | jq -er '.selectedReplacementRepositoryFullName // empty | select(type == "string")' 2>/dev/null || true)
  if [ "$active" -ge "$max_active" ]; then
    [ -n "$replacement_pr" ] && [ "$replacement_repository" = "$PROJECT_REPOSITORY" ] ||
      fail 'Preview online capacity is full; explicit replacement is required' 73
    validate_sha "$replacement_head"
    requested_revision=$(printf '%s' "$request" | jq -er '.inventoryRevision // empty | select(type == "string" and length > 0)' 2>/dev/null || true)
    [ -n "$requested_revision" ] && [ "$requested_revision" = "$(inventory_revision)" ] ||
      fail 'Preview inventory changed; choose a replacement again' 73
    selected_file="$STATE_ROOT/pr-$replacement_pr/runtime.json"
    [ -f "$selected_file" ] || fail 'selected replacement Preview no longer exists' 75
    [ "$(jq -er '.state' "$selected_file")" = online ] || fail 'selected replacement Preview is no longer online' 75
    [ "$(jq -er '.requestedSha' "$selected_file")" = "$replacement_head" ] ||
      fail 'selected replacement Preview head changed' 75
  fi
  web_image=$(jq -er '.webImageDigest' "$runtime_file")
  docs_image=$(jq -er '.docsImageDigest' "$runtime_file")
  gateway_image=$(jq -er '.gatewayImageDigest' "$runtime_file")
  prototype_image=$(jq -er '.prototypeImageDigest' "$runtime_file")
  postgres_password=$(openssl rand -hex 32); gateway_secret=$(openssl rand -hex 32); prototype_access_secret=$(openssl rand -hex 32)
  verification_secret=$(openssl rand -hex 32)
  prepare_storage_policy
  write_runtime_env "$env_file" "$requested_sha" "$web_image" "$docs_image" "$gateway_image" "$prototype_image" "$postgres_password" "$gateway_secret" "$prototype_access_secret" "$verification_secret"
  prepare_repository "$requested_sha"
  compose pull --quiet >&2 || fail 'could not prepare the exact Preview images' 70
  check_storage_policy
  if [ "$active" -ge "$max_active" ]; then
    stop_selected_runtime "$replacement_pr"
  fi
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  assert_state_transition "$runtime_file" starting
  atomic_json_write "$runtime_file" "$(jq --arg now "$now" '.state="starting" | .updatedAt=$now' "$runtime_file")"
  if compose up -d --wait --wait-timeout 240 >&2 && verify_runtime_with_retry "$requested_sha"; then
    if ! open_pr_is_current "$requested_sha"; then
      refuse_superseded_activation "$requested_sha" "$web_image" "$docs_image" "$gateway_image" "$prototype_image"
      if [ "$active" -ge "$max_active" ]; then
        restore_selected_runtime "$replacement_pr" "$replacement_head" || true
      fi
      fail 'PR head was superseded before Preview activation; target resources were removed' 75
    fi
    sed -e 's/^PROJECT_SPACE_PREVIEW_VERIFIED=.*/PROJECT_SPACE_PREVIEW_VERIFIED=1/' \
      -e 's/^PROJECT_SPACE_PREVIEW_OFFLINE=.*/PROJECT_SPACE_PREVIEW_OFFLINE=0/' \
      "$env_file" > "$env_file.verified"
    chmod 600 "$env_file.verified"
    mv -f -- "$env_file.verified" "$env_file"
    compose up -d --no-deps --force-recreate --wait --wait-timeout 60 gateway >&2 || fail 'Preview gateway activation could not be verified' 72
    record=$(runtime_record online "$requested_sha" "$requested_sha" "$web_image" "$docs_image" "$gateway_image" "$prototype_image")
    atomic_json_write "$runtime_file" "$record"
    emit_receipt "$record"
    return
  fi
  if [ "$active" -ge "$max_active" ]; then
    destroy_resources
  fi
  target_resources_absent=true
  assert_runtime_resources_absent_for "$pr" || target_resources_absent=false
  if [ "$active" -ge "$max_active" ] && [ "$target_resources_absent" = true ] && restore_selected_runtime "$replacement_pr" "$replacement_head"; then
    assert_state_transition "$runtime_file" failed
    atomic_json_write "$runtime_file" "$(jq --arg now "$now" \
      '.state="failed" | .failureCode="operation_failed" |
       .capacityBlocked=false | .message="Target Preview failed; the selected previous Preview was restored." |
       .updatedAt=$now | .runningSha=null | .verifiedAt=null' "$runtime_file")"
    fail 'Preview start failed; the selected previous Preview was restored' 72
  fi
  assert_state_transition "$runtime_file" failed
  capacity_blocked=false
  [ "$target_resources_absent" = true ] || capacity_blocked=true
  atomic_json_write "$runtime_file" "$(jq --arg now "$now" --argjson capacityBlocked "$capacity_blocked" '.state="failed" | .failureCode="unhealthy" | .capacityBlocked=$capacityBlocked | .message="Exact-head health verification failed; Preview remains offline." | .updatedAt=$now | .runningSha=null | .verifiedAt=null' "$runtime_file")"
  destroy_resources
  fail 'Preview start failed exact-head or health verification' 72
}

stop_preview() {
  prepare_directories
  acquire_lifecycle_locks
  [ -f "$runtime_file" ] || fail 'Preview is not registered' 74
  state=$(jq -er '.state' "$runtime_file")
  [ "$state" = online ] || [ "$state" = update_failed ] || fail "Preview is not online; refusing implicit transition from $state" 74
  requested_head_sha=$(printf '%s' "$request" | jq -er '.requestedHeadSha // .headSha // empty | select(type == "string")' 2>/dev/null || true)
  if [ -n "$requested_head_sha" ]; then
    validate_sha "$requested_head_sha"
    [ "$(jq -er '.requestedSha' "$runtime_file")" = "$requested_head_sha" ] ||
      fail 'Preview head changed; refusing to stop stale identity' 75
  fi
  assert_state_transition "$runtime_file" stopping
  atomic_json_write "$runtime_file" "$(jq --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.state="stopping" | .updatedAt=$now' "$runtime_file")"
  compose down --remove-orphans --timeout 30 >/dev/null 2>&1 || {
    capacity_blocked=true
    assert_runtime_resources_absent_for "$pr" && capacity_blocked=false || true
    atomic_json_write "$runtime_file" "$(jq --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson capacityBlocked "$capacity_blocked" '.state="failed" | .failureCode="operation_failed" | .capacityBlocked=$capacityBlocked | .message="Preview stop was not positively confirmed." | .updatedAt=$now' "$runtime_file")"
    fail 'Preview stop was not positively confirmed' 72
  }
  assert_runtime_resources_absent_for "$pr" || {
    atomic_json_write "$runtime_file" "$(jq --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.state="failed" | .failureCode="operation_failed" | .capacityBlocked=true | .message="Preview stop teardown was not positively confirmed." | .updatedAt=$now' "$runtime_file")"
    fail 'Preview stop teardown was not positively confirmed' 72
  }
  assert_state_transition "$runtime_file" ready
  record=$(jq --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.state="ready" | .capacityBlocked=false | .runningSha=null | .verifiedAt=null | .prototypeHealthy=false | .prototypeMetaSha=null | .prototypeUrl=null | .liveUrl=null | .updatedAt=$now | .message="Preview is ready offline; runtime resources are stopped."' "$runtime_file")
  atomic_json_write "$runtime_file" "$record"
  emit_receipt "$record"
}

touch_preview() {
  prepare_directories
  acquire_lifecycle_locks
  [ -f "$runtime_file" ] || fail 'Preview is not registered' 74
  [ "$(jq -er '.state' "$runtime_file")" = online ] || fail 'Preview is not online' 74
  requested_head_sha=$(printf '%s' "$request" | jq -er '.requestedHeadSha // .headSha // empty | select(type == "string")')
  validate_sha "$requested_head_sha"
  revalidate_open_pr "$requested_head_sha"
  [ "$(jq -er '.requestedSha' "$runtime_file")" = "$requested_head_sha" ] || fail 'Preview head changed; refusing stale activity lease' 75
  idle_seconds=$(config_value PREVIEW_IDLE_SECONDS)
  printf '%s' "$idle_seconds" | grep -Eq '^[1-9][0-9]*$' || fail 'PREVIEW_IDLE_SECONDS is invalid' 78
  now_epoch=$(date +%s)
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  lease=$(date -u -d "@$((now_epoch + idle_seconds))" +%Y-%m-%dT%H:%M:%SZ)
  record=$(jq --arg now "$now" --arg lease "$lease" '.lastActivityAt=$now | .activityLeaseExpiresAt=$lease | .updatedAt=$now' "$runtime_file")
  atomic_json_write "$runtime_file" "$record"
  emit_receipt "$record"
}

status_preview() {
  if [ -f "$state_dir/blocked.json" ]; then cat "$state_dir/blocked.json"; return; fi
  if [ -f "$runtime_file" ]; then cat "$runtime_file"; return; fi
  if [ -f "$tombstone_file" ]; then cat "$tombstone_file"; return; fi
  jq -n --arg repository "$repository" --argjson pr "$pr" '{repositoryFullName:$repository,pullRequestNumber:$pr,state:"absent"}'
}

status_all_previews() {
  files=$(find "$STATE_ROOT" -mindepth 2 -maxdepth 2 -type f \( -name runtime.json -o -name tombstone.json -o -name blocked.json \) 2>/dev/null | sort)
  if [ -z "$files" ]; then printf '{"records":[]}\n'; return; fi
  # Registry files contain only the bounded public status contract, never runtime.env or controller secrets.
  jq -s '{records: map(select(.repositoryFullName == "DotNaos/project-space"))}' $files
}

require_command jq
reaper_script=${PROJECT_SPACE_PREVIEW_REAPER_SCRIPT:-$ASSET_ROOT/preview-reaper.sh}
[ -f "$reaper_script" ] || reaper_script=$(dirname "$0")/preview-reaper.sh
. "$reaper_script"
storage_policy_script=${PROJECT_SPACE_PREVIEW_STORAGE_POLICY_SCRIPT:-$ASSET_ROOT/preview-storage-policy.sh}
[ -f "$storage_policy_script" ] || storage_policy_script=$(dirname "$0")/preview-storage-policy.sh
. "$storage_policy_script"
runtime_verification_script=${PROJECT_SPACE_PREVIEW_RUNTIME_VERIFICATION_SCRIPT:-$ASSET_ROOT/preview-runtime-verification.sh}
[ -f "$runtime_verification_script" ] || runtime_verification_script=$(dirname "$0")/preview-runtime-verification.sh
. "$runtime_verification_script"
command_name=${1:-}
case "$command_name" in
  apply)
    require_command curl; require_command docker; require_command flock; require_command git; require_command openssl
    read_request; prepare_identity; apply_preview
    ;;
  register)
    require_command curl; require_command docker; require_command flock; require_command jq; read_request; prepare_identity; apply_preview
    ;;
  start)
    require_command curl; require_command docker; require_command flock; require_command jq; require_command git; require_command openssl
    read_request; prepare_identity; start_preview
    ;;
  stop)
    require_command docker; require_command flock; require_command jq
    read_request; prepare_identity; stop_preview
    ;;
  touch)
    require_command flock; require_command jq; read_request; prepare_identity; touch_preview
    ;;
  destroy)
    require_command curl; require_command docker; require_command flock; read_request; prepare_identity; destroy_preview
    ;;
  status)
    read_request; prepare_identity; status_preview
    ;;
  status-all)
    status_all_previews
    ;;
  reap)
    require_command curl; require_command docker; require_command flock; read_request; reap_previews
    ;;
  *) fail 'usage: preview-runner.sh apply|register|start|stop|touch|destroy|status|status-all|reap' 64;;
esac
