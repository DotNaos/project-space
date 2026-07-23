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
COMPOSE_FILE=$ASSET_ROOT/preview.compose.yml

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

revalidate_open_pr() {
  expected_sha=$1
  pr_json=$(github_get "/repos/$PROJECT_REPOSITORY/pulls/$pr") || fail 'could not revalidate PR under lock' 75
  printf '%s' "$pr_json" | jq -e \
    --arg repository "$PROJECT_REPOSITORY" \
    --arg sha "$expected_sha" \
    '.state == "open" and .base.ref == "main" and
     .base.repo.full_name == $repository and .head.repo.full_name == $repository and
     .head.sha == $sha' >/dev/null || fail 'PR is closed, forked, targets another base, or its head was superseded' 75
}

atomic_json_write() {
  target=$1
  body=$2
  tmp=$(mktemp "${target}.tmp.XXXXXX")
  printf '%s\n' "$body" > "$tmp"
  chmod 640 "$tmp"
  mv -f -- "$tmp" "$target"
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
  postgres_password=$6
  gateway_secret=$7
  gateway_env_file=$(config_value PREVIEW_GATEWAY_ENV_FILE)
  validate_image "$gateway_image" gateway
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
PREVIEW_DOMAIN=$domain
PREVIEW_DOCS_IMAGE=$docs_image
PREVIEW_GATEWAY_ENV_FILE=$gateway_env_file
PREVIEW_GATEWAY_IMAGE=$gateway_image
PREVIEW_GATEWAY_SECRET=$gateway_secret
PREVIEW_HEAD_SHA=$sha
PREVIEW_POSTGRES_PASSWORD=$postgres_password
PREVIEW_PR_NUMBER=$pr
PREVIEW_REPOSITORY=$repository
PREVIEW_REPOSITORY_PATH=$repo_path
PREVIEW_WEB_IMAGE=$web_image
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
  max_active=$(config_value PREVIEW_MAX_ACTIVE)
  min_free=$(config_value PREVIEW_MIN_FREE_BYTES)
  printf '%s' "$max_active" | grep -Eq '^[1-9][0-9]*$' || fail 'PREVIEW_MAX_ACTIVE is invalid' 78
  printf '%s' "$min_free" | grep -Eq '^[1-9][0-9]*$' || fail 'PREVIEW_MIN_FREE_BYTES is invalid' 78
  active=$(find "$STATE_ROOT" -mindepth 2 -maxdepth 2 -name runtime.json -type f 2>/dev/null | wc -l | tr -d ' ')
  [ -f "$runtime_file" ] || [ "$active" -lt "$max_active" ] || fail 'Preview quota is full' 73
  free=$(df -Pk "$PLATFORM_ROOT" | awk 'NR==2 {print $4 * 1024}')
  [ "$free" -ge "$min_free" ] || fail 'Preview runner has insufficient free space' 73
}

verify_runtime() {
  sha=$1
  for service in gateway web docs db; do
    container=$(compose ps -q "$service")
    [ -n "$container" ] || return 1
    [ "$(docker inspect --format '{{.State.Status}}' "$container")" = running ] || return 1
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")
    [ -z "$health" ] || [ "$health" = healthy ] || return 1
    [ "$(docker inspect --format '{{index .Config.Labels "com.dotnaos.project-space.pr"}}' "$container")" = "$pr" ] || return 1
    [ "$(docker inspect --format '{{index .Config.Labels "com.dotnaos.project-space.sha"}}' "$container")" = "$sha" ] || return 1
    case "$service" in
      gateway) expected_image=$(sed -n 's/^PREVIEW_GATEWAY_IMAGE=//p' "$env_file");;
      web) expected_image=$(sed -n 's/^PREVIEW_WEB_IMAGE=//p' "$env_file");;
      docs) expected_image=$(sed -n 's/^PREVIEW_DOCS_IMAGE=//p' "$env_file");;
      *) expected_image=;;
    esac
    [ -z "$expected_image" ] || [ "$(docker inspect --format '{{.Config.Image}}' "$container")" = "$expected_image" ] || return 1
  done
  meta=$(curl --fail --silent --show-error --max-time 20 "https://$domain/api/app/meta") || return 1
  [ "$(printf '%s' "$meta" | jq -er '.commit')" = "$sha" ] || return 1
  health=$(curl --fail --silent --show-error --max-time 20 "https://$domain/api/health") || return 1
  printf '%s' "$health" | jq -e '.ok == true' >/dev/null || return 1
  session_status=$(curl --silent --show-error --max-time 20 --output /dev/null --write-out '%{http_code}' "https://$domain/api/auth/session") || return 1
  [ "$session_status" = 401 ] || return 1
  curl --fail --silent --show-error --max-time 20 --output /dev/null "https://$domain/" || return 1
}

