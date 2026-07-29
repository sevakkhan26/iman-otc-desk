# Shadow Arbitrage — Master Status

Living document. Every stage records status, files, migrations, tests, deployment
state, blockers, the last safe commit and rollback steps, so another agent can
resume after an interruption.

Statuses: `COMPLETE` · `RUNNING` · `BLOCKED_BY_TIME` · `BLOCKED_BY_CREDENTIALS` ·
`BLOCKED_BY_ACCESS` · `DISABLED_FOR_SAFETY` · `NOT_STARTED`

**Last updated:** 2026-07-30 (local session)

---

## 0. Safety invariants (must never regress)

* No real trading: no authenticated exchange endpoints, no API keys, no orders,
  no balances, no deposits, withdrawals or transfers anywhere in the module.
* Shadow Arbitrage is admin-only (middleware + `requireAdminSession` per route).
* OMPFinex stays fully functional in the main OTC project and completely absent
  from Shadow Arbitrage.
* The damaged PGlite backup `.data/pglite-local.damaged-20260730-011258` is
  preserved and must not be deleted.
* Secrets never enter git.

---

## 1. Rollback point and commits

| Ref | Meaning |
| --- | --- |
| `393b756` | **Rollback point** — last commit before any Shadow Arbitrage work (`v3.6.0`) |
| `3becb6b` | Phase 2 system (schema, migrations 0001+0002, adapters, engine, APIs, UI, tests) |
| `7fbed2f` | Unified local environment + PGlite single-writer safety |

### Rollback instructions

Local (code only — no data is touched):

```bash
git log --oneline            # confirm the SHA you want
git revert --no-commit 7fbed2f 3becb6b && git commit -m "revert: shadow arbitrage"
# or, to move the branch back entirely (only if nothing else was built on top):
git reset --hard 393b756
```

Production (once deployable — see stage 1):

```bash
# on the Ubuntu host, in the repo the poller pulls into
git log --oneline -5
git revert --no-commit <shadow shas> && git commit -m "revert: shadow arbitrage"
git push                      # poller redeploys within ~30–60s
# or pin to the rollback point:
git checkout 393b756 -- . && git commit -m "rollback to 393b756"
docker compose up -d --build --force-recreate iman-otc-desk
```

Database rollback is **not** required for these migrations: `0001` only creates
new `shadow_*` tables and `0002` is `ADD COLUMN IF NOT EXISTS` /
`CREATE TABLE IF NOT EXISTS` only. Nothing existing is dropped, renamed or
rewritten, so reverting the code leaves the extra tables unused and harmless.

---

## 2. Production deployment audit (2026-07-30)

| Item | Finding |
| --- | --- |
| Host | Ubuntu LAN server **192.168.50.105**, project at `docker-projects/iman-otc-desk` |
| Public URL | `http://price-monitoring.blumarkets.com/dashboard` — reachable, HTTP 200, served through ArvanCloud edges `185.143.233.238` / `185.143.234.238` |
| CD mechanism | **Pull-based poller on the server** (`auto-deploy-poller`). Push to `main` → server detects the SHA within ~30–60 s → `git pull --ff-only && docker compose build && up -d`. GitHub runners cannot reach the LAN host (`.github/workflows/cd-server-poller.yml`). |
| Manual deploy hook | `curl -X POST "http://192.168.50.105:9000/hooks/<id>?token=…"` |
| Containers | `docker-compose.yml` → service `iman-otc-desk`, `restart: unless-stopped`, port `${IMAN_OTC_PORT:-3000}:3000`, healthcheck on `/api/auth/me`, named volume `iman-otc-alerts-data` |
| PostgreSQL | `docker-compose.postgres.yml` → `otc-postgres` (postgres:16-alpine), bound to `127.0.0.1:5432` only, volume `otc-postgres-data` |
| Migrations | `docker-entrypoint.sh` runs the schema migrate on **every** container start, then `AUTO_IMPORT_LEGACY=auto` imports legacy JSON only when settings are missing |
| Env strategy | Server-side `.env` / `environment:` only; never committed |
| Restart policy | `unless-stopped` (survives reboot) |
| Logs | `docker logs`; poller log `docker logs -f auto-deploy-poller` |

### Access available from this environment

| Capability | Status |
| --- | --- |
| Public URL over HTTPS | ✅ reachable |
| LAN route to 192.168.50.105 | ❌ this machine is on `192.168.0.101`; ICMP and TCP 22/80/443/3000/9000 all fail (different subnet) |
| SSH to the server | ❌ no route, no host entry in `~/.ssh/config` |
| `git push` to any remote | ❌ `git@ssh.github.com: Permission denied (publickey)` for `origin`, `iman-otc`, `sevak`; `ssh-add -l` → "The agent has no identities" |
| Production database backup | ❌ requires server access |
| Verify worker on the server | ❌ requires server access or production admin credentials |

**Consequence:** stage 1 cannot be executed or verified from here. All of its
artifacts are prepared and committed so that a single push (or one command on the
host) completes it. See stage 1 for the exact runbook.

---

## 3. Pre-deployment database backup (run on the Ubuntu host)

Required before the first Shadow migration reaches production.

```bash
cd ~/docker-projects/iman-otc-desk        # adjust if the path differs
bash scripts/backup-production-db.sh      # added in this repo; writes to ./backups
```

