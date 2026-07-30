# Release v4.6.1 — Shadow Arbitrage production release

**Date:** 2026-07-30
**Source branch:** `shadow-arbitrage-master`
**Previous production commit:** `393b756` (tagged `pre-v4.6.1`)
**Production site:** <http://price-monitoring.blumarkets.com>

Version flows from `package.json` → `next.config.ts` (`NEXT_PUBLIC_APP_VERSION`)
→ `src/lib/version.ts` → the login footer, so `4.6.1` appears on the site once
the image is rebuilt.

---

## What ships

### Shadow Arbitrage — read-only observation system (new, admin-only)

Nine domestic USDT venues are polled server-side every 30 s and normalized into
one comparable view. **No credentials, no authenticated exchange endpoints, no
orders, balances, deposits, withdrawals or transfers exist anywhere in the
module.** OMPFinex is deliberately absent from Shadow Arbitrage and untouched in
the main OTC project.

* **Adapters** rewritten against verified live responses: declared price units
  (IRR/IRT) rather than sniffing, documented direction mapping, per-source
  latency, HTTP status and attempt counts, retry/backoff and 429 awareness.
* **No fabricated depth** — a headline-only response never yields a fillable
  size; multi-level executable VWAP or nothing.
* **Certification**: `LIVE_VERIFIED` only after a real public response *and*
  validated normalization; otherwise `LIVE_DEGRADED` / `REFERENCE_ONLY` /
  `UNSUPPORTED` with the exact reason. Tetherland is capped at degraded
  (inferred field inversion) and Arzinja at reference-only (undocumented API).
* **Fixed** Ramzinex endpoint (`/orderbooks/11` → 404, correct path is
  `/buys_sells`) and the Arzinja JSON path (`result.bids`, not `data.bids`).
* **Economics** keep raw spread, fees, risk buffer, net edge and net profit
  separate. Unknown fees are reported as *raw potential*, never expected profit.
* **Persistence**: dedicated `shadow_*` tables — collection runs, source
  snapshots, opportunity lifecycles, lifecycle transitions, source-health events,
  route aggregates, observation sessions, worker heartbeat. One persistent
  opportunity stays one lifecycle. 14-day retention that never truncates an
  active lifecycle.

### Persian admin dashboard

`/shadow-arbitrage`, admin-only, RTL: observation status header, eight summary
cards, filterable/sortable/searchable opportunity table, a details drawer with
the exact calculation, source & account table with evidence-based
account-opening priority, and analytics. Dark/light, responsive, with skeleton,
empty, stale and error states. The permanent banner
«حالت آزمایشی — هیچ سفارش یا انتقال واقعی انجام نمی‌شود» is unconditional.

### Production collector

New compose service `iman-otc-shadow-worker`: the same image started with
`SHADOW_COLLECTOR=1`, `restart: unless-stopped`, **no published ports**,
`AUTO_IMPORT_LEGACY=0`, log rotation at 5×10 MB. The production image is a Next
standalone build without `tsx`, so the collector runs through the server's
instrumentation hook — a bootstrap hook, not a request handler, so it never
depends on a browser. Exactly one collector is enforced by a PostgreSQL advisory
lock, a heartbeat lease and a per-interval idempotency key.

### Security and caching

Shadow page and APIs send `private, no-store` plus `CDN-Cache-Control`,
`Surrogate-Control`, `Vary: Cookie` and `X-Robots-Tag`, so ArvanCloud and any
shared cache stay out of authenticated admin responses. Admin-only health at
`GET /api/shadow-arbitrage/health` exposes no endpoint URLs, stack traces or
database details.

### Local developer experience

`pnpm shadow:local` runs app + collector from one terminal with a single Ctrl+C,
and `pnpm build:verify` builds into an isolated dist dir so a verification build
can never corrupt a running server's build.

---

## Database migrations — additive only

| File | Effect |
| --- | --- |
| `0001_shadow_arbitrage.sql` | `CREATE TABLE IF NOT EXISTS` for 5 new `shadow_*` tables + indexes |
| `0002_shadow_arbitrage_phase2.sql` | `ADD COLUMN IF NOT EXISTS` and `CREATE TABLE IF NOT EXISTS` only (3 more tables, extra columns, indexes) |

No `DROP`, no `TRUNCATE`, no `DELETE`, no `ALTER … TYPE`, no renames. Nothing
existing is modified, so reverting the code leaves the new tables unused and
harmless. Money columns are `numeric`; all timestamps are `timestamp with time
zone`.

## Rollback

```bash
# code only — no data is touched
git revert --no-commit <release shas> && git commit -m "revert: v4.6.1"
git push            # poller redeploys within ~30–60s
# or pin production to the previous release
git checkout pre-v4.6.1
```

Tags: `pre-v4.6.1` (previous production commit) and `v4.6.1` (this release).

## Verification before release

| Check | Result |
| --- | --- |
| `npm test` (12 suites) | 261 assertions, 0 failures |
| `pnpm typecheck` | clean |
| `pnpm lint` | 0 errors (17 pre-existing warnings, unrelated files) |
| `pnpm build:verify` | isolated production build OK |
| Secret / forbidden-file audit | clean — no `.env*`, `.data/`, PGlite, backups, logs, keys or `.next*` tracked |
| Local always-on run | app + collector, cycles recorded across restarts, zero duplicate cycles |
