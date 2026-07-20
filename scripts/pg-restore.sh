#!/usr/bin/env bash
# =============================================================================
# Restore a portable OTC PostgreSQL dump onto local or a new PC.
#
# Prerequisites:
#   - Postgres running as Docker container (default name: otc-postgres)
#   - Empty or disposable database (default: otc_desk)
#   - Same major Postgres version recommended (16.x)
#
# Usage:
#   ./scripts/pg-restore.sh ./backups/postgres/otc_desk_YYYYMMDD.dump
#
# Env (optional):
#   CONTAINER=otc-postgres
#   PGUSER=otc_app
#   PGDATABASE=otc_desk
#   DROP_EXISTING=1   # drop & recreate public schema objects via --clean
#
# After restore, point the app at the DB:
#   DATABASE_URL=postgres://otc_app:PASSWORD@127.0.0.1:5432/otc_desk
# =============================================================================
set -euo pipefail

CONTAINER="${CONTAINER:-otc-postgres}"
PGUSER="${PGUSER:-otc_app}"
PGDATABASE="${PGDATABASE:-otc_desk}"
DROP_EXISTING="${DROP_EXISTING:-1}"

DUMP="${1:-}"
if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "[pg-restore] Usage: $0 /path/to/otc_desk_*.dump" >&2
  exit 1
fi

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "[pg-restore] ERROR: container '$CONTAINER' not running.
  Start Postgres first, e.g.:
    export POSTGRES_PASSWORD=secret
    docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d otc-postgres
" >&2
  exit 1
fi

echo "[pg-restore] restoring $DUMP → $CONTAINER/$PGDATABASE"
# Copy into container (pg_restore reads from file more reliably than stdin for -Fc)
REMOTE="/tmp/otc_restore_$$.dump"
docker cp "$DUMP" "${CONTAINER}:${REMOTE}"

RESTORE_FLAGS=(-U "$PGUSER" -d "$PGDATABASE" --no-owner --no-acl)
if [ "$DROP_EXISTING" = "1" ]; then
  RESTORE_FLAGS+=(--clean --if-exists)
fi

docker exec "$CONTAINER" pg_restore "${RESTORE_FLAGS[@]}" "$REMOTE" || {
  # pg_restore returns non-zero on some benign notices; verify connectivity
  echo "[pg-restore] pg_restore exit non-zero — verifying tables…"
}
docker exec "$CONTAINER" rm -f "$REMOTE"

echo "[pg-restore] tables in public schema:"
docker exec "$CONTAINER" psql -U "$PGUSER" -d "$PGDATABASE" -c \
  "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1;"

echo "[pg-restore] app_settings keys:"
docker exec "$CONTAINER" psql -U "$PGUSER" -d "$PGDATABASE" -c \
  "SELECT key FROM app_settings ORDER BY 1;" 2>/dev/null || true

echo "[pg-restore] OK — set DATABASE_URL and start the app"
echo "  DATABASE_URL=postgres://${PGUSER}:PASSWORD@127.0.0.1:5432/${PGDATABASE}"
