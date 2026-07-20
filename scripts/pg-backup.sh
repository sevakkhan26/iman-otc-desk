#!/usr/bin/env bash
# =============================================================================
# Logical backup of OTC PostgreSQL (independent of the Next.js app container).
#
# Works on production Ubuntu (Docker) or local Compose.
# Output is a portable pg_dump custom-format file (.dump) you can copy to
# another PC and restore with scripts/pg-restore.sh.
#
# Usage:
#   ./scripts/pg-backup.sh
#   ./scripts/pg-backup.sh /path/to/backups
#   CONTAINER=otc-postgres PGUSER=otc_app PGDATABASE=otc_desk ./scripts/pg-backup.sh
#
# Env (optional):
#   CONTAINER   docker container name (default: otc-postgres)
#   PGUSER      (default: otc_app)
#   PGDATABASE  (default: otc_desk)
#   BACKUP_DIR  default output directory if no arg given
# =============================================================================
set -euo pipefail

CONTAINER="${CONTAINER:-otc-postgres}"
PGUSER="${PGUSER:-otc_app}"
PGDATABASE="${PGDATABASE:-otc_desk}"
BACKUP_DIR="${1:-${BACKUP_DIR:-./backups/postgres}}"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "[pg-backup] ERROR: container '$CONTAINER' not found or not running" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR%/}/otc_desk_${STAMP}.dump"

echo "[pg-backup] dumping $PGDATABASE from $CONTAINER → $OUT"
docker exec -t "$CONTAINER" pg_dump -U "$PGUSER" -d "$PGDATABASE" -Fc --no-owner --no-acl >"$OUT"

# sidecar metadata (no password)
cat >"${OUT}.meta.json" <<EOF
{
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "database": "$PGDATABASE",
  "user": "$PGUSER",
  "container": "$CONTAINER",
  "format": "pg_dump -Fc",
  "bytes": $(wc -c <"$OUT" | tr -d ' '),
  "hostname": "$(hostname 2>/dev/null || echo unknown)"
}
EOF

echo "[pg-backup] OK"
ls -lh "$OUT" "${OUT}.meta.json"
echo "[pg-backup] Copy this file to another machine, then:"
echo "  ./scripts/pg-restore.sh $OUT"
