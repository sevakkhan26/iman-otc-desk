# Backup & restore (independent PostgreSQL)

The OTC desk database is a **standalone Postgres** service (`otc-postgres` container + named volume `otc-postgres-data`).

- **Not** tied to the Next.js container filesystem  
- **Not** dependent on legacy JSON files  
- Backups are portable: copy a `.dump` file to another PC and restore

## Quick commands (repo scripts)

### Backup (production or local)

```bash
# From machine that runs Docker and container otc-postgres:
chmod +x scripts/pg-backup.sh scripts/pg-restore.sh
./scripts/pg-backup.sh ./backups/postgres
```

Creates:

- `backups/postgres/otc_desk_YYYYMMDDTHHMMSSZ.dump` — portable archive  
- `….dump.meta.json` — size / time / hostname (no secrets)

Copy the `.dump` file to USB / cloud / new laptop.

### Restore (local or new PC)

```bash
# 1) Start a fresh Postgres
export POSTGRES_PASSWORD='choose-a-password'
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d otc-postgres

# 2) Restore dump
./scripts/pg-restore.sh ./backups/postgres/otc_desk_YYYYMMDD.dump

# 3) Point the app at it
export DATABASE_URL="postgres://otc_app:${POSTGRES_PASSWORD}@127.0.0.1:5432/otc_desk"
export DATABASE_POOL_MAX=10
pnpm dev
# or docker compose up app with DATABASE_URL set
```

On a **new empty DB**, first boot of the app also runs schema migrations automatically when `DATABASE_URL` is set. Prefer restoring a full dump (schema + data) when moving machines.

## Manual pg_dump (same idea)

```bash
docker exec -t otc-postgres pg_dump -U otc_app -d otc_desk -Fc --no-owner --no-acl \
  > "otc_desk_$(date -u +%Y%m%dT%H%M%SZ).dump"
```

Restore:

```bash
docker cp otc_desk_….dump otc-postgres:/tmp/r.dump
docker exec otc-postgres pg_restore -U otc_app -d otc_desk --clean --if-exists --no-owner --no-acl /tmp/r.dump
```

## Daily automatic backup (Ubuntu server)

```bash
sudo mkdir -p /var/backups/otc-postgres
sudo tee /usr/local/bin/otc-pg-backup.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
DIR=/var/backups/otc-postgres
mkdir -p "$DIR"
FILE="$DIR/otc_desk_$(date -u +%Y%m%d).dump"
docker exec otc-postgres pg_dump -U otc_app -d otc_desk -Fc --no-owner --no-acl >"$FILE"
find "$DIR" -name 'otc_desk_*.dump' -mtime +14 -delete
ls -lh "$FILE"
EOF
sudo chmod +x /usr/local/bin/otc-pg-backup.sh

# 03:00 UTC daily
echo '0 3 * * * root /usr/local/bin/otc-pg-backup.sh >>/var/log/otc-pg-backup.log 2>&1' \
  | sudo tee /etc/cron.d/otc-pg-backup
```

## What is independent vs what is not

| Asset | Independent? | How to move |
|-------|--------------|-------------|
| Postgres data | **Yes** | `.dump` file or volume snapshot |
| App container / code | Yes (Git) | `git pull` + rebuild |
| Secrets (`DATABASE_URL`, passwords) | Yes (env only) | Copy secrets file securely — never commit |
| Legacy JSON on volume | Cold backup only | Optional; app runtime uses PG |

## Volume snapshot (second layer)

Named volume: **`otc-postgres-data`**.

Logical dump (`pg_dump`) is preferred for restore onto another machine.  
Volume tar is possible but less portable across Docker hosts.

```bash
# example volume archive (stop app first if you need a freeze)
docker run --rm -v otc-postgres-data:/data -v "$(pwd)":/backup alpine \
  tar czf /backup/otc-postgres-data.tgz -C /data .
```

## Rollback

1. Stop app: `docker compose stop iman-otc-desk`  
2. Restore last good `.dump` into Postgres  
3. Start app again  
4. Do **not** `docker compose down -v` (destroys the volume)

## Security

- Backup files contain **all business data** (settings, keys hashes, history). Encrypt and store securely.  
- Never commit `.dump` files to Git.  
- Rotate DB password when moving to a new PC if the dump was shared insecurely.
