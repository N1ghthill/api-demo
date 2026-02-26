#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

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
