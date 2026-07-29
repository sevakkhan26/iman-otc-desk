# Shadow Arbitrage — Phase 2

Live source certification and automatic 14-day observation.

**This module is read-only and stays read-only.** It reads public market data
over unauthenticated HTTP GET and writes rows to the database. There are no API
keys, no authenticated endpoints, no balances, no order placement or
cancellation, no deposits, no withdrawals, no transfers, and no automatic
trading anywhere in `src/lib/shadowArbitrage/**`, the shadow APIs, the worker, or
the admin page. The `SHADOW MODE — NO REAL ORDERS OR FUND TRANSFERS` banner is
rendered unconditionally.

**OMPFinex separation.** OMPFinex remains fully functional in the main OTC
project (`src/lib/providers/domestic.ts` is untouched, and its dashboard usage is
unchanged). It is absent from every Shadow Arbitrage source list, adapter,
calculation, API, UI table and test. `pnpm test:shadow` asserts this
mechanically: no executable line in the shadow module may reference it.

---

## 1. Running it locally — one command

```bash
pnpm shadow:local
```

That is the whole local environment: app on <http://127.0.0.1:3000> plus the
collector, in one terminal, stopped by a single `Ctrl+C`. It:

1. identifies whatever holds port 3000 and stops it **only** if it belongs to
   this project — including the `net.blumarkets.otcdesk` launchd KeepAlive
   agent, which is booted out so it cannot respawn and is restored on exit;
2. runs database migrations first and aborts loudly if they fail;
3. builds into an **isolated** dist dir (`.next-local`), so it can never corrupt
   the `.next` build the launchd server serves;
4. starts the app and the collector, streaming prefixed `[app]` / `[worker]` logs;
5. forwards `SIGINT`/`SIGTERM` to every child and waits for a clean exit;
6. refuses to start twice (pidfile at `.data/shadow-local.pid`).

Useful env: `SHADOW_POLL_MS` (15000–300000, default 30000),
`SHADOW_LOCAL_PORT`, `SHADOW_LOCAL_DIST`, `SHADOW_LOCAL_SKIP_BUILD=1`.

### Why the collector runs inside the app process on PGlite

A PGlite data directory has exactly one safe writer. Two processes can both
*open* the same directory without erroring, then silently lose each other's
writes — verified on this machine: with A and B both open, B's committed row
vanished when A closed. That is what damaged `.data/pglite-local` (the app's own
log recorded `PGlite init failed … Aborted()` on every DB access, and the project
client already prints *"For multi-process use real Postgres"*).

So the collector's placement follows the database:

| DATABASE_URL | Collector placement | Why |
| --- | --- | --- |
| `pglite:…` | inside the app process, via `instrumentation.ts` → `instrumentation.node.ts` | one writer per data dir |
| `postgres://…` | separate `shadow:worker` child process | real Postgres handles concurrency |

Either way collection is driven by a server-side loop at bootstrap — never by a
request handler, and never by a browser being open.

Guards against a second writer:

* `pnpm shadow:worker` **refuses to start** if its PGlite dir is already open by
  another process (`lsof +D`), naming the offending pid.
* The collector lease in `shadow_worker_heartbeat` refuses a second collector,
  and a lease whose owning process is gone on this host is reclaimed
  immediately, so a restart resumes within seconds instead of waiting it out.
* The interval-bucket idempotency key with a unique index stops duplicate cycles.

## 1b. Standalone collector (production / real Postgres)

```bash
# default: 30s interval, DATABASE_URL from .env.local (loaded automatically now)
pnpm shadow:worker

# explicit interval (clamped to 15000–300000 ms)
SHADOW_POLL_MS=30000 pnpm shadow:worker

# bounded run, used by the soak test
SHADOW_MAX_CYCLES=6 pnpm shadow:worker
```

## 1c. Builds never collide

| Command | Writes to | Use |
| --- | --- | --- |
| `pnpm build` | `.next` | the build the launchd server serves |
| `pnpm build:verify` | `.next-verify` | verification builds — safe while anything is running |
| `pnpm shadow:local` | `.next-local` | the unified local environment |

Verified: running `pnpm build:verify` left both `.next/BUILD_ID` and
`.next-local/BUILD_ID` byte-identical while the app kept serving and the
collector kept recording cycles.

The worker runs migrations, claims a cooperative lease, then collects on a fixed
interval until `SIGINT`/`SIGTERM`. A signal interrupts the sleep immediately, the
in-flight cycle finishes, the lease is released, and the database handle is
closed — so a restart can take over at once instead of waiting for a stale lease
to expire. No browser is involved at any point.

Other commands:

