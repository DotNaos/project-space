package main

import (
	"fmt"
	"sort"
	"strings"
)

func deploySteps(project deployProject, options deployOptions) []string {
	remotePath := shellQuote(project.RemotePath)
	return []string{
		"set -e; docker --version; docker compose version; docker info >/dev/null",
		"set -e; docker network inspect traefik-public >/dev/null",
		fmt.Sprintf("set -e; sudo -n mkdir -p %s; sudo -n chown $(id -u):$(id -g) %s", remotePath, remotePath),
		fmt.Sprintf("set -e; if [ -d %s/.git ]; then cd %s && git fetch origin %s && git reset --hard origin/%s; else git clone --branch %s %s %s; fi", remotePath, remotePath, shellQuote(project.Branch), shellQuote(project.Branch), shellQuote(project.Branch), shellQuote(project.RemoteURL), remotePath),
		composeUpStep(project, options),
		composeStatusStep(project, options),
	}
}

func composeUpStep(project deployProject, options deployOptions) string {
	return strings.Join([]string{
		"set -e",
		"cd " + shellQuote(project.RemotePath),
		deployEnvFileWriteScript(project, options, false),
		fmt.Sprintf(
			"docker compose --env-file .env -p %s -f deploy/compose.yml -f deploy/ingress.labels.yml up -d --build",
			shellQuote(project.ComposeProject),
		),
	}, "\n")
}

func composeStatusStep(project deployProject, options deployOptions) string {
	return fmt.Sprintf("set -e; cd %s; docker compose --env-file .env -p %s -f deploy/compose.yml -f deploy/ingress.labels.yml ps", shellQuote(project.RemotePath), shellQuote(project.ComposeProject))
}

func deployStatusEnv(project deployProject, options deployOptions) string {
	parts := []string{
		"PROJECT_ENV=" + shellQuote(project.Environment),
		"PROJECT_COMPOSE_NAME=" + shellQuote(project.ComposeProject),
		"PROJECT_DOMAIN=" + shellQuote(options.ProjectDomain),
		"PROJECT_API_DOMAIN=" + shellQuote(options.APIDomain),
	}
	if options.AcmeEmail != "" {
		parts = append(parts, "TRAEFIK_ACME_EMAIL="+shellQuote(options.AcmeEmail))
	}
	return strings.Join(parts, " ")
}

func deployEnvFileContent(project deployProject, options deployOptions, includeSecretValues bool) string {
	secretValue := func(secret deploySecretValue) string {
		if includeSecretValues {
			return dotenvLiteral(secret.Value)
		}
		return secretSourceLabel(secret.Source)
	}

	lines := []string{
		"PROJECT_ENV=" + project.Environment,
		"PROJECT_COMPOSE_NAME=" + project.ComposeProject,
		"PROJECT_DOMAIN=" + options.ProjectDomain,
		"PROJECT_API_DOMAIN=" + options.APIDomain,
		"PROJECT_SPACE_BUILD_NAME=" + project.Name,
		"PROJECT_SPACE_BUILD_VERSION=" + project.BuildVersion,
		"PROJECT_SPACE_BUILD_COMMIT=" + project.BuildCommit,
		"PROJECT_SPACE_BUILD_REF=" + project.BuildRef,
		"PROJECT_SPACE_BUILD_TIME=" + project.BuildTime,
	}
	if options.AcmeEmail != "" {
		lines = append(lines, "TRAEFIK_ACME_EMAIL="+options.AcmeEmail)
	}
	names := make([]string, 0, len(options.Secrets))
	for name := range options.Secrets {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		lines = append(lines, name+"="+secretValue(options.Secrets[name]))
	}
	return strings.Join(lines, "\n")
}

func dotenvLiteral(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `'`, `\'`)
	return `'` + value + `'`
}

func deployEnvFileWriteScript(
	project deployProject,
	options deployOptions,
	includeSecretValues bool,
) string {
	return strings.Join([]string{
		"umask 077",
		`project_env_tmp="$(mktemp .env.tmp.XXXXXX)"`,
		`cleanup_project_env() { [ -z "$project_env_tmp" ] || rm -f -- "$project_env_tmp"; }`,
		"trap cleanup_project_env 0",
		`trap 'cleanup_project_env; exit 1' 1 2 15`,
		`cat > "$project_env_tmp" <<'PROJECT_SPACE_ENV'`,
		deployEnvFileContent(project, options, includeSecretValues),
		"PROJECT_SPACE_ENV",
		`chmod 600 "$project_env_tmp"`,
		`mv -f -- "$project_env_tmp" .env`,
		"project_env_tmp=",
		"trap - 1 2 15",
	}, "\n")
}

