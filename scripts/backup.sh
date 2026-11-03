#!/usr/bin/env bash
# PostgreSQL backup of the compose stack (DF-604): one custom-format dump per run, checked with pg_restore --list.
# Retention: daily dumps 7 days, the Sunday dump additionally 30 days in weekly/. Redis is not backed up: it only holds
# queued jobs and scheduler state, which the worker recreates. Restoring needs the SECRETS_KEY active at backup time.
# Daily on a host: 15 3 * * * cd /opt/dealforge && scripts/backup.sh >> backups/backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
dir="${BACKUP_DIR:-backups}"
mkdir -p "$dir/daily" "$dir/weekly"
name="dealforge-$(date -u +%Y%m%dT%H%M%SZ).dump"
tmp="$dir/daily/.$name.partial"
trap 'rm -f "$tmp"' EXIT
docker compose exec -T postgres pg_dump -U dealforge -d dealforge -Fc > "$tmp"
# A dump pg_restore cannot read is no backup.
docker compose exec -T postgres pg_restore --list < "$tmp" > /dev/null
mv "$tmp" "$dir/daily/$name"
if [ "$(date -u +%u)" = 7 ]; then cp "$dir/daily/$name" "$dir/weekly/$name"; fi
find "$dir/daily" -name 'dealforge-*.dump' -mtime +$(( ${KEEP_DAILY_DAYS:-7} - 1 )) -delete
find "$dir/weekly" -name 'dealforge-*.dump' -mtime +$(( ${KEEP_WEEKLY_DAYS:-30} - 1 )) -delete
echo "$dir/daily/$name"
