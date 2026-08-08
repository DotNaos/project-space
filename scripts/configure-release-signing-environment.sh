#!/usr/bin/env bash
set -euo pipefail

repository=${1:-${GITHUB_REPOSITORY:-}}
if [[ -z $repository ]]; then
  repository=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
fi
[[ $repository =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]

root=$(git rev-parse --show-toplevel)
configuration="$root/.github/environments/release-signing.json"

# PUT is idempotent. An empty reviewers list removes the interactive approval
# rule while the environment continues to be the only source of the signer token.
gh api --method PUT \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "repos/$repository/environments/release-signing" \
  --input "$configuration" >/dev/null

environment=$(gh api \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "repos/$repository/environments/release-signing")

jq -e '
  ([.protection_rules[]?.type] | index("required_reviewers") | not) and
  ([.protection_rules[]? | select(.type == "wait_timer") | .wait_timer] | all(. == 0)) and
  .deployment_branch_policy.protected_branches == true and
  .deployment_branch_policy.custom_branch_policies == false
' <<<"$environment" >/dev/null

printf 'release-signing is non-interactive and restricted to protected branches.\n'
