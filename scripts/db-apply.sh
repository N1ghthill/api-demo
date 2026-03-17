#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

source "$ROOT_DIR/scripts/load-env.sh" "$ROOT_DIR"

if command -v docker >/dev/null 2>&1 \
  && docker compose ps --services --status running 2>/dev/null | grep -q "^db$"; then
  echo "Applying migrations from db/init via docker compose..."
  docker compose exec -T db sh -c '
    set -e
    for file in /docker-entrypoint-initdb.d/*.sql; do
      [ -f "$file" ] || continue
      echo "-> $file"
      psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f "$file"
    done
  '
  echo "Done."
  exit 0
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not configured and docker compose db is not running."
  echo "Start Postgres with: docker compose up -d db"
  echo "Or export DATABASE_URL and ensure 'psql' is installed locally."
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required to apply migrations against DATABASE_URL."
  exit 1
fi

echo "Applying migrations from db/init via DATABASE_URL..."
for file in "$ROOT_DIR"/db/init/*.sql; do
  [ -f "$file" ] || continue
  echo "-> $file"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$file"
done

echo "Done."
