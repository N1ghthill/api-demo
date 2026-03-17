#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

source "$ROOT_DIR/scripts/load-env.sh" "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required for db:setup."
  echo "Use npm run db:apply with DATABASE_URL + psql for a non-Docker flow."
  exit 1
fi

echo "Starting Postgres (docker compose)..."
docker compose up -d db

echo "Waiting for Postgres to be ready..."
for i in {1..30}; do
  if docker compose exec -T db pg_isready -U "${POSTGRES_USER:-demo}" -d "${POSTGRES_DB:-enrollment_demo}" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! docker compose exec -T db pg_isready -U "${POSTGRES_USER:-demo}" -d "${POSTGRES_DB:-enrollment_demo}" >/dev/null 2>&1; then
  echo "Postgres did not become ready in time."
  exit 1
fi

"$ROOT_DIR/scripts/db-apply.sh"
