# Phase 3 PAPER/FAKE implementation notes

## Scope and safety

This change implements simulated PAPER/FAKE discovery, pricing, sizing, reservation, and session allocation only. It adds no authenticated exchange client, real-order call, transfer operation, deployment action, or production database mutation.

`src/lib/shadowArbitrage/live/capability.ts` is unchanged. `LIVE_EXECUTION_IMPLEMENTED === false` and `ExecutionSurface` remains `"PAPER" | "FAKE"`.

`PAPER_4D_MAX_ROUTE_CAPITAL_PERCENT` remains historical experiment metadata. It is not applied by the Phase-3 sizing domain, engine, portfolio allocator, or derived order-cap calculation.

## Files changed

Core economics, discovery, and types:

- `src/lib/shadowArbitrage/paper/canonicalEconomics.ts` (new canonical PAPER economics)
- `src/lib/shadowArbitrage/fees.ts`
- `src/lib/shadowArbitrage/paper/broker.ts`
- `src/lib/shadowArbitrage/calculate.ts`
- `src/lib/shadowArbitrage/types.ts`
- `src/lib/shadowArbitrage/vwap.ts`

Sizing, caps, reservations, and engine:

- `src/lib/shadowArbitrage/paper/dynamicRiskCap.ts` (new exported dynamic E cap)
- `src/lib/shadowArbitrage/paper/sizing.ts`
- `src/lib/shadowArbitrage/paper/adaptiveSizeSolver.ts`
- `src/lib/shadowArbitrage/paper/smartCandidates.ts`
- `src/lib/shadowArbitrage/paper/venueExecutionLimits.ts`
- `src/lib/shadowArbitrage/paper/engine.ts`
- `src/lib/shadowArbitrage/paper/reasons.ts`
- `src/lib/shadowArbitrage/paper/portfolioAllocator.ts`
- `src/lib/shadowArbitrage/paper/run.ts`

Liquidity-aware session opening and experiment policy:

- `src/lib/shadowArbitrage/paper/allocation.ts`
- `src/lib/shadowArbitrage/paper/sessionCapital.ts`
- `src/lib/shadowArbitrage/paper/experimentBootstrap.ts`
- `src/lib/shadowArbitrage/paper/experimentPolicy.ts`
- `app/api/shadow-arbitrage/paper/session-capital/route.ts`

Audit/UI wording:

- `src/db/schema.ts`
- `src/components/shadowArbitrage/CommandCenter.tsx`

Tests:

- `scripts/test-phase3-paper-optimizer.mts` (new mandatory deterministic suite)
- `scripts/test-smart-sizing.mts`
- `scripts/test-shadow-sizing.mts`
- `scripts/test-shadow-arbitrage.mts`
- `scripts/test-shadow-liquidity.mts`
- `scripts/test-paper-4d-experiment.mts`
- `scripts/test-capital-aware-sizing.mts`
- `scripts/test-session-capital.mts`
- `scripts/test-step4-min-size-and-capital.mts`
- `scripts/test-step4-lifecycle-fixture.mts`

## Canonical economics implemented

All decision paths use `computeCanonicalEconomics` directly or through the thin `computeRouteEconomics` compatibility wrapper. Both legs must be completely walked. Rounded child notionals are preserved, the sell-side USDT fee is marked at the same quantity's buy VWAP, impact is reported but not deducted twice, and the 5 bps market-risk buffer is added to a non-negative inventory penalty. A required rebalance with missing or zero confirmed cost returns `rebalance_required_unpriced`.

The eligibility denominator is fee-inclusive buy debit. Simultaneous capital `K` is fee-inclusive buy IRT debit plus the capital mark of sell USDT debit. Discovery, sizing, and the simulated broker therefore share the same EconomicNet and RiskAdjustedPnL arithmetic.

## Dynamic-cap pseudocode as implemented

```text
computeDynamicRiskCap(input):
  if snapshot stale, venue unhealthy, fee uncertain, settlement unknown,
     required data missing, inventory unmeasurable, or two-leg walk incomplete:
       return { ok: false, structural code }

  headrooms = [
    accepted buy HARD-10-bps depth B,
    accepted sell HARD-10-bps depth B,
    complete two-leg quantity C,
    fee-inclusive buy and sell balance capacity,
    role-aware venue allocation D,
    measured hard inventory-band crossing D,
    free paper capital E,
    remaining global utilization and reserve E,
    buy and sell venue concentration E,
    capacity left after concurrent atomic reservations E,
    verified venue maximum (when supplied),
    admin order maximum (when configured),
    one late numeric clip (when required)
  ]

  q_e = min(all finite, non-negative measured headrooms)
  return q_e, every input headroom, and all binding headroom names
```

