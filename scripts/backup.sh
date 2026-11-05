#!/usr/bin/env bash
# Back up Vita's metadata database (connections, queries, datasets, charts, dashboards,
# users) to a dated file with pg_dump (custom format).
#
#   scripts/backup.sh                                   # dev stack  -> backups/
#   scripts/backup.sh -f docker-compose.prod.yml        # prod stack -> backups/
#   scripts/backup.sh -f docker-compose.prod.yml /mnt/backups
#
# IMPORTANT: also keep VITA_SECRET_KEY (from .env) somewhere safe. Saved connection
# passwords in the backup are encrypted with it; without the same key they can't be
# decrypted after a restore.
set -euo pipefail
cd "$(dirname "$0")/.."

compose=(docker compose)
if [[ "${1:-}" == "-f" ]]; then
  compose+=(-f "$2")
  shift 2
fi
out_dir="${1:-backups}"
mkdir -p "$out_dir"
file="$out_dir/vita-$(date +%Y%m%d-%H%M%S).dump"

"${compose[@]}" exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  >"$file.partial"
mv "$file.partial" "$file"

echo "Backup written to $file ($(du -h "$file" | cut -f1))."
echo "Keep VITA_SECRET_KEY from .env safe as well: saved connection passwords need it."
