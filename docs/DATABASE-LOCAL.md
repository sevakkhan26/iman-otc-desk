# Local PostgreSQL setup

## Option A — PGlite (no Docker / no system Postgres)

```bash
export DATABASE_URL=pglite:.data/pglite
export DATABASE_POOL_MAX=5

# Apply schema
pnpm db:migrate
# or: pnpm exec tsx src/db/migrate.ts

# Import existing .data JSON (idempotent; never deletes sources)
pnpm db:import:dry
pnpm db:import

# Dev server (loads .env.local)
pnpm dev
# or preview on 3020 with OTC_NEXT_DIST=.next-preview
```

Add to `.env.local`:

```env
DATABASE_URL=pglite:.data/pglite
DATABASE_POOL_MAX=5
```

## Option B — Docker Postgres

```bash
# Set a password (never commit it)
export POSTGRES_PASSWORD='choose-a-strong-password'

docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d otc-postgres

export DATABASE_URL="postgres://otc_app:${POSTGRES_PASSWORD}@127.0.0.1:5432/otc_desk"
pnpm db:migrate
pnpm db:import
pnpm dev
```

Port `5432` is bound to `127.0.0.1` only.

## Verify

```bash
pnpm test:postgres
pnpm typecheck
```

Confirm:

- App starts with `DATABASE_URL` set
- Admin login works
- Market snapshot loads from DB after restart
- No new runtime writes to `.data/*.json` for settings/keys/alerts/snapshots
