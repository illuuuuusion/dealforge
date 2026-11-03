#!/usr/bin/env bash
# Deploys a git revision on the server (DF-605), called by the CI deploy job or by hand:
# backup -> build -> migration dry run -> start (API applies migrations) -> readiness check. Any failing step stops the release.
# Rollback: scripts/deploy.sh <previous revision>. Migrations only add; if one must be undone, restore the backup taken
# by this script (scripts/restore.sh) and deploy the previous revision.
set -euo pipefail
# Everything runs inside main: git checkout replaces this file while bash may still be reading it.
main() {
  cd "$(dirname "$0")/.."
  local rev="${1:?Usage: scripts/deploy.sh <git revision>}" previous
  previous="$(git rev-parse --short HEAD)"
  git fetch --quiet origin
  git checkout --quiet --detach "$rev"
  echo "Deploying $(git rev-parse --short HEAD) (was $previous)"
  scripts/backup.sh
  docker compose build
  docker compose run --rm --no-deps api node packages/db/dist/cli.js migrate --dry-run
  docker compose --profile proxy up -d --wait --remove-orphans
  for _ in $(seq 30); do
    if docker compose exec -T api wget -qO- http://127.0.0.1:3000/api/v1/health/ready; then echo; echo "Deployed $rev"; return 0; fi
    sleep 2
  done
  echo "Not ready after 60 s. Roll back: scripts/deploy.sh $previous" >&2
  return 1
}
main "$@"
