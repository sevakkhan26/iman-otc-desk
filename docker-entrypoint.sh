#!/bin/sh
# Runtime init for iman-otc-desk.
# 1) Fix data volume ownership (legacy JSON volume kept as cold backup)
# 2) Auto-apply PostgreSQL schema migrations when DATABASE_URL is set
# 3) Optional one-shot legacy import when AUTO_IMPORT_LEGACY=1
# 4) Drop privileges and start the app
set -eu

DATA_DIR="${PRICE_ALERTS_DATA_DIR:-/app/data/price-alerts}"
DATA_FILE="${PRICE_ALERTS_DATA_FILE:-${DATA_DIR}/price-alerts.json}"
APP_USER="${APP_USER:-nextjs}"
APP_GROUP="${APP_GROUP:-nodejs}"
MIGRATE_SCRIPT="${MIGRATE_SCRIPT:-/app/scripts/run-migrations.mjs}"
IMPORT_SCRIPT="${IMPORT_SCRIPT:-/app/scripts/run-legacy-import.mjs}"

log() {
  echo "[entrypoint] $*"
}

fail() {
  echo "[entrypoint] FATAL: $*" >&2
  exit 1
}

run_db_bootstrap() {
  # Schema migrate is mandatory when DATABASE_URL is set (fail closed).
  if [ -n "${DATABASE_URL:-}" ] && [ "${SKIP_DB_MIGRATE:-0}" != "1" ]; then
    if [ -f "${MIGRATE_SCRIPT}" ]; then
      log "running PostgreSQL migrations…"
      # Prefer app user if we are root
      if [ "$(id -u)" -eq 0 ]; then
        su-exec "${APP_USER}" node "${MIGRATE_SCRIPT}" || fail "database migration failed"
      else
        node "${MIGRATE_SCRIPT}" || fail "database migration failed"
      fi
      log "migrations OK"
    else
      log "WARN: migrate script missing at ${MIGRATE_SCRIPT}"
    fi
  else
    if [ -z "${DATABASE_URL:-}" ]; then
      log "WARN: DATABASE_URL unset — app will fail closed on durable reads"
    else
      log "SKIP_DB_MIGRATE=1 — not applying schema"
    fi
  fi

  # One-shot JSON import (optional)
  if [ "${AUTO_IMPORT_LEGACY:-0}" = "1" ] || [ "${RUN_LEGACY_IMPORT:-0}" = "1" ]; then
    if [ -f "${IMPORT_SCRIPT}" ]; then
      log "AUTO_IMPORT_LEGACY enabled — importing legacy JSON…"
      if [ "$(id -u)" -eq 0 ]; then
        su-exec "${APP_USER}" node "${IMPORT_SCRIPT}" || fail "legacy import failed"
      else
        node "${IMPORT_SCRIPT}" || fail "legacy import failed"
      fi
    fi
  fi
}

if [ "$(id -u)" -eq 0 ]; then
  log "preparing data directory: ${DATA_DIR}"
  mkdir -p "${DATA_DIR}" || fail "cannot create ${DATA_DIR}"

  chown -R "${APP_USER}:${APP_GROUP}" "${DATA_DIR}" || fail "chown failed for ${DATA_DIR}"
  chmod 775 "${DATA_DIR}" || true

  if ! su-exec "${APP_USER}" sh -c "test -w '${DATA_DIR}' && touch '${DATA_DIR}/.write-check' && rm -f '${DATA_DIR}/.write-check'"; then
    fail "data directory is not writable by ${APP_USER}: ${DATA_DIR}"
  fi

  case "${DATA_FILE}" in
    "${DATA_DIR}"/*) ;;
    *) log "WARN: PRICE_ALERTS_DATA_FILE is outside DATA_DIR; ensure it is also mounted" ;;
  esac

  # Ensure migrate scripts are readable by app user
  if [ -d /app/scripts ]; then
    chown -R "${APP_USER}:${APP_GROUP}" /app/scripts /app/drizzle 2>/dev/null || true
  fi

  run_db_bootstrap

  log "dropping privileges to ${APP_USER} and starting app"
  exec su-exec "${APP_USER}" "$@"
fi

# Already non-root
if [ -d "${DATA_DIR}" ]; then
  mkdir -p "${DATA_DIR}" 2>/dev/null || true
fi

run_db_bootstrap

exec "$@"