| Command | Purpose |
| --- | --- |
| `pnpm shadow:certify` | Live public probe of all nine sources, prints the certification evidence below. `SHADOW_CERTIFY_ROUNDS=3` repeats it. |
| `pnpm shadow:soak` | Spawns two real worker processes (restart in the middle) and verifies the database afterwards. |
| `pnpm test:shadow` | Unit tests + database persistence tests. |

### Polling and rate-limit behaviour

* Default interval 30 s; configurable via `SHADOW_POLL_MS`, clamped to
  **15 000–300 000 ms** (`clampPollInterval`).
* Per-source timeout from `ShadowSourceConfig.timeoutMs` (10–12 s).
* Up to 3 attempts per source with exponential backoff (400 ms → 800 ms → …,
  capped at 4 s). A permanent 4xx is **not** retried; an HTTP 429/418 adds a
  further 5 s before the next attempt and marks the cycle `rate_limited`.
* A self-imposed minimum spacing per host (1 000–2 000 ms) so a retry storm can
  never hammer a public endpoint.
* Failure isolation: sources are collected with `Promise.allSettled`, so one dead
  venue cannot abort a cycle.
* Single-flight: an in-process guard plus a PostgreSQL advisory lock, plus an
  interval-bucket idempotency key with a unique index. Two workers waking in the
  same bucket derive the same key and the second is rejected as a duplicate.
* Manual refresh from the UI is throttled to one cycle per 15 s and shares the
  same single-flight path; if throttled, the persisted cache is served instead.
  Manual refresh is never the primary collection mechanism.

---

## 2. Source certification

Probed live on **2026-07-29 / 2026-07-30** with `SHADOW_CERTIFY_ROUNDS=3`. All
nine endpoints returned HTTP 200 in every round.

`LIVE_VERIFIED` requires a real public response **and** validated normalization:
resolved price unit, confirmed user-buy/user-sell direction, and either a
walkable multi-level book or a published OTC maximum. Anything less is
`LIVE_DEGRADED` with the exact reason shown in the UI.

| Source | Status | Endpoint (public) | Symbol | Model | Price unit → | Qty | Depth | Exchange ts | p50 / p95 latency | Fee | Rate limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Nobitex | `LIVE_VERIFIED` | `apiv2.nobitex.ir/v3/orderbook/USDTIRT` | USDTIRT | order book | IRR ÷10 → IRT | USDT | ~24 levels/side | `lastUpdate` epoch ms — used for staleness | 88 / 393 ms | 0.25 % taker, **provisional** | none published |
| Wallex | `LIVE_VERIFIED` | `api.wallex.ir/v1/depth?symbol=USDTTMN&limit=50` | USDTTMN | order book | IRT | USDT | multi-level `{price,quantity,sum}` | none | 287 / 404 ms | 0.35 % taker, **provisional** | none published |
| Tabdeal | `LIVE_VERIFIED` | `api1.tabdeal.org/r/api/v1/depth?symbol=USDTIRT&limit=50` | USDTIRT | order book | IRT (despite IRT-in-name, values are toman) | USDT | 50 levels/side | none | 398 / 10 876 ms | 0.35 % taker, **provisional** | none published |
| Bitpin | `LIVE_VERIFIED` | `api.bitpin.ir/api/v1/mth/orderbook/USDT_IRT/` | USDT_IRT | order book | IRT | USDT | 20 levels/side | none | 217 / 565 ms | **unknown** | none published |
| AbanTether | `LIVE_VERIFIED` | `api.abantether.com/api/v1/manager/otc/ticker` | USDTIRT | OTC quote | IRT | USDT (inferred, see limits) | n/a — single quote, max 50 000 | none | 404 / 738 ms | **unknown** (embedded in spread) | none published |
| Ramzinex | `LIVE_VERIFIED` | `publicapi.ramzinex.com/exchange/api/v1.0/exchange/orderbooks/11/buys_sells` | pair 11 (USDT/IRR) | order book | IRR ÷10 → IRT | USDT | multi-level tuples | per-order epoch only — **not** used for staleness | 320 / 543 ms | **unknown** | none published |
| Tetherland | `LIVE_DEGRADED` | `market.tetherland.com/prices` | USDTTMN | P2P board | IRT | USDT | multi-level, outliers filtered | none | 280 / 899 ms | **unknown** | none published |
| Bit24 | `LIVE_VERIFIED` | `pro.bit24.cash/api/v3/markets/USDT-IRT/order-books` | USDT-IRT | order book | IRT | USDT | multi-level | none | 129 / 540 ms | **unknown** | none published |
| Arzinja | `REFERENCE_ONLY` | `api-v2.arzinja.ir/api/v1/trade/p2p/orderbook?pair=USDTIRT` | USDTIRT (P2P) | reference | IRT | USDT | multi-level P2P | `last_update`, no timezone — **not** used | 403 / 958 ms | **unknown** | `X-RateLimit-Limit: 100` |

