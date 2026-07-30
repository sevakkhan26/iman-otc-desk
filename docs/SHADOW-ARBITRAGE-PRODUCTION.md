# Shadow Arbitrage — production deployment runbook

Read-only observation worker for the always-on Ubuntu host. No credentials, no
orders, no transfers. OMPFinex is untouched in the main OTC project and absent
from Shadow Arbitrage.

**Status:** artifacts committed and validated locally; not yet deployed. See
`docs/SHADOW_ARBITRAGE_MASTER_STATUS.md` §2 for why (no LAN route and no push
access from the machine this was built on).

---

## 1. Architecture

The production image is a **Next standalone** build: it contains `server.js`,
`drizzle/`, three plain `.mjs` scripts and `node_modules/postgres` — no `tsx`,
no devDependencies, no `.mts` files. So `pnpm shadow:worker` cannot run there.

Instead the collector runs through the server's **instrumentation hook** in a
second container from the same image:

```
iman-otc-desk   app + Shadow collector in ONE Node process (SHADOW_COLLECTOR_ENABLED=true)
otc-postgres    database, bound to 127.0.0.1 only
```

There is no separate worker service: a second Compose service was never started
by the deploy path (which targets `iman-otc-desk` explicitly), so the collector
now lives inside the web container's Node process.

The hook runs at server bootstrap, not in a request handler, so collection never
depends on a browser. Validated locally against the standalone build:

```
[shadow-worker …] starting in-process collector workerId=shadow-inproc-… pollMs=15000
[shadow-worker …] cycle 1 success — sources 7 healthy / 2 degraded / 0 down …
[shadow-worker …] cycle 2 success …
[shadow-worker …] cycle 3 success …
```

Exactly one collector is guaranteed by three independent mechanisms:

1. PostgreSQL advisory lock around each cycle;
2. a lease row in `shadow_worker_heartbeat` (a second collector refuses to start;
   a lease owned by a dead process on the same host is reclaimed at once);
3. a per-interval idempotency key with a unique index, so two collectors waking
   in the same window cannot both record a cycle.


---

## 2. Deploy

### 2.1 Back up first (mandatory)

```bash
cd ~/docker-projects/iman-otc-desk
bash scripts/backup-production-db.sh
```

Writes `backups/otc_desk-<UTC>.dump` (+ schema, row counts, verified TOC) and
prints the restore command. Read-only against the database.

### 2.2 Record the rollback point

```bash
git rev-parse HEAD > backups/rollback-sha.txt
cat backups/rollback-sha.txt
```

### 2.3 Deploy

Either push to `main` and let the poller do it (~30–60 s):

```bash
git push origin main       # or the remote the server polls
docker logs -f auto-deploy-poller
```

…or deploy on the host directly:

```bash
git pull --ff-only
docker compose up -d --build iman-otc-desk
```

The app container migrates the schema on start (`docker-entrypoint.sh`). The
worker container is started with `AUTO_IMPORT_LEGACY=0` so it never runs the
legacy import.

### 2.4 Migrations applied

| File | Effect |
| --- | --- |
| `0001_shadow_arbitrage.sql` | creates `shadow_*` tables only |
| `0002_shadow_arbitrage_phase2.sql` | `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` only |

Nothing existing is dropped, renamed or rewritten. Money columns are
`numeric` (never float) and all timestamps are `timestamp with time zone`.

---

## 3. Post-deploy verification

```bash
# 1. containers healthy, exactly one worker
docker compose ps

# 2. collector is cycling (no browser involved)

# 3. schema present and row counts sane
docker compose exec -T otc-postgres psql -U otc_app -d otc_desk -c "\dt shadow_*"
docker compose exec -T otc-postgres psql -U otc_app -d otc_desk -c \
  "SELECT count(*) runs, count(DISTINCT idempotency_key) uniq FROM shadow_collection_runs;"
#    runs must equal uniq — no duplicate cycles

# 4. one observation session only
docker compose exec -T otc-postgres psql -U otc_app -d otc_desk -c \
  "SELECT id, status, started_at, completed_cycles FROM shadow_observation_sessions;"

# 5. restart survival: same session id, counters keep climbing
sleep 60

# 6. reboot survival (restart: unless-stopped)
sudo reboot        # then re-check steps 1–2
```

### Access control (from any client)

```bash
BASE=http://price-monitoring.blumarkets.com
curl -s -o /dev/null -w '%{http_code}\n' $BASE/shadow-arbitrage                    # 307 → login
for p in matrix observation history analytics health; do
  curl -s -o /dev/null -w "$p %{http_code}\n" $BASE/api/shadow-arbitrage/$p        # 401
done
# viewer session → page 307 to /dashboard, every API 403
# admin session  → page 200, every API 200
```

### Cache safety

```bash
curl -sI $BASE/api/shadow-arbitrage/matrix | grep -iE 'cache-control|cdn-cache|surrogate|vary'
# Cache-Control: private, no-store, no-cache, must-revalidate, max-age=0
# CDN-Cache-Control: no-store
# Surrogate-Control: no-store
# Vary: Cookie, …
```

### Main dashboard unaffected

```bash
curl -s -o /dev/null -w '%{http_code}\n' $BASE/login       # 200
# with an admin session: /api/tether-market must still list ompfinex as available
```

---

## 4. Rollback

```bash
cd ~/docker-projects/iman-otc-desk
git revert --no-commit <shadow shas> && git commit -m "revert: shadow arbitrage"
docker compose up -d --build iman-otc-desk
```

No database rollback is needed — the migrations are additive, so reverted code
simply leaves the `shadow_*` tables unused. If a restore is ever required:

```bash
docker exec -i otc-postgres pg_restore -U otc_app -d otc_desk \
  --clean --if-exists < backups/otc_desk-<UTC>.dump
```

---

## 5. Operational notes

* **Interval:** `SHADOW_POLL_MS` (default 30000, clamped 15000–300000).
* **Logs:** json-file driver, `max-size=10m`, `max-file=5` — bounded, rotated.
* **Retention:** the collector prunes data older than 14 days every ~20 cycles
  and never removes an active lifecycle.
* **Health:** `GET /api/shadow-arbitrage/health` (admin-only) reports collector
  state, heartbeat age, last successful cycle, next expected cycle, lease owner,
  duplicate-key count and per-source error rates. It exposes no endpoint URLs,
  stack traces or database details.
