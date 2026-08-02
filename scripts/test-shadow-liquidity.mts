#!/usr/bin/env npx tsx
/**
 * Phase 8C-4 — deterministic tests for liquidity-aware sizing and allocation.
 *
 * Pure: no browser, no network, no database. Every risk policy used here is
 * supplied explicitly by the test; production contains no default for any of
 * them, and a test below proves that.
 */
import assert from "node:assert/strict";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (e) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e instanceof Error ? (e.stack ?? e.message) : e}`);
    failed += 1;
  }
}

const {
  candidateQuantities,
  cumulativeCurve,
  totalDepthMicros,
  validateBook,
  venueCapacity,
  walkBook,
  usdtToMicros,
  microsToUsdt,
  CAP_LABEL_FA,
  VENUE_CAPACITY_REASON_FA,
  checkQuote
} = await import("../src/lib/shadowArbitrage/paper/liquidity.ts");
const { computeRouteSize, SIZING_REQUIRED_POLICIES } = await import(
  "../src/lib/shadowArbitrage/paper/sizing.ts"
);
const { buildLiquidityAwarePlan, deriveVenueDemand, DISCOVERY_FLOOR_PERCENT } = await import(
  "../src/lib/shadowArbitrage/paper/allocation.ts"
);
const { buildPolicyState } = await import("../src/lib/shadowArbitrage/live/policy.ts");
const { planFill, applyFill } = await import("../src/lib/shadowArbitrage/paper/broker.ts");

type Any = Record<string, unknown>;

const IRT_FEE = { feeAsset: "IRT", debitMode: "ADD_TO_DEBIT", provenance: "ADMIN_CONFIRMED" } as const;
const USDT_FEE = { feeAsset: "USDT", debitMode: "ADD_TO_DEBIT", provenance: "ADMIN_CONFIRMED" } as const;

function policies(over: Partial<Record<string, number | undefined>> = {}) {
  const base: Record<string, number> = {
    max_order_size_usdt: 1_000_000,
    max_venue_exposure_percent: 100,
    min_risk_adjusted_edge_percent: 0,
    max_quote_age_ms: 90_000,
    max_slippage_bps: 100
  };
  const merged: Record<string, number | undefined> = { ...base, ...over };
  return buildPolicyState(
    Object.entries(merged)
      .filter(([, v]) => v !== undefined)
      .map(([key, value]) => ({
        key: key as never,
        value: value as number,
        provenance: "ADMIN_APPROVED" as const,
        setBy: "test",
        setAt: "2026-08-02T00:00:00.000Z",
        validForDays: null,
        note: null
      })),
    Date.parse("2026-08-02T12:00:00.000Z")
  );
}

const lv = (priceToman: number, amountUsdt: number) => ({ priceToman, amountUsdt });

/** A venue snapshot carrying a real walkable book. */
function snap(sourceId: string, bids: Any[], asks: Any[], over: Any = {}): Any {
  return {
    sourceId,
    sourceName: sourceId,
    ageMs: 5_000,
    stale: false,
    health: "healthy",
    sizeExecutables: [],
    bookBids: bids,
    bookAsks: asks,
    ...over
  };
}

function routeInput(over: Any = {}): Any {
  return {
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    // Buy venue: asks climb. Sell venue: bids fall.
    buySnapshot: snap("nobitex", [lv(99_000, 1_000)], [lv(100_000, 100), lv(100_500, 100), lv(102_000, 1_000)]),
    sellSnapshot: snap("wallex", [lv(101_500, 100), lv(101_000, 100), lv(99_500, 1_000)], [lv(103_000, 1_000)]),
    buyFeeBps: 25,
    sellFeeBps: 35,
    buySettlement: IRT_FEE,
    sellSettlement: USDT_FEE,
    balances: [
      { sourceId: "nobitex", irtToman: 10_000_000_000, usdtMicros: usdtToMicros(100_000) },
      { sourceId: "wallex", irtToman: 10_000_000_000, usdtMicros: usdtToMicros(100_000) }
    ],
    buyVenueAllocationToman: 10_000_000_000,
    portfolioValueToman: 10_000_000_000,
    buyVenueExposureToman: 1_000_000_000,
    policies: policies(),
    slippageBufferBps: 5,
    ...over
  };
}

const size = (over: Any = {}) => computeRouteSize(routeInput(over) as never);

/* ── 1. book walking, cumulative depth and child fills ───────────────────── */

await test("the cumulative curve is monotonic and its VWAP degrades with size", () => {
  const asks = [lv(100_000, 10), lv(101_000, 10), lv(103_000, 10)];
  const curve = cumulativeCurve(asks as never, "buy");
  assert.deepEqual(curve.map((p) => p.cumulativeMicros), [
    usdtToMicros(10),
    usdtToMicros(20),
    usdtToMicros(30)
  ]);
  assert.deepEqual(curve.map((p) => p.vwapToman), [100_000, 100_500, 101_333]);
  for (let i = 1; i < curve.length; i += 1) {
    assert.ok(curve[i].cumulativeMicros > curve[i - 1].cumulativeMicros, "quantity increases");
    assert.ok(curve[i].vwapToman > curve[i - 1].vwapToman, "a buy VWAP only gets worse");
  }
});

await test("child fills consume each level exactly once and never reuse liquidity", () => {
  const asks = [lv(100_000, 10), lv(101_000, 10), lv(103_000, 10)];
  const w = walkBook(asks as never, usdtToMicros(25), "buy");
  assert.equal(w.complete, true);
  assert.equal(w.fills.length, 3, "three child fills across three levels");
  assert.deepEqual(w.fills.map((f) => f.quantityMicros), [
    usdtToMicros(10),
    usdtToMicros(10),
    usdtToMicros(5)
  ]);
  // The ladder consumes exactly the requested quantity — no level double-counts.
  assert.equal(
    w.fills.reduce((s, f) => s + f.quantityMicros, 0),
    usdtToMicros(25)
  );
  // And never more than each level holds.
  const byPrice = new Map(asks.map((a) => [a.priceToman, usdtToMicros(a.amountUsdt)]));
  for (const f of w.fills) {
    assert.ok(f.quantityMicros <= (byPrice.get(f.priceToman) as number), "a level cannot overfill");
  }
  assert.equal(w.bestPriceToman, 100_000);
  assert.equal(w.worstPriceToman, 103_000);
  assert.equal(w.vwapToman, Math.round((100_000 * 10 + 101_000 * 10 + 103_000 * 5) / 25));
  assert.ok(w.priceImpactPercent > 0, "a size that walks three levels has impact");
  assert.equal(w.bookParticipationPercent, Math.round((25 / 30) * 1_000_000) / 10_000);
});

await test("a walk never extrapolates past the last observed level", () => {
  const asks = [lv(100_000, 10)];
  const w = walkBook(asks as never, usdtToMicros(50), "buy");
  assert.equal(w.complete, false, "an oversized request is not complete");
  assert.equal(w.filledMicros, usdtToMicros(10));
  assert.equal(w.unfilledMicros, usdtToMicros(40), "the remainder is reported, not invented");
  assert.equal(w.fills.length, 1);
  assert.equal(w.vwapToman, 100_000, "priced only on what existed");
});

await test("a shallow book and a deep book size very differently", () => {
  const deep = size();
  const shallow = size({
    buySnapshot: snap("nobitex", [lv(99_000, 1_000)], [lv(100_000, 3)]),
    sellSnapshot: snap("wallex", [lv(101_500, 3)], [lv(103_000, 1_000)])
  });
  assert.equal(deep.status, "SIZED");
  assert.equal(shallow.status, "SIZED");
  assert.ok(
    (deep.sizeUsdtMicros as number) > (shallow.sizeUsdtMicros as number),
    "the deep book supports a bigger trade"
  );
  assert.equal(shallow.sizeUsdtMicros, usdtToMicros(3), "capped by the shallower side");
  assert.equal(shallow.bindingConstraint, "depth_evidence");
});

/* ── 2. book validation blocks rather than guessing ──────────────────────── */

await test("missing, empty, crossed and malformed books each block with a reason", () => {
  assert.equal(validateBook(null, [lv(1, 1)] as never).ok, false);
  assert.equal((validateBook(null, [lv(1, 1)] as never) as Any).problem, "book_missing");
  assert.equal((validateBook([] as never, [lv(1, 1)] as never) as Any).problem, "book_empty");
  // bid >= ask inside one venue is bad data, not a tight market.
  assert.equal(
    (validateBook([lv(101_000, 1)] as never, [lv(100_000, 1)] as never) as Any).problem,
    "book_crossed"
  );
  assert.equal(
    (validateBook([lv(-1, 1)] as never, [lv(100_000, 1)] as never) as Any).problem,
    "book_unusable_level"
  );
  assert.equal(validateBook([lv(99_000, 1)] as never, [lv(100_000, 1)] as never).ok, true);

  // And the sizer refuses on each of them, naming the venue.
  const noBook = size({ buySnapshot: snap("nobitex", null as never, null as never) });
  assert.equal(noBook.status, "BLOCKED");
  assert.ok(noBook.blockers.some((b) => b.code === "book_invalid" && b.subject === "nobitex"));

  const crossed = size({
    sellSnapshot: snap("wallex", [lv(104_000, 100)], [lv(103_000, 100)])
  });
  assert.equal(crossed.status, "BLOCKED");
  assert.ok(crossed.blockers.some((b) => b.code === "book_invalid" && b.subject === "wallex"));
});

await test("stale books block against the admin's own freshness budget", () => {
  const stale = size({
    buySnapshot: snap("nobitex", [lv(99_000, 1_000)], [lv(100_000, 100)], { ageMs: 91_000 })
  });
  assert.equal(stale.status, "BLOCKED");
  assert.ok(stale.blockers.some((b) => b.code === "stale_quote"));
});

/* ── 3. nonlinear VWAP and an interior optimum ───────────────────────────── */

await test("the optimum is interior: a larger size can earn less and must lose", () => {
  /*
   * Ten USDT are cheap to buy and dear to sell; beyond that the books turn
   * sharply against the trade. The profitable quantity is therefore 10, not the
   * 60 both books could technically absorb.
   */
  const r = size({
    buySnapshot: snap("nobitex", [lv(99_000, 1_000)], [lv(100_000, 10), lv(130_000, 50)]),
    sellSnapshot: snap("wallex", [lv(102_000, 10), lv(70_000, 50)], [lv(140_000, 1_000)])
  });
  assert.equal(r.status, "SIZED");
  assert.equal(r.sizeUsdtMicros, usdtToMicros(10), "the interior optimum wins");

  // The bigger quantity was evaluated and was genuinely worse.
  const big = r.candidates.find((c) => c.sizeUsdtMicros === usdtToMicros(60));
  assert.ok(big, "the larger quantity was considered, not skipped");
  assert.ok(
    (big?.riskAdjustedPnlToman ?? 0) < (r.economics?.riskAdjustedPnlToman ?? 0),
    "and it earns less than the chosen size"
  );
  // Maximum liquidity is reported next to the chosen size, and is larger.
  assert.ok((r.maxFeasibleUsdtMicros as number) > (r.sizeUsdtMicros as number));
});

await test("the whole profit curve is reported, ascending and evaluated at breakpoints", () => {
  const r = size();
  assert.ok(r.candidates.length >= 2, "several quantities were evaluated");
  for (let i = 1; i < r.candidates.length; i += 1) {
    assert.ok(
      r.candidates[i].sizeUsdtMicros > r.candidates[i - 1].sizeUsdtMicros,
      "candidates ascend"
    );
  }
  // Every candidate is a real, fully-fillable quantity with a walked VWAP.
  for (const c of r.candidates) {
    assert.ok(c.buyVwapToman > 0 && c.sellVwapToman > 0);
    assert.ok(c.buyLevels >= 1 && c.sellLevels >= 1);
  }
  // The chosen size is the argmax of the curve.
  const bestOnCurve = Math.max(...r.candidates.map((c) => c.riskAdjustedPnlToman));
  assert.equal(r.economics?.riskAdjustedPnlToman, bestOnCurve);
});

await test("a route that is unprofitable at every quantity blocks, showing its best try", () => {
  const r = size({
    sellSnapshot: snap("wallex", [lv(99_000, 1_000)], [lv(103_000, 1_000)])
  });
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.sizeUsdtMicros, null);
  assert.ok(r.blockers.some((b) => b.code === "not_net_positive"));
  assert.ok(r.economics, "the losing economics are shown, not hidden");
  assert.ok((r.economics?.riskAdjustedPnlToman ?? 0) <= 0);
});

/* ── 4. balances, allocation and fee settlement ──────────────────────────── */

await test("insufficient IRT caps the size at the walked price, not the best price", () => {
  const r = size({
    balances: [
      { sourceId: "nobitex", irtToman: 1_000_000, usdtMicros: usdtToMicros(100_000) },
      { sourceId: "wallex", irtToman: 10_000_000_000, usdtMicros: usdtToMicros(100_000) }
    ]
  });
  assert.equal(r.status, "SIZED");
  // Whatever was chosen must actually be fundable at its own walked VWAP.
  const need =
    (r.quote?.buyWalk.notionalToman as number) +
    Math.round(((r.quote?.buyWalk.notionalToman as number) * 25) / 10_000);
  assert.ok(need <= 1_000_000, `chosen size must be affordable: needed ${need}`);
});

await test("the sell USDT cap is fee-inclusive and blocks when it cannot cover one USDT", () => {
  const r = size({
    balances: [
      { sourceId: "nobitex", irtToman: 10_000_000_000, usdtMicros: usdtToMicros(100_000) },
      { sourceId: "wallex", irtToman: 10_000_000_000, usdtMicros: usdtToMicros(1) }
    ]
  });
  // 1 USDT cannot cover 1 USDT plus a 35bps fee, so nothing is tradeable.
  assert.equal(r.status, "BLOCKED");
  const cap = r.constraints.find((c) => c.key === "sell_usdt_balance")?.capUsdtMicros as number;
  assert.ok(cap < usdtToMicros(1), "the cap is fee-inclusive");
  assert.equal(r.blockers[0]?.code, "size_floor");
});

await test("allocation and concentration caps bind and are reported", () => {
  const alloc = size({ buyVenueAllocationToman: 500_000 });
  assert.equal(alloc.bindingConstraint, "venue_allocation");

  const conc = size({
    policies: policies({ max_venue_exposure_percent: 10 }),
    portfolioValueToman: 10_000_000_000,
    buyVenueExposureToman: 999_500_000
  });
  const capMicros = conc.constraints.find((c) => c.key === "venue_concentration")
    ?.capUsdtMicros as number;
  assert.ok(capMicros > 0 && capMicros < usdtToMicros(10), "headroom is small but positive");
  assert.equal(conc.bindingConstraint, "venue_concentration");
});

await test("an unmeasurable cap is null and excluded, never treated as zero", () => {
  const r = size({ portfolioValueToman: null, buyVenueAllocationToman: null });
  assert.equal(r.constraints.find((c) => c.key === "venue_concentration")?.capUsdtMicros, null);
  assert.equal(r.constraints.find((c) => c.key === "venue_allocation")?.capUsdtMicros, null);
  assert.equal(r.status, "SIZED");
});

await test("fee settlement is honoured on both sides, per venue and per side", () => {
  const irtSell = size({ sellSettlement: IRT_FEE });
  assert.equal(irtSell.status, "SIZED");
  // With an IRT-settled sell fee no USDT is consumed by fees at all.
  assert.equal(irtSell.economics?.sellFeeValueToman, 0);

  const usdtSell = size();
  assert.ok((usdtSell.economics?.sellFeeValueToman ?? 0) > 0, "a USDT fee has a toman value");

  const unknown = { feeAsset: "UNKNOWN", debitMode: "UNKNOWN", provenance: "UNKNOWN" } as const;
  const blockedSettle = size({ sellSettlement: unknown });
  assert.equal(blockedSettle.status, "BLOCKED");
  assert.ok(blockedSettle.blockers.some((b) => b.code === "settlement_unconfirmed"));
});

/* ── 5. no invented policy values ────────────────────────────────────────── */

await test("every required risk policy still blocks when unset, by name", () => {
  const none = size({ policies: buildPolicyState([], Date.now()) });
  assert.equal(none.status, "BLOCKED");
  assert.deepEqual(
    none.blockers.filter((b) => b.code === "missing_policy").map((b) => b.subject).sort(),
    [...SIZING_REQUIRED_POLICIES].sort()
  );
  for (const key of SIZING_REQUIRED_POLICIES) {
    const one = size({ policies: policies({ [key]: undefined }) });
    assert.equal(one.status, "BLOCKED", `${key} must block on its own`);
  }
});

/* ── 6. broker agreement, rounding and non-negative balances ─────────────── */

await test("the sized trade prices and applies exactly as the broker would", () => {
  const r = size();
  const plan = planFill({
    buySourceId: "nobitex" as never,
    sellSourceId: "wallex" as never,
    sizeUsdt: r.sizeUsdt as number,
    buyVwapToman: r.quote?.buyVwapToman as number,
    sellVwapToman: r.quote?.sellVwapToman as number,
    buyFeeBps: 25,
    sellFeeBps: 35,
    buySettlement: IRT_FEE as never,
    sellSettlement: USDT_FEE as never,
    markPriceToman: r.quote?.markPriceToman as number,
    slippageBufferToman: r.economics?.slippageBufferToman as number
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.economicNetPnlToman, r.economics?.economicNetPnlToman);
  assert.equal(plan.riskAdjustedPnlToman, r.economics?.riskAdjustedPnlToman);
});

await test("no balance can go negative at any evaluated size", () => {
  for (const irt of [1_000_000, 50_000_000, 10_000_000_000]) {
    for (const usdt of [2, 40, 100_000]) {
      const balances = [
        { sourceId: "nobitex", irtToman: irt, usdtMicros: usdtToMicros(usdt) },
        { sourceId: "wallex", irtToman: irt, usdtMicros: usdtToMicros(usdt) }
      ];
      const r = size({ balances });
      if (r.status !== "SIZED") continue;
      const plan = planFill({
        buySourceId: "nobitex" as never,
        sellSourceId: "wallex" as never,
        sizeUsdt: r.sizeUsdt as number,
        buyVwapToman: r.quote?.buyVwapToman as number,
        sellVwapToman: r.quote?.sellVwapToman as number,
        buyFeeBps: 25,
        sellFeeBps: 35,
        buySettlement: IRT_FEE as never,
        sellSettlement: USDT_FEE as never,
        markPriceToman: r.quote?.markPriceToman as number,
        slippageBufferToman: r.economics?.slippageBufferToman as number
      });
      assert.equal(plan.ok, true, `broker rejected irt=${irt} usdt=${usdt}`);
      if (!plan.ok) continue;
      const applied = applyFill(plan, balances as never);
      assert.equal(applied.ok, true, `applyFill rejected irt=${irt} usdt=${usdt}`);
      if (!applied.ok) continue;
      for (const b of applied.balancesAfter) {
        assert.ok(b.irtToman >= 0 && b.usdtMicros >= 0, `negative at irt=${irt} usdt=${usdt}`);
      }
    }
  }
});

await test("sizes are floored to the ledger's precision and round-trip exactly", () => {
  const r = size({ buyVenueAllocationToman: 1_234_567 });
  assert.equal((r.sizeUsdtMicros as number) % 100, 0, "quantised to 1e-4 USDT");
  assert.equal(usdtToMicros(Number((r.sizeUsdt as number).toFixed(4))), r.sizeUsdtMicros);
});

/* ── 7. determinism and restart ──────────────────────────────────────────── */

await test("identical inputs produce an identical result, including the curve", () => {
  const a = size();
  const b = size();
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));

  // Restart: rebuilt from plain JSON the way a fresh process would.
  const revived = JSON.parse(JSON.stringify(routeInput())) as Any;
  revived.policies = policies();
  const c = computeRouteSize(revived as never);
  assert.equal(c.sizeUsdtMicros, a.sizeUsdtMicros);
  assert.deepEqual(c.economics, a.economics);
  assert.deepEqual(c.quote?.buyWalk.fills, a.quote?.buyWalk.fills);
});

await test("candidate generation is stable, sorted, capped and de-duplicated", () => {
  const q = candidateQuantities({
    buyAsks: [lv(100_000, 10), lv(101_000, 10)] as never,
    sellBids: [lv(102_000, 10), lv(99_000, 10)] as never,
    capsMicros: [usdtToMicros(15)],
    minMicros: usdtToMicros(1),
    granularityMicros: 100
  });
  assert.deepEqual(q, [...q].sort((a, b) => a - b), "sorted");
  assert.equal(new Set(q).size, q.length, "de-duplicated");
  assert.ok(q.every((x) => x <= usdtToMicros(15)), "clipped to the ceiling");
  assert.ok(q.includes(usdtToMicros(10)), "a shared breakpoint is present");
  assert.ok(q.includes(usdtToMicros(15)), "the ceiling itself is a candidate");
  // Below the minimum nothing is proposed at all.
  assert.deepEqual(
    candidateQuantities({
      buyAsks: [lv(100_000, 0.5)] as never,
      sellBids: [lv(102_000, 0.5)] as never,
      capsMicros: [usdtToMicros(0.5)],
      minMicros: usdtToMicros(1),
      granularityMicros: 100
    }),
    []
  );
});

/* ── 8. role-based allocation of the 10B portfolio ───────────────────────── */

const NINE = [
  "abantether", "arzinja", "bit24", "bitpin", "exnovin",
  "nobitex", "ramzinex", "tabdeal", "wallex"
];
const TEN_B = 10_000_000_000;

await test("venue roles come from observed sides, not from a preference", () => {
  const demands = deriveVenueDemand(NINE, [
    { buySourceId: "nobitex", sellSourceId: "wallex", occurrences: 10, riskAdjustedPnlToman: 5_000, capacityUsdtMicros: usdtToMicros(100) },
    { buySourceId: "bitpin", sellSourceId: "nobitex", occurrences: 4, riskAdjustedPnlToman: 2_000, capacityUsdtMicros: usdtToMicros(50) }
  ]);
  const byId = new Map(demands.map((d) => [d.sourceId, d]));
  assert.equal(byId.get("nobitex")?.role, "BOTH", "buys on one route, sells on another");
  assert.equal(byId.get("wallex")?.role, "SELL_SIDE");
  assert.equal(byId.get("bitpin")?.role, "BUY_SIDE");
  assert.equal(byId.get("arzinja")?.role, "EXPLORATION");
  // A losing route funds nothing.
  const losing = deriveVenueDemand(NINE, [
    { buySourceId: "nobitex", sellSourceId: "wallex", occurrences: 10, riskAdjustedPnlToman: -1, capacityUsdtMicros: 1 }
  ]);
  assert.ok(losing.every((d) => d.role === "EXPLORATION"));
});

await test("allocation follows role: buyers hold toman, sellers hold USDT", () => {
  const plan = buildLiquidityAwarePlan({
    totalCapitalToman: TEN_B,
    valuationPriceToman: 100_000,
    venueIds: NINE,
    observations: [
      { buySourceId: "nobitex", sellSourceId: "wallex", occurrences: 20, riskAdjustedPnlToman: 9_000, capacityUsdtMicros: usdtToMicros(500) },
      { buySourceId: "bitpin", sellSourceId: "tabdeal", occurrences: 5, riskAdjustedPnlToman: 3_000, capacityUsdtMicros: usdtToMicros(200) }
    ]
  });
  const byId = new Map(plan.rows.map((r) => [r.sourceId, r]));

  assert.equal(byId.get("nobitex")?.role, "BUY_SIDE");
  assert.equal(byId.get("nobitex")?.usdtUnits, 0, "a pure buyer holds no USDT");
  assert.ok((byId.get("nobitex")?.irtToman ?? 0) > 0);

  assert.equal(byId.get("wallex")?.role, "SELL_SIDE");
  assert.ok((byId.get("wallex")?.usdtUnits ?? 0) > 0, "a pure seller holds USDT");
  assert.equal(byId.get("wallex")?.irtToman, 0);

  // The busiest profitable route gets more than the idle venues.
  assert.ok((byId.get("nobitex")?.valueToman ?? 0) > (byId.get("arzinja")?.valueToman ?? 0));
  // But no venue is starved: the discovery floor is real.
  const floor = Math.floor((TEN_B * DISCOVERY_FLOOR_PERCENT) / 100);
  for (const r of plan.rows) assert.ok(r.valueToman >= floor * 0.99, `${r.sourceId} below the floor`);
  // Nine venues, none silently dropped.
  assert.equal(plan.rows.length, 9);
  // And it is not the equal split it replaced.
  assert.notEqual(new Set(plan.rows.map((r) => r.valueToman)).size, 1);
});

await test("the plan conserves exactly 10,000,000,000 toman", () => {
  for (const price of [90_000, 100_000, 194_396, 1_234_567]) {
    const plan = buildLiquidityAwarePlan({
      totalCapitalToman: TEN_B,
      valuationPriceToman: price,
      venueIds: NINE,
      observations: [
        { buySourceId: "nobitex", sellSourceId: "wallex", occurrences: 7, riskAdjustedPnlToman: 4_321, capacityUsdtMicros: usdtToMicros(123) },
        { buySourceId: "wallex", sellSourceId: "bitpin", occurrences: 3, riskAdjustedPnlToman: 1_111, capacityUsdtMicros: usdtToMicros(77) }
      ]
    });
    assert.deepEqual(plan.errorsFa, [], `errors at price ${price}`);
    assert.equal(plan.allocatedToman, TEN_B, `not conserved at price ${price}`);
    assert.equal(plan.residualToman, 0, `residual at price ${price}`);
    for (const r of plan.rows) {
      assert.ok(r.irtToman >= 0 && r.usdtUnits >= 0, "no negative allocation");
    }
  }
});

await test("allocation is deterministic and rounding lands on one fixed venue", () => {
  const build = () =>
    buildLiquidityAwarePlan({
      totalCapitalToman: TEN_B,
      valuationPriceToman: 194_396,
      venueIds: [...NINE].reverse(),
      observations: [
        { buySourceId: "nobitex", sellSourceId: "wallex", occurrences: 9, riskAdjustedPnlToman: 7_777, capacityUsdtMicros: usdtToMicros(300) }
      ]
    });
  const a = build();
  const b = build();
  assert.deepEqual(a, b, "identical inputs, identical plan");
  // Input order cannot change the plan: venues are sorted internally.
  assert.deepEqual(a.rows.map((r) => r.sourceId), [...NINE].sort());
});

await test("with no profitable observation the plan says so instead of pretending", () => {
  const plan = buildLiquidityAwarePlan({
    totalCapitalToman: TEN_B,
    valuationPriceToman: 100_000,
    venueIds: NINE,
    observations: []
  });
  assert.equal(plan.allocatedToman, TEN_B, "still conserved");
  assert.ok(plan.errorsFa.some((e) => e.includes("آگاهانه نیست")), "and honest about being uninformed");
  assert.ok(plan.rows.every((r) => r.role === "EXPLORATION"));
});

/* ── 9. safety boundary ──────────────────────────────────────────────────── */

await test("liquidity, sizing and allocation contain no order, credential or network path", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of [
    "../src/lib/shadowArbitrage/paper/liquidity.ts",
    "../src/lib/shadowArbitrage/paper/sizing.ts",
    "../src/lib/shadowArbitrage/paper/allocation.ts"
  ]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const banned of [
      "fetch(", "axios", "apiKey", "apiSecret", "privateKey",
      "placeOrder", "cancelOrder", "withdraw", "deposit", "transferFunds", "@/db/"
    ]) {
      assert.equal(src.includes(banned), false, `${file} must not contain ${banned}`);
    }
    assert.equal(/Date\.now\(\)|new Date\(\)/.test(src), false, `${file} must read no clock`);
  }
  const capability = readFileSync(
    new URL("../src/lib/shadowArbitrage/live/capability.ts", import.meta.url),
    "utf8"
  );
  assert.ok(capability.includes("export const LIVE_EXECUTION_IMPLEMENTED = false as const"));
});

await test("the legacy probe ladder no longer sizes anything", () => {
  const r = size();
  // A chosen size that is not one of 5/10/20/25 proves the ladder is not in play.
  assert.ok(r.status === "SIZED");
  const asUsdt = microsToUsdt(r.sizeUsdtMicros as number);
  assert.ok(asUsdt > 0);
  // The sizer read the BOOK: sizeExecutables is empty in every fixture here,
  // so a size at all proves the legacy probe ladder is not what produced it.
  const buySnapshot = routeInput().buySnapshot as Any;
  assert.equal((buySnapshot.sizeExecutables as unknown[]).length, 0);
  assert.ok(totalDepthMicros(buySnapshot.bookAsks as never) > 0, "depth came from the book");
  // And the chosen size need not be one of 5/10/20/25 at all.
  const legacy = [5, 10, 20, 25].map((n) => usdtToMicros(n));
  const shallow = size({
    buySnapshot: snap("nobitex", [lv(99_000, 1_000)], [lv(100_000, 7.5)]),
    sellSnapshot: snap("wallex", [lv(101_500, 7.5)], [lv(103_000, 1_000)])
  });
  assert.equal(shallow.sizeUsdtMicros, usdtToMicros(7.5));
  assert.equal(legacy.includes(shallow.sizeUsdtMicros as number), false, "off the legacy ladder");
});

await test("an unset policy blocks the trade but never hides the capacity study", () => {
  const r = size({ policies: buildPolicyState([], Date.parse("2026-08-02T12:00:00.000Z")) });

  // Still blocked, still naming every missing key — approval is unchanged.
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.sizeUsdtMicros, null);
  assert.deepEqual(
    r.blockers.map((b) => b.subject).sort(),
    [...SIZING_REQUIRED_POLICIES].sort()
  );

  // But the liquidity study is fully reported, which is the whole point: an
  // administrator must be able to see whether a venue carries the intended
  // scale BEFORE choosing the limit that would constrain it.
  assert.ok((r.liquidityMaxUsdtMicros as number) > 0, "unconstrained capacity is measured");
  assert.ok(r.candidates.length > 0, "the profit curve is still evaluated");
  assert.ok(r.quote, "the child-fill ladder is still produced");
  assert.ok((r.quote?.buyWalk.fills.length ?? 0) > 0);
  assert.ok(r.economics, "and the economics of the best feasible size");

  // An unset cap contributes nothing rather than a fabricated ceiling.
  const order = r.constraints.find((c) => c.key === "policy_max_order_size");
  assert.equal(order?.capUsdtMicros, null, "an unset policy is not a cap of zero");
  assert.ok(order?.detailFa.includes("تعیین نشده"), "and says so");
  const conc = r.constraints.find((c) => c.key === "venue_concentration");
  assert.equal(conc?.capUsdtMicros, null, "the exposure cap is absent too");
  assert.ok(conc?.detailFa.includes("تعیین نشده"));
  // What remains on that side is the capital plan's own share, which is not a
  // risk policy and is still a real ceiling.
  const alloc = r.constraints.find((c) => c.key === "venue_allocation");
  assert.equal(r.policyMaxUsdtMicros, alloc?.capUsdtMicros, "only the plan share remains");

  // A malformed book still stops everything — that is a data fault, not a decision.
  const badBook = size({
    policies: buildPolicyState([], Date.now()),
    buySnapshot: snap("nobitex", null as never, null as never)
  });
  assert.equal(badBook.candidates.length, 0, "no study without a usable book");
  assert.ok(badBook.blockers.some((b) => b.code === "book_invalid"));
});

/* ── Phase 8C-5 regressions: the two audited figures ─────────────────────── */

await test("8C-5 regression: fee-inclusive sell capacity is balance ÷ (1 + fee)", () => {
  /*
   * Audited case: Tetherland holding 3,217.854868 USDT with a 45 bps sell fee
   * taken in USDT. The venue is debited quantity PLUS fee, so the deliverable
   * quantity is balance ÷ 1.0045 = 3,203.4394 — NOT the raw balance, and not
   * balance × (1 − fee), which would overstate it by a fee-squared term.
   */
  const v = venueCapacity({
    sourceId: "tetherland",
    marketModel: "ORDER_BOOK",
    bookBids: [lv(195_000, 10_000)] as never,
    bookAsks: [lv(196_000, 10_000)] as never,
    irtToman: 485_699_479,
    usdtMicros: usdtToMicros(3217.854868),
    feeBps: 45,
    buyFeeAsset: "IRT",
    sellFeeAsset: "USDT",
    capitalShareToman: null,
    policyOrderSizeMicros: null,
    policyExposureMicros: null
  });
  const cap = v.sell.caps.find((c) => c.key === "usdt_balance")?.capUsdtMicros as number;
  // Floored to whole micros: 3,203.439390 rather than a rounded-up 3,203.4394,
  // because rounding up would report a quantity the balance cannot deliver.
  assert.equal(cap, Math.floor(usdtToMicros(3217.854868) / 1.0045));
  assert.equal(cap, 3_203_439_390);
  assert.ok(Math.abs(microsToUsdt(cap) - 3217.854868 / 1.0045) < 1e-5);
  assert.ok(microsToUsdt(cap) <= 3217.854868 / 1.0045, "never rounds up");
  assert.ok(cap < usdtToMicros(3217.854868), "never the raw balance");
  /*
   * The lookalike form balance × (1 − fee) is NOT the same number: 1/(1+f) and
   * (1−f) differ by f² , so that form understates capacity by ~0.065 USDT here.
   * Pinning the division keeps the two from being silently interchanged.
   */
  const lookalike = usdtToMicros(3217.854868 * (1 - 45 / 10_000));
  assert.ok(cap > lookalike, "division by (1+f) is not multiplication by (1−f)");
  assert.ok(microsToUsdt(cap - lookalike) < 0.1, "and the gap is the f² term, nothing larger");

  // An IRT-settled sell fee consumes no USDT, so the whole balance is deliverable.
  const irtFee = venueCapacity({
    sourceId: "tetherland",
    marketModel: "ORDER_BOOK",
    bookBids: [lv(195_000, 10_000)] as never,
    bookAsks: [lv(196_000, 10_000)] as never,
    irtToman: 1,
    usdtMicros: usdtToMicros(3217.854868),
    feeBps: 45,
    buyFeeAsset: "IRT",
    sellFeeAsset: "IRT",
    capitalShareToman: null,
    policyOrderSizeMicros: null,
    policyExposureMicros: null
  });
  assert.equal(
    irtFee.sell.caps.find((c) => c.key === "usdt_balance")?.capUsdtMicros,
    usdtToMicros(3217.854868)
  );
});

await test("8C-5 regression: quote-only is never grouped with a missing book", () => {
  const common = {
    bookBids: null,
    bookAsks: null,
    irtToman: 555_555_556,
    usdtMicros: usdtToMicros(2857.85),
    feeBps: 30,
    buyFeeAsset: "IRT",
    sellFeeAsset: "USDT",
    capitalShareToman: null,
    policyOrderSizeMicros: null,
    policyExposureMicros: null
  };
  /*
   * AbanTether: an OTC dealer. With no quote supplied this cycle the reason is
   * `quote_missing` — sharper than the old catch-all, and still nothing to do
   * with a book venue whose ladder failed to arrive.
   */
  const quoteOnly = venueCapacity({ ...common, sourceId: "abantether", marketModel: "OTC_QUOTE" });
  assert.equal(quoteOnly.buy.reason, "quote_missing");
  assert.equal(quoteOnly.sell.reason, "quote_missing");
  // The structural label still exists for the sizer's book path.
  assert.ok(VENUE_CAPACITY_REASON_FA.quote_only_no_order_book.includes("ساختاری"));

  // A book venue that missed a cycle. Transient, and an operator should act.
  const outage = venueCapacity({ ...common, sourceId: "bitpin", marketModel: "ORDER_BOOK" });
  assert.equal(outage.buy.reason, "book_missing");
  assert.notEqual(outage.buy.reason, quoteOnly.buy.reason, "the two causes never collapse");
  assert.notEqual(outage.buy.reasonFa, quoteOnly.buy.reasonFa);

  // And the same distinction reaches the sizer's blockers.
  const q = size({ buySnapshot: snap("nobitex", null as never, null as never, { marketModel: "OTC_QUOTE" }) });
  assert.ok(q.blockers.some((b) => b.code === "quote_only_no_order_book"));
  const m = size({ buySnapshot: snap("nobitex", null as never, null as never, { marketModel: "ORDER_BOOK" }) });
  assert.ok(m.blockers.some((b) => b.code === "book_invalid"));
});

await test("8C-5 a venue with a real book reports capacity on both sides", () => {
  // Bitpin: 20 levels a side. It must produce numbers, not an unavailable flag.
  const v = venueCapacity({
    sourceId: "bitpin",
    marketModel: "ORDER_BOOK",
    bookBids: Array.from({ length: 20 }, (_, i) => lv(195_000 - i * 10, 5)) as never,
    bookAsks: Array.from({ length: 20 }, (_, i) => lv(196_000 + i * 10, 5)) as never,
    irtToman: 555_555_556,
    usdtMicros: usdtToMicros(2857.85),
    feeBps: 30,
    buyFeeAsset: "IRT",
    sellFeeAsset: "USDT",
    capitalShareToman: 1_111_111_111,
    policyOrderSizeMicros: null,
    policyExposureMicros: null
  });
  assert.equal(v.buy.reason, "ok");
  assert.equal(v.sell.reason, "ok");
  assert.ok((v.buy.capacityUsdtMicros as number) > 0);
  assert.ok((v.sell.capacityUsdtMicros as number) > 0);
  assert.ok(v.buy.limitingCap, "the limiting cap is named");
  // Depth is 100 USDT a side, which binds well before the toman balance.
  assert.equal(v.buy.limitingCap, "depth");
  assert.equal(v.buy.capacityUsdtMicros, usdtToMicros(100));

  // An unset policy is NOT APPLIED — never a cap of zero.
  const policy = v.buy.caps.find((c) => c.key === "policy_order_size");
  assert.equal(policy?.capUsdtMicros, null);
  assert.ok(policy?.detailFa.includes("اعمال نشد"));
  assert.notEqual(v.buy.capacityUsdtMicros, 0, "an unset policy must not zero the capacity");
});

await test("8C close-out: capacity, limiter and reason are decided in one place", () => {
  // Buy and sell answer independently: a venue can be limited by depth on one
  // side and by a balance on the other, and each says which.
  const v = venueCapacity({
    sourceId: "wallex",
    marketModel: "ORDER_BOOK",
    // Deep bids, thin asks.
    bookBids: Array.from({ length: 10 }, (_, i) => lv(195_000 - i * 10, 500)) as never,
    bookAsks: [lv(196_000, 4)] as never,
    irtToman: 10_000_000_000,
    usdtMicros: usdtToMicros(12),
    feeBps: 35,
    buyFeeAsset: "IRT",
    sellFeeAsset: "USDT",
    capitalShareToman: null,
    policyOrderSizeMicros: null,
    policyExposureMicros: null
  });
  assert.equal(v.buy.limitingCap, "depth", "the thin ask ladder binds the buy side");
  assert.equal(v.buy.capacityUsdtMicros, usdtToMicros(4));
  assert.equal(v.sell.limitingCap, "usdt_balance", "the small USDT balance binds the sell side");
  // Fee-inclusive: 12 / 1.0035, floored.
  assert.equal(v.sell.capacityUsdtMicros, Math.floor(usdtToMicros(12) / 1.0035));
  assert.equal(v.buy.reason, "ok");
  assert.equal(v.sell.reason, "ok");

  // Every limiter key the UI can receive has a label in the engine's own map.
  for (const side of [v.buy, v.sell]) {
    for (const c of side.caps) {
      assert.ok(CAP_LABEL_FA[c.key], `${c.key} needs a label`);
    }
  }
});

await test("8C close-out: an OTC quote reports quote_only, with both sides unavailable", () => {
  const v = venueCapacity({
    sourceId: "abantether",
    marketModel: "OTC_QUOTE",
    bookBids: null,
    bookAsks: null,
    irtToman: 555_555_556,
    usdtMicros: usdtToMicros(2857.85),
    feeBps: 30,
    buyFeeAsset: "IRT",
    sellFeeAsset: "USDT",
    capitalShareToman: 1_111_111_111,
    policyOrderSizeMicros: null,
    policyExposureMicros: null
  });
  // Unavailable, with a reason — never a capacity of zero, which would read as
  // "this venue can trade nothing right now" rather than "no quote arrived".
  assert.equal(v.buy.capacityUsdtMicros, null);
  assert.equal(v.sell.capacityUsdtMicros, null);
  assert.notEqual(v.buy.capacityUsdtMicros, 0);
  assert.equal(v.buy.reason, "quote_missing");
  assert.equal(v.sell.reason, "quote_missing");
  assert.equal(v.buy.limitingCap, null, "nothing limited it; there was nothing to limit");
  assert.ok(VENUE_CAPACITY_REASON_FA.quote_only_no_order_book.includes("ساختاری"));
});

/* ── Phase 8C final: quote capacity and venue semantics ──────────────────── */

const QUOTE_VENUE = {
  sourceId: "abantether",
  marketModel: "OTC_QUOTE",
  bookBids: null,
  bookAsks: null,
  irtToman: 555_555_556,
  usdtMicros: usdtToMicros(2857.85),
  feeBps: 30,
  buyFeeAsset: "IRT",
  sellFeeAsset: "USDT",
  capitalShareToman: 1_111_111_111,
  policyOrderSizeMicros: null,
  policyExposureMicros: null
} as const;

const FRESH_QUOTE = {
  userBuyPriceToman: 192_287,
  userSellPriceToman: 190_230,
  maxExecutableUsdt: 50_000,
  ageMs: 461,
  stale: false,
  maxQuoteAgeMs: null
};

await test("a dealer quote with a published maximum yields real capacity", () => {
  const v = venueCapacity({ ...QUOTE_VENUE, quote: FRESH_QUOTE } as never);
  assert.equal(v.buy.reason, "ok");
  assert.equal(v.sell.reason, "ok");
  assert.ok((v.buy.capacityUsdtMicros as number) > 0, "a quote with a max IS capacity");
  assert.ok((v.sell.capacityUsdtMicros as number) > 0);

  // The published maximum is a cap like any other, labelled as the quote's own.
  const depthCap = v.buy.caps.find((c) => c.key === "depth");
  assert.equal(depthCap?.capUsdtMicros, usdtToMicros(50_000));
  assert.ok(depthCap?.detailFa.includes("بدون دفتر سفارش"), "it is not called a book");

  // Balances still bind, fee-inclusive on the sell side.
  assert.equal(
    v.sell.caps.find((c) => c.key === "usdt_balance")?.capUsdtMicros,
    Math.floor(usdtToMicros(2857.85) / 1.003)
  );
  // No order-book fields were fabricated anywhere.
  assert.equal(QUOTE_VENUE.bookBids, null);
  assert.equal(QUOTE_VENUE.bookAsks, null);
});

await test("a quote without a published maximum is unverified, not zero", () => {
  const v = venueCapacity({
    ...QUOTE_VENUE,
    quote: { ...FRESH_QUOTE, maxExecutableUsdt: null }
  } as never);
  assert.equal(v.buy.capacityUsdtMicros, null, "null, never 0");
  assert.equal(v.sell.capacityUsdtMicros, null);
  assert.equal(v.buy.reason, "quote_capacity_unverified");
  assert.equal(v.sell.reason, "quote_capacity_unverified");
  assert.ok(v.buy.reasonFa.includes("حداکثر حجم اجراپذیر اعلام نشده"));
});

await test("missing, stale and unverified quotes are three different reasons", () => {
  const missing = checkQuote({ ...FRESH_QUOTE, userBuyPriceToman: null });
  assert.equal(missing.ok, false);
  assert.equal((missing as Any).reason, "quote_missing");

  const stale = checkQuote({ ...FRESH_QUOTE, stale: true });
  assert.equal((stale as Any).reason, "quote_stale");

  const overAge = checkQuote({ ...FRESH_QUOTE, ageMs: 90_000, maxQuoteAgeMs: 60_000 });
  assert.equal((overAge as Any).reason, "quote_stale");

  const unverified = checkQuote({ ...FRESH_QUOTE, maxExecutableUsdt: null });
  assert.equal((unverified as Any).reason, "quote_capacity_unverified");

  // A dealer never sells below its own bid; the reverse is bad parsing.
  const reversed = checkQuote({ ...FRESH_QUOTE, userBuyPriceToman: 100, userSellPriceToman: 200 });
  assert.equal((reversed as Any).reason, "quote_direction_unverified");

  // All four are distinct strings — none may collapse into another.
  const reasons = [missing, stale, unverified, reversed].map((r) => (r as Any).reason);
  assert.equal(new Set(reasons).size, 4);

  const ok = checkQuote(FRESH_QUOTE);
  assert.equal(ok.ok, true);
  assert.equal((ok as Any).maxMicros, usdtToMicros(50_000));
});

await test("a funded venue with no observed route is EXPLORATION, never UNUSED", () => {
  const plan = buildLiquidityAwarePlan({
    totalCapitalToman: TEN_B,
    valuationPriceToman: 194_396,
    venueIds: NINE,
    observations: [
      { buySourceId: "nobitex", sellSourceId: "wallex", occurrences: 5, riskAdjustedPnlToman: 9_000, capacityUsdtMicros: usdtToMicros(100) }
    ]
  });
  const idle = plan.rows.filter((r) => r.role === "EXPLORATION");
  assert.ok(idle.length > 0, "some venues have no observed route yet");
  for (const r of idle) {
    assert.ok(r.valueToman > 0, "and every one of them is funded");
  }
  // The retired label is gone from the type and from every row.
  assert.equal(
    plan.rows.some((r) => (r.role as string) === "UNUSED"),
    false,
    "a funded venue must never be called unused"
  );
  assert.equal(plan.allocatedToman, TEN_B, "still conserved exactly");
  assert.equal(plan.residualToman, 0);
});

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
