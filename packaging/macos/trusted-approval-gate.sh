#!/bin/sh
set -eu

: "${TRUSTED_PROJECT_SHA256:?runner must pin TRUSTED_PROJECT_SHA256}"
: "${TRUST_ROOT_SHA256:?runner must pin TRUST_ROOT_SHA256}"
: "${APPROVAL_REPOSITORY_ROOT:?runner must set APPROVAL_REPOSITORY_ROOT}"

project_bin=/opt/project-trust/bin/project
trust_root=/etc/project-trust/approval.json
checkpoint=/etc/project-trust/approval.checkpoint.json

verify_hash() {
  expected=$1
  path=$2
  actual=$(/usr/bin/shasum -a 256 "$path" | /usr/bin/awk '{print $1}')
  [ "$actual" = "$expected" ] || { echo "trusted approval artifact hash mismatch" >&2; exit 1; }
}

verify_hash "$TRUSTED_PROJECT_SHA256" "$project_bin"
verify_hash "$TRUST_ROOT_SHA256" "$trust_root"

exec "$project_bin" approval verify \
  --root "$APPROVAL_REPOSITORY_ROOT" \
  --policy .project/approvals/policy.yaml \
	--trust-root "$trust_root" \
	--checkpoint "$checkpoint" \
	--format json
