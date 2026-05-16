#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

set -a
[ -f .env.local ] && source .env.local
[ -f .env.op ] && source .env.op
set +a

exec "$@"
