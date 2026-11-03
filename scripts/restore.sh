#!/usr/bin/env bash
# Restores a backup from scripts/backup.sh into the stack's database (DF-604). REPLACES ALL DATA of that stack.
# Usage: scripts/restore.sh [--yes] backups/daily/dealforge-<time>.dump
# Another stack: COMPOSE_PROJECT_NAME=... (see scripts/restore-test.sh). Afterwards: docker compose up -d
set -euo pipefail
cd "$(dirname "$0")/.."
yes=false
if [ "${1:-}" = --yes ]; then yes=true; shift; fi
file="${1:?Usage: scripts/restore.sh [--yes] <backup.dump>}"
[ -r "$file" ] || { echo "Cannot read $file" >&2; exit 1; }
project="${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}"
if ! $yes; then
  read -r -p "Replace ALL data of compose project '$project' with $file? Type 'restore': " answer
  [ "$answer" = restore ] || { echo "Aborted."; exit 1; }
fi
docker compose stop api worker 2>/dev/null || true
docker compose up -d --wait postgres
docker compose exec -T postgres dropdb -U dealforge --if-exists --force dealforge
docker compose exec -T postgres createdb -U dealforge dealforge
docker compose exec -T postgres pg_restore -U dealforge -d dealforge --no-owner --exit-on-error < "$file"
echo "Restored $file into '$project'. Start the app: docker compose up -d"
