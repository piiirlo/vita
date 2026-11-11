#!/usr/bin/env bash
# Back up Vita's metadata database (connections, queries, datasets, charts, dashboards,
# users) to a dated file with pg_dump (custom format), and the tables of uploaded files (the
# Uploads database) to <name>.uploads.dump next to it.
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
# The Uploads database (uploaded files' tables): VITA_UPLOADS_DB from .env, else vita_uploads.
uploads_db="$(sed -n 's/^VITA_UPLOADS_DB=//p' .env 2>/dev/null | tail -n 1 | tr -d '\r" ')"
uploads_db="${uploads_db:-vita_uploads}"

"${compose[@]}" exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  >"$file.partial"
mv "$file.partial" "$file"

uploads_file="${file%.dump}.uploads.dump"
if "${compose[@]}" exec -T -e UPLOADS_DB="$uploads_db" db sh -c \
  'psql -U "$POSTGRES_USER" -d "$UPLOADS_DB" -qc "" >/dev/null 2>&1'; then
  # Only the uploads schema, without owners / grants: the backend sets them at startup.
  "${compose[@]}" exec -T -e UPLOADS_DB="$uploads_db" db sh -c \
    'pg_dump -U "$POSTGRES_USER" -d "$UPLOADS_DB" --schema=uploads --no-owner --no-acl --format=custom' \
    >"$uploads_file.partial"
  mv "$uploads_file.partial" "$uploads_file"
  echo "Uploaded files' tables written to $uploads_file ($(du -h "$uploads_file" | cut -f1))."
else
  echo "No Uploads database ($uploads_db) yet: nothing uploaded to back up."
fi

echo "Backup written to $file ($(du -h "$file" | cut -f1))."
echo "Keep VITA_SECRET_KEY from .env safe as well: saved connection passwords need it."