func secretSourceLabel(source string) string {
	if source == "" {
		return "<secret>"
	}
	return "<secret from " + source + ">"
}

func deployComposeScript(project deployProject, options deployOptions, up bool) string {
	command := fmt.Sprintf("docker compose --env-file .env -p %s -f deploy/compose.yml -f deploy/ingress.labels.yml ps", shellQuote(project.ComposeProject))
	if up {
		command = fmt.Sprintf("docker compose --env-file .env -p %s -f deploy/compose.yml -f deploy/ingress.labels.yml up -d --build", shellQuote(project.ComposeProject))
	}
	return strings.Join([]string{
		"set -e",
		"cd " + shellQuote(project.RemotePath),
		deployEnvFileWriteScript(project, options, true),
		command,
	}, "\n")
}

func runRemoteScript(host string, script string) (string, error) {
	return runCommand("", []byte(script), "ssh", host, "sh", "-s")
}

func deployTransactionPlan(project deployProject, options deployOptions) []string {
	lockPath := deployLockPath(project)
	return []string{
		"validate full commit " + project.BuildCommit + " against origin/" + project.Branch,
		"acquire shared lock " + lockPath,
		"revalidate origin/" + project.Branch + " under lock",
		"deploy exact commit and verify checkout, image, services, metadata, health, and live origin",
		"rollback to the last verified commit and verify it if deployment or health fails",
	}
}

func deployLockPath(project deployProject) string {
	return "/opt/platform/locks/" + project.Name + "-" + project.Environment + ".lock"
}

func deployStateDirectory(project deployProject) string {
	return "/opt/platform/state/" + project.Name + "-" + project.Environment
}

func deployTransactionScript(project deployProject, options deployOptions) string {
	return deployTransactionScriptForPaths(project, options, deployLockPath(project), deployStateDirectory(project))
}

