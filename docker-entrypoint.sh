#!/bin/sh
# Runtime init for iman-otc-desk (Ubuntu production).
# 1) Fix data volume ownership (legacy JSON cold backup)
# 2) ALWAYS apply PostgreSQL schema when DATABASE_URL is set (fail closed)
# 3) Import legacy JSON when AUTO_IMPORT_LEGACY=1 OR first boot (empty settings)
# 4) Start app as non-root
set -eu

DATA_DIR="${PRICE_ALERTS_DATA_DIR:-/app/data/price-alerts}"
DATA_FILE="${PRICE_ALERTS_DATA_FILE:-${DATA_DIR}/price-alerts.json}"
APP_USER="${APP_USER:-nextjs}"
APP_GROUP="${APP_GROUP:-nodejs}"
MIGRATE_SCRIPT="${MIGRATE_SCRIPT:-/app/scripts/run-migrations.mjs}"
IMPORT_DATA_SCRIPT="${IMPORT_DATA_SCRIPT:-/app/scripts/run-legacy-import-data.mjs}"

log() { echo "[entrypoint] $*"; }
fail() { echo "[entrypoint] FATAL: $*" >&2; exit 1; }

run_as_app() {
  if [ "$(id -u)" -eq 0 ]; then
    su-exec "${APP_USER}" "$@"
  else
    "$@"
  fi
}

# Redact password in postgres URL for logs: postgres://user:***@host:port/db
redact_db_url() {
  echo "$1" | sed -E 's#(postgres(ql)?://[^:/@]+:)[^@]+@#\1***@#'
}

# Extract host:port from DATABASE_URL (best-effort).
db_url_hostport() {
  echo "$1" | sed -E 's#^postgres(ql)?://[^@]+@([^/]+)/.*#\2#'
}

#
# Pin Postgres for Docker production.
#
# Prefer Unix socket (shared volume /var/run/postgresql) — avoids Docker Desktop
# bridge TCP flakiness (CONNECT_TIMEOUT → HTTP 503).
#
# Fallback: compose service DNS otc-postgres:5432 (never host.docker.internal).
#
# Controlled by:
#   OTC_FORCE_COMPOSE_DB=1
#   OTC_DB_SOCKET=/var/run/postgresql   → postgres://user:pass@/db?host=SOCKET
#   OTC_DB_HOST (default otc-postgres) + OTC_DB_PORT (default 5432) when no socket
#
pin_database_url_for_docker() {
  url="${DATABASE_URL:-}"
  force="${OTC_FORCE_COMPOSE_DB:-0}"
  socket="${OTC_DB_SOCKET:-}"
  host="${OTC_DB_HOST:-otc-postgres}"
  port="${OTC_DB_PORT:-5432}"
  user="${POSTGRES_USER:-otc_app}"
  pass="${POSTGRES_PASSWORD:-}"
  db="${POSTGRES_DB:-otc_desk}"

  need_pin=0
  if [ "$force" = "1" ] || [ "$force" = "true" ]; then
    need_pin=1
  elif [ -n "$url" ]; then
    case "$url" in
      *host.docker.internal*|*127.0.0.1:5433*|*localhost:5433*)
        need_pin=1
        log "WARN: DATABASE_URL uses host hairpin ($(db_url_hostport "$url")) — will re-pin"
        ;;
    esac
  fi

  if [ "$need_pin" != "1" ]; then
    return 0
  fi

  if [ -z "$pass" ]; then
    case "${url}" in
      *host.docker.internal*|*127.0.0.1:5433*|*localhost:5433*)
        fail "DATABASE_URL uses host hairpin but POSTGRES_PASSWORD is unset — cannot pin."
        ;;
    esac
    log "WARN: OTC_FORCE_COMPOSE_DB set but POSTGRES_PASSWORD empty — leaving DATABASE_URL as-is"
    return 0
  fi

  # Always pin a TCP URL that postgres.js URL parser accepts (migrator + older images).
  # When OTC_DB_SOCKET is set and the socket exists, leave it exported so the app
  # client (createPgSql) can open Unix-domain connections without Docker bridge TCP.
  export DATABASE_URL="postgres://${user}:${pass}@${host}:${port}/${db}"
  if [ -n "$socket" ]; then
    i=0
    while [ "$i" -lt 20 ]; do
      if [ -S "${socket}/.s.PGSQL.5432" ] || [ -S "${socket}/.s.PGSQL.${port}" ]; then
        break
      fi
      i=$((i + 1))
      sleep 1
    done
    if [ -S "${socket}/.s.PGSQL.5432" ] || [ -S "${socket}/.s.PGSQL.${port}" ]; then
      export OTC_DB_SOCKET="$socket"
      log "Unix socket ready at ${socket} (app client may use OTC_DB_SOCKET; migrator uses ${host}:${port})"
    else
      log "WARN: OTC_DB_SOCKET=${socket} set but socket missing — using ${host}:${port} only"
      unset OTC_DB_SOCKET || true
    fi
  fi
  log "DATABASE_URL pinned: $(redact_db_url "$DATABASE_URL")"
}

