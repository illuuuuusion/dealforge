#!/usr/bin/env bash
# Restore test (DF-604): restores a backup into an empty, separate compose project, proves the data is identical
# to the dump, starts API and worker on it and checks readiness. The project is removed afterwards.
# Usage: scripts/restore-test.sh [backup.dump]   (default: newest daily backup; uses SECRETS_KEY etc. from .env)
set -euo pipefail
cd "$(dirname "$0")/.."
dumps=(backups/daily/dealforge-*.dump)  # UTC timestamps in the name: the last one is the newest
file="${1:-${dumps[-1]}}"
[ -r "$file" ] || { echo "No backup found; run scripts/backup.sh first" >&2; exit 1; }
export COMPOSE_PROJECT_NAME=dealforge-restore-test API_PORT=3901 POSTGRES_PORT=55901 REDIS_PORT=56901
# Never poll providers from the copy.
export ENABLE_SCHEDULER=false APPROVED_PROVIDERS='' DEMO_MODE=false
export APP_PASSWORD="${APP_PASSWORD:-restore-test-password-$RANDOM$RANDOM}"
trap 'docker compose down -v --remove-orphans > /dev/null 2>&1' EXIT
docker compose down -v --remove-orphans > /dev/null 2>&1 || true
docker compose up -d --wait postgres redis
scripts/restore.sh --yes "$file"
# Data only, without comments and per-run \restrict keys: the dump and the restored database must match row for row.
# Each line is tagged with its table and sorted, because a new dump may order the tables differently.
data() { grep -v -e '^--' -e '^\\restrict' -e '^\\unrestrict' -e '^$' | awk '/^COPY /{t=$2} {print t "\t" $0} $0 == "\\." {t=""}' | LC_ALL=C sort; }
want="$(docker compose exec -T postgres pg_restore --data-only -f - < "$file" | data | sha256sum)"
got="$(docker compose exec -T postgres pg_dump -U dealforge -d dealforge --data-only | data | sha256sum)"
[ "$want" = "$got" ] || { echo "FAIL: restored data differs from the dump" >&2; exit 1; }
echo "Data identical to the dump."
docker compose exec -T postgres psql -U dealforge -d dealforge -Atc \
  "SELECT relname || ': ' || n_live_tup FROM pg_stat_user_tables WHERE relname IN ('listings', 'listing_snapshots', 'watchlists', 'alerts', 'repair_projects') ORDER BY 1"
docker compose up -d --wait api worker
for _ in $(seq 30); do
  if docker compose exec -T api wget -qO- http://127.0.0.1:3000/api/v1/health/ready 2>/dev/null; then echo; echo "OK: restore of $file works, app is ready."; exit 0; fi
  sleep 2
done
echo "FAIL: app did not become ready on the restored database" >&2
docker compose logs --tail 30 api worker >&2
exit 1
