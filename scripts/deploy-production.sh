#!/usr/bin/env bash
# Safe production deploy for iman-otc-desk (Docker + named volume for alerts).
#
# Usage (from this repository root):
#   ./scripts/deploy-production.sh
#
# Or with an external compose root:
#   COMPOSE_DIR=/home/server/docker-projects ./scripts/deploy-production.sh
#
# Never uses: docker compose down -v | volume prune | git reset --hard | git clean

set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-iman-otc-desk}"
BRANCH="${DEPLOY_BRANCH:-main}"
REMOTE="${DEPLOY_REMOTE:-iman-otc}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_DIR="${COMPOSE_DIR:-${REPO_ROOT}}"
CONTEXT="${DOCKER_CONTEXT:-}"

log() { echo "[deploy] $*"; }
fail() { echo "[deploy] ERROR: $*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

require_cmd git
require_cmd docker

log "repo: ${REPO_ROOT}"
log "compose dir: ${COMPOSE_DIR}"

cd "${REPO_ROOT}"

# --- git fast-forward only ---
current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "${current_branch}" != "${BRANCH}" ]; then
  fail "expected branch ${BRANCH}, currently on ${current_branch}"
fi

log "fetching ${REMOTE}/${BRANCH}"
git fetch "${REMOTE}" "${BRANCH}"

LOCAL="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "${REMOTE}/${BRANCH}")"
if [ "${LOCAL}" != "${REMOTE_SHA}" ]; then
  log "fast-forward pull ${LOCAL:0:7} -> ${REMOTE_SHA:0:7}"
  git merge --ff-only "${REMOTE}/${BRANCH}" || fail "fast-forward pull failed (local commits or diverged history)"
else
  log "already up to date at ${LOCAL:0:7}"
fi

COMMIT_SHA="$(git rev-parse HEAD)"
export GIT_COMMIT_SHA="${COMMIT_SHA}"

# --- confirm non-secret Docker configuration is present ---
cd "${COMPOSE_DIR}"
if [ ! -f "docker-compose.yml" ] && [ ! -f "compose.yml" ]; then
  fail "no docker-compose.yml in ${COMPOSE_DIR}"
fi

COMPOSE_FILE="docker-compose.yml"
[ -f "${COMPOSE_FILE}" ] || COMPOSE_FILE="compose.yml"

if ! grep -q "iman-otc-alerts-data" "${COMPOSE_FILE}" 2>/dev/null \
  && ! grep -q "PRICE_ALERTS_STORAGE" "${COMPOSE_FILE}" 2>/dev/null; then
  # Allow using repo compose when COMPOSE_DIR is external without config
  if [ -f "${REPO_ROOT}/docker-compose.yml" ] && grep -q "iman-otc-alerts-data" "${REPO_ROOT}/docker-compose.yml"; then
    log "using repository docker-compose.yml for alerts volume config"
    COMPOSE_DIR="${REPO_ROOT}"
    cd "${COMPOSE_DIR}"
    COMPOSE_FILE="docker-compose.yml"
  else
    fail "compose file missing iman-otc-alerts-data / PRICE_ALERTS_STORAGE — see docs/DOCKER-DEPLOYMENT.md"
  fi
fi

if [ -n "${CONTEXT}" ]; then
  log "docker context use ${CONTEXT}"
  docker context use "${CONTEXT}"
fi

# --- PostgreSQL schema migrate before recreate (when DATABASE_URL is available) ---
if [ -n "${DATABASE_URL:-}" ] && [ "${SKIP_DB_MIGRATE:-0}" != "1" ]; then
  log "DATABASE_URL set — applying schema migrations before container recreate"
  if command -v pnpm >/dev/null 2>&1; then
    pnpm exec tsx src/db/migrate.ts || node scripts/run-migrations.mjs \
      || fail "database migration failed (fix DATABASE_URL / Postgres health)"
  else
    node scripts/run-migrations.mjs \
      || fail "database migration failed (fix DATABASE_URL / Postgres health)"
  fi
  log "schema migrations OK"
  if [ "${AUTO_IMPORT_LEGACY:-0}" = "1" ]; then
    log "AUTO_IMPORT_LEGACY=1 — importing legacy JSON before restart"
    if command -v pnpm >/dev/null 2>&1; then
      pnpm exec tsx scripts/import-legacy-to-postgres.mts --skip-migrate \
        || fail "legacy import failed"
    else
      log "WARN: pnpm/tsx missing — import will retry in container entrypoint if scripts present"
    fi
  fi
else
  log "DATABASE_URL unset or SKIP_DB_MIGRATE=1 — container entrypoint will migrate if DATABASE_URL is injected via compose"
fi

log "building and recreating service ${SERVICE_NAME} (volume preserved)"
# Never pass -v / --volumes — that would delete iman-otc-alerts-data.
docker compose -f "${COMPOSE_FILE}" up -d --build --force-recreate "${SERVICE_NAME}"

log "waiting for health"
deadline=$((SECONDS + 120))
healthy=0
while [ "${SECONDS}" -lt "${deadline}" ]; do
  status="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${SERVICE_NAME}" 2>/dev/null || echo missing)"
  log "container status: ${status}"
  if [ "${status}" = "healthy" ] || [ "${status}" = "running" ]; then
    # Prefer healthy when healthcheck exists
    if [ "${status}" = "healthy" ]; then
      healthy=1
      break
    fi
    # running without health: give start_period then accept
    sleep 5
    status2="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}running{{end}}' "${SERVICE_NAME}" 2>/dev/null || echo missing)"
    if [ "${status2}" = "healthy" ] || [ "${status2}" = "running" ]; then
      healthy=1
      break
    fi
  fi
  sleep 3
done

if [ "${healthy}" -ne 1 ]; then
  docker compose -f "${COMPOSE_FILE}" ps "${SERVICE_NAME}" || true
  docker logs --tail 80 "${SERVICE_NAME}" 2>&1 || true
  fail "service did not become healthy in time"
fi

log "container ok; verifying volume mount"
mounts="$(docker inspect --format='{{range .Mounts}}{{.Name}} -> {{.Destination}}{{println}}{{end}}' "${SERVICE_NAME}" 2>/dev/null || true)"
echo "${mounts}" | grep -q "price-alerts" || log "WARN: could not confirm price-alerts mount in inspect output"
echo "${mounts}" || true

# Safe diagnostics: storage env inside container (no secrets)
log "in-container storage env:"
docker exec "${SERVICE_NAME}" sh -c 'echo PRICE_ALERTS_STORAGE=$PRICE_ALERTS_STORAGE; echo PRICE_ALERTS_DATA_DIR=$PRICE_ALERTS_DATA_DIR' 2>/dev/null || true

# Writable probe as app user path
docker exec "${SERVICE_NAME}" sh -c 'test -w "${PRICE_ALERTS_DATA_DIR:-/app/data/price-alerts}" && echo data_dir_writable=yes' \
  || fail "data directory not writable inside container"

# Volume must still exist
if docker volume inspect iman-otc-alerts-data >/dev/null 2>&1; then
  log "volume iman-otc-alerts-data present"
else
  log "WARN: named volume iman-otc-alerts-data not found by that exact name (check compose project prefix)"
fi

log "deploy complete"
log "commit: ${COMMIT_SHA}"
log "service: ${SERVICE_NAME}"
log "do NOT run: docker compose down -v"