assert_database_url_safe() {
  url="${DATABASE_URL:-}"
  [ -n "$url" ] || return 0
  case "$url" in
    *host.docker.internal*|*127.0.0.1:5433*|*localhost:5433*)
      if [ "${ALLOW_UNSAFE_DB_HOST:-0}" = "1" ]; then
        log "WARN: allowing unsafe DATABASE_URL host (ALLOW_UNSAFE_DB_HOST=1): $(db_url_hostport "$url")"
        return 0
      fi
      fail "Refusing DATABASE_URL host $(db_url_hostport "$url"). Use @otc-postgres:5432 (compose network). Override only with ALLOW_UNSAFE_DB_HOST=1."
      ;;
  esac
}

run_db_bootstrap() {
  pin_database_url_for_docker
  assert_database_url_safe

  if [ -z "${DATABASE_URL:-}" ]; then
    log "FATAL-ish: DATABASE_URL is empty — durable APIs will return 503"
    log "Set DATABASE_URL=postgres://otc_app:***@otc-postgres:5432/otc_desk on the server"
    # Fail closed at process start so empty deploys are obvious in docker logs
    if [ "${ALLOW_START_WITHOUT_DB:-0}" != "1" ]; then
      fail "DATABASE_URL required (set ALLOW_START_WITHOUT_DB=1 only for emergency)"
    fi
    return 0
  fi

  log "DATABASE_URL host: $(db_url_hostport "$DATABASE_URL")"

  if [ "${SKIP_DB_MIGRATE:-0}" != "1" ]; then
    if [ -f "${MIGRATE_SCRIPT}" ]; then
      log "PostgreSQL schema migrate…"
      run_as_app node "${MIGRATE_SCRIPT}" || fail "migration failed — check DATABASE_URL and Postgres"
      log "migrate OK"
    else
      fail "missing ${MIGRATE_SCRIPT}"
    fi
  fi

  # Import policy:
  # - AUTO_IMPORT_LEGACY=1 → always try import (idempotent)
  # - AUTO_IMPORT_LEGACY=auto (default) → import only if desk_settings row missing
  IMPORT_MODE="${AUTO_IMPORT_LEGACY:-auto}"
  NEED_IMPORT=0
  if [ "${IMPORT_MODE}" = "1" ] || [ "${IMPORT_MODE}" = "true" ]; then
    NEED_IMPORT=1
    log "AUTO_IMPORT_LEGACY=1 — will import legacy JSON"
  elif [ "${IMPORT_MODE}" = "auto" ]; then
    # Probe: if settings empty, assume first cutover
    if run_as_app node -e "
      import postgres from 'postgres';
      const url=process.env.DATABASE_URL;
      const sql=postgres(url,{max:1,prepare:false,connect_timeout:10});
      try {
        const r=await sql\`select 1 from app_settings where key='desk_settings' limit 1\`;
        process.exit(r.length?0:2);
      } catch { process.exit(2); }
      finally { await sql.end({timeout:2}); }
    " 2>/dev/null; then
      NEED_IMPORT=0
      log "DB already has settings — skip auto import"
    else
      NEED_IMPORT=1
      log "DB looks empty — auto importing legacy JSON"
    fi
  else
    log "AUTO_IMPORT_LEGACY=${IMPORT_MODE} — skip import"
  fi

  if [ "${NEED_IMPORT}" = "1" ] && [ -f "${IMPORT_DATA_SCRIPT}" ]; then
    export LEGACY_DATA_DIR="${LEGACY_DATA_DIR:-${DATA_DIR}}"
    log "legacy import from LEGACY_DATA_DIR=${LEGACY_DATA_DIR}"
    # force flag so script runs even if AUTO_IMPORT_LEGACY=auto
    run_as_app env AUTO_IMPORT_LEGACY=1 node "${IMPORT_DATA_SCRIPT}" --force \
      || log "WARN: legacy import failed (app will still start; run production-pg-setup.sh)"
  fi
}

if [ "$(id -u)" -eq 0 ]; then
  log "preparing data dir ${DATA_DIR}"
  mkdir -p "${DATA_DIR}" || fail "cannot create ${DATA_DIR}"
  chown -R "${APP_USER}:${APP_GROUP}" "${DATA_DIR}" || fail "chown failed"
  chmod 775 "${DATA_DIR}" || true

  if ! su-exec "${APP_USER}" sh -c "test -w '${DATA_DIR}' && touch '${DATA_DIR}/.write-check' && rm -f '${DATA_DIR}/.write-check'"; then
    fail "data dir not writable by ${APP_USER}"
  fi

  if [ -d /app/scripts ]; then
    chown -R "${APP_USER}:${APP_GROUP}" /app/scripts /app/drizzle 2>/dev/null || true
  fi

  run_db_bootstrap

  log "start app as ${APP_USER}"
  exec su-exec "${APP_USER}" "$@"
fi

mkdir -p "${DATA_DIR}" 2>/dev/null || true
run_db_bootstrap
exec "$@"
