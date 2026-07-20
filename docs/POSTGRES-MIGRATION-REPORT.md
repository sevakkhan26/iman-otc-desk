# PostgreSQL migration — final report

**Date:** 2026-07-20  
**Branch:** `main` (local uncommitted work)  
**Production Ubuntu server:** **not modified**  
**Git commit/push:** **not performed** (awaiting your approval)

---

## Root-cause inventory (old persistence paths)

| Domain | Old path | New path |
|--------|----------|----------|
| Desk settings | `.data/settings.json` | `app_settings` (`desk_settings`) |
| API keys + scopes + rate limits | `.data/tether-api-keys.json` or Upstash | `api_keys`, `api_key_scopes`, `api_rate_limit_buckets` |
| Market snapshot | `.data/market-snapshot.json` / Upstash / memory | `market_snapshots` + `market_quotes` + `source_health` + `ingestion_runs` |
| Price alerts + notifications | `.data/price-alerts*.json` / Upstash | `price_alerts`, `alert_notifications` |
| Managed users | `.data/desk-users.json` | `users` |
| Viewer password override | `.data/viewer-auth.json` | `app_settings.viewer_auth_override` |
| Env admin/viewer bootstrap | env vars | **unchanged** (env remains source for bootstrap admin; viewer override in PG) |
| Median history | `.data/median-history.json` | `median_history_samples` |
| Impact news | `.data/impact-news-store.json` | `news_items` + `app_settings.impact_news_store` |
| Provider short caches | `.data/*-cache.json` | **kept as ephemeral I/O caches** (not business SoT) |
| Theme / UI prefs | browser localStorage | **client-only** (harmless) |
| Auth sessions | signed cookies + credentialVersion | cookies + PG `credential_version` / viewer epoch |

### Obsolete env vars (do not auto-delete in production)

- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- `MARKET_SNAPSHOT_STORAGE`, `MARKET_SNAPSHOT_DATA_DIR`, `MARKET_SNAPSHOT_DATA_FILE`
- `PRICE_ALERTS_STORAGE`, `PRICE_ALERTS_DATA_DIR`, `PRICE_ALERTS_DATA_FILE`
- `TETHER_API_KEYS_STORAGE`, `TETHER_API_KEYS_DATA_DIR`, `TETHER_API_KEYS_DATA_FILE`
- `VIEWER_AUTH_DATA_FILE`, `DESK_USERS_DATA_FILE`

### Required env vars

```env
DATABASE_URL=
DATABASE_DIRECT_URL=   # optional
DATABASE_POOL_MAX=10
```

Plus existing `AUTH_TOKEN_SECRET`, admin/viewer credentials, `TETHER_API_KEY_HMAC_SECRET` (for API-key hash compatibility).

---

## Final schema

See `drizzle/0000_init.sql` and `src/db/schema.ts`.

Tables: `users`, `auth_sessions`, `app_settings`, `api_clients`, `api_keys`, `api_key_scopes`, `api_rate_limit_buckets`, `market_sources`, `market_snapshots`, `market_quotes`, `source_health`, `ingestion_runs`, `price_alerts`, `alert_notifications`, `median_history_samples`, `news_items`, `audit_logs`, `schema_meta`.

- Money: `numeric(24,8)`
- Timestamps: `timestamptz` (UTC)
- API rate window: `bigint` bucket start ms
- Snapshot dedup: unique `(market_type, content_hash)`
- Advisory lock key for tether refresh: `74201931`

---

## Data migration counts (local import)

From latest successful import report (`.data/migration-report-*.json`):

| Entity | before (source) | after notes |
|--------|-----------------|-------------|
| settings | 1 | imported / present |
| api_keys | 6 | all 6 present; HMAC hashes preserved; 2 active |
| price_alerts | 1 | present |
| alert_notifications | 1 | present |
| market_snapshots | 1 | median **188139.75** |
| median_history | 246 samples | imported |
| news_items | 103 | imported |
| desk-users / viewer-auth files | missing locally | env bootstrap only |

Importer is idempotent (`pnpm db:import` twice skips existing keys).

**API-key compatibility:** hashes are 64-char hex HMAC-SHA256 — **migrated safely**. Same `TETHER_API_KEY_HMAC_SECRET` / `AUTH_TOKEN_SECRET` required at runtime.

---

## Files changed (high level)

**New**

- `src/db/*` (client, schema, migrate, repositories)
- `drizzle/0000_init.sql`, `drizzle.config.ts`
- `scripts/import-legacy-to-postgres.mts`, `scripts/test-postgres.mts`, `scripts/verify-pg-data.mts`
- `docker-compose.postgres.yml`, `deploy/postgres/init-app-role.sql`
- Docs: `docs/DATABASE*.md`, this report