func deployTransactionScriptForPaths(project deployProject, options deployOptions, lockPath string, stateDirectory string) string {
	lockSeconds := int(options.LockTimeout.Seconds())
	if lockSeconds < 1 {
		lockSeconds = 1
	}
	staticEnv := deployEnvStaticFileContent(project, options, true)
	return fmt.Sprintf(`set -u
event() { printf 'PROJECT_DEPLOY_EVENT|%%s|%%s|%%s\n' "$1" "$2" "${3:-}"; }
fail_state() { event state "$1" "${2:-}"; [ -z "${2:-}" ] || printf '%%s\n' "$2" >&2; exit "${3:-1}"; }

requested=%s
branch=%s
remote_url=%s
remote_path=%s
compose_project=%s
lock_path=%s
state_dir=%s
verified_file="$state_dir/verified.sha"
compatibility_dir="$state_dir/compat"
web_url=%s

event phase checking running
case "$requested" in (*[!0-9a-f]*|'') fail_state failed_before_deploy 'requested commit is not a lowercase hexadecimal SHA' 64;; esac
[ "${#requested}" -eq 40 ] || fail_state failed_before_deploy 'requested commit is not a full 40-character SHA' 64

sudo -n mkdir -p "$(dirname "$lock_path")" "$state_dir" "$(dirname "$remote_path")" || fail_state blocked 'cannot prepare deployment lock/state directories' 73
sudo -n touch "$lock_path" || fail_state blocked 'cannot prepare deployment lock file' 73
sudo -n chown "$(id -u):$(id -g)" "$lock_path" "$state_dir" || fail_state blocked 'cannot own deployment lock/state paths' 73
chmod 600 "$lock_path" || fail_state blocked 'cannot protect deployment lock file' 73
exec 9>>"$lock_path"
event phase lock running
if ! flock -w %d 9; then
  lock_holder="$(head -n 1 "$lock_path" 2>/dev/null || true)"
  fail_state blocked "production deployment lock timeout; holder=${lock_holder:-unknown}" 73
fi
event phase lock success
lock_owner="$(id -un)@$(hostname):$$"
lock_acquired_at="$(date -u +%%Y-%%m-%%dT%%H:%%M:%%SZ)"
: > "$lock_path"
printf '%%s|%%s\n' "$lock_owner" "$lock_acquired_at" >&9
event evidence lockOwner "$lock_owner"
event evidence lockAcquiredAt "$lock_acquired_at"

if [ ! -d "$remote_path/.git" ]; then
  git clone --no-checkout "$remote_url" "$remote_path" || fail_state failed_before_deploy 'cannot clone production repository' 70
fi
cd "$remote_path" || fail_state failed_before_deploy 'cannot enter production repository' 70
git fetch --prune origin "$branch" || fail_state failed_before_deploy 'cannot fetch production branch' 70
current_main="$(git rev-parse "refs/remotes/origin/$branch")" || fail_state failed_before_deploy 'cannot resolve fetched production branch' 70
event evidence mainHeadCommit "$current_main"
if [ "$current_main" != "$requested" ]; then fail_state superseded "requested $requested is superseded by $current_main" 75; fi
event phase checking success

compose() { docker compose --env-file .env -p "$compose_project" -f deploy/compose.yml -f deploy/ingress.labels.yml "$@"; }

persist_verified() {
  verified_commit="$1"
  verified_strict="$2"
  if [ "$verified_strict" = false ]; then
    mkdir -p "$compatibility_dir" || return 1
    compatibility_tmp="$(mktemp "$compatibility_dir/$verified_commit.tmp.XXXXXX")" || return 1
    printf 'compat\n' > "$compatibility_tmp" && chmod 600 "$compatibility_tmp" && mv -f "$compatibility_tmp" "$compatibility_dir/$verified_commit" || return 1
  fi
  verified_tmp="$(mktemp "$state_dir/verified.sha.tmp.XXXXXX")" || return 1
  printf '%%s\n' "$verified_commit" > "$verified_tmp" && chmod 600 "$verified_tmp" && mv -f "$verified_tmp" "$verified_file" || return 1
}

retry_public_get() {
  public_url="$1"
  public_attempt=1
  while [ "$public_attempt" -le 20 ]; do
    public_response="$(curl --fail --silent --max-time 20 "$public_url" 2>/dev/null)" && {
      printf '%%s' "$public_response"
      return 0
    }
    public_attempt=$((public_attempt + 1))
    sleep 2
  done
  return 1
}

write_env() {
  deploy_commit="$1"
  deploy_version="$(git show "$deploy_commit:package.json" | jq -er '.version')" || return 1
  project_env_tmp="$(mktemp .env.tmp.XXXXXX)" || return 1
  umask 077
  cat > "$project_env_tmp" <<'PROJECT_SPACE_ENV'
%s
PROJECT_SPACE_ENV
  if ! printf 'PROJECT_SPACE_BUILD_VERSION=%%s\nPROJECT_SPACE_BUILD_COMMIT=%%s\nPROJECT_SPACE_BUILD_TIME=%%s\n' \
    "$deploy_version" "$deploy_commit" "$(date -u +%%Y-%%m-%%dT%%H:%%M:%%SZ)" >> "$project_env_tmp" ||
    ! chmod 600 "$project_env_tmp" || ! mv -f -- "$project_env_tmp" .env; then
    rm -f -- "$project_env_tmp"
    return 1
  fi
  project_env_tmp=
}

verify_release() {
  verify_commit="$1"
  require_checkout="$2"
  strict_health="$3"
  if [ "$require_checkout" = true ]; then
    checkout_commit="$(git rev-parse HEAD)" || return 1
    [ "$checkout_commit" = "$verify_commit" ] || return 1
    event evidence remoteCheckoutCommit "$checkout_commit"
  fi
  for service in web docs db; do
    container_id="$(compose ps -q "$service")" || return 1
    [ -n "$container_id" ] || return 1
    service_state="$(docker inspect --format '{{.State.Status}}' "$container_id")" || return 1
    [ "$service_state" = running ] || return 1
    health_state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id")" || return 1
    if [ "$strict_health" = true ]; then
      [ "$health_state" = healthy ] || return 1
    elif [ -n "$health_state" ]; then
      [ "$health_state" = healthy ] || return 1
    fi
  done
  web_container="$(compose ps -q web)" || return 1
  running_commit="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$web_container" | sed -n 's/^PROJECT_SPACE_BUILD_COMMIT=//p' | tail -n 1)"
  [ "$running_commit" = "$verify_commit" ] || return 1
  image_id="$(docker inspect --format '{{.Image}}' "$web_container")" || return 1
  image_commit="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")" || return 1
  if [ "$strict_health" = true ]; then [ "$image_commit" = "$verify_commit" ] || return 1; fi
  docker exec "$web_container" bun -e "const r=await fetch('http://127.0.0.1:4173/api/health');const b=await r.json();if(!r.ok||b.ok!==true)process.exit(1)" >/dev/null || return 1
  meta="$(retry_public_get "$web_url/api/app/meta")" || return 1
  meta_commit="$(printf '%%s' "$meta" | jq -er '.commit')" || return 1
  [ "$meta_commit" = "$verify_commit" ] || return 1
  health="$(retry_public_get "$web_url/api/health")" || return 1
  printf '%%s' "$health" | jq -e '.ok == true' >/dev/null || return 1
  retry_public_get "$web_url/" >/dev/null || return 1
  event evidence runningBuildCommit "$running_commit"
  event evidence containerImageId "$image_id"
  event evidence composeHealthy true
  event evidence httpHealthy true
  event evidence liveOriginHealthy true
}

deploy_release() {
  deploy_commit="$1"
  git cat-file -e "$deploy_commit^{commit}" || return 1
  git reset --hard "$deploy_commit" || return 1
  git clean -fdx -e ssh/ || return 1
  write_env "$deploy_commit" || return 1
  compose up -d --build --wait --wait-timeout 240 || return 1
  event phase verify running
  verify_release "$deploy_commit" true true
}

restore_release() {
  restore_commit="$1"
  restore_strict="$2"
  git reset --hard "$restore_commit" &&
    git clean -fdx -e ssh/ &&
    write_env "$restore_commit" &&
    compose up -d --build --wait --wait-timeout 240 &&
    verify_release "$restore_commit" true "$restore_strict"
}

previous=""
previous_strict=true
if [ -f "$verified_file" ]; then previous="$(tr -d '\r\n' < "$verified_file")"; fi
if ! printf '%%s' "$previous" | grep -Eq '^[0-9a-f]{40}$'; then
  live_meta="$(curl --fail --silent --show-error --max-time 20 "$web_url/api/app/meta")" || fail_state failed_before_deploy 'cannot establish previous verified release' 70
  previous="$(printf '%%s' "$live_meta" | jq -er '.commit')" || fail_state failed_before_deploy 'running release has no commit metadata' 70
  printf '%%s' "$previous" | grep -Eq '^[0-9a-f]{40}$' || fail_state failed_before_deploy 'running release commit is invalid' 70
  git cat-file -e "$previous^{commit}" || fail_state failed_before_deploy 'running release commit cannot be fetched' 70
  git merge-base --is-ancestor "$previous" "refs/remotes/origin/$branch" || fail_state failed_before_deploy 'running release is not on production branch' 70
  verify_release "$previous" false false || fail_state failed_before_deploy 'running release is not fully verifiable' 70
  previous_strict=false
  persist_verified "$previous" false || fail_state failed_before_deploy 'cannot persist verified state' 70
else
  if [ -f "$compatibility_dir/$previous" ]; then previous_strict=false; fi
  git cat-file -e "$previous^{commit}" || fail_state failed_before_deploy 'recorded verified commit is unavailable' 70
  git merge-base --is-ancestor "$previous" "refs/remotes/origin/$branch" || fail_state failed_before_deploy 'recorded verified commit is not on production branch' 70
  if ! verify_release "$previous" false "$previous_strict"; then
    event evidence reset true
    event rollback status recovering_interrupted_deploy
    event rollback commit "$previous"
    restore_release "$previous" "$previous_strict" || fail_state rollback_failed 'cannot recover recorded release after an interrupted deployment' 71
    event rollback status rollback_succeeded
    event rollback verifiedCommit "$previous"
  fi
fi
event evidence previousVerifiedCommit "$previous"

mutation_started=false
transaction_complete=false
rollback_interrupted() {
  interrupted_status=$?
  trap - 0 1 2 15
  if [ "$mutation_started" = true ] && [ "$transaction_complete" = false ]; then
    event evidence reset true
    event rollback status running
    event rollback commit "$previous"
    if restore_release "$previous" "$previous_strict" && persist_verified "$previous" "$previous_strict"; then
      event rollback status rollback_succeeded
      event rollback verifiedCommit "$previous"
    else
      event rollback status rollback_failed
      event rollback error 'interrupted deployment rollback verification failed'
    fi
  fi
  exit "$interrupted_status"
}
trap rollback_interrupted 0 1 2 15

event evidence reset true
event phase deploy running
mutation_started=true
if deploy_release "$requested" && persist_verified "$requested" true; then
  transaction_complete=true
  trap - 0 1 2 15
  event phase deploy success
  event phase verify success
  event state success ''
  exit 0
fi

event phase deploy failed
event evidence reset true
event rollback status running
event rollback commit "$previous"
git cat-file -e "$previous^{commit}" || { event rollback status rollback_failed; fail_state rollback_failed 'cannot find rollback commit' 71; }
git merge-base --is-ancestor "$previous" "refs/remotes/origin/$branch" || { event rollback status rollback_failed; fail_state rollback_failed 'rollback commit is not on production branch' 71; }
if restore_release "$previous" "$previous_strict" && persist_verified "$previous" "$previous_strict"; then
  transaction_complete=true
  trap - 0 1 2 15
  event rollback status rollback_succeeded
  event rollback verifiedCommit "$previous"
  fail_state rollback_succeeded "deployment failed; restored verified commit $previous" 72
fi
transaction_complete=true
trap - 0 1 2 15
event rollback status rollback_failed
event rollback error 'rollback verification failed'
fail_state rollback_failed 'deployment and rollback verification failed' 71
`,
		shellQuote(project.BuildCommit),
		shellQuote(project.Branch),
		shellQuote(project.RemoteURL),
		shellQuote(project.RemotePath),
		shellQuote(project.ComposeProject),
		shellQuote(lockPath),
		shellQuote(stateDirectory),
		shellQuote(project.WebURL),
		lockSeconds,
		staticEnv,
	)
}

