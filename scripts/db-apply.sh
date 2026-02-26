#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! docker compose ps --services --status running | grep -q "^db$"; then
  echo "Database container not running. Start with: docker compose up -d db"
  exit 1
fi

echo "Applying migrations from db/init..."
docker compose exec -T db sh -c '
  set -e
  for file in /docker-entrypoint-initdb.d/*.sql; do
    [ -f "$file" ] || continue
    echo "-> $file"
    psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f "$file"
  done
'

echo "Done."
