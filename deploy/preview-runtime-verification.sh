#!/bin/sh

verify_tls_identity() {
  openssl s_client \
    -connect "$domain:443" \
    -servername "$domain" \
    -verify_hostname "$domain" \
    -verify_return_error </dev/null >/dev/null 2>&1
}

verify_runtime() {
  sha=$1
  verification_secret=$(sed -n 's/^PROJECT_SPACE_PREVIEW_VERIFICATION_SECRET=//p' "$env_file")
  for service in gateway web docs prototype db; do
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
      prototype) expected_image=$(sed -n 's/^PREVIEW_PROTOTYPE_IMAGE=//p' "$env_file");;
      *) expected_image=;;
    esac
    [ -z "$expected_image" ] || [ "$(docker inspect --format '{{.Config.Image}}' "$container")" = "$expected_image" ] || return 1
  done
  verify_tls_identity || return 1
  meta=$(curl --fail --silent --show-error --max-time 20 "https://$domain/api/app/meta") || return 1
  printf '%s' "$meta" | jq -e \
    --arg repository "$repository" \
    --argjson pr "$pr" \
    --arg sha "$sha" \
    '.commit == $sha and
      .preview.state == "verified" and
      .preview.identity.repositoryFullName == $repository and
      .preview.identity.pullRequestNumber == $pr and
      .preview.identity.headSha == $sha' >/dev/null || return 1
  gateway_container=$(compose ps -q gateway)
  [ -n "$gateway_container" ] || return 1
  prototype_meta=$(docker exec "$gateway_container" node --input-type=module -e '
    const response = await fetch("http://preview-prototype:8080/prototype/meta.json");
    if (!response.ok) process.exit(1);
    process.stdout.write(await response.text());
  ') || return 1
  [ "$(printf '%s' "$prototype_meta" | jq -er '.commit')" = "$sha" ] || return 1
  printf '%s' "$prototype_meta" |
    jq -e '.surfaces == ["mobile-prototype","desktop-prototype"]' >/dev/null || return 1
  curl --fail --silent --show-error --max-time 20 -H "x-project-space-preview-verification: $verification_secret" --output /dev/null \
    "https://$domain/prototype/desktop/?scenario=ready&viewport=desktop" || return 1
  curl --fail --silent --show-error --max-time 20 -H "x-project-space-preview-verification: $verification_secret" --output /dev/null \
    "https://$domain/prototype/mobile/?scenario=populated&viewport=phone" || return 1
  health=$(curl --fail --silent --show-error --max-time 20 "https://$domain/api/health") || return 1
  printf '%s' "$health" | jq -e '.ok == true' >/dev/null || return 1
  session_status=$(curl --silent --show-error --max-time 20 -H "x-project-space-preview-verification: $verification_secret" --output /dev/null --write-out '%{http_code}' "https://$domain/api/auth/session") || return 1
  [ "$session_status" = 401 ] || return 1
  curl --fail --silent --show-error --max-time 20 -H "x-project-space-preview-verification: $verification_secret" --output /dev/null "https://$domain/" || return 1
  docs_headers=$(curl --fail --silent --show-error --max-time 20 \
    --dump-header - --output /dev/null \
    -H "x-project-space-preview-verification: $verification_secret" \
    "https://$domain/docs/changelog?pr=$pr") || return 1
  printf '%s\n' "$docs_headers" | tr -d '\r' |
    grep -Eiq '^x-project-space-preview-docs-source:[[:space:]]*exact-pr-source$' || return 1
}

verify_runtime_with_retry() {
  sha=$1
  attempt=1
  max_attempts=12
  while ! verify_runtime "$sha"; do
    [ "$attempt" -lt "$max_attempts" ] || return 1
    attempt=$((attempt + 1))
    sleep 5
  done
}