runtime_record() {
  status=$1
  requested_sha=$2
  running_sha=$3
  web_image=$4
  docs_image=$5
  gateway_image=$6
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq -n \
    --arg status "$status" --arg repository "$repository" --argjson pr "$pr" \
    --arg requestedSha "$requested_sha" --arg runningSha "$running_sha" \
    --arg webImage "$web_image" --arg docsImage "$docs_image" --arg gatewayImage "$gateway_image" \
    --arg liveUrl "https://$domain" --arg verifiedAt "$now" \
    '{state:$status,repositoryFullName:$repository,pullRequestNumber:$pr,requestedSha:$requestedSha,
      runningSha:$runningSha,webImageDigest:$webImage,docsImageDigest:$docsImage,gatewayImageDigest:$gatewayImage,
      liveUrl:$liveUrl,composeHealthy:true,httpHealthy:true,liveOriginHealthy:true,
      metaSha:$runningSha,verifiedAt:$verifiedAt,updatedAt:$verifiedAt}'
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

assert_removed() {
  containers=$(docker ps -aq --filter "label=com.dotnaos.project-space.repository=$repository" --filter "label=com.dotnaos.project-space.pr=$pr")
  [ -z "$containers" ] || fail 'Preview containers remain after cleanup' 71
  ! docker network inspect "${compose_project}_preview-internal" >/dev/null 2>&1 || fail 'Preview network remains after cleanup' 71
  ! docker volume inspect "${compose_project}_postgres-data" >/dev/null 2>&1 || fail 'Preview volume remains after cleanup' 71
  route_status=$(curl --silent --output /dev/null --max-time 10 --write-out '%{http_code}' "https://$domain/" || true)
  case "$route_status" in 000|404|410) ;; *) fail "Preview route still responds with HTTP $route_status" 71;; esac
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
  validate_sha "$head_sha"
  validate_image "$web_image" web
  validate_image "$docs_image" docs
  validate_image "$gateway_image" gateway
  [ -f "$COMPOSE_FILE" ] || fail 'trusted Preview Compose asset is missing' 78
  prepare_directories
  acquire_lock
  revalidate_open_pr "$head_sha"
  check_quota
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
  if [ -n "$previous_env" ]; then
    postgres_password=$(sed -n 's/^PREVIEW_POSTGRES_PASSWORD=//p' "$previous_env")
    gateway_secret=$(sed -n 's/^PREVIEW_GATEWAY_SECRET=//p' "$previous_env")
  fi
  write_runtime_env "$env_file" "$head_sha" "$web_image" "$docs_image" "$gateway_image" "$postgres_password" "$gateway_secret"
  if compose pull --quiet && compose up -d --wait --wait-timeout 240 && verify_runtime "$head_sha"; then
    record=$(runtime_record ready "$head_sha" "$head_sha" "$web_image" "$docs_image" "$gateway_image")
    atomic_json_write "$runtime_file" "$record"
    rm -f -- "$tombstone_file" "$previous_env"
    rm -rf -- "$runtime_dir/repository.previous"
    printf '%s\n' "$record"
    return
  fi
  if [ -n "$previous_record" ] && [ -f "$previous_env" ] && [ -d "$runtime_dir/repository.previous" ]; then
    rm -rf -- "$repo_path"
    mv -- "$runtime_dir/repository.previous" "$repo_path"
    mv -f -- "$previous_env" "$env_file"
    old_sha=$(printf '%s' "$previous_record" | jq -er '.runningSha')
    if compose up -d --wait --wait-timeout 240 && verify_runtime "$old_sha"; then
      failed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      record=$(printf '%s' "$previous_record" | jq --arg requested "$head_sha" --arg updated "$failed_at" \
        '.state="update_failed" | .requestedSha=$requested | .updatedAt=$updated | .message="Latest Preview update failed; prior verified SHA remains live."')
      atomic_json_write "$runtime_file" "$record"
      printf '%s\n' "$record"
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
  acquire_lock
  last_requested=
  last_running=
  if [ -f "$runtime_file" ]; then
    last_requested=$(jq -er '.requestedSha // empty' "$runtime_file" 2>/dev/null || true)
    last_running=$(jq -er '.runningSha // empty' "$runtime_file" 2>/dev/null || true)
  fi
  destroy_resources
  assert_removed
  remove_runtime_tree
  rm -f -- "$runtime_file"
  install -d -m 700 "$state_dir"
  write_tombstone "$reason" "$last_requested" "$last_running"
  cat "$tombstone_file"
}

