#!/bin/sh
# Runtime init for Price Alerts persistent volume.
# Runs as root briefly to fix volume ownership, then drops to nextjs.
set -eu

DATA_DIR="${PRICE_ALERTS_DATA_DIR:-/app/data/price-alerts}"
DATA_FILE="${PRICE_ALERTS_DATA_FILE:-${DATA_DIR}/price-alerts.json}"
APP_USER="${APP_USER:-nextjs}"
APP_GROUP="${APP_GROUP:-nodejs}"

log() {
  echo "[entrypoint] $*"
}

fail() {
  echo "[entrypoint] FATAL: $*" >&2
  exit 1
}

if [ "$(id -u)" -eq 0 ]; then
  log "preparing alert data directory: ${DATA_DIR}"
  mkdir -p "${DATA_DIR}" || fail "cannot create ${DATA_DIR}"

  # Named volumes often mount as root:root; fix ownership for the app user.
  chown -R "${APP_USER}:${APP_GROUP}" "${DATA_DIR}" || fail "chown failed for ${DATA_DIR}"
  chmod 775 "${DATA_DIR}" || true

  # Verify writable as the application user (do not leave app running as root).
  if ! su-exec "${APP_USER}" sh -c "test -w '${DATA_DIR}' && touch '${DATA_DIR}/.write-check' && rm -f '${DATA_DIR}/.write-check'"; then
    fail "data directory is not writable by ${APP_USER}: ${DATA_DIR}"
  fi

  # Ensure parent path for configured data file is the mounted volume.
  case "${DATA_FILE}" in
    "${DATA_DIR}"/*) ;;
    *) log "WARN: PRICE_ALERTS_DATA_FILE is outside DATA_DIR; ensure it is also mounted" ;;
  esac

  if [ "${PRICE_ALERTS_STORAGE:-}" = "file" ]; then
    log "PRICE_ALERTS_STORAGE=file (persistent volume backend; single-writer only)"
  fi

  log "dropping privileges to ${APP_USER} and starting app"
  exec su-exec "${APP_USER}" "$@"
fi

# Already non-root — still require a writable data dir when file mode is selected.
if [ "${PRICE_ALERTS_STORAGE:-}" = "file" ]; then
  mkdir -p "${DATA_DIR}" 2>/dev/null || true
  if ! test -w "${DATA_DIR}"; then
    fail "data directory is not writable: ${DATA_DIR}"
  fi
fi

exec "$@"
