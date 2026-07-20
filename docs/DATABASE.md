# PostgreSQL architecture — OTC desk

PostgreSQL is the **single source of truth** for all durable server-side state.
Runtime code does **not** fall back to JSON files, Redis/Upstash, or process memory.

## Stack

| Layer | Choice |
|--------|--------|
| ORM | Drizzle ORM |
| Driver | `postgres` (postgres.js) with bounded pool |
| Local without Docker | PGlite via `DATABASE_URL=pglite:.data/pglite` |
| Migrations | Versioned SQL under `drizzle/*.sql` (no auto-sync in prod) |
| Money | `numeric(24,8)` — never float |
| IDs | UUID for externally referenced rows |
| Timestamps | `timestamptz` stored in **UTC**; UI displays `Asia/Tehran` |

## Environment

```env
DATABASE_URL=postgres://otc_app:SECRET@127.0.0.1:5432/otc_desk
# or local: pglite:.data/pglite
DATABASE_DIRECT_URL=   # optional; same as DATABASE_URL unless using a pooler
DATABASE_POOL_MAX=10
```

Missing `DATABASE_URL` → fail closed (`DatabaseUnavailableError`).

## ER overview

```
users 1──* auth_sessions
users (actor) ──* audit_logs
api_clients 1──* api_keys 1──* api_key_scopes
api_keys 1──* api_rate_limit_buckets
market_sources
market_snapshots 1──* market_quotes
source_health (source_code, market_type)
ingestion_runs
price_alerts / alert_notifications
median_history_samples
news_items
app_settings (key/value JSONB)
schema_meta
```

### Buy / sell semantics (preserved)

On domestic USDT/IRT quotes:

- `buy_price` = desk bid = **user sell USDT** (user sells to market)
- `sell_price` = desk ask = **user buy USDT** (user buys from market)
- `user_buy_price` mirrors desk sell; `user_sell_price` mirrors desk buy

Formulas and providers are unchanged; only persistence moved to PostgreSQL.

## Canonical market flow

1. Server fetches providers with existing adapters.
2. Existing formulas build the tether market snapshot.
3. Snapshot + quotes + source_health + ingestion_run write in one path.
4. Dashboard / external APIs read the latest committed snapshot.
5. Refresh uses PostgreSQL advisory lock (`TETHER_REFRESH_LOCK`); if locked, serve last snapshot with `isStale`.
6. Identical content is deduplicated via `content_hash`.

## Obsolete paths (import only)

Do **not** delete production env vars until import is verified:

- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
- `MARKET_SNAPSHOT_STORAGE` / `MARKET_SNAPSHOT_DATA_*`
- `PRICE_ALERTS_STORAGE` / `PRICE_ALERTS_DATA_*`
- `TETHER_API_KEYS_STORAGE` / `TETHER_API_KEYS_DATA_*`
- `VIEWER_AUTH_DATA_FILE` / `DESK_USERS_DATA_FILE`

Source JSON under `.data/` is never deleted by the importer.

## Related docs

- [Local setup](./DATABASE-LOCAL.md)
- [Ubuntu production](./DATABASE-UBUNTU.md)
- [Migration runbook](./DATABASE-MIGRATION.md)
- [Backup / restore / rollback](./DATABASE-BACKUP.md)