### Direction validation (user-buy / user-sell)

Every source is normalized to *user buy* (what the user pays, the ask) and *user
sell* (what the user receives, the bid). A crossed book is **never** silently
swapped — it is flagged `quote_direction_unverified` and the source is degraded.

| Source | Mapping | Verified |
| --- | --- | --- |
| Nobitex | `asks` → user buy, `bids` → user sell | yes |
| Wallex | `result.ask` → user buy, `result.bid` → user sell | yes |
| Tabdeal | `asks` → user buy, `bids` → user sell | yes |
| Bitpin | `asks` → user buy, `bids` → user sell | yes |
| AbanTether | `buy_price` → user buy, `sell_price` → user sell; `buy_price > sell_price` holds across the whole payload | yes (invariant checked every cycle) |
| Ramzinex | `data.sells` → user buy, `data.buys` → user sell | yes |
| Tetherland | field `asks` actually holds bids and field `bids` holds asks | **no** — inferred from ordering, not documented |
| Bit24 | `sell_orders` → user buy, `buy_orders` → user sell | yes |
| Arzinja | `result.asks` / `result.bids` appear standard | **no** — undocumented |

### Limitations recorded per source

* **Nobitex** — the legacy `v2/orderbook` endpoint is deliberately *not* used as
  a fallback: its `asks` ordering did not match v3 on probe, so its direction is
  unconfirmed and falling back could publish inverted prices.
* **Wallex / Ramzinex** — if depth is empty, the adapter falls back to a
  headline-only quote (`markets` ticker / `pairs/11`). Those responses publish no
  sizes, so the snapshot is marked `depthAvailable: false`, every trade size
  becomes non-fillable (`depth_unverified`), and the source is degraded. No level
  amounts are invented.
* **Tabdeal** — the symbol says IRT but the values are toman. The unit is
  declared from observation and cross-checked against the cross-venue median
  every cycle; a rial reading falls outside the plausibility band and is
  rejected rather than rescaled.
* **AbanTether** — `buy_max`/`sell_max` (50 000) are read as **asset quantity**.
  The venue does not document the unit; the reading is supported by the fact
  that the values scale inversely with unit price across the payload (MORI 200,
  ELSA 500, EURI 2 000, USDT 50 000). Because the account is unverified, every
  route through this venue is `ACCOUNT_REQUIRED` regardless.
* **Tetherland** — a P2P offer board with inverted field names and junk levels
  (observed up to 50 501 202 toman). Outliers are removed by the plausibility
  band plus a ±8 % anchor band. Because the direction mapping is inferred rather
  than published, this source is **capped** at `LIVE_DEGRADED` by design.
* **Bit24** — a WAF may throttle some egress IPs.
* **Arzinja** — the previous implementation read `data.bids`, which does not
  exist; the correct path is `result.bids`/`result.asks`, and it is now parsed
  correctly. The source nevertheless stays **`REFERENCE_ONLY` by mandate**: one
  successful probe against an undocumented `api-v2` P2P host is not a verified
  stable official market-data API, and `last_update` carries no timezone.

Certification status can never exceed a source's documented ceiling
(`maxStatus`): Arzinja is capped at `REFERENCE_ONLY`, Tetherland at
`LIVE_DEGRADED`. A source that has never returned a usable response is
`UNSUPPORTED`; a source that used to work and then fails is `LIVE_DEGRADED`, not
`UNSUPPORTED`.

---

## 3. Fees and cost assumptions

Every fee record carries a value, a status, a reference, a verification date and
an explanation. **No personal fee tier is inferred** — that would require
authenticated account data, which this phase does not use.

| Item | Value | Status | Reference | Checked | Note |
| --- | --- | --- | --- | --- | --- |
| Nobitex taker | 0.25 % | `provisional` | <https://nobitex.ir/fees/> | 2026-07-01 | kept as the provisional value |
| Wallex taker | 0.35 % | `provisional` | <https://wallex.ir/fees> | 2026-07-01 | conservative |
| Tabdeal taker | 0.35 % | `provisional` | — | 2026-07-01 | no verified public schedule captured |
| Bitpin / Ramzinex / Tetherland / Bit24 | — | `unknown` | — | — | raw spread only |
| AbanTether | — | `unknown` | — | — | OTC fee is embedded in the quote spread |
| Arzinja | — | `unknown` | — | — | reference only |
| Slippage / risk buffer | 0.05 % of buy cost | `provisional` | — | 2026-07-01 | not derived from execution data |
| Rebalancing cost | 0 toman | `provisional` | — | 2026-07-01 | real transfer cost is unprovable without account data |

When a required fee is unknown the route reports **raw spread only**, is tagged
`fee_unknown`, is never classified net-positive, and is ranked as *raw
opportunity potential* rather than expected profit. Raw spread, fees, buffer,
net edge and net profit are stored and displayed as separate quantities.

