# Backup, restore, rollback

## pg_dump (logical backup)

```bash
export PGPASSWORD='…'
export PGHOST=127.0.0.1
export PGPORT=5432
export PGUSER=otc_app
export PGDATABASE=otc_desk

# Custom format (recommended)
pg_dump -Fc -f "otc_desk_$(date -u +%Y%m%dT%H%M%SZ).dump"

# Or plain SQL
pg_dump -f "otc_desk_$(date -u +%Y%m%dT%H%M%SZ).sql"
```

Via Docker:

```bash
docker exec -t otc-postgres pg_dump -U otc_app -d otc_desk -Fc \
  > "otc_desk_$(date -u +%Y%m%dT%H%M%SZ).dump"
```

## Restore

```bash
# WARNING: restores into an existing DB; prefer empty DB or restore to a new name first
pg_restore --clean --if-exists -d otc_desk otc_desk_YYYYMMDD.dump
# or
psql -d otc_desk -f otc_desk_YYYYMMDD.sql
```

Never auto-drop production tables from the application.

## Daily backup example (cron, 7-day retention)

```bash
#!/usr/bin/env bash
set -euo pipefail
DIR=/var/backups/otc-postgres
mkdir -p "$DIR"
FILE="$DIR/otc_desk_$(date -u +%Y%m%d).dump"
docker exec otc-postgres pg_dump -U otc_app -d otc_desk -Fc > "$FILE"
find "$DIR" -name 'otc_desk_*.dump' -mtime +7 -delete
```

Install: `0 3 * * * /usr/local/bin/otc-pg-backup.sh`

## Volume snapshot

Named volume `otc-postgres-data` can be backed up with Docker volume tools / host LVM snapshots as a second layer.

## Rollback procedure

1. **Stop** app containers (`iman-otc-desk`).
2. **Restore** DB from the last known-good dump to a staging DB name; validate.
3. If schema migration is the problem: restore dump taken **before** migration; redeploy previous image.
4. Do **not** `TRUNCATE` or `DROP` blindly.
5. JSON under the old alerts volume remains as cold backup until you deliberately purge it.

## Application-level rollback

Runtime after this change **requires** PostgreSQL. Rolling back to file/Redis storage means deploying a **previous Git tag** (e.g. v3.1.1) and re-enabling its env vars — not flipping a feature flag.