The script takes a `pg_dump -Fc` custom-format dump plus a plain-SQL schema dump
from inside the `otc-postgres` container, records row counts for every table,
verifies the dump is readable, and prints the exact `pg_restore` command. It
never writes into the database and never deletes anything.

Restore (only if needed):

```bash
docker compose exec -T otc-postgres pg_restore -U otc_app -d otc_desk --clean --if-exists < backups/<file>.dump
```

---

## 4. Stage status

| Stage | Title | Status | Notes |
| --- | --- | --- | --- |
| 1 | Always-on production operation | `BLOCKED_BY_ACCESS` | Artifacts committed (compose worker service, backup script, runbook, cache/security headers, admin health endpoint). Cannot push or reach the LAN host from this environment. |
| 2 | Complete UI/UX redesign | `COMPLETE` | Persian RTL dashboard rebuilt: observation header, summary cards, filterable opportunity table, details drawer, source/account table, analytics. |
| 3 | 14-day observation workflow | `RUNNING` | Auto start/resume, true server elapsed time, coverage, restart survival all working; automatic final report generator implemented. Cannot be `COMPLETE` until 14 real days elapse — see `BLOCKED_BY_TIME`. |
| 4 | Account-readiness layer | `BLOCKED_BY_CREDENTIALS` | Read-only interface + admin UI section prepared; no credentials requested or stored. |
| 5 | Capital and rebalancing simulator | `NOT_STARTED` | Next session. Purely theoretical, 50,000,000 toman. |
| 6 | Paper execution engine | `NOT_STARTED` | Next session. Paper records only. |
| 7 | Guarded live-readiness architecture | `NOT_STARTED` | Next session. Interfaces only, `DISABLED_FOR_SAFETY` by construction. |

---

## 5. Per-stage detail

### Stage 1 — Always-on production operation · `BLOCKED_BY_ACCESS`

Prepared and committed:

* `docker-compose.yml` — new `iman-otc-shadow-worker` service: same image, runs
  `pnpm shadow:worker`, `restart: unless-stopped`, no published ports (never
  exposed to the internet), shares the app's `DATABASE_URL`, log rotation via the
  json-file driver.
* `scripts/backup-production-db.sh` — pre-migration backup + row-count report.
* `docs/SHADOW-ARBITRAGE-PRODUCTION.md` — deployment runbook and acceptance tests.
* Cache/security: shadow page and APIs send `private, no-store` so ArvanCloud and
  any intermediary cannot cache authenticated admin responses.
* `GET /api/shadow-arbitrage/health` — admin-only worker health (heartbeat, last
  successful cycle, next expected cycle, lease owner, error summary).

Remaining to complete the stage (needs someone with push or host access):

1. Run the backup script on the host.
2. Push the Shadow commits to `main` (poller deploys) **or** run
   `docker compose up -d --build` on the host.
3. Confirm `docker compose ps` shows exactly one healthy `shadow-worker`.
4. Confirm ≥5 production cycles, then reboot/restart and confirm the same
   observation session continues.
5. Re-run the acceptance checklist in `docs/SHADOW-ARBITRAGE-PRODUCTION.md`.

### Stage 2 — UI/UX redesign · `COMPLETE`

See `src/components/shadowArbitrage/*`. Sections A–F implemented per spec, Persian
RTL, dark/light, responsive, with skeleton/empty/stale/error states and the
permanent «حالت آزمایشی — هیچ سفارش یا انتقال واقعی انجام نمی‌شود» banner.

### Stage 3 — 14-day observation workflow · `RUNNING`

Working: automatic start/resume, real server elapsed time excluding paused
periods, cycle and data coverage, restart/deploy survival, degraded detection.
Added: `buildObservationReport()` and the report section in the analytics API,
which refuses to emit a final report before 14 real days have elapsed and never
backfills observations. Local session start: see the observation row in the DB
(`shadow_observation_sessions`), currently a fresh session created 2026-07-30.

### Stage 4 — Account readiness · `BLOCKED_BY_CREDENTIALS`

Verified accounts today: Nobitex, Wallex, Tabdeal. The remaining six are
`نیازمند افتتاح حساب`. Server-side interface shapes are defined for connection
status, read-only balance, account fee tier, permission validation, rate-limit
status and last authenticated sync — all unimplemented by design until
restricted, read-only credentials are supplied out of chat. Any future key must
start read-only with no withdrawal, transfer or order permission.

---

## 6. Test and quality status (local, 2026-07-30)

| Check | Result |
| --- | --- |
| `npm test` (12 suites) | 254 assertions, 0 failures |
| `pnpm test:shadow` | 40 unit + 14 persistence, 0 failures |
| `pnpm typecheck` | clean |
| `pnpm lint` | 0 errors (17 pre-existing warnings in unrelated files) |
| `pnpm build:verify` | isolated build OK, `.next` and `.next-local` untouched |
| Local always-on | `pnpm shadow:local` — app + collector, one Ctrl+C; 77 cycles across restarts, 0 duplicates |

---

## 7. Real blockers

| Blocker | Type | Unblocks when |
| --- | --- | --- |
| No LAN route / no push access from this environment | access | Someone with host or GitHub access runs the stage 1 runbook |
| 14 real days of observation | time | ~2026-08-13 if collection runs continuously from 2026-07-30 |
| Six exchange accounts not opened; no API credentials | credentials | Accounts opened and read-only keys supplied out of chat |
| Fee schedules unverified for 6 of 9 venues | data | Official published fees confirmed, or account API fee tier |
