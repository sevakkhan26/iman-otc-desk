# Ubuntu production deployment (PostgreSQL)

**Do not run these on production until you explicitly approve.** This document is a runbook only.

## 1. Prerequisites

- Existing Docker Compose stack (`docker-compose.yml`) for `iman-otc-desk`
- Overlay: `docker-compose.postgres.yml`
- Secrets via host env / `.env` (never Git)

## 2. Bring up Postgres (safe defaults)

```bash
cd /path/to/dealing-desk-otc-dashboard

# Generate app password; store only on the server
export POSTGRES_PASSWORD='…'
export POSTGRES_DB=otc_desk
export POSTGRES_USER=otc_app
export DATABASE_POOL_MAX=10

# Start Postgres only first (named volume otc-postgres-data)
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d otc-postgres

# Wait healthy
docker compose -f docker-compose.yml -f docker-compose.postgres.yml ps
```

- Volume: `otc-postgres-data` (persistent)
- Healthcheck: `pg_isready`
- Port: `127.0.0.1:5432` only (not public)

## 3. Migrate before app restart

```bash
export DATABASE_URL="postgres://otc_app:${POSTGRES_PASSWORD}@127.0.0.1:5432/otc_desk"

# From a one-off container or host with Node:
pnpm db:migrate
pnpm db:import:dry   # review counts
pnpm db:import       # idempotent
```

Verify logins against PostgreSQL (admin + viewer) before removing old JSON volume mounts from runtime.

## 4. Point the app at Postgres and restart

```bash
export DATABASE_URL="postgres://otc_app:${POSTGRES_PASSWORD}@otc-postgres:5432/otc_desk"

docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d --build iman-otc-desk
```

## 5. Obsolete env (report only — do not auto-delete)

After verification, these are unused by runtime:

- `UPSTASH_REDIS_REST_*`
- `MARKET_SNAPSHOT_*`
- `PRICE_ALERTS_STORAGE` / `PRICE_ALERTS_DATA_*`
- `TETHER_API_KEYS_STORAGE` / `TETHER_API_KEYS_DATA_*`
- `VIEWER_AUTH_DATA_FILE` / `DESK_USERS_DATA_FILE`

Keep the `iman-otc-alerts-data` volume until you confirm import completeness.

## 6. Least-privilege role

Prefer a dedicated login role with DML only (no DROP). See `deploy/postgres/init-app-role.sql`.

## 7. Never

- `docker compose down -v` (destroys volumes)
- Automatic `DROP TABLE` / `TRUNCATE` in app code
- Expose `5432` on `0.0.0.0`