**Rewritten to PG fail-closed**

- `src/lib/settings.ts`, `userStore.ts`, `viewerAuthStore.ts`
- `src/lib/priceAlerts/store.ts`, `service.ts`
- `src/lib/apiKeys/store.ts`, `service.ts` (atomic PG rate limit)
- `src/lib/marketSnapshotStore.ts`, `marketSnapshot.ts` (advisory lock)
- `src/lib/history.ts`, `news/store.ts`

**Config**

- `.env.example`, `package.json` (`db:migrate`, `db:import`, `test:postgres`)
- `docker-compose.yml` (DATABASE_URL injection; legacy file vars documented obsolete)

---

## Tests / build

| Check | Result |
|-------|--------|
| `tsc --noEmit` | **pass** |
| `scripts/test-postgres.mts` | **10/10 pass** |
| `test-viewer-auth` | **18/18 pass** |
| `test-user-store` | **28/28 pass** |
| `test-tether-api-keys` | **19/19 pass** |
| `test-price-alerts` | **29/29 pass** |
| Full `pnpm build` | not forced in this session (dev server running); run before Ubuntu deploy |

---

## Local runtime status

- **PGlite DB:** `.data/pglite` (migrated + imported)
- **Dev server:** `http://127.0.0.1:3020` (Next.js, loads `.env.local` with `DATABASE_URL=pglite:.data/pglite`)
- Production Ubuntu: **untouched**
- No commit / no push

### Preview URLs

| Page | URL |
|------|-----|
| Login | http://127.0.0.1:3020/login |
| Dashboard / Monitoring | http://127.0.0.1:3020/ |
| Admin | http://127.0.0.1:3020/admin |
| Settings | http://127.0.0.1:3020/settings |
| Alerts | http://127.0.0.1:3020/alerts |

### Market / API endpoints

| Endpoint | Auth |
|----------|------|
| http://127.0.0.1:3020/api/tether-market | session |
| http://127.0.0.1:3020/api/dashboard | session |
| http://127.0.0.1:3020/api/fx-prices | session |
| http://127.0.0.1:3020/api/gold-prices | session |
| http://127.0.0.1:3020/api/bubble | session |
| http://127.0.0.1:3020/api/v1/tether-prices | Bearer API key `tether:read` |
| http://127.0.0.1:3020/api/v1/usd-prices | Bearer `usd:read` |
| http://127.0.0.1:3020/api/v1/aed-prices | Bearer `aed:read` |
| http://127.0.0.1:3020/api/v1/gold-prices | Bearer `gold:read` |
| http://127.0.0.1:3020/api/v1/market-prices | Bearer (scopes per section) |

---

## Safe Ubuntu commands (run later, after your approval)

```bash
# 1) On server — do NOT run until approved
cd /path/to/dealing-desk-otc-dashboard
export POSTGRES_PASSWORD='…strong…'
export DATABASE_URL="postgres://otc_app:${POSTGRES_PASSWORD}@127.0.0.1:5432/otc_desk"

docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d otc-postgres
# wait healthy
pnpm db:migrate
pnpm db:import:dry
pnpm db:import
# verify admin/viewer login + one API key against PG
export DATABASE_URL="postgres://otc_app:${POSTGRES_PASSWORD}@otc-postgres:5432/otc_desk"
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d --build iman-otc-desk

# Backup example
docker exec otc-postgres pg_dump -U otc_app -d otc_desk -Fc > otc_desk_$(date -u +%Y%m%d).dump
```

Full runbooks: `docs/DATABASE-UBUNTU.md`, `docs/DATABASE-MIGRATION.md`, `docs/DATABASE-BACKUP.md`.

---

## Risks / manual decisions

1. **HMAC secret** must match the secret used when keys were created, or Bearer auth fails (hashes still migrate; verification fails).
2. **PGlite** is for local/dev only; multi-process single-flight advisory locks need real Postgres (Docker overlay).
3. **Ephemeral provider caches** still under `.data/*-cache.json` — not durable SoT.
4. **Production cutover** requires explicit approval: migrate → import → verify logins → restart with `DATABASE_URL`.
5. **Rollback** to file/Redis requires redeploying a **pre-PostgreSQL** image tag; runtime no longer falls back.
6. Review `tsconfig.json` include change Next may have auto-added for `.next-preview/types`.

---

## Confirmations

- ✅ Production Ubuntu server **not** modified  
- ✅ No automatic data deletion of source JSON  
- ✅ No git commit  
- ✅ No git push  
- ✅ Local app + PGlite database left running for preview  
