# PostgreSQL is the only durable store (v3.3.0+)

## Runtime

All durable application state is read/written through **PostgreSQL** (`DATABASE_URL`).

There is **no JSON / Redis / file runtime fallback**. If the database is down, durable APIs fail closed (503).

### What lives in Postgres

| Domain | Storage |
|--------|---------|
| Desk settings | `app_settings.desk_settings` |
| Managed users | `users` |
| Viewer password override | `app_settings.viewer_auth_override` |
| Price alerts + notifications | `price_alerts`, `alert_notifications` |
| API keys | `api_keys`, `api_key_scopes`, rate buckets |
| Market snapshots / quotes / health | `market_snapshots`, `market_quotes`, `source_health`, `ingestion_runs` |
| Median history | `median_history_samples` |
| Impact news | `news_items` + `app_settings.impact_news_store` |
| Gold history | `app_settings.gold_history` |
| Forex event history | `app_settings.forex_events_history` |
| Intelligence history | `app_settings.intelligence_history` |
| News translation cache | `app_settings.news_translations` |
| Provider last-good caches (gold/fx/telegram/forex calendar) | `app_settings.*` KV keys |

### What is *not* business SoT

| Item | Notes |
|------|--------|
| Env bootstrap admin/viewer | `ADMIN_*` / `VIEWER_*` env — always required for first login |
| Secrets | Server env only (`DATABASE_URL`, `AUTH_TOKEN_SECRET`, proxy, …) |
| Live market prices | Fetched from external APIs each cycle; **snapshots** are written to PG |
| Browser theme / UI | `localStorage` (client-only) |

Legacy JSON files may still exist on disk after one-shot import as **cold backup only**. They are never deleted by the importer; the app does not use them at runtime.

## Local developer setup (friend git pull)

```bash
git pull
pnpm install

# Option A — embedded PG for quick local (no Docker DB):
export DATABASE_URL=pglite:.data/pglite
pnpm db:migrate
pnpm dev

# Option B — real Postgres via Compose:
export POSTGRES_PASSWORD=localdev
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d
# DATABASE_URL is injected for the app service when using that overlay
```

Import old JSON once (if you have a backup folder):

```bash
export DATABASE_URL=postgres://otc_app:localdev@127.0.0.1:5432/otc_desk
export AUTO_IMPORT_LEGACY=1
export LEGACY_DATA_DIR=/path/to/json/backup
node scripts/run-legacy-import-data.mjs --force
```

## Production

See `docs/PRODUCTION-PG-SETUP.md` and `docs/DATABASE-UBUNTU.md`.

Container start always runs schema migrations when `DATABASE_URL` is set.

## Backup / restore (independent DB)

Postgres is a **separate container + volume** (`otc-postgres` / `otc-postgres-data`).  
You can backup only the database and restore it on another laptop without the app container.

```bash
./scripts/pg-backup.sh ./backups/postgres          # portable .dump
./scripts/pg-restore.sh ./backups/postgres/….dump  # new PC / local
```

Full guide: **`docs/DATABASE-BACKUP.md`**.