There is no `PAPER_4D_MAX_ROUTE_CAPITAL_PERCENT` term in this minimum.

## Optimizer pseudocode as implemented

```text
q_min  = max(paper_policy_min, verified buy/sell venue minima)
step   = lcm(buy quantity step, sell quantity step, ledger 100 micros)
q_e    = computeDynamicRiskCap(...)
q_max  = floor(q_e / step) * step

vertices = {
  q_min, q_max,
  cumulative accepted buy-ask endpoints,
  cumulative accepted sell-bid endpoints,
  inventory/capacity crossing endpoint,
  floored RA=0 crossings,
  floored configured edge-floor crossings
}

for q in sorted unique vertices within [q_min, q_max]:
  walk both books 100%; incomplete walk is illegal
  price with canonical economics
  apply exact fee-inclusive balances and hard inventory band
  eligible = RA > 0 and NetEdgeBps >= configured floor and all gates pass

q_star = argmax eligible candidate by:
  RiskAdjustedPnL,
  CapitalEfficiencyBps,
  less inventory worsening,
  lower K,
  smaller q

if a later numeric engine cap is tighter:
  replace q_max with that cap and run the same optimizer once
if a structural fact fails:
  SKIP/BLOCK; do not guess or clip
```

Midpoint densification and `selectLargestValid` remain deprecated analysis helpers and are not called by execution. The historical 5/10/20/25 probes are analysis-only. Route identity is `buySourceId->sellSourceId`; `sizeUsdt` is the optimizer output.

## Allocation and sequential execution

Session preview and experiment bootstrap now build opening allocations from fresh, healthy, certified, fee-certain books. A raw TOB cross establishes buy/sell roles; remainder weight is accepted HARD-10-bps two-leg depth times fee/risk-adjusted TOB economics. Eligible venues receive the discovery floor, buy roles receive IRT, sell roles receive USDT, and the global reserve remains unallocated. Fewer than two complementary roles or failure to fund one buy and one sell venue at `q_min` makes the opener invalid and leaves capital in reserve.

The engine ranks routes by standalone RA, processes them sequentially, re-sizes each route against balances left by earlier atomic dual-leg holds, and never double-reserves one simulated balance. No joint/MIP solver was added.

## Replay telemetry

`SizingAudit` records the `MAX_RA_PNL` objective and canonical economics version; raw visible A; accepted HARD-10-bps B; complete two-leg C; balance, allocation, and inventory D headrooms; all dynamic E inputs and bindings; reservation headroom; q-pre, execution step, rounded/chosen F; both VWAPs; fee components; observed impact; risk buffer; K; every evaluated breakpoint with eligibility/rejection; the next-larger rejection; and binding constraints.

## Verification results

Required commands:

- `npx --yes tsx scripts/test-phase3-paper-optimizer.mts` — 15 passed, 0 failed
- `npx --yes tsx scripts/test-smart-sizing.mts` — 37 passed, 0 failed
- `npx --yes tsx scripts/test-shadow-sizing.mts` — 29 passed, 0 failed
- `npx --yes tsx scripts/test-shadow-arbitrage.mts` — 125 passed, 0 failed
- `npx --yes tsx scripts/test-paper-accounting.mts` — 6 passed, 0 failed
- `npx --yes tsx scripts/test-session-setup.mts` — 9 passed, 0 failed
- `npx --yes tsx scripts/test-paper-4d-experiment.mts` — 16 passed, 0 failed
- `npx --yes tsx scripts/test-shadow-liquidity.mts` — 43 passed, 0 failed
- `npx --yes tsx scripts/test-shadow-allocation-store.mts` — 15 passed, 0 failed

Additional regressions:

- `npx --yes tsx scripts/test-capital-aware-sizing.mts` — 11 passed, 0 failed
- `npx --yes tsx scripts/test-session-capital.mts` — 4 passed, 0 failed
- `npx --yes tsx scripts/test-step4-min-size-and-capital.mts` — 12 passed, 0 failed
- `npx --yes tsx scripts/test-step4-lifecycle-fixture.mts` — passed (`ok: true`, one simulated fill, restart proof true)
- `npx tsc --noEmit` — passed
- `git diff --check` — passed

## Emergency fail-safe proposal only (not implemented)

No absolute emergency notional ceiling was technically required and none was implemented. If operations later require one, it should be a new, explicitly named, admin-approved and expiry-bound PAPER policy with visible provenance, a dedicated dynamic-E headroom/audit key, and fail-closed behavior when unset. It must not reuse, reinterpret, or silently raise `PAPER_4D_MAX_ROUTE_CAPITAL_PERCENT`, and it must clip the feasible domain followed by one re-optimization rather than acting as an order-size preference.