func deployEnvStaticFileContent(project deployProject, options deployOptions, includeSecretValues bool) string {
	copyProject := project
	copyProject.BuildCommit = ""
	copyProject.BuildTime = ""
	copyProject.BuildVersion = ""
	lines := strings.Split(deployEnvFileContent(copyProject, options, includeSecretValues), "\n")
	filtered := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.HasPrefix(line, "PROJECT_SPACE_BUILD_COMMIT=") ||
			strings.HasPrefix(line, "PROJECT_SPACE_BUILD_TIME=") ||
			strings.HasPrefix(line, "PROJECT_SPACE_BUILD_VERSION=") {
			continue
		}
		filtered = append(filtered, line)
	}
	return strings.Join(filtered, "\n")
}

func deployStatusEvidenceScript(project deployProject) string {
	return fmt.Sprintf(`set -u
event() { printf 'PROJECT_DEPLOY_EVENT|%%s|%%s|%%s\n' "$1" "$2" "${3:-}"; }
remote_path=%s
compose_project=%s
web_url=%s
[ -d "$remote_path/.git" ] || { event state unhealthy 'repository missing'; exit 0; }
cd "$remote_path" || { event state unhealthy 'repository unavailable'; exit 0; }
compose() { docker compose --env-file .env -p "$compose_project" -f deploy/compose.yml -f deploy/ingress.labels.yml "$@"; }
checkout_commit="$(git rev-parse HEAD 2>/dev/null || true)"
event evidence remoteCheckoutCommit "$checkout_commit"
compose_healthy=true
for service in web docs db; do
  container_id="$(compose ps -q "$service" 2>/dev/null || true)"
  if [ -z "$container_id" ]; then compose_healthy=false; continue; fi
  service_state="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
  health_state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
  [ "$service_state" = running ] && [ "$health_state" = healthy ] || compose_healthy=false
done
event evidence composeHealthy "$compose_healthy"
web_container="$(compose ps -q web 2>/dev/null || true)"
running_commit=""
image_id=""
image_commit=""
if [ -n "$web_container" ]; then
  running_commit="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$web_container" 2>/dev/null | sed -n 's/^PROJECT_SPACE_BUILD_COMMIT=//p' | tail -n 1)"
  image_id="$(docker inspect --format '{{.Image}}' "$web_container" 2>/dev/null || true)"
  [ -z "$image_id" ] || image_commit="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id" 2>/dev/null || true)"
fi
event evidence runningBuildCommit "$running_commit"
event evidence containerImageId "$image_id"
meta_commit="$(curl --fail --silent --show-error --max-time 20 "$web_url/api/app/meta" 2>/dev/null | jq -er '.commit' 2>/dev/null || true)"
http_healthy=false
health="$(curl --fail --silent --show-error --max-time 20 "$web_url/api/health" 2>/dev/null || true)"
if printf '%%s' "$health" | jq -e '.ok == true' >/dev/null 2>&1; then http_healthy=true; fi
event evidence httpHealthy "$http_healthy"
live_healthy=false
if curl --fail --silent --show-error --max-time 20 --output /dev/null "$web_url/"; then live_healthy=true; fi
event evidence liveOriginHealthy "$live_healthy"
if [ -n "$checkout_commit" ] && [ "$checkout_commit" = "$running_commit" ] && [ "$running_commit" = "$meta_commit" ] && [ "$image_commit" = "$running_commit" ] && [ "$compose_healthy" = true ] && [ "$http_healthy" = true ] && [ "$live_healthy" = true ]; then
  event state healthy ''
else
  event state unhealthy 'deployment evidence does not agree'
fi
`, shellQuote(project.RemotePath), shellQuote(project.ComposeProject), shellQuote(project.WebURL))
}
