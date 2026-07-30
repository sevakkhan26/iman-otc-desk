# Shadow Arbitrage — Master Status

Living document. Every stage records status, files, migrations, tests, deployment
state, blockers, the last safe commit and rollback steps, so another agent can
resume after an interruption.

Statuses: `COMPLETE` · `RUNNING` · `BLOCKED_BY_TIME` · `BLOCKED_BY_CREDENTIALS` ·
`BLOCKED_BY_ACCESS` · `DISABLED_FOR_SAFETY` · `NOT_STARTED`

**Last updated:** 2026-07-30 — stages 1 (prepared), 2 (complete), 3 (running) done; 4–7 pending

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
| `3becb6b` | Phase 2 system (schema, migrations 0001+0002, adapters, engine, APIs, tests) |
| `7fbed2f` | Unified local environment + PGlite single-writer safety |
| `587b561` | Stage 1 artifacts: production collector service, health endpoint, CDN-safe headers, backup script, runbook |
| `262df82` | Stage 2: redesigned Persian admin dashboard |

**Pushed** to `sevakkhan26/iman-otc-desk` on branch **`shadow-arbitrage-master`**
(head `6f4bdad`) on 2026-07-30. `main` is deliberately untouched and still at the
rollback point `393b756`, because a push to `main` auto-deploys within ~30–60 s
and the mandatory production database backup cannot be run or verified from this
machine (see §2).

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
| `git push` (after `gh auth login --web`) | ✅ authenticated as `ImanH96`, WRITE on the repo, credential in the macOS keychain |

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
| 2 | Complete UI/UX redesign | `COMPLETE` | Sections A–F rebuilt in Persian RTL: observation header, 8 summary cards, filterable/sortable/searchable opportunity table, details drawer, source & account table, analytics. Dark/light via theme tokens, responsive to 414px, skeleton/empty/stale/error states, compact yellow warning chip only. |
| 3 | 14-day observation workflow | `RUNNING` / `BLOCKED_BY_TIME` | Auto start/resume, true server elapsed time excluding pauses, cycle + data coverage, restart and deploy survival all working and verified (176 cycles recorded locally across many restarts, one session, zero duplicates). Cannot become `COMPLETE` until 14 real days elapse. The automatic final report generator is **not yet written** — next session. |
| 4 | Account-readiness layer | `BLOCKED_BY_CREDENTIALS` | Verified accounts (Nobitex, Wallex, Tabdeal) and the six that need opening are surfaced in the UI with evidence-based priority. Server-side authenticated interfaces are **not implemented** — deliberately, until read-only credentials arrive out of chat. |
| 5 | Capital and rebalancing simulator | `NOT_STARTED` | Next session. Purely theoretical, 50,000,000 toman. |
| 6 | Paper execution engine | `NOT_STARTED` | Next session. Paper records only. |
| 7 | Guarded live-readiness architecture | `NOT_STARTED` | Next session. Interfaces only, `DISABLED_FOR_SAFETY` by construction. |

---

## 5. Per-stage detail

### Stage 1 — Always-on production operation · `BLOCKED_BY_ACCESS`

Prepared and committed:

