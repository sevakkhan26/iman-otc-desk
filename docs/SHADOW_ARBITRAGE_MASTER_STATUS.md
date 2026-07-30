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

---

## 10. Hotfix v4.6.3 — single-container collector (2026-07-30)

The two-service Compose design (`iman-otc-desk` + `iman-otc-shadow-worker`)
never ran in production: the deploy path targets the `iman-otc-desk` service
explicitly, so the worker service was defined but never created. Replaced with
one container — the Next server process runs both the app and the collector via
the Node-runtime instrumentation hook. The worker service was removed from
`docker-compose.yml`.

Commit `bf93872`, tag `v4.6.3`, `main` = `bf93872`.

---

## 11. Hotfix v4.6.4 — collector no longer depends on Compose env plumbing (2026-07-30)

v4.6.3 shipped but the collector still did not run: the production host composes
this service from an external parent Compose file plus
`docker-compose.production.yml`, so `SHADOW_COLLECTOR_ENABLED` added to this
repo's `docker-compose.yml` never reached the container. Reproduced locally with
the standalone artifact and no `SHADOW_*` variables set.

Fix: `enabled()` in `instrumentation.node.ts` now defaults **on** whenever
`NODE_ENV === "production"`. An explicit env value can still force it off
(`false/0/no/off`); env can no longer be the reason it fails to start. The
bootstrap also logs `NODE_ENV`, `NEXT_RUNTIME`, the env value and the pid.

Commit `411646a`, tag `v4.6.4`, `main` = `411646a`.

---

## 12. Hotfix v4.6.5 — restart-safe collector lease supervisor (2026-07-30)

