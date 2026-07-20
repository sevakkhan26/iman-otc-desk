# Production PostgreSQL setup (Ubuntu)

One-shot path to **install schema** and **transfer existing JSON data** into PostgreSQL.

Production URL: `http://price-monitoring.blumarkets.com/dashboard`

## Automated CI/CD (v3.2.1+)

On every container start (docker entrypoint):

1. If `DATABASE_URL` is set → run `scripts/run-migrations.mjs` (schema only, idempotent)
2. If `AUTO_IMPORT_LEGACY=1` → try one-shot JSON import (set **once** on first cutover)

Also `scripts/deploy-production.sh` runs migrate **before** recreate when `DATABASE_URL` is exported on the host.

**Server `.env` / compose env (never Git):**

```env
DATABASE_URL=postgres://otc_app:SECRET@otc-postgres:5432/otc_desk
DATABASE_POOL_MAX=10
# first boot only:
AUTO_IMPORT_LEGACY=1
```

After first successful import, set `AUTO_IMPORT_LEGACY=0` (or remove).

## Prerequisites

1. PostgreSQL running (host install **or** `docker-compose.postgres.yml`).
2. App secrets already on the server (`ADMIN_*`, `VIEWER_*`, `AUTH_TOKEN_SECRET`, HMAC secret for API keys).
3. Git repo checked out (same tree the server pulls on deploy).
4. **Do not** put `DATABASE_URL` password in Git.

## Recommended order

```bash
cd /path/to/dealing-desk-otc-dashboard   # production git clone

# --- secrets (server env only) ---
export DATABASE_URL='postgres://otc_app:STRONG_PASSWORD@127.0.0.1:5432/otc_desk'
export DATABASE_POOL_MAX=10

# Where old JSON lives (Docker named volume often):
#   docker volume inspect iman-otc-alerts-data
export LEGACY_DATA_DIR='/var/lib/docker/volumes/iman-otc-alerts-data/_data'
# Also search repo .data if present:
# export LEGACY_DATA_DIRS="$LEGACY_DATA_DIR:/path/to/repo/.data"

# 1) Dry-run: see counts, no data mutation (schema migrate still runs — additive)
./scripts/production-pg-setup.sh --dry-run

# 2) Real: create tables + import
./scripts/production-pg-setup.sh

# 3) Point the app at Postgres and restart
# In compose / systemd env:
#   DATABASE_URL=postgres://otc_app:…@otc-postgres:5432/otc_desk
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d --build iman-otc-desk
```

## Package shortcuts

```bash
pnpm db:migrate                 # schema only
pnpm db:import:dry              # dry import
pnpm db:import                  # real import
pnpm db:production-setup        # full shell wrapper
pnpm db:production-setup:dry
```

## What is imported

| Source file | Target |
|-------------|--------|
| `settings.json` | `app_settings` |
| `tether-api-keys.json` | `api_keys` + scopes |
| `desk-users.json` | `users` |
| `viewer-auth.json` | `app_settings.viewer_auth_override` |
| `price-alerts.json` | `price_alerts` + notifications |
| `market-snapshot.json` | `market_snapshots` (+ quotes/health) |
| `median-history.json` | `median_history_samples` |
| `impact-news-store.json` | `news_items` |

- **Never deletes** source files  
- **Idempotent** (second run skips existing keys/hashes)  
- Report: `.data/migration-report-*.json`

## Safety

- No `DROP` / `TRUNCATE` of production tables  
- No automatic volume delete (`docker compose down -v` is forbidden)  
- API key hashes migrate only if still 64-char hex HMAC (same secret required)

## Verify after restart

1. http://price-monitoring.blumarkets.com/dashboard loads  
2. Admin + viewer login  
3. API keys still authenticate  
4. Alerts visible  
5. Prices not empty / not permanent 500  

## Rollback

Restore previous app image/tag **and** keep old JSON volume.  
Database restore: see `docs/DATABASE-BACKUP.md` (`pg_dump` / `pg_restore`).
