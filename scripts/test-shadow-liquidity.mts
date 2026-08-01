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
  walkBook,
  usdtToMicros,
  microsToUsdt
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
  assert.equal(byId.get("arzinja")?.role, "UNUSED");
  // A losing route funds nothing.
  const losing = deriveVenueDemand(NINE, [
    { buySourceId: "nobitex", sellSourceId: "wallex", occurrences: 10, riskAdjustedPnlToman: -1, capacityUsdtMicros: 1 }
  ]);
  assert.ok(losing.every((d) => d.role === "UNUSED"));
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
  assert.ok(plan.rows.every((r) => r.role === "UNUSED"));
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

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