**Root cause of the restart outage, proven from production health JSON**
(`lastCycleAt=13:20:01Z`, `leaseExpiredAt=13:22:01Z`, heartbeat still naming the
previous container's worker): the recreated container bootstrapped *inside* the
previous container's still-valid lease, `claimWorkerLease` returned
`acquired:false`, and `instrumentation.node.ts` took the
`if (!handle.leaseAcquired) return` path — a **permanent** exit. When the old
lease expired two minutes later, no process was left to claim it. The pid-based
`isDeadLocalWorker` takeover could not rescue it either, because a recreated
container has a different hostname and that helper deliberately refuses to judge
a worker on another host.

Fix: `acquireLeaseWithRetry()` in `runner.ts` retries with bounded backoff
(2 s → 30 s, ×1.5), survives database errors during bootstrap, and never exits;
`startShadowCollector` defaults to `waitForLease: true`; instrumentation no
longer exits on a held lease. A live lease is still never stolen, so
exactly-one-collector holds. `SHADOW_LEASE_MIN_MS` makes the lease floor
tunable for tests. Integration test reproduces A-holds → A-vanishes →
B-waits → B-takes-over with `observation.id` preserved.

Commit `728e567`, tag `v4.6.5`, `main` = `728e567`.

**Verified live in production after the deploy restart:**

| Field | Value |
| --- | --- |
| `status` | `healthy` |
| `running` | `true` |
| `workerId` | `shadow-web-ca46643de6bc-7-ms7kmodf` (new) |
| `leaseHeld` | `true` |
| `heartbeatAgeMs` | `328` (`heartbeatStale=false`) |
| `observation.id` | `9846b26c-54ed-49ef-9e59-a57ef2b07a64` (unchanged) |
| cycles | `63` completed / `63` successful / `0` failed |
| `duplicateIdempotencyKeys` | `0` |
| sources | 9/9, no errors |

The same 14-day observation survived the restart and five further cycles
completed after it. This closes the previously unverified items: collector
heartbeat age, consecutive production cycles, exactly-one-collector, duplicate
idempotency keys and restart resumption.

---

## 13. Phase 4 — exchange account & fee readiness (v4.7.0, 2026-07-30)

Merged into `main` as an ordinary non-fast-forward merge on top of v4.6.5; the
only conflict was the `package.json` version field, resolved to `4.7.0`. The
lease-retry hotfix is preserved intact.

**Scope — read-only, no credentials.** Phase 4 records which venues are actually
usable for a net-profit calculation and on what fee evidence:

* `src/lib/shadowArbitrage/accounts.ts` — `buildVenueReadiness` /
  `buildAllReadiness` / `venueUsableForNetProfit`, plus the account-state map:
  nobitex, wallex, tabdeal `VERIFIED`; bitpin, abantether, ramzinex, tetherland,
  bit24 `NEEDS_ACCOUNT`; arzinja `REFERENCE_ONLY`. OMPFinex is absent by design.
* Fees are never invented. A venue is usable for net profit only with an
  admin-confirmed taker fee; evidence older than `FEE_REVERIFY_DAYS = 90` is
  stale and blocks usability again.
* `drizzle/0003_shadow_fee_confirmations.sql` — one additive table,
  `shadow_fee_confirmations`, append-only fee-evidence history. No drops, no
  changes to existing tables, no credential columns.
* `app/api/shadow-arbitrage/accounts/route.ts` — admin-only GET/POST. POST
  hard-rejects `apiKey`, `api_key`, `secret`, `apiSecret`, `token`, `password`
  and `passphrase` with `forbidden_field`.
* `src/components/shadowArbitrage/AccountReadiness.tsx` — Persian readiness
  panel on the dashboard.

**No API keys are requested or stored in this phase, and nothing here can place
an order or move funds.**

Verification before release: typecheck clean · ESLint 0 errors (17 pre-existing
warnings) · 12/12 test suites green, 268 assertions, 0 failures — including 52
shadow-arbitrage tests (Phase 4 covered) and 15 persistence tests (v4.6.5
restart test covered) · isolated standalone build succeeds and emits the
`accounts` route.

**Still outstanding:** the production database backup has never been run or
verified — the LAN host stays unreachable. Protection remains the `pre-v4.6.1`
tag plus strictly additive migrations. Phase 5 has not started.

---

## 14. Phase 5 — Capital Allocation Simulator (branch `shadow-phase5-capital`, not merged)

Built on top of v4.7.0 after the user verified production healthy. **Not merged,
not tagged and not deployed** — awaiting explicit approval for v4.8.0.

**Scope — admin-only, Shadow Mode only, no execution.** Every balance is
virtual. Nothing in this phase contacts an exchange, accepts credentials, places
an order or moves funds, and automatic paper execution is deliberately absent
(that is Phase 6).

### Rules the engine enforces

* **Portfolio conservation.** Allocated value plus reserve always equals the
  stated capital, to the toman, by construction. `conservationResidualToman` is
  reported on every simulation and is asserted to be exactly zero.
* **No negative balances.** Negative IRT or USDT, duplicate venues, non-finite
  amounts, out-of-range capital and over-allocation are all structural
  violations; a violating plan produces no metrics at all rather than
  authoritative-looking numbers, and cannot be saved.
* **No invented numbers.** Unknown or stale fees, a missing valuation price and
  an unconfirmed transfer cost each yield `UNKNOWN`/`BLOCKED` through a typed
  `Estimate<T>`. The configured rebalance cost is a provisional zero, which is
  not evidence, so **estimated monthly rebalancing cost is UNKNOWN today** and
  is not replaced by a default.
* **No profit is claimed.** The simulator reports what an allocation could have
  funded from observed route data; it never asserts realised or expected profit.

### Venues

Executable venues are exactly those with a verified account **and** a fee that
is known and fresh — today nobitex, wallex and tabdeal, gated through Phase 4's
`venueUsableForNetProfit` so there is one definition in the codebase. bitpin,
abantether, ramzinex, tetherland and bit24 stay `WHATIF_DISABLED`: capital may
be placed there for exploration, but it never counts toward utilization and can
never fund a covered route until the account and fee land. arzinja is
`REFERENCE_ONLY` and its inputs are disabled in the UI. OMPFinex is not a valid
venue id and is rejected as `unknown_venue`.

### Metrics

Capital utilization (executable share of capital), opportunity coverage (funded
route samples ÷ observed route samples, plus funded-of-structurally-executable),
unused reserve, concentration risk (HHI over venue shares with LOW/MODERATE/HIGH
bands) and estimated monthly rebalancing cost. Coverage returns UNKNOWN when the
observation has no route data; concentration returns UNKNOWN when nothing is
allocated. Unfunded routes are always reported with a reason, never dropped.

### Allocation modes

Manual entry per venue, and a **provisional optimized** split that is fully
deterministic: capital follows venues that actually appeared on the profitable
side of observed routes (net-positive samples, falling back to raw-positive,
falling back to an explicitly labelled equal split when there is no evidence).
Integer largest-remainder splitting keeps the portfolio exact. An explicit
`reservePercent` is honoured and defaults to 0 so no reserve policy is invented.

### Lock

`recommendation.status` is permanently `PROVISIONAL` with `locked: true`. The
14-day gate (`COMPLETED` **and** ≥80% success coverage) is reported separately as
`observationGatePassed`; passing it does not unlock the recommendation.

### Files

* `src/lib/shadowArbitrage/capital.ts` — pure engine, no database import.
* `app/api/shadow-arbitrage/capital/route.ts` — admin-only GET/POST
  (`simulate` / `optimize` / `save`); rejects `apiKey`, `api_key`, `secret`,
  `apiSecret`, `token`, `password`, `passphrase`, `privateKey`, `mnemonic`.
* `drizzle/0004_shadow_capital_plans.sql` + `shadowCapitalPlans` — one additive
  table, append-only plan history, no drops or alters.
* `src/components/shadowArbitrage/CapitalSimulator.tsx` + RTL Persian styles.
* `REQUIRED_SUCCESS_COVERAGE_PERCENT` moved to `config.ts` and re-exported from
  the repository, so the pure engine can gate on it without the database layer.

The collector, runner, instrumentation and the running observation session are
untouched; `observation.id` is read only.

### Verification

typecheck clean · ESLint 0 errors (17 pre-existing warnings, none new) ·
12/12 suites green, 288 assertions, 0 failures — including 19 new deterministic
accounting tests and 1 new persistence test · isolated standalone build succeeds
and emits the `capital` route.

**Phase 6 (automatic paper execution) has not started.**
