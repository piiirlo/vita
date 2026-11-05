#!/usr/bin/env bash
# Restore Vita's metadata database from a backup made with scripts/backup.sh.
# This REPLACES all current Vita data. A safety backup of the current data is taken first.
#
#   scripts/restore.sh backups/vita-20261105-101500.dump
#   scripts/restore.sh -f docker-compose.prod.yml backups/vita-20261105-101500.dump
#   scripts/restore.sh --yes ...        # don't ask for confirmation
#
# The .env must have the same VITA_SECRET_KEY as when the backup was made, or saved
# connection passwords can't be decrypted (they would have to be re-entered).
set -euo pipefail
cd "$(dirname "$0")/.."

compose=(docker compose)
compose_file_args=()
assume_yes=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    -f) compose+=(-f "$2"); compose_file_args=(-f "$2"); shift 2 ;;
    -y | --yes) assume_yes=true; shift ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
file="${1:-}"
if [[ -z "$file" || ! -f "$file" ]]; then
  echo "Usage: scripts/restore.sh [-f compose-file] [--yes] <backup.dump>" >&2
  exit 2
fi

if [[ "$assume_yes" != true ]]; then
  read -r -p "This replaces ALL current Vita data with $file. Type 'restore' to continue: " answer
  [[ "$answer" == "restore" ]] || { echo "Cancelled."; exit 1; }
fi

"${compose[@]}" up -d --wait db

echo "Taking a safety backup of the current data first..."
scripts/backup.sh "${compose_file_args[@]}" backups/pre-restore

echo "Stopping the backend..."
"${compose[@]}" stop backend

echo "Restoring $file..."
# Start from an empty schema so tables added after the backup don't get in the way.
"${compose[@]}" exec -T db sh -c \
  'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"'
"${compose[@]}" exec -T db sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error --single-transaction' \
  <"$file"

echo "Starting the backend (it runs any newer migrations)..."
"${compose[@]}" start backend

echo "Restored $file. You may have to log in again."