* `docker-compose.yml` — new `iman-otc-shadow-worker` service: same image started
  with `SHADOW_COLLECTOR=1` (the production image is a Next standalone build with
  no tsx and no .mts files, so `pnpm shadow:worker` cannot run there; the
  collector runs through the server's instrumentation hook instead),
  `restart: unless-stopped`, no published ports (never
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

Files: `src/components/shadowArbitrage/{labels,types,ObservationHeader,SummaryCards,OpportunityTable,OpportunityDrawer,SourceTable,AnalyticsPanels}.tsx`,
`src/components/ShadowArbitrageView.tsx`, `app/globals.css`.

Verified: typecheck, lint (0 errors), isolated production build, 46 unit tests
including blocked-code translation completeness, collector-state derivation,
Persian formatting, freshness buckets, account priority and the permanent banner.
Rendered live at `http://127.0.0.1:3000/shadow-arbitrage` with an admin session
(HTTP 200) while the collector recorded cycles.

**Not verified:** pixel-level dark/light and responsive rendering. This
environment has no browser automation (no Playwright/Puppeteer, and Node 20's
experimental WebSocket would not attach to Chrome DevTools Protocol). Both themes
and the 720px breakpoint are implemented against the existing theme tokens and
reviewed in CSS, but no screenshots were taken.

### Stage 3 — 14-day observation workflow · `RUNNING` / `BLOCKED_BY_TIME`

Working and verified: automatic start/resume, real server elapsed time excluding
paused periods, cycle and data coverage, restart survival, degraded detection,
pause/resume without losing progress. The local session created on 2026-07-30 has
recorded 176 cycles across roughly a dozen app restarts with a single session id
and zero duplicate cycles.

Still to build (next session): `buildObservationReport()` — the automatic final
report after 14 real days (unique lifecycles, route frequency, duration and edge
distributions, PnL by size, source uptime/errors, coverage, fee confidence,
exchange ranking, unusable routes and why). It must refuse to emit before 14 real
days have elapsed and must never backfill observations.

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
| `npm test` (12 suites) | 261 assertions, 0 failures |
| `pnpm test:shadow` | 46 unit + 14 persistence, 0 failures |
| `pnpm typecheck` | clean |
| `pnpm lint` | 0 errors (17 pre-existing warnings in unrelated files) |
| `pnpm build:verify` | isolated build OK, `.next` and `.next-local` untouched |
| Local always-on | `pnpm shadow:local` — app + collector, one Ctrl+C; 176 cycles across restarts, 0 duplicates, single PGlite writer |
| Production design proof | standalone build (what production runs) started the collector and recorded 3 cycles; health 401 unauthenticated; CDN headers confirmed |

---

## 7. Real blockers

| Blocker | Type | Unblocks when |
| --- | --- | --- |
| No LAN route / no push access from this environment | access | Someone with host or GitHub access runs the stage 1 runbook |
| 14 real days of observation | time | ~2026-08-13 if collection runs continuously from 2026-07-30 |
| Six exchange accounts not opened; no API credentials | credentials | Accounts opened and read-only keys supplied out of chat |
| Fee schedules unverified for 6 of 9 venues | data | Official published fees confirmed, or account API fee tier |

---

## 8. Release v4.6.1 — pushed, NOT yet live in production (2026-07-30)

| Item | Value |
| --- | --- |
| Release commit | `37921ec` — "Release v4.6.1 — Shadow Arbitrage production release" |
| Deploy fix commit | `5d367a3` — compose worker build context + `pull_policy: never` |
| `main` (GitHub) | `5d367a3` |
| `shadow-arbitrage-master` | `5d367a3` |
| Tag `v4.6.1` | → `37921ec` |
| Tag `pre-v4.6.1` | → `393b756` (previous production commit) |
| Production version observed | **`4.6.1`** — deployed and verified 2026-07-30 |
| Production health | HTTP 200, existing dashboard unaffected, no regression |

### What is verified vs not

* **Pushed to `main`: yes.** GitHub `main` is at the release.
* **Verified in production: NO.** The site still serves the pre-release build.
  Evidence: the login footer reports `3.6.0`, and the headers that only the new
  `next.config.ts` emits (`CDN-Cache-Control`, `Surrogate-Control` on
  `/api/shadow-arbitrage/*`) are absent. `X-Cache: BYPASS`, so this is not CDN
  caching — the origin itself is serving the old build.
* Note: `/shadow-arbitrage` → 307 and `/api/shadow-arbitrage/*` → 401 do **not**
  prove deployment. Non-existent paths return the same codes, because middleware
  redirects/401s every unauthenticated request before routing.

### Database backup

**Not performed and not verified.** The LAN host `192.168.50.105` is unreachable
from the release machine (`192.168.0.101`, different subnet; ICMP and TCP
22/9000/3000 all fail) and Docker is not installed locally, so
`scripts/backup-production-db.sh` could not be run. The release proceeded on the
user's explicit authorization, protected by the `pre-v4.6.1` tag and by the fact
that both migrations are strictly additive (8 × `CREATE TABLE IF NOT EXISTS`,
14 × `ADD COLUMN IF NOT EXISTS`, indexes only; every table touched is a new
`shadow_*` table).

### To finish the deployment (needs LAN/host access)

```bash
cd ~/docker-projects/iman-otc-desk
docker logs --tail 100 auto-deploy-poller     # is the poller alive? did it try?
git log --oneline -3                          # did the host actually pull 5d367a3?
git pull --ff-only
bash scripts/backup-production-db.sh          # backup first
docker compose build iman-otc-desk            # watch for build errors
docker compose up -d iman-otc-desk iman-otc-shadow-worker
docker compose ps
curl -s localhost:3000/login | grep -o '4\.6\.1'
```

Then re-check: version `4.6.1` on the login footer, `CDN-Cache-Control` on the
shadow APIs, exactly one `iman-otc-shadow-worker`, and ≥3 recorded cycles via the
admin health endpoint.


### Deployment outcome (updated)

`4.6.1` **is live**. It applied after the compose fix `5d367a3` (the worker
service previously had `image:` with no `build:`, so a pull attempt aborted the
deploy). Total time from the first `main` push to a verified live version was
longer than the ~30–60 s the poller comment suggests, because the host performed
a full image rebuild.

Verified externally at <http://price-monitoring.blumarkets.com> (cache-busted,
`X-Cache: BYPASS`):

* login footer reports `4.6.1`
* `/api/shadow-arbitrage/*` now emit `private, no-store`, `CDN-Cache-Control`,
  `Surrogate-Control`, `Vary: Cookie`, `X-Robots-Tag` — the new build's headers
* unauthenticated: page `307` → login, all five shadow APIs and the observation
  POST `401`
* existing dashboard unaffected (`/login` 200, `/dashboard` 307)

Still **not** verified (needs production admin credentials or host access, which
this machine does not have):

* admin and viewer login behaviour on production
* the Persian dashboard rendered while authenticated
* collector heartbeat, production cycle count, duplicate-key count, one-collector
  check, and PostgreSQL-vs-PGlite confirmation via
  `GET /api/shadow-arbitrage/health`
* whether `iman-otc-shadow-worker` is actually running on the host

The production **database backup was never run or verified** — the host stayed
unreachable. Protection remains the `pre-v4.6.1` tag plus the strictly additive
migrations.

---

## 9. Hotfix v4.6.2 (2026-07-30)

**Root cause of the stalled collector:** `withAdvisoryLock` ran
`pg_try_advisory_lock` and `pg_advisory_unlock` as two separate pooled queries.
Advisory locks are session scoped, so the unlock landed on a different pooled
connection and no-opped; the original connection held the lock for its lifetime
and every later cycle received `acquired:false`. That is exactly the reported
"1 cycle in ~2h43m, stale heartbeat, status متوقف". Fixed by pinning one
`sql.reserve()` connection for lock + unlock.

Also in this release: separated elapsed/coverage/downtime/source-response
metrics, COMPLETED now requires 14 days **and** ≥80% successful coverage,
state-correct action button, valid/raw/blocked opportunity classification with
valid-first ordering, analytics gated behind ≥20 successful cycles, and the
dashboard label/clarity fixes.

Commit `bdf101e`, tag `v4.6.2`, `main` = `bdf101e`. Verified live: version
`4.6.2` on the login footer, shadow APIs still `private, no-store` +
`CDN-Cache-Control` + `Surrogate-Control`, unauthenticated page 307 and APIs 401.

**Not verified (needs production admin credentials or host access):** collector
heartbeat age, ≥10 consecutive 30 s production cycles, exactly-one-collector,
duplicate idempotency key count, PostgreSQL-vs-PGlite confirmation, restart
resumption, and the authenticated dashboard. The production database backup was
again **not** run — the LAN host stayed unreachable.