---

## 4. Opportunity validation

Trade sizes: **5, 10, 20, 25 USDT**.

* Order-book venues: multi-level executable VWAP by walking the book. A size
  that cannot be filled to ≥99.5 % is rejected as insufficient depth. The
  headline best price is never substituted for a full-size execution.
* OTC quote venues: direction validated, published maximum enforced. An unknown
  maximum yields `quote_max_unverified` and no fillable size.
* A route can never be valid or net-positive when any of these hold:
  `stale_buy_source`, `stale_sell_source`, `source_unhealthy`,
  `insufficient_buy_depth`, `insufficient_sell_depth`, `depth_unverified`,
  `quote_direction_unverified`, `quote_max_unverified`, `fee_unknown`,
  `units_ambiguous`, `rate_limited`, `source_not_certified`,
  `market_data_missing`, or `account_required`.
* A cross-source sanity pass degrades any venue whose mid sits more than 8 % from
  the cross-venue median, on the grounds that a unit or field-mapping error is
  far more likely than a real 8 % dislocation.

---

## 5. Storage architecture and 14-day volume

History is **not** kept as a growing JSON value in `app_settings`. Two bounded,
overwritten key/value rows remain as UI caches only (latest matrix, latest
certification records).

Expected volume at nine sources, a 30 s interval, four trade sizes, 14 days:

| Entity | Table | Rows in 14 days | Basis |
| --- | --- | --- | --- |
| Collection runs | `shadow_collection_runs` | **40 320** | 2 880 cycles/day × 14 |
| Source snapshots | `shadow_source_snapshots` | **362 880** | 40 320 × 9 sources |
| Route aggregates | `shadow_route_metrics` | **≤ 4 032** | 72 ordered pairs × 4 sizes × 14 days |
| Opportunity lifecycles | `shadow_opportunity_lifecycles` | one row per *lifecycle*, not per cycle | a persistent opportunity stays one row |
| Lifecycle transitions | `shadow_opportunity_events` | one row per open / eligibility change / close / reappearance | ~6 per cycle observed in the soak |
| Source health events | `shadow_source_health_events` | one row per health/certification **change** | not one per cycle |
| Observation sessions | `shadow_observation_sessions` | 1 | reused across restarts |

Naively persisting every venue pair every cycle would produce
40 320 × 72 × 4 ≈ **11.6 million** rows. That is exactly what this design avoids:
only *material* routes (positive raw spread) get a lifecycle row, everything else
is folded into the per-route/per-day aggregates.

Other storage properties:

* UTC, server-authoritative timestamps (`timestamp with time zone`).
* Exact `numeric` money and percentage columns — no floats.
* Indexes on time, source+time, route, route+active, active, and bucket date.
* Idempotency key with a unique index on collection runs.
* Retention sweep deletes runs (snapshots cascade), health events, lifecycle
  events and route buckets older than 14 days; a lifecycle is only removed once
  it is both closed and outside the window, so an in-flight opportunity is never
  truncated.
* Migration `0002_shadow_arbitrage_phase2.sql` is additive only — `ADD COLUMN IF
  NOT EXISTS` and `CREATE TABLE IF NOT EXISTS`, no drops, no rewrites. Phase 1
  rows are preserved.

---

## 6. Observation lifecycle

`shadow_observation_sessions` holds exactly one session, with statuses
`NOT_STARTED`, `RUNNING`, `PAUSED`, `DEGRADED`, `COMPLETED`. It tracks start
time, elapsed (excluding paused time), 14-day target, completed / successful /
partial / failed cycles, cycle coverage, last heartbeat, last successful
collection and end time.

Restarting the application or the worker reuses the same session: counters,
start time and lifecycle rows all survive. `PAUSED` is never auto-resumed by a
worker start — only an explicit admin action resumes it
(`POST /api/shadow-arbitrage/observation` with `{"action":"resume"}`).

Duplicate-worker prevention has three layers: the advisory lock (PostgreSQL), the
cooperative lease in `shadow_worker_heartbeat` (a second worker exits at startup
while the lease is held), and the interval-bucket idempotency key.

---

## 7. Verification

```bash
pnpm test:shadow      # 38 unit tests + 13 persistence tests
pnpm typecheck
pnpm lint
pnpm build
pnpm shadow:soak      # 2 worker processes, restart in the middle
```

Soak result (2026-07-29, browser closed, 15 s interval, two worker processes of
6 cycles each): **15/15 checks passed** — 11 cycles recorded automatically, zero
duplicate runs, all 9 sources probed in every cycle, 60 active lifecycles carried
across the restart with one row per route, session id and start time unchanged,
288 route aggregate buckets, 76 transition events, and the API read path
returning the collected data.
