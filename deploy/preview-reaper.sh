reap_previews() {
  open_prs=$(printf '%s' "$request" | jq -cer '.openPullRequests | select(type == "array" and all(.[]; type == "number" and . == floor and . > 0)) | unique')
  printf '%s' "$request" | jq -e '.ttlHours | select(type == "number" and . == floor and . >= 1 and . <= 720)' >/dev/null
  now=$(date +%s)
  removed='[]'
  for file in "$STATE_ROOT"/pr-*/runtime.json; do
    [ -f "$file" ] || continue
    candidate=$(jq -er '.pullRequestNumber | select(type == "number" and . == floor and . > 0)' "$file") || continue
    is_open=$(printf '%s' "$open_prs" | jq -e --argjson pr "$candidate" 'index($pr) != null' >/dev/null && printf true || printf false)
    if [ "$is_open" = true ]; then
      state=$(jq -er '.state' "$file" 2>/dev/null || true)
      if [ "$state" = online ]; then
        lease=$(jq -er '.activityLeaseExpiresAt // empty' "$file" 2>/dev/null || true)
        [ -n "$lease" ] || continue
        lease_epoch=$(date -d "$lease" +%s 2>/dev/null || true)
        [ -n "$lease_epoch" ] && [ "$lease_epoch" -le "$now" ] || continue
        request=$(jq -n --arg repository "$PROJECT_REPOSITORY" --argjson pr "$candidate" \
          --arg requestedHeadSha "$(jq -er '.requestedSha' "$file")" \
          '{repository:$repository,prNumber:$pr,requestedHeadSha:$requestedHeadSha}')
        prepare_identity
        stop_preview >/dev/null
      fi
      # Ready and failed records remain reproducible registry state until the PR closes.
      continue
    fi
    request=$(jq -n --arg repository "$PROJECT_REPOSITORY" --argjson pr "$candidate" --arg reason "reaper" \
      '{repository:$repository,prNumber:$pr,reason:$reason}')
    prepare_identity
    destroy_preview >/dev/null
    removed=$(printf '%s' "$removed" | jq --argjson pr "$candidate" '. + [$pr]')
  done
  jq -n --argjson removed "$removed" '{status:"complete",removedPullRequests:$removed}'
}
