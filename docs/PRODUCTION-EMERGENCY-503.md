# Production 503 / empty data — emergency cutover

Symptom: version 3.2.x live, dashboard empty, HTTP **503**, no data.

Cause: app requires PostgreSQL (`DATABASE_URL`). Schema/data not loaded yet.

## On Ubuntu server (NOW)

```bash
cd /path/to/iman-otc-desk   # git clone that CI/CD pulls

# 1) Secrets — server .env only
export DATABASE_URL='postgres://otc_app:PASSWORD@127.0.0.1:5432/otc_desk'
export DATABASE_POOL_MAX=10

# 2) Ensure Postgres is up
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d otc-postgres
# or systemctl status postgresql

# 3) Point legacy JSON (Docker volume)
export LEGACY_DATA_DIR='/var/lib/docker/volumes/iman-otc-alerts-data/_data'
# if files live elsewhere, set the directory that contains:
#   price-alerts.json, tether-api-keys.json, settings.json, market-snapshot.json, …

# 4) Schema + data (host, full checkout)
chmod +x scripts/production-pg-setup.sh scripts/run-migrations.mjs scripts/run-legacy-import-data.mjs
./scripts/production-pg-setup.sh --dry-run
./scripts/production-pg-setup.sh

# Or pure node after migrate:
# node scripts/run-migrations.mjs
# AUTO_IMPORT_LEGACY=1 LEGACY_DATA_DIR=… node scripts/run-legacy-import-data.mjs --force

# 5) Put DATABASE_URL into compose/systemd env permanently, then:
export AUTO_IMPORT_LEGACY=auto
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d --build --force-recreate iman-otc-desk

# 6) Logs — must see migrate OK
docker logs --tail 100 iman-otc-desk
```

## Verify

- http://price-monitoring.blumarkets.com/dashboard  
- Login admin/viewer  
- Prices not empty  
- No 503 on `/api/dashboard`

## Never

- `docker compose down -v` (deletes volumes)  
- Commit passwords  
- Drop production tables  
