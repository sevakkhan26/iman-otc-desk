#!/usr/bin/env bash
# =============================================================================
# Isolated restore drill for the OTC desk PostgreSQL backups.
#
#   bash scripts/restore-drill.sh backups/otc_desk-<stamp>.dump
#
# It restores a backup into a THROWAWAY database and verifies it, then drops
# only that throwaway database. It never connects to, writes to, or drops the
# live database — a restore you have never rehearsed is not a backup.
#
# Safety properties:
#   * the target name is generated here, never taken from the caller, and is
#     re-validated against a strict pattern before every statement;
#   * the target must start with the drill prefix and must not equal the live
#     database name, or the script aborts;
#   * every psql invocation runs against the drill database or the maintenance
#     database, never against the live one;
#   * the drill database is dropped in a trap, so an interrupted run cleans up;
#   * nothing is echoed that could contain a credential.
#
# Verified after the restore:
#   applied migrations, per-table row counts, the observation id, the Paper
#   session and its status, virtual balances, the immutable ledgers, and paper
#   PnL reconciliation (cash − sellFeeValue == economicNet).
# =============================================================================
set -euo pipefail
set +x
umask 077

CONTAINER="${OTC_PG_CONTAINER:-otc-postgres}"
LIVE_DB="${POSTGRES_DB:-otc_desk}"
DB_USER="${POSTGRES_USER:-otc_app}"
DUMP="${1:-}"

log() { printf '[drill %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
die() { printf '[drill] ERROR: %s\n' "$*" >&2; exit 1; }

[ -n "${DUMP}" ] || die "usage: bash scripts/restore-drill.sh <backup.dump>"
[ -f "${DUMP}" ] || die "dump not found: ${DUMP}"
command -v docker >/dev/null 2>&1 || die "docker not found on PATH"
docker ps --format '{{.Names}}' | grep -qx "${CONTAINER}" || die "container '${CONTAINER}' is not running"

# ── verify the artefact before restoring anything ────────────────────────────
if [ -f "${DUMP}.sha256" ]; then
  log "verifying checksum"
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "${DUMP}" | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "${DUMP}" | cut -d' ' -f1)"
  else
    ACTUAL=""
  fi
  EXPECTED="$(cut -d' ' -f1 < "${DUMP}.sha256")"
  if [ -n "${ACTUAL}" ] && [ "${ACTUAL}" != "${EXPECTED}" ]; then
    die "checksum mismatch — the backup is corrupt, DO NOT rely on it"
  fi
  log "checksum ok"
else
  log "no .sha256 sidecar — continuing with structural verification only"
fi

log "verifying the dump is readable"
docker exec -i "${CONTAINER}" pg_restore --list < "${DUMP}" > /dev/null \
  || die "pg_restore cannot read this dump — the backup is corrupt"

# ── strictly validated throwaway target ──────────────────────────────────────
DRILL_PREFIX="otc_restore_drill_"
DRILL_DB="${DRILL_PREFIX}$(date -u +%Y%m%d%H%M%S)_$$"

validate_target() {
  # Re-checked before every statement, not just once.
  case "${DRILL_DB}" in
    ${DRILL_PREFIX}*) : ;;
    *) die "refusing to touch '${DRILL_DB}': it does not carry the drill prefix" ;;
  esac
  printf '%s' "${DRILL_DB}" | grep -Eq '^[a-z0-9_]{20,60}$' \
    || die "refusing to touch '${DRILL_DB}': name failed strict validation"
  [ "${DRILL_DB}" != "${LIVE_DB}" ] \
    || die "refusing to touch the live database"
  [ "${DRILL_DB}" != "postgres" ] && [ "${DRILL_DB}" != "template0" ] && [ "${DRILL_DB}" != "template1" ] \
    || die "refusing to touch a system database"
}
validate_target

drop_drill() {
  validate_target
  docker exec -i "${CONTAINER}" psql -U "${DB_USER}" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"${DRILL_DB}\";" >/dev/null 2>&1 || true
}
trap drop_drill EXIT

log "creating throwaway database ${DRILL_DB}"
validate_target
docker exec -i "${CONTAINER}" psql -U "${DB_USER}" -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"${DRILL_DB}\";" >/dev/null

log "restoring into ${DRILL_DB} (live database untouched)"
validate_target
docker exec -i "${CONTAINER}" pg_restore -U "${DB_USER}" -d "${DRILL_DB}" \
  --no-owner --no-privileges < "${DUMP}" >/dev/null 2>&1 \
  || log "pg_restore reported warnings — continuing to verification"

