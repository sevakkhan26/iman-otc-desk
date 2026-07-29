#!/usr/bin/env bash
# Pre-migration backup for the OTC desk production PostgreSQL database.
#
# Run on the Ubuntu host, from the repository directory, BEFORE deploying a
# migration:
#
#   bash scripts/backup-production-db.sh
#
# What it does (read-only against the database):
#   1. custom-format dump  (pg_dump -Fc)  → restorable with pg_restore
#   2. plain schema-only dump             → easy diffing
#   3. per-table row counts before the migration
#   4. verifies the dump is readable (pg_restore --list)
#   5. prints the exact restore command
#
# It never writes to the database, never drops anything, and never deletes an
# existing backup.
set -euo pipefail

CONTAINER="${OTC_PG_CONTAINER:-otc-postgres}"
DB_NAME="${POSTGRES_DB:-otc_desk}"
DB_USER="${POSTGRES_USER:-otc_app}"
OUT_DIR="${OTC_BACKUP_DIR:-backups}"
STAMP="$(date -u +%Y%m%d-%H%M%SZ)"
PREFIX="${OUT_DIR}/otc_desk-${STAMP}"

log() { printf '[backup %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
die() { printf '[backup] ERROR: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker not found on PATH"

if ! docker ps --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
  die "container '${CONTAINER}' is not running. Start PostgreSQL first:
  docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d otc-postgres"
fi

mkdir -p "${OUT_DIR}"

log "container=${CONTAINER} db=${DB_NAME} user=${DB_USER}"
log "readiness check"
docker exec "${CONTAINER}" pg_isready -U "${DB_USER}" -d "${DB_NAME}" >/dev/null \
  || die "database is not accepting connections"

log "1/5 custom-format dump → ${PREFIX}.dump"
docker exec "${CONTAINER}" pg_dump -U "${DB_USER}" -d "${DB_NAME}" -Fc --no-owner --no-privileges \
  > "${PREFIX}.dump"
[ -s "${PREFIX}.dump" ] || die "dump is empty — aborting"

log "2/5 schema-only dump → ${PREFIX}.schema.sql"
docker exec "${CONTAINER}" pg_dump -U "${DB_USER}" -d "${DB_NAME}" --schema-only --no-owner \
  > "${PREFIX}.schema.sql"

log "3/5 row counts → ${PREFIX}.rowcounts.txt"
docker exec -i "${CONTAINER}" psql -U "${DB_USER}" -d "${DB_NAME}" -At -F$'\t' <<'SQL' \
  > "${PREFIX}.rowcounts.txt"
SELECT
  c.relname,
  (SELECT count(*) FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
  (SELECT n_live_tup FROM pg_stat_user_tables s WHERE s.relid = c.oid) AS approx_rows
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND n.nspname = 'public'
ORDER BY c.relname;
SQL

log "4/5 verifying the dump is readable"
docker exec -i "${CONTAINER}" pg_restore --list < "${PREFIX}.dump" > "${PREFIX}.toc.txt" \
  || die "pg_restore could not read the dump — DO NOT DEPLOY"
TOC_LINES="$(wc -l < "${PREFIX}.toc.txt" | tr -d ' ')"
[ "${TOC_LINES}" -gt 5 ] || die "dump table of contents looks empty — DO NOT DEPLOY"

log "5/5 done"
printf '\n'
log "files:"
ls -lh "${PREFIX}".* | sed 's/^/    /'
printf '\n'
log "table row counts (before migration):"
sed 's/^/    /' "${PREFIX}.rowcounts.txt"
printf '\n'
log "restore command if you ever need it:"
cat <<EOF
    docker exec -i ${CONTAINER} pg_restore -U ${DB_USER} -d ${DB_NAME} \\
      --clean --if-exists < ${PREFIX}.dump
EOF
printf '\n'
log "backup complete — safe to deploy the additive Shadow migrations"
