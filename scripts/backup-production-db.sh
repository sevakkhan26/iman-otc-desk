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
#   4. verifies the dump is readable (pg_restore --list) and checksums it
#   5. publishes the backup atomically and prints the exact restore command
#
# It never writes to the database, never drops anything, and never deletes or
# overwrites an existing backup.
#
# Hardening (v7A.2):
#   * the dump is written to a .partial file and renamed only after every
#     verification passes, so a crashed run can never leave a file that looks
#     like a complete backup;
#   * a SHA-256 checksum is written next to each artefact;
#   * the timestamp is checked for collision and the run aborts rather than
#     overwrite anything;
#   * tracing is disabled and no credential is ever echoed.
set -euo pipefail
# Never trace: a traced pg_dump line can leak a connection string.
set +x
umask 077

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

# Never overwrite: if this exact stamp already exists, stop rather than clobber.
for existing in "${PREFIX}".*; do
  [ -e "${existing}" ] && die "backup artefact already exists: ${existing} — refusing to overwrite"
done

# Atomic publication: everything is written here and renamed only on success.
PARTIAL="${PREFIX}.dump.partial"
cleanup_partial() {
  # A failed run leaves nothing that could be mistaken for a good backup.
  [ -e "${PARTIAL}" ] && rm -f "${PARTIAL}"
}
trap cleanup_partial EXIT

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    echo "unavailable"
  fi
}

log "container=${CONTAINER} db=${DB_NAME} user=${DB_USER}"
log "readiness check"
docker exec "${CONTAINER}" pg_isready -U "${DB_USER}" -d "${DB_NAME}" >/dev/null \
  || die "database is not accepting connections"

log "1/6 custom-format dump → ${PARTIAL}"
docker exec "${CONTAINER}" pg_dump -U "${DB_USER}" -d "${DB_NAME}" -Fc --no-owner --no-privileges \
  > "${PARTIAL}"
[ -s "${PARTIAL}" ] || die "dump is empty — aborting"

log "2/6 schema-only dump → ${PREFIX}.schema.sql"
docker exec "${CONTAINER}" pg_dump -U "${DB_USER}" -d "${DB_NAME}" --schema-only --no-owner \
  > "${PREFIX}.schema.sql"

log "3/6 row counts → ${PREFIX}.rowcounts.txt"
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

log "4/6 verifying the dump is readable"
docker exec -i "${CONTAINER}" pg_restore --list < "${PARTIAL}" > "${PREFIX}.toc.txt" \
  || die "pg_restore could not read the dump — DO NOT DEPLOY"
TOC_LINES="$(wc -l < "${PREFIX}.toc.txt" | tr -d ' ')"
[ "${TOC_LINES}" -gt 5 ] || die "dump table of contents looks empty — DO NOT DEPLOY"

log "5/6 publishing atomically and checksumming"
# Only now does a file named like a finished backup appear.
mv "${PARTIAL}" "${PREFIX}.dump"
trap - EXIT
DUMP_SHA="$(sha256_of "${PREFIX}.dump")"
printf '%s  %s\n' "${DUMP_SHA}" "$(basename "${PREFIX}.dump")" > "${PREFIX}.dump.sha256"
cat > "${PREFIX}.meta.json" <<META
{
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "database": "${DB_NAME}",
  "format": "pg_dump -Fc",
  "bytes": $(wc -c < "${PREFIX}.dump" | tr -d ' '),
  "sha256": "${DUMP_SHA}",
  "tocEntries": ${TOC_LINES},
  "verified": true
}
META

log "6/6 done"
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
log "checksum: ${DUMP_SHA}"
log "verify later with: shasum -a 256 -c ${PREFIX}.dump.sha256"
log "restore DRILL (isolated, never touches production):"
log "  bash scripts/restore-drill.sh ${PREFIX}.dump"
log "backup complete — safe to deploy the additive Shadow migrations"