status_preview() {
  if [ -f "$runtime_file" ]; then cat "$runtime_file"; return; fi
  if [ -f "$tombstone_file" ]; then cat "$tombstone_file"; return; fi
  jq -n --arg repository "$repository" --argjson pr "$pr" '{repositoryFullName:$repository,pullRequestNumber:$pr,state:"absent"}'
}

status_all_previews() {
  files=$(find "$STATE_ROOT" -mindepth 2 -maxdepth 2 -type f \( -name runtime.json -o -name tombstone.json \) 2>/dev/null | sort)
  if [ -z "$files" ]; then printf '{"records":[]}\n'; return; fi
  # Registry files contain only the bounded public status contract, never runtime.env or controller secrets.
  jq -s '{records: map(select(.repositoryFullName == "DotNaos/project-space"))}' $files
}

reap_previews() {
  open_prs=$(printf '%s' "$request" | jq -cer '.openPullRequests | select(type == "array" and all(.[]; type == "number" and . == floor and . > 0)) | unique')
  ttl_hours=$(printf '%s' "$request" | jq -er '.ttlHours | select(type == "number" and . == floor and . >= 1 and . <= 720)')
  now=$(date +%s)
  removed='[]'
  for file in "$STATE_ROOT"/pr-*/runtime.json; do
    [ -f "$file" ] || continue
    candidate=$(jq -er '.pullRequestNumber | select(type == "number" and . == floor and . > 0)' "$file") || continue
    verified=$(jq -er '.verifiedAt' "$file" 2>/dev/null || true)
    verified_epoch=$(date -d "$verified" +%s 2>/dev/null || stat -c %Y "$file" 2>/dev/null || stat -f %m "$file")
    age_hours=$(( (now - verified_epoch) / 3600 ))
    is_open=$(printf '%s' "$open_prs" | jq -e --argjson pr "$candidate" 'index($pr) != null' >/dev/null && printf true || printf false)
    if [ "$is_open" = true ] && [ "$age_hours" -lt "$ttl_hours" ]; then continue; fi
    request=$(jq -n --arg repository "$PROJECT_REPOSITORY" --argjson pr "$candidate" --arg reason "reaper" \
      '{repository:$repository,prNumber:$pr,reason:$reason}')
    prepare_identity
    destroy_preview >/dev/null
    removed=$(printf '%s' "$removed" | jq --argjson pr "$candidate" '. + [$pr]')
  done
  jq -n --argjson removed "$removed" '{status:"complete",removedPullRequests:$removed}'
}

require_command jq
command_name=${1:-}
case "$command_name" in
  apply)
    require_command curl; require_command docker; require_command flock; require_command git; require_command openssl
    read_request; prepare_identity; apply_preview
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
  *) fail 'usage: preview-runner.sh apply|destroy|status|status-all|reap' 64;;
esac