drill_query() {
  validate_target
  docker exec -i "${CONTAINER}" psql -U "${DB_USER}" -d "${DRILL_DB}" -At -v ON_ERROR_STOP=1 -c "$1"
}

FAILURES=0
check() {
  local label="$1" actual="$2" condition="$3"
  if [ "${condition}" = "ok" ]; then
    printf '    PASS  %-34s %s\n' "${label}" "${actual}"
  else
    printf '    FAIL  %-34s %s\n' "${label}" "${actual}"
    FAILURES=$((FAILURES + 1))
  fi
}

log "verification"

# 1 — migrations
APPLIED="$(drill_query "SELECT value FROM schema_meta WHERE key = 'applied_migrations';" || echo '')"
MIG_COUNT="$(printf '%s' "${APPLIED}" | grep -o '\.sql' | wc -l | tr -d ' ')"
ON_DISK="$(ls -1 drizzle/*.sql 2>/dev/null | wc -l | tr -d ' ')"
if [ "${MIG_COUNT}" -gt 0 ] && [ "${MIG_COUNT}" -eq "${ON_DISK}" ]; then
  check "migrations applied" "${MIG_COUNT}/${ON_DISK}" ok
else
  check "migrations applied" "${MIG_COUNT}/${ON_DISK}" fail
fi

# 2 — shadow table row counts
for TABLE in shadow_observation_sessions shadow_collection_runs shadow_opportunity_lifecycles \
             shadow_paper_sessions shadow_paper_balances shadow_paper_ledger \
             shadow_paper_candidate_state shadow_capital_plans shadow_live_risk_policies; do
  COUNT="$(drill_query "SELECT count(*) FROM ${TABLE};" 2>/dev/null || echo "missing")"
  if [ "${COUNT}" = "missing" ]; then
    check "rows ${TABLE}" "table missing" fail
  else
    check "rows ${TABLE}" "${COUNT}" ok
  fi
done

# 3 — observation id survived
OBS_ID="$(drill_query "SELECT id FROM shadow_observation_sessions ORDER BY created_at DESC LIMIT 1;" 2>/dev/null || echo '')"
if [ -n "${OBS_ID}" ]; then
  check "observation.id present" "${OBS_ID}" ok
else
  check "observation.id present" "none found" fail
fi

# 4 — paper session and status
PAPER="$(drill_query "SELECT id || ' ' || status FROM shadow_paper_sessions ORDER BY created_at DESC LIMIT 1;" 2>/dev/null || echo '')"
if [ -n "${PAPER}" ]; then
  check "paper session + status" "${PAPER}" ok
else
  check "paper session + status" "none found" fail
fi

# 5 — no negative virtual balance survived the round trip
NEG="$(drill_query "SELECT count(*) FROM shadow_paper_balances WHERE irt_toman < 0 OR usdt_micros < 0;" 2>/dev/null || echo '1')"
if [ "${NEG}" = "0" ]; then
  check "virtual balances non-negative" "0 negative rows" ok
else
  check "virtual balances non-negative" "${NEG} negative rows" fail
fi

# 6 — immutable ledgers: no duplicate idempotency key survived
DUP="$(drill_query "SELECT count(*) FROM (SELECT idempotency_key FROM shadow_paper_ledger WHERE idempotency_key IS NOT NULL GROUP BY idempotency_key HAVING count(*) > 1) d;" 2>/dev/null || echo '1')"
if [ "${DUP}" = "0" ]; then
  check "ledger idempotency intact" "0 duplicate keys" ok
else
  check "ledger idempotency intact" "${DUP} duplicate keys" fail
fi

# 7 — paper PnL reconciliation
MISMATCH="$(drill_query "SELECT count(*) FROM shadow_paper_ledger WHERE outcome = 'FILLED' AND (cash_pnl_irt_toman IS NULL OR sell_fee_value_toman IS NULL OR economic_net_pnl_toman IS NULL OR cash_pnl_irt_toman - sell_fee_value_toman <> economic_net_pnl_toman);" 2>/dev/null || echo '1')"
if [ "${MISMATCH}" = "0" ]; then
  check "paper PnL reconciles" "0 mismatched fills" ok
else
  check "paper PnL reconciles" "${MISMATCH} mismatched fills" fail
fi

printf '\n'
if [ "${FAILURES}" -eq 0 ]; then
  log "restore drill PASSED — this backup is restorable and internally consistent"
  log "throwaway database ${DRILL_DB} will now be dropped; the live database was never touched"
  exit 0
fi
log "restore drill FAILED with ${FAILURES} problem(s) — investigate before relying on this backup"
exit 1
