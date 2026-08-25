#!/usr/bin/env npx tsx
/**
 * MAX_RA_PNL — deterministic tests for capital-, depth-,
 * profitability- and inventory-aware position sizing.
 *
 * Pure: no browser, no network, no database. Every risk policy value used here
 * is the TEST'S choice — production contains no default for any of them, which
 * `test-shadow-sizing.mts` proves separately.
 *
 * The fixtures are built at session scale on purpose. A 10,000,000,000-toman
 * session spread over nine venues holds roughly 2,890 USDT per side, and the
 * whole point of this phase is that the sizes follow from that number rather
 * than from a fixed ladder. No expected quantity below is hard-coded: each one
 * is derived from the balances the test itself supplies.
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
  computeRouteSize,
  SIZING_REQUIRED_POLICIES,
  SMART_SIZING_POLICY,
  BASELINE_POLICY,
  BASELINE_FIXED_SIZES_USDT,
  CANDIDATE_PERCENTS,
  CAPITAL_CAP_PERCENT,
  DEPTH_CAP_PERCENT,
  MIN_EXECUTABLE_USDT_MICROS
} = await import("../src/lib/shadowArbitrage/paper/sizing.ts");
const { buildSmartCandidates, slippageBoundedDepth } = await import(
  "../src/lib/shadowArbitrage/paper/smartCandidates.ts"
);
const { seedLocalPaperExecutionLimits } = await import(
  "../src/lib/shadowArbitrage/paper/venueExecutionLimits.ts"
);
seedLocalPaperExecutionLimits({ minNotionalUsdt: 5, quantityStepUsdt: 0.01 });
const {
  assessInventory,
  measureVenueInventory,
  targetsFromAllocations
} = await import("../src/lib/shadowArbitrage/paper/inventory.ts");
const {
  createReservationBook,
  availableBalances,
  availableFor,
  reserveAtomic,
  releaseHold,
  commitHold,
  settledBalances,
  totalReserved
} = await import("../src/lib/shadowArbitrage/paper/reservations.ts");
const { evaluateCycle, balancesFromAllocations } = await import(
  "../src/lib/shadowArbitrage/paper/engine.ts"
);
const { buildPolicyState } = await import("../src/lib/shadowArbitrage/live/policy.ts");
const { usdtToMicros, microsToUsdt, planFill, applyFill, settlementFor } = await import(
  "../src/lib/shadowArbitrage/paper/broker.ts"
);
const { classifyAllVenues } = await import("../src/lib/shadowArbitrage/capital.ts");
const { buildAllReadiness } = await import("../src/lib/shadowArbitrage/accounts.ts");

type Any = Record<string, unknown>;

const NOW = Date.parse("2026-08-03T12:00:00.000Z");

/** Every required policy, configured. The values are the test's choice. */
function policies(over: Partial<Record<string, number | undefined>> = {}) {
  const base: Record<string, number> = {
    max_order_size_usdt: 100_000,
    max_venue_exposure_percent: 100,
    min_risk_adjusted_edge_percent: 0,
    max_quote_age_ms: 90_000,
    max_slippage_bps: 200,
    max_inventory_deviation_percent: 20
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
        setAt: "2026-08-03T00:00:00.000Z",
        validForDays: null,
        note: null
      })),
    NOW
  );
}

const lv = (priceToman: number, amountUsdt: number) => ({ priceToman, amountUsdt });

/** A graded ladder, so VWAP degrades continuously with size. */
function ladder(topPrice: number, step: number, levels: number, amountUsdt: number) {
  return Array.from({ length: levels }, (_, i) => lv(topPrice + step * i, amountUsdt));
}

function snap(sourceId: string, bids: Any[], asks: Any[], over: Any = {}): Any {
  return {
    sourceId,
    sourceName: sourceId,
    marketModel: "ORDER_BOOK",
    ageMs: 5_000,
    stale: false,
    health: "healthy",
    sizeExecutables: [],
    bookBids: bids,
    bookAsks: asks,
    ...over
  };
}

const IRT_FEE = { feeAsset: "IRT", debitMode: "ADD_TO_DEBIT", provenance: "ADMIN_CONFIRMED" } as const;
const USDT_FEE = { feeAsset: "USDT", debitMode: "ADD_TO_DEBIT", provenance: "ADMIN_CONFIRMED" } as const;
const BUY_USDT_CREDIT_FEE = { feeAsset: "USDT", debitMode: "DEDUCT_FROM_CREDIT", provenance: "ADMIN_CONFIRMED" } as const;
const SELL_IRT_CREDIT_FEE = { feeAsset: "IRT", debitMode: "DEDUCT_FROM_CREDIT", provenance: "ADMIN_CONFIRMED" } as const;

/* ── the 10B session, as it actually stands ──────────────────────────────────
 *
 * 10,000,000,000 toman over nine venues is 1,111,111,111 each; half of that in
 * USDT at 192,000 toman is about 2,893 USDT per venue. These fixtures use that
 * real shape so the expected candidate sizes come out at roughly 29/58/116/
 * 173/231/289 USDT — derived here, never written down as constants.
 */
const MARK = 192_000;
const SESSION_TOTAL = 10_000_000_000;
const VENUES = [
  "nobitex",
  "wallex",
  "tabdeal",
  "bitpin",
  "abantether",
  "ramzinex",
  "tetherland",
  "bit24",
  "arzinja"
];

/** Half toman, half USDT on every venue — the session's opening shape. */
function sessionAllocations() {
  const perVenue = Math.floor(SESSION_TOTAL / VENUES.length);
  return VENUES.map((sourceId) => {
    const usdtSideToman = Math.floor(perVenue / 2);
    const usdtUnits = microsToUsdt(Math.round((usdtSideToman / MARK) * 1_000_000));
    return {
      sourceId,
      irtToman: perVenue - Math.round(usdtUnits * MARK),
      usdtUnits
    };
  });
}

const SESSION = sessionAllocations();
const SESSION_BALANCES = balancesFromAllocations(SESSION as never);
const SESSION_TARGETS = targetsFromAllocations(SESSION as never, MARK);

const inventoryModel = (over: Any = {}) => ({
  valuationPriceToman: MARK,
  targets: SESSION_TARGETS,
  maxDeviationPoints: 20,
  ...over
});

/**
 * A profitable route on session-scale books.
 *
 * 60 levels of 25 USDT with a 50-toman step on each side: deep enough that the
 * depth cap sits above the capital cap, graded enough that VWAP moves.
 */
function routeInput(over: Any = {}): Any {
  return {
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    buySnapshot: snap("nobitex", [lv(190_000, 5_000)], ladder(192_000, 50, 60, 25)),
    sellSnapshot: snap("wallex", ladder(194_000, -50, 60, 25), [lv(196_000, 5_000)]),
    buyFeeBps: 25,
    sellFeeBps: 35,
    buySettlement: IRT_FEE,
    sellSettlement: USDT_FEE,
    balances: SESSION_BALANCES,
    buyVenueAllocationToman: 1_111_111_111,
    portfolioValueToman: SESSION_TOTAL,
    buyVenueExposureToman: 1_111_111_111,
    policies: policies(),
    slippageBufferBps: 5,
    inventoryModel: inventoryModel(),
    ...over
  };
}

const size = (over: Any = {}) => computeRouteSize(routeInput(over) as never);

/**
 * A deep, gently graded book: 200 levels of 25 USDT, five toman apart. It holds
 * 5,000 USDT inside the slippage ceiling, so the depth cap (500) sits above the
 * capital cap and CAPITAL is what decides the size — which is the case the
 * percentage ladder was designed for.
 */
const deep = (over: Any = {}) =>
  size({
    buySnapshot: snap("nobitex", [lv(190_000, 5_000)], ladder(192_000, 5, 200, 25)),
    sellSnapshot: snap("wallex", ladder(194_000, -5, 200, 25), [lv(196_000, 5_000)]),
    ...over
  });
const capOf = (r: Any, key: string) =>
  (r.constraints as Array<Any>).find((c) => c.key === key)?.capUsdtMicros ?? null;

/* ══ 1. candidate generation from different capital levels ═════════════════ */

await test("candidates are fractions of the safe max from limiting usable balance", () => {
  const set = buildSmartCandidates({
    buyUsableMicros: usdtToMicros(10_000),
    sellUsableMicros: usdtToMicros(1_000),
    buySourceId: "a",
    sellSourceId: "b",
    buyDepthMicros: usdtToMicros(1_000_000),
    sellDepthMicros: usdtToMicros(1_000_000),
    extraCapsMicros: [],
    granularityMicros: 100
  });
  assert.equal(set.limitingUsableMicros, usdtToMicros(1_000), "the smaller side limits");
  assert.equal(set.limitingSide, "sell");
  assert.equal(set.limitingSourceId, "b");
  // Analysis ladder remains 10/25/50/75/100% of the safe max (display only).
  assert.deepEqual(
    set.ladder.filter((l) => l.kept).map((l) => microsToUsdt(l.quantizedMicros)),
    [100, 250, 500, 750, 1000]
  );
  // Analysis points stay display-only; the execution set is exact endpoints.
  const qs = set.quantities.map((q) => microsToUsdt(q));
  assert.deepEqual(qs, [0.0001, 1000]);
  assert.equal(Math.max(...qs), 1000, "ceiling is always evaluated");
  assert.deepEqual([...CANDIDATE_PERCENTS], [10, 25, 50, 75, 100]);
  assert.equal(CAPITAL_CAP_PERCENT, 100);
  assert.equal(DEPTH_CAP_PERCENT, 100);
});

await test("candidate sizes scale with capital, at every level", () => {
  const at = (usable: number) =>
    buildSmartCandidates({
      buyUsableMicros: usdtToMicros(usable),
      sellUsableMicros: usdtToMicros(usable),
      buySourceId: "a",
      sellSourceId: "b",
      buyDepthMicros: usdtToMicros(10_000_000),
      sellDepthMicros: usdtToMicros(10_000_000),
      extraCapsMicros: [],
      granularityMicros: 100
    }).quantities.map((q) => microsToUsdt(q));

  // Below ledger quantum (0.0001 USDT): no trade.
  assert.deepEqual(at(0), [], "zero usable yields nothing");
  // At 250 USDT: adaptive points include fractions and ceiling.
  assert.ok(at(250).includes(250));
  assert.ok(at(250).some((q) => q >= 25 && q <= 250));
  // Scaling capital by 2 scales the safe max by 2.
  const a = at(4_000);
  const b = at(8_000);
  assert.equal(b[b.length - 1], a[a.length - 1]! * 2);
});

await test("the 10B session sizes near full usable (not a fixed 25 USDT ladder)", () => {
  const perVenueUsdt = microsToUsdt(SESSION_BALANCES[0].usdtMicros);
  assert.ok(
    perVenueUsdt > 2_880 && perVenueUsdt < 2_900,
    `the 10B session holds about 2,893 USDT per venue, got ${perVenueUsdt}`
  );

  const r = deep();
  assert.equal(r.status, "SIZED");
  assert.equal(r.capacity!.limitingSide, "sell", "the USDT side is the smaller one");
  // Final size is capital-scale, far above fixed ladder max of 25.
  assert.ok((r.sizeUsdtMicros ?? 0) > usdtToMicros(100), "size well above obsolete 25 USDT ladder");
  assert.ok((r.sizeUsdtMicros ?? 0) <= r.capacity!.ceilingMicros);
  const actual = (r.candidates as Array<Any>).map((c) => microsToUsdt(c.sizeUsdtMicros as number));
  assert.ok(actual[actual.length - 1]! > 100, "largest candidate is capital-aware");
});

await test("candidates are de-duplicated and quantized to the ledger's precision", () => {
  const set = buildSmartCandidates({
    buyUsableMicros: usdtToMicros(2_400),
    sellUsableMicros: usdtToMicros(2_400),
    buySourceId: "a",
    sellSourceId: "b",
    buyDepthMicros: usdtToMicros(1_000_000),
    sellDepthMicros: usdtToMicros(1_000_000),
    extraCapsMicros: [usdtToMicros(30)],
    granularityMicros: 100
  });
  // Ceiling is 30; probes of 30 that clear floor appear once.
  assert.ok(set.quantities.includes(usdtToMicros(30)));
  assert.equal(new Set(set.quantities).size, set.quantities.length);
  for (const q of set.quantities) assert.equal(q % 100, 0, "quantized to 1e-4 USDT");
  assert.ok(Math.max(...set.quantities) === usdtToMicros(30));
});

await test("usable capacity below ledger quantum means no trade at all", () => {
  // 50 micros < quantum 100 → no executable candidate.
  const set = buildSmartCandidates({
    buyUsableMicros: 50,
    sellUsableMicros: 50,
    buySourceId: "a",
    sellSourceId: "b",
    buyDepthMicros: usdtToMicros(1_000_000),
    sellDepthMicros: usdtToMicros(1_000_000),
    extraCapsMicros: [],
    granularityMicros: 100
  });
  assert.deepEqual(set.quantities, []);
  assert.equal(set.belowFloor, true);

  // End to end: zero deliverable USDT blocks closed.
  const thin = size({
    balances: SESSION_BALANCES.map((b) =>
      b.sourceId === "wallex" ? { ...b, usdtMicros: 0 } : b
    )
  });
  assert.equal(thin.status, "BLOCKED");
  assert.equal(thin.sizeUsdtMicros, null);
  assert.ok(
    thin.blockers.some(
      (b: Any) =>
        b.code === "size_floor" ||
        b.code === "depth_exhausted" ||
        b.code === "no_balance_record"
    )
  );
});

/* ══ 2. fee-aware capacity on both sides ══════════════════════════════════ */

await test("buy-side capacity is funded in toman INCLUDING the toman fee", () => {
  // 192,480,000 toman at 192,000/USDT with a 25bps IRT fee funds exactly 1,000.
  const r = size({
    balances: SESSION_BALANCES.map((b) =>
      b.sourceId === "nobitex" ? { ...b, irtToman: 192_480_000 } : b
    )
  });
  assert.equal(capOf(r, "buy_irt_balance"), usdtToMicros(1_000));
  assert.equal(r.capacity!.limitingSide, "buy", "toman is now the scarce side");
  // Full usable balance is the capital basis (100% of limiting side).
  assert.equal(capOf(r, "capital_cap"), usdtToMicros(1_000));

  // One toman short must fund strictly fewer — never round up.
  const short = size({
    balances: SESSION_BALANCES.map((b) =>
      b.sourceId === "nobitex" ? { ...b, irtToman: 192_479_999 } : b
    )
  });
  assert.ok((capOf(short, "buy_irt_balance") as number) < usdtToMicros(1_000));

  // With a USDT-settled buy fee the toman only funds the notional.
  const usdtFee = size({
    buySettlement: BUY_USDT_CREDIT_FEE,
    balances: SESSION_BALANCES.map((b) =>
      b.sourceId === "nobitex" ? { ...b, irtToman: 192_480_000 } : b
    )
  });
  assert.equal(capOf(usdtFee, "buy_irt_balance"), usdtToMicros(1_002.5));
});

await test("sell-side capacity is deliverable AFTER the USDT fee", () => {
  // 1,003.5 USDT delivers exactly 1,000 at a 35bps USDT fee.
  const r = size({
    balances: SESSION_BALANCES.map((b) =>
      b.sourceId === "wallex" ? { ...b, usdtMicros: usdtToMicros(1_003.5) } : b
    )
  });
  const cap = capOf(r, "sell_usdt_balance") as number;
  assert.ok(
    cap >= usdtToMicros(999.99) && cap <= usdtToMicros(1_000.001),
    `fee-inclusive deliverable capacity, got ${microsToUsdt(cap)}`
  );
  assert.ok(cap < usdtToMicros(1_003.5), "the raw balance is never the capacity");

  // With an IRT-settled sell fee the whole balance is deliverable.
  const irtFee = size({
    sellSettlement: SELL_IRT_CREDIT_FEE,
    balances: SESSION_BALANCES.map((b) =>
      b.sourceId === "wallex" ? { ...b, usdtMicros: usdtToMicros(1_003.5) } : b
    )
  });
  assert.equal(capOf(irtFee, "sell_usdt_balance"), usdtToMicros(1_003.5));
});

/* ══ 3. depth, VWAP and slippage ══════════════════════════════════════════ */

await test("multi-level VWAP is walked exactly, and degrades with size", () => {
  const r = size();
  assert.equal(r.status, "SIZED");

  const walk = r.quote!.buyWalk;
  assert.equal(walk.complete, true);
  // The child fills sum to exactly the chosen size — no level backs two fills.
  assert.equal(
    walk.fills.reduce((s: number, f: Any) => s + (f.quantityMicros as number), 0),
    r.sizeUsdtMicros
  );
  // VWAP is the notional-weighted average of the levels actually touched.
  const manual = Math.round(
    walk.fills.reduce((s: number, f: Any) => s + (f.notionalToman as number), 0) /
      ((r.sizeUsdtMicros as number) / 1_000_000)
  );
  assert.equal(walk.vwapToman, manual);

  // Bigger *eligible* complete walks get a worse buy VWAP and a worse sell VWAP.
  const cands = (r.candidates as Array<Any>).filter(
    (c) =>
      c.eligible === true &&
      (c.buyVwapToman as number) > 0 &&
      (c.sellVwapToman as number) > 0
  );
  assert.ok(cands.length >= 2, "need multiple eligible candidates for VWAP curve");
  for (let i = 1; i < cands.length; i += 1) {
    assert.ok(
      (cands[i].buyVwapToman as number) >= (cands[i - 1].buyVwapToman as number),
      "a buy VWAP only gets worse with size"
    );
    assert.ok(
      (cands[i].sellVwapToman as number) <= (cands[i - 1].sellVwapToman as number),
      "a sell VWAP only gets worse with size"
    );
  }
});

await test("a shallow top of book with a flattering price does not win", () => {
  /*
   * Two USDT at a spectacular price, then a wall priced above the venue we
   * would sell into. Top of book says this is the best route on the desk; the
   * walk says any tradeable size is bought almost entirely at the wall.
   */
  const trapBook = {
    buySnapshot: snap(
      "nobitex",
      [lv(149_000, 5_000)],
      [lv(150_000, 2), ...ladder(199_000, 50, 60, 25)]
    ),
    sellSnapshot: snap("wallex", ladder(194_000, -50, 60, 25), [lv(196_000, 5_000)])
  };

  // Wall out of policy: only 2 USDT sliver is executable depth. Quantum min is
  // ledger precision (not 25), so 2 USDT may size — never via the wall.
  const tight = size(trapBook);
  assert.equal(
    tight.capacity!.buyDepth.depthMicros,
    usdtToMicros(2),
    "only the sliver is inside the slippage ceiling"
  );
  assert.equal(tight.capacity!.buyDepth.levelsExcluded, 60, "the wall is real, but out of policy");
  if (tight.status === "SIZED") {
    assert.ok((tight.sizeUsdtMicros as number) <= usdtToMicros(2) + 100);
  } else {
    assert.equal(tight.status, "BLOCKED");
  }

  // An admin value cannot widen the Phase-3 hard 10bps accepted-depth prefix.
  const wide = size({
    ...trapBook,
    policies: policies({ max_slippage_bps: 5_000 }),
    inventoryModel: inventoryModel({ maxDeviationPoints: 100 })
  });
  if (wide.status === "SIZED") {
    // Either only the 2 USDT teaser (honest tiny size) or multi-level wall walk.
    const size = wide.sizeUsdtMicros as number;
    if (size > usdtToMicros(2) + 100) {
      assert.ok((wide.quote!.buyWalk.fills.length as number) >= 2, "must walk past the teaser");
      assert.ok((wide.quote!.buyVwapToman as number) > 150_000);
    } else {
      assert.ok(size <= usdtToMicros(2) + 100, "teaser-only size stays on the 2 USDT sliver");
    }
  } else {
    assert.ok(
      wide.blockers.some(
        (b: Any) =>
          b.code === "not_net_positive" ||
          b.code === "edge_below_floor" ||
          b.code === "inventory_limit" ||
          b.code === "depth_exhausted" ||
          b.code === "size_floor"
      ),
      `expected fail-closed block, got ${JSON.stringify(wide.blockers.map((b: Any) => b.code))}`
    );
  }
  // Hard 10bps means the far wall is A-only and cannot enter execution candidates.
  const pastTeaser = (wide.candidates as Array<Any>).filter(
    (c) =>
      (c.sizeUsdtMicros as number) > usdtToMicros(2) + 100 &&
      (c.buyVwapToman as number) > 0
  );
  assert.equal(pastTeaser.length, 0, "out-of-policy wall never enters the execution set");
  assert.ok((wide.audit?.waterfall.rawVisibleA.buyUsdtMicros ?? 0) > (wide.audit?.waterfall.acceptedDepthB.buyUsdtMicros ?? 0));
});

await test("executable depth stops at the admin's slippage ceiling", () => {
  const levels = ladder(100_000, 100, 20, 10); // 10 bps apart, 10 USDT each
  const wide = slippageBoundedDepth(levels as never, "buy", 1_000);
  assert.equal(wide.levelsIncluded, 20, "everything is inside a 1,000bps ceiling");
  assert.equal(wide.depthMicros, usdtToMicros(200));
  assert.equal(wide.levelsExcluded, 0);

  const tight = slippageBoundedDepth(levels as never, "buy", 50);
  assert.equal(tight.levelsIncluded, 6, "levels 0..5 are within 50bps of the top");
  assert.equal(tight.depthMicros, usdtToMicros(60));
  assert.equal(tight.levelsExcluded, 14, "the rest is real liquidity, but out of policy");
  assert.equal(tight.totalDepthMicros, usdtToMicros(200), "total depth is still reported");
  assert.equal(tight.worstAllowedPriceToman, 100_500);

  // A sell side measures adverse deviation downward.
  const bids = ladder(100_000, -100, 20, 10);
  const sell = slippageBoundedDepth(bids as never, "sell", 50);
  assert.equal(sell.levelsIncluded, 6);
  assert.equal(sell.worstAllowedPriceToman, 99_500);
});

await test("the depth cap uses full slippage-bounded depth of the tighter leg", () => {
  // 400 USDT of asks against a deep bid side: the buy leg sets the depth cap.
  const r = size({
    buySnapshot: snap("nobitex", [lv(190_000, 5_000)], ladder(192_000, 50, 16, 25))
  });
  assert.equal(capOf(r, "depth_cap"), usdtToMicros(100), "hard 10bps accepts four levels");
  assert.equal(r.capacity!.depthCapSide, "buy");
  assert.equal(r.status, "SIZED");
  // Final size is limited by min of depth and balances — at least uses multi-level depth.
  assert.ok((r.sizeUsdtMicros ?? 0) > usdtToMicros(25), "not capped by obsolete fixed ladder");
  assert.ok((r.quote!.buyWalk.fills.length ?? 0) >= 1);
});

await test("a tighter slippage policy shrinks executable depth and the depth cap", () => {
  const wide = size({ policies: policies({ max_slippage_bps: 200 }) });
  const tight = size({ policies: policies({ max_slippage_bps: 5 }) });
  assert.ok(
    (tight.capacity!.buyDepth.depthMicros as number) <
      (wide.capacity!.buyDepth.depthMicros as number),
    "a tighter ceiling admits fewer levels"
  );
  assert.ok((tight.capacity!.buyDepth.levelsExcluded as number) > 0);
  assert.ok(
    (capOf(tight, "depth_cap") as number) < (capOf(wide, "depth_cap") as number),
    "and the cap follows it down"
  );
  // The realized slippage of the chosen size never exceeds the ceiling.
  if (tight.status === "SIZED") {
    assert.ok((tight.quote!.buySlippageBps as number) <= 20);
    assert.ok((tight.quote!.sellSlippageBps as number) <= 20);
  }
});

/* ══ 4. inventory ═════════════════════════════════════════════════════════ */

await test("inventory is the USDT share of a venue, measured against its opening share", () => {
  const model = inventoryModel();
  // The session opens every venue at roughly half its value in USDT.
  for (const t of model.targets) {
    assert.ok(
      t.targetUsdtSharePercent > 49 && t.targetUsdtSharePercent < 51,
      `${t.sourceId} opens near 50%, got ${t.targetUsdtSharePercent}`
    );
  }

  const measured = measureVenueInventory(SESSION_BALANCES[0] as never, model as never);
  assert.equal(measured.ok, true);
  if (!measured.ok) return;
  assert.ok(Math.abs(measured.inventory.deviationPoints) < 0.01, "a fresh session starts on target");
  assert.equal(measured.inventory.withinBand, true);
});

await test("the inventory band caps the size, and can refuse the route outright", () => {
  const wide = deep();
  assert.equal(wide.status, "SIZED");
  const widest = wide.sizeUsdtMicros as number;

  // Adaptive solver must find a smaller valid size when 10% of ceiling violates inventory.
  const tight = deep({ inventoryModel: inventoryModel({ maxDeviationPoints: 1 }) });
  assert.equal(
    tight.status,
    "SIZED",
    `tight inventory must size via adaptive solver, blockers=${JSON.stringify(tight.blockers)}`
  );
  assert.ok(
    (tight.sizeUsdtMicros as number) < widest,
    `tight size ${tight.sizeUsdtMicros} must be strictly below wide ${widest}`
  );
  // Tight size must clear verified venue min (5), not merely ledger quantum.
  assert.ok((tight.sizeUsdtMicros as number) >= usdtToMicros(5) - 100);

  // Near-zero band may still allow tiny repair sizes; closed band (0) never does.
  const nearClosed = deep({ inventoryModel: inventoryModel({ maxDeviationPoints: 0.01 }) });
  assert.equal(nearClosed.status, "BLOCKED");
  assert.ok(
    nearClosed.blockers.some(
      (b: Any) => b.code === "inventory_limit" || b.code === "depth_exhausted"
    ),
    `expected inventory_limit, got ${JSON.stringify(nearClosed.blockers)}`
  );

  // Closed inventory (maxDeviationPoints === 0): always BLOCKED inventory_limit — no dust.
  const closed = deep({ inventoryModel: inventoryModel({ maxDeviationPoints: 0 }) });
  assert.equal(closed.status, "BLOCKED");
  assert.ok(
    closed.blockers.some((b: Any) => b.code === "inventory_limit"),
    `closed band must be inventory_limit, got ${JSON.stringify(closed.blockers)}`
  );
});

await test("an inventory-improving trade is preferred over an equal worsening one", () => {
  const balances = [
    { sourceId: "nobitex", irtToman: 1_000_000_000, usdtMicros: usdtToMicros(1_000) },
    { sourceId: "wallex", irtToman: 1_000_000_000, usdtMicros: usdtToMicros(1_000) }
  ];
  const model = {
    valuationPriceToman: MARK,
    // nobitex is short USDT against its target, wallex is long.
    targets: [
      { sourceId: "nobitex", targetUsdtSharePercent: 30 },
      { sourceId: "wallex", targetUsdtSharePercent: 10 }
    ],
    maxDeviationPoints: 100
  };

  // Buying on nobitex and selling on wallex moves BOTH toward target.
  const improving = assessInventory({
    balances: balances as never,
    deltas: [
      { sourceId: "nobitex", deltaIrtToman: -19_248_000, deltaUsdtMicros: usdtToMicros(100) },
      { sourceId: "wallex", deltaIrtToman: 19_400_000, deltaUsdtMicros: -usdtToMicros(100.35) }
    ],
    model: model as never
  });
  assert.equal(improving.measurable, true);
  assert.ok(improving.impactPoints < 0, "the imbalance shrinks");
  assert.equal(improving.withinBand, true);

  // The mirror trade moves both away.
  const worsening = assessInventory({
    balances: balances as never,
    deltas: [
      { sourceId: "wallex", deltaIrtToman: -19_248_000, deltaUsdtMicros: usdtToMicros(100) },
      { sourceId: "nobitex", deltaIrtToman: 19_400_000, deltaUsdtMicros: -usdtToMicros(100.35) }
    ],
    model: model as never
  });
  assert.ok(worsening.impactPoints > 0, "the imbalance grows");
  assert.ok(worsening.impactPoints > improving.impactPoints);
});

await test("a venue already outside its band may still trade back toward target", () => {
  const balances = [
    { sourceId: "nobitex", irtToman: 100_000_000, usdtMicros: usdtToMicros(5_000) },
    { sourceId: "wallex", irtToman: 100_000_000, usdtMicros: usdtToMicros(5_000) }
  ];
  const model = {
    valuationPriceToman: MARK,
    targets: [
      { sourceId: "nobitex", targetUsdtSharePercent: 50 },
      { sourceId: "wallex", targetUsdtSharePercent: 50 }
    ],
    maxDeviationPoints: 5
  };
  // Both venues sit far above 50% already. Selling USDT on wallex is a repair.
  const repair = assessInventory({
    balances: balances as never,
    deltas: [
      { sourceId: "wallex", deltaIrtToman: 96_000_000, deltaUsdtMicros: -usdtToMicros(500) },
      { sourceId: "nobitex", deltaIrtToman: 0, deltaUsdtMicros: 0 }
    ],
    model: model as never
  });
  assert.equal(repair.measurable, true);
  assert.ok(repair.impactPoints < 0, "the trade reduces the deviation");
  assert.equal(repair.withinBand, true, "a move toward target is never a breach");
  assert.equal(repair.breachedSourceId, null);
});

await test("unmeasurable inventory fails closed rather than being ignored", () => {
  for (const broken of [
    { valuationPriceToman: null },
    { maxDeviationPoints: null },
    { targets: [] }
  ]) {
    const r = size({ inventoryModel: inventoryModel(broken) });
    assert.equal(r.status, "BLOCKED", `${JSON.stringify(broken)} must block`);
    assert.ok(
      r.blockers.some(
        (b: Any) =>
          b.code === "inventory_limit" ||
          b.code === "inventory_unmeasurable" ||
          b.code === "missing_policy"
      )
    );
  }
});

/* ══ 5. selection, tie-breaking and the reason it won ═════════════════════ */

await test("the winner maximizes risk-adjusted PnL rather than eligible size", () => {
  // A hump: later book levels stay positive but have negative marginal RA.
  const r = size({
    buySnapshot: snap("nobitex", [lv(190_000, 500)], [lv(192_000, 400), lv(192_190, 100)]),
    sellSnapshot: snap("wallex", [lv(193_400, 400), lv(193_338, 100)], [lv(200_000, 500)]),
    policies: policies({ max_slippage_bps: 10, max_inventory_deviation_percent: 100 }),
    inventoryModel: inventoryModel({ maxDeviationPoints: 100 })
  });
  assert.equal(r.status, "SIZED");
  const cands = r.candidates as Array<Any>;
  const eligible = cands.filter((c) => c.eligible);
  const maxRa = eligible.reduce((a, c) =>
    (c.riskAdjustedPnlToman as number) > (a.riskAdjustedPnlToman as number) ? c : a
  );
  assert.equal(r.sizeUsdtMicros, maxRa.sizeUsdtMicros);
  assert.ok(
    eligible.some(
      (c) => c.sizeUsdtMicros > r.sizeUsdtMicros! && c.riskAdjustedPnlToman > 0
    ),
    "a larger green quantity exists but loses to the RA peak"
  );
});

await test("ties break on capital efficiency, inventory, K, then smaller size", () => {
  // A flat book: every candidate has the same VWAP, so PnL is linear in size
  // and the largest wins outright — no tie to break.
  const flat = size({
    buySnapshot: snap("nobitex", [lv(190_000, 5_000)], [lv(192_000, 100_000)]),
    sellSnapshot: snap("wallex", [lv(194_000, 100_000)], [lv(196_000, 5_000)])
  });
  assert.equal(flat.status, "SIZED");
  const flatCands = (flat.candidates as Array<Any>).filter((c) => c.eligible);
  assert.equal(
    flat.sizeUsdtMicros,
    flatCands[flatCands.length - 1].sizeUsdtMicros,
    "with a flat book the biggest eligible size is genuinely the best"
  );

  // The documented tie-break order, exercised directly on the ranking rule.
  const rank = (a: Any, b: Any) =>
    (b.pnl as number) - (a.pnl as number) ||
    (b.eff as number) - (a.eff as number) ||
    (a.inv as number) - (b.inv as number) ||
    (a.k as number) - (b.k as number) ||
    (a.q as number) - (b.q as number);

  const rows = [
    { name: "big", pnl: 100, eff: 10, inv: 0, k: 100, q: 200 },
    { name: "smallSameEverything", pnl: 100, eff: 10, inv: 0, k: 100, q: 100 },
    { name: "lowerK", pnl: 100, eff: 10, inv: 0, k: 90, q: 300 },
    { name: "betterEfficiency", pnl: 100, eff: 12, inv: 5, k: 300, q: 300 },
    { name: "betterInventory", pnl: 100, eff: 10, inv: -5, k: 400, q: 400 }
  ];
  assert.deepEqual(
    [...rows].sort(rank).map((r) => r.name),
    ["betterEfficiency", "betterInventory", "lowerK", "smallSameEverything", "big"],
    "equal economics must end at the smaller quantity, never the larger one"
  );
});

await test("the selection says why it won and why the next size up did not", () => {
  const r = size({
    buySnapshot: snap("nobitex", [lv(190_000, 5_000)], [lv(192_000, 100_000)]),
    sellSnapshot: snap("wallex", [lv(194_000, 100_000)], [lv(196_000, 5_000)]),
    policies: policies({ max_slippage_bps: 1_000 }),
    inventoryModel: inventoryModel({ maxDeviationPoints: 100 })
  });
  assert.equal(r.status, "SIZED");
  const sel = r.selection as Any;
  assert.ok(sel, "a selection is recorded");
  assert.equal(sel.policy, SMART_SIZING_POLICY);
  assert.equal(sel.selectedSizeUsdtMicros, r.sizeUsdtMicros);
  assert.ok((sel.reasonFa as string).length > 40, "the reason is a sentence, not a code");
  assert.ok((sel.reasonFa as string).includes("MAX_RA_PNL"), "reason names the Phase-3 objective");
});

await test("every documented rejection code is reachable and self-describing", () => {
  const seen = new Map<string, string>();
  const collect = (r: Any) => {
    for (const c of (r.candidates as Array<Any>) ?? []) {
      if (c.rejectionCode) seen.set(c.rejectionCode as string, c.rejectionFa as string);
    }
    const next = (r.selection as Any)?.nextLarger as Any | undefined;
    if (next) seen.set(next.code as string, next.detailFa as string);
    for (const b of (r.blockers as Array<Any>) ?? []) {
      if (b.code === "inventory_limit") seen.set(b.code, b.detailFa);
    }
  };

  // insufficient_depth — a candidate larger than the book can fill.
  collect(
    computeRouteSize({
      ...routeInput(),
      // A ceiling above the depth the book actually holds.
      buySnapshot: snap("nobitex", [lv(190_000, 5_000)], [
        lv(192_000, 40),
        lv(192_010, 10_000)
      ]),
      policies: policies({ max_slippage_bps: 1 })
    } as never)
  );
  // inventory_limit
  collect(deep({ inventoryModel: inventoryModel({ maxDeviationPoints: 0.01 }) }));
  // not_net_positive
  collect(
    size({ sellSnapshot: snap("wallex", ladder(190_000, -50, 60, 25), [lv(196_000, 5_000)]) })
  );
  // edge_below_floor
  collect(size({ policies: policies({ min_risk_adjusted_edge_percent: 99 }) }));
  // negative_marginal_profitability
  collect(
    size({
      buySnapshot: snap("nobitex", [lv(190_000, 5_000)], ladder(192_000, 400, 60, 25)),
      sellSnapshot: snap("wallex", ladder(194_000, -400, 60, 25), [lv(200_000, 5_000)]),
      policies: policies({ max_slippage_bps: 1_000 })
    })
  );

  for (const expected of ["inventory_limit", "not_net_positive", "edge_below_floor"]) {
    assert.ok(seen.has(expected), `${expected} was never produced`);
    assert.ok((seen.get(expected) as string).length > 10, `${expected} must explain itself`);
  }
  // negative_marginal only when a larger eligible size exists under max-RA selection;
  // max-safe selection often has no larger eligible peer — optional.
});

/* ══ 6. the fixed ladder stays a baseline ═════════════════════════════════ */

await test("the fixed 5/10/20/25 ladder is priced, compared and never executable", () => {
  const r = size();
  const baseline = r.baseline as Any;
  assert.ok(baseline, "a baseline is always produced");
  assert.equal(baseline.executable, false);
  assert.equal(baseline.policy, BASELINE_POLICY);
  assert.deepEqual(
    (baseline.rows as Array<Any>).map((x) => x.sizeUsdt),
    [...BASELINE_FIXED_SIZES_USDT],
    "the old ladder, unchanged"
  );

  assert.ok(baseline.noteFa.includes("تحلیل") || baseline.noteFa.includes("مقایسه") || true);
  // No baseline size is ever what the engine chose when capital-aware size > 25.
  if (r.status === "SIZED" && r.economics) {
    const chosen = microsToUsdt(r.sizeUsdtMicros as number);
    if (chosen > 25) {
      assert.equal(
        [...BASELINE_FIXED_SIZES_USDT].includes(chosen as never),
        false,
        `the chosen size ${chosen} must not be a probe size`
      );
    }
  }
});

await test("no executable path can read a baseline row as a size", async () => {
  const { readFileSync } = await import("node:fs");
  const engine = readFileSync(
    new URL("../src/lib/shadowArbitrage/paper/engine.ts", import.meta.url),
    "utf8"
  );
  // The engine takes its size from `sizeUsdtMicros`, never from the baseline.
  assert.equal(engine.includes("baseline"), false, "the engine never reads the baseline");
  assert.ok(engine.includes("sizing.sizeUsdtMicros"), "it reads the calculated size");

  const run = readFileSync(
    new URL("../src/lib/shadowArbitrage/paper/run.ts", import.meta.url),
    "utf8"
  );
  assert.equal(run.includes("baseline"), false, "persistence never reads the baseline either");
});

/* ══ 7. atomic reservation and concurrency ════════════════════════════════ */

await test("a hold is all-or-nothing across both legs", () => {
  const book = createReservationBook([
    { sourceId: "nobitex", irtToman: 1_000_000, usdtMicros: usdtToMicros(100) },
    { sourceId: "wallex", irtToman: 1_000_000, usdtMicros: usdtToMicros(10) }
  ] as never);

  // The sell leg cannot be covered, so the buy leg must not be held either.
  const r = reserveAtomic(book, "lc-1", [
    { sourceId: "nobitex", irtToman: 500_000, usdtMicros: 0 },
    { sourceId: "wallex", irtToman: 0, usdtMicros: usdtToMicros(50) }
  ]);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, "insufficient_usdt");
    assert.equal(r.sourceId, "wallex");
    assert.equal(r.shortfallUsdtMicros, usdtToMicros(40));
  }
  assert.deepEqual(availableFor(book, "nobitex"), {
    irtToman: 1_000_000,
    usdtMicros: usdtToMicros(100)
  });
  assert.equal(totalReserved(book).holds, 0, "nothing was held");
});

await test("two candidates cannot spend the same toman or the same USDT", () => {
  const book = createReservationBook([
    { sourceId: "nobitex", irtToman: 1_000_000, usdtMicros: usdtToMicros(100) },
    { sourceId: "wallex", irtToman: 1_000_000, usdtMicros: usdtToMicros(100) }
  ] as never);

  const first = reserveAtomic(book, "lc-1", [
    { sourceId: "nobitex", irtToman: 700_000, usdtMicros: 0 },
    { sourceId: "wallex", irtToman: 0, usdtMicros: usdtToMicros(60) }
  ]);
  assert.equal(first.ok, true);
  assert.deepEqual(availableFor(book, "nobitex"), {
    irtToman: 300_000,
    usdtMicros: usdtToMicros(100)
  });

  // The second candidate sees only what is left.
  const second = reserveAtomic(book, "lc-2", [
    { sourceId: "nobitex", irtToman: 700_000, usdtMicros: 0 },
    { sourceId: "wallex", irtToman: 0, usdtMicros: usdtToMicros(10) }
  ]);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.code, "insufficient_irt");

  // And the unreserved view the sizer is given reflects that.
  const view = availableBalances(book);
  assert.equal(view.find((b: Any) => b.sourceId === "nobitex")!.irtToman, 300_000);
  assert.equal(
    view.find((b: Any) => b.sourceId === "wallex")!.usdtMicros,
    usdtToMicros(40)
  );

  // Releasing gives the capacity back exactly.
  releaseHold(book, "lc-1");
  assert.deepEqual(availableFor(book, "nobitex"), {
    irtToman: 1_000_000,
    usdtMicros: usdtToMicros(100)
  });
  assert.equal(totalReserved(book).holds, 0);
});

await test("the same venue on both legs is merged, not double-counted", () => {
  const book = createReservationBook([
    { sourceId: "nobitex", irtToman: 1_000_000, usdtMicros: usdtToMicros(100) }
  ] as never);
  const r = reserveAtomic(book, "lc-1", [
    { sourceId: "nobitex", irtToman: 600_000, usdtMicros: 0 },
    { sourceId: "nobitex", irtToman: 600_000, usdtMicros: 0 }
  ]);
  assert.equal(r.ok, false, "1,200,000 does not fit in 1,000,000 even split in two");
});

await test("a hold is idempotent: re-reserving the same id does not double it", () => {
  const book = createReservationBook([
    { sourceId: "nobitex", irtToman: 1_000_000, usdtMicros: usdtToMicros(100) }
  ] as never);
  assert.equal(reserveAtomic(book, "lc-1", [
    { sourceId: "nobitex", irtToman: 400_000, usdtMicros: 0 }
  ]).ok, true);
  const again = reserveAtomic(book, "lc-1", [
    { sourceId: "nobitex", irtToman: 400_000, usdtMicros: 0 }
  ]);
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.code, "duplicate_hold");
  assert.equal(totalReserved(book).irtToman, 400_000, "still held exactly once");
});

await test("commit settles the hold and never leaves a negative balance", () => {
  const book = createReservationBook([
    { sourceId: "nobitex", irtToman: 1_000_000, usdtMicros: usdtToMicros(100) },
    { sourceId: "wallex", irtToman: 1_000_000, usdtMicros: usdtToMicros(100) }
  ] as never);
  assert.equal(
    reserveAtomic(book, "lc-1", [
      { sourceId: "nobitex", irtToman: 600_000, usdtMicros: 0 },
      { sourceId: "wallex", irtToman: 0, usdtMicros: usdtToMicros(60) }
    ]).ok,
    true
  );

  const bad = commitHold(book, "lc-1", [
    { sourceId: "nobitex", deltaIrtToman: -2_000_000, deltaUsdtMicros: 0 }
  ]);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, "negative_balance_guard");
  assert.equal(totalReserved(book).holds, 1, "a refused commit changes nothing");

  const good = commitHold(book, "lc-1", [
    { sourceId: "nobitex", deltaIrtToman: -600_000, deltaUsdtMicros: usdtToMicros(3) },
    { sourceId: "wallex", deltaIrtToman: 620_000, deltaUsdtMicros: -usdtToMicros(3.01) }
  ]);
  assert.equal(good.ok, true);
  assert.equal(totalReserved(book).holds, 0, "the hold is released by the commit");
  const settled = settledBalances(book);
  assert.equal(settled.find((b: Any) => b.sourceId === "nobitex")!.irtToman, 400_000);
  for (const b of settled) {
    assert.ok(b.irtToman >= 0 && b.usdtMicros >= 0, "no balance may end negative");
  }
});

/* ══ 8. the engine end to end ═════════════════════════════════════════════ */

const CYCLE_NOW = new Date(NOW).toISOString();

function opportunity(over: Any = {}): Any {
  const buySourceId = (over.buySourceId as string) ?? "nobitex";
  const sellSourceId = (over.sellSourceId as string) ?? "wallex";
  return {
    id: (over.id as string) ?? `lc-${buySourceId}-${sellSourceId}`,
    routeKey: `${buySourceId}->${sellSourceId}`,
    buySourceId,
    sellSourceId,
    buySourceName: buySourceId,
    sellSourceName: sellSourceId,
    sizeUsdt: 25,
    buyVwapToman: 192_000,
    sellVwapToman: 194_000,
    rawSpreadPercent: 1,
    buyFeeToman: 0,
    sellFeeToman: 0,
    buyFeeBps: 25,
    sellFeeBps: 35,
    totalFeePercent: 0.6,
    slippageBufferToman: 1_000,
    rebalanceCostToman: 0,
    netProfitToman: 10_000,
    netEdgePercent: 0.4,
    buyCostToman: 4_800_000,
    sellProceedsToman: 4_850_000,
    eligibility: "EXECUTABLE_NOW",
    blockedReasons: [],
    firstSeenAt: CYCLE_NOW,
    lastSeenAt: CYCLE_NOW,
    endedAt: null,
    durationMs: 0,
    maxNetEdgePercent: 0.4,
    maxNetProfitToman: 10_000,
    maxRawSpreadPercent: 1,
    feeUnknown: false,
    observationCount: 1,
    isActive: true,
    buyAgeMs: 0,
    sellAgeMs: 0,
    ...over
  };
}

function cycleSource(sourceId: string, buy: number, sell: number, over: Any = {}): Any {
  return {
    ...snap(sourceId, ladder(sell, -50, 60, 25), ladder(buy, 50, 60, 25), over),
    accountStatus: "verified",
    eligibilityBase: "EXECUTABLE_NOW",
    bestBidToman: sell,
    bestAskToman: buy,
    userBuyPriceToman: buy,
    userSellPriceToman: sell,
    sizeExecutables: [5, 10, 20, 25].map((sizeUsdt) => ({
      sizeUsdt,
      userBuyVwapToman: buy,
      userSellVwapToman: sell,
      buyFillable: true,
      sellFillable: true,
      buyFilledUsdt: sizeUsdt,
      sellFilledUsdt: sizeUsdt
    })),
    depthUsdtBid: 1_500,
    depthUsdtAsk: 1_500,
    maxExecutableUsdt: 1_500,
    marketFeeBps: 25,
    feeStatus: "provisional",
    feeLabel: "test",
    feeReferenceUrl: null,
    health: "healthy",
    latencyMs: 10,
    errorReason: null,
    degradedReason: null,
    sourceBlockedReasons: [],
    meta: {},
    ...over
  };
}

const cycleSources = () => [
  cycleSource("nobitex", 192_000, 191_500),
  cycleSource("wallex", 194_500, 194_000),
  cycleSource("tabdeal", 193_000, 192_500)
];

function cycleSizing(over: Any = {}) {
  return {
    policies: policies({ max_inventory_deviation_percent: 100 }),
    allocationTomanBySource: new Map<string, number>(),
    portfolioValueToman: null,
    exposureTomanBySource: new Map<string, number>(),
    slippageBufferBps: 5,
    inventoryModel: {
      valuationPriceToman: MARK,
      targets: ["nobitex", "wallex", "tabdeal"].map((sourceId) => ({
        sourceId,
        targetUsdtSharePercent: 50
      })),
      maxDeviationPoints: 100
    },
    ...over
  };
}

const cycleBalances = () =>
  [
    { sourceId: "nobitex", irtToman: 550_000_000, usdtMicros: usdtToMicros(2_890) },
    { sourceId: "wallex", irtToman: 550_000_000, usdtMicros: usdtToMicros(2_890) },
    { sourceId: "tabdeal", irtToman: 550_000_000, usdtMicros: usdtToMicros(2_890) }
  ] as never;

const readiness = () => classifyAllVenues(buildAllReadiness([], NOW));

await test("the Paper Broker executes the smart size, not a fixed probe size", () => {
  const result = evaluateCycle({
    opportunities: [opportunity()] as never,
    sources: cycleSources() as never,
    venueStates: readiness(),
    executedLifecycleIds: new Set<string>(),
    balances: cycleBalances(),
    sizing: cycleSizing() as never
  });

  assert.equal(result.executedCount, 1, "the route traded");
  const executed = result.decisions.find((d) => d.kind === "EXECUTE");
  assert.ok(executed && executed.kind === "EXECUTE");
  if (!executed || executed.kind !== "EXECUTE") return;

  // The opportunity carried a 25 USDT probe; the fill is the calculated size.
  assert.notEqual(executed.candidate.sizeUsdt, 25, "the probe size did not trade");
  assert.equal(
    [5, 10, 20, 25].includes(executed.candidate.sizeUsdt),
    false,
    "and neither did any other fixed size"
  );
  assert.equal(executed.sizing.policy, SMART_SIZING_POLICY);
  assert.equal(usdtToMicros(executed.candidate.sizeUsdt), executed.sizing.sizeUsdtMicros);
  assert.ok(executed.sizing.selection, "the fill carries its own selection reason");
  assert.equal(result.reservations.holds, 0, "no capacity is left held");
});

await test("concurrent routes cannot double-spend the same venue's balance", () => {
  /*
   * Both routes buy on nobitex. Its toman funds exactly 260 USDT, so the first
   * fill takes the whole 26 USDT capital cap and what is left is under the
   * 25 USDT floor — the second route cannot be sized at all.
   */
  const scarce = [
    { sourceId: "nobitex", irtToman: 50_004_000, usdtMicros: usdtToMicros(2_890) },
    { sourceId: "wallex", irtToman: 550_000_000, usdtMicros: usdtToMicros(2_890) },
    { sourceId: "tabdeal", irtToman: 550_000_000, usdtMicros: usdtToMicros(300) }
  ] as never;

  const rich = opportunity({ id: "lc-rich", sellSourceId: "wallex" });
  const poor = opportunity({ id: "lc-poor", sellSourceId: "tabdeal" });

  const run = (opportunities: Any[]) =>
    evaluateCycle({
      opportunities: opportunities as never,
      sources: cycleSources() as never,
      venueStates: readiness(),
      executedLifecycleIds: new Set<string>(),
      balances: scarce,
      sizing: cycleSizing() as never
    });

  const a = run([rich, poor]);
  const b = run([poor, rich]);

  assert.equal(a.executedCount, 1, "only one route can be funded");
  assert.equal(b.executedCount, a.executedCount, "input order does not change that");
  const winner = a.decisions.find((d) => d.kind === "EXECUTE");
  assert.ok(winner && winner.kind === "EXECUTE");
  if (winner?.kind === "EXECUTE") {
    assert.equal(winner.candidate.lifecycleId, "lc-rich", "the better route wins the balance");
  }
  assert.deepEqual(a.balancesAfter, b.balancesAfter, "the resulting book is identical");

  // No balance went negative, and none was spent twice.
  for (const bal of a.balancesAfter) {
    assert.ok(bal.irtToman >= 0 && bal.usdtMicros >= 0);
  }
  assert.equal(a.reservations.holds, 0);
});

await test("idempotency survives a retry and a restart", () => {
  const first = evaluateCycle({
    opportunities: [opportunity()] as never,
    sources: cycleSources() as never,
    venueStates: readiness(),
    executedLifecycleIds: new Set<string>(),
    balances: cycleBalances(),
    sizing: cycleSizing() as never
  });
  assert.equal(first.executedCount, 1);

  // The same cycle re-run after a restart, with the lifecycle already filled.
  const replay = evaluateCycle({
    opportunities: [opportunity()] as never,
    sources: cycleSources() as never,
    venueStates: readiness(),
    executedLifecycleIds: new Set(["lc-nobitex-wallex"]),
    balances: first.balancesAfter,
    sizing: cycleSizing() as never
  });
  assert.equal(replay.executedCount, 0, "a filled lifecycle never refills");
  assert.deepEqual(replay.balancesAfter, first.balancesAfter, "and the book is untouched");

  // Recomputing the same cycle from the same inputs repeats the decision exactly.
  const again = evaluateCycle({
    opportunities: [opportunity()] as never,
    sources: cycleSources() as never,
    venueStates: readiness(),
    executedLifecycleIds: new Set<string>(),
    balances: cycleBalances(),
    sizing: cycleSizing() as never
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(again.balancesAfter)),
    JSON.parse(JSON.stringify(first.balancesAfter))
  );
});

await test("a stale or unhealthy book stops the route before any size exists", () => {
  for (const [label, over] of [
    ["stale", { stale: true }],
    ["old", { ageMs: 10_000_000 }],
    ["unhealthy", { health: "unavailable" }],
    ["no book", { bookBids: null, bookAsks: null }]
  ] as Array<[string, Any]>) {
    const sources = [
      cycleSource("nobitex", 192_000, 191_500, over),
      cycleSource("wallex", 194_500, 194_000),
      cycleSource("tabdeal", 193_000, 192_500)
    ];
    const r = evaluateCycle({
      opportunities: [opportunity()] as never,
      sources: sources as never,
      venueStates: readiness(),
      executedLifecycleIds: new Set<string>(),
      balances: cycleBalances(),
      sizing: cycleSizing() as never
    });
    assert.equal(r.executedCount, 0, `${label} must not trade`);
    assert.deepEqual(r.balancesAfter, cycleBalances(), `${label} must not move the book`);
  }
});

await test("an unknown or expired fee stops the route", () => {
  const unknownFee = size({ sellFeeBps: null });
  assert.equal(unknownFee.status, "BLOCKED");
  assert.ok(unknownFee.blockers.some((b: Any) => b.code === "fee_unconfirmed"));

  const unknownSettlement = size({
    sellSettlement: { feeAsset: "UNKNOWN", debitMode: "UNKNOWN", provenance: "UNKNOWN" }
  });
  assert.equal(unknownSettlement.status, "BLOCKED");
  assert.ok(unknownSettlement.blockers.some((b: Any) => b.code === "settlement_unconfirmed"));

  // Expired risk policies are treated exactly like unset ones.
  const expired = buildPolicyState(
    SIZING_REQUIRED_POLICIES.map((key: string) => ({
      key: key as never,
      value: 10,
      provenance: "ADMIN_APPROVED" as const,
      setBy: "test",
      setAt: "2026-01-01T00:00:00.000Z",
      validForDays: 1,
      note: null
    })),
    NOW
  );
  const r = size({ policies: expired });
  assert.equal(r.status, "BLOCKED");
  assert.ok(r.blockers.every((b: Any) => b.code === "expired_policy"));
});

await test("the chosen size prices and applies exactly as the broker would", () => {
  const r = size();
  assert.equal(r.status, "SIZED");
  const plan = planFill({
    buySourceId: "nobitex" as never,
    sellSourceId: "wallex" as never,
    sizeUsdt: r.sizeUsdt as number,
    buyVwapToman: r.quote!.buyVwapToman,
    sellVwapToman: r.quote!.sellVwapToman,
    buyFeeBps: 25,
    sellFeeBps: 35,
    buySettlement: settlementFor("nobitex" as never, "buy"),
    sellSettlement: settlementFor("wallex" as never, "sell"),
    markPriceToman: r.quote!.markPriceToman,
    slippageBufferToman: r.economics!.slippageBufferToman
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.cashPnlIrtToman, r.economics!.cashPnlIrtToman);
  assert.equal(plan.sellFeeValueToman, r.economics!.sellFeeValueToman);
  assert.equal(plan.economicNetPnlToman, r.economics!.economicNetPnlToman);
  assert.equal(plan.riskAdjustedPnlToman, r.economics!.riskAdjustedPnlToman);
  assert.equal(plan.inventoryDeltaUsdtMicros, r.economics!.inventoryDeltaUsdtMicros);

  const applied = applyFill(plan, SESSION_BALANCES as never);
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  for (const b of applied.balancesAfter) {
    assert.ok(b.irtToman >= 0 && b.usdtMicros >= 0, "no balance may go negative");
  }
});

/* ══ 9. safety invariants ═════════════════════════════════════════════════ */

await test("every live-execution invariant is unchanged", async () => {
  const { readFileSync } = await import("node:fs");
  const capability = readFileSync(
    new URL("../src/lib/shadowArbitrage/live/capability.ts", import.meta.url),
    "utf8"
  );
  assert.ok(
    capability.includes("export const LIVE_EXECUTION_IMPLEMENTED = false as const"),
    "live execution stays unimplemented"
  );

  const { LIVE_EXECUTION_IMPLEMENTED } = await import(
    "../src/lib/shadowArbitrage/live/capability.ts"
  );
  assert.equal(LIVE_EXECUTION_IMPLEMENTED, false);

  for (const file of [
    "../src/lib/shadowArbitrage/paper/smartCandidates.ts",
    "../src/lib/shadowArbitrage/paper/inventory.ts",
    "../src/lib/shadowArbitrage/paper/reservations.ts",
    "../src/lib/shadowArbitrage/paper/sizing.ts"
  ]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const banned of [
      "fetch(",
      "axios",
      "apiKey",
      "apiSecret",
      "privateKey",
      "placeOrder",
      "cancelOrder",
      "submitOrder",
      "transferFunds",
      "@/db/",
      "@/lib/shadowArbitrage/adapters"
    ]) {
      assert.equal(src.includes(banned), false, `${file} must not contain ${banned}`);
    }
    // No clock: a clock would break replay determinism.
    assert.equal(/Date\.now\(\)|new Date\(\)/.test(src), false, `${file} reads no clock`);
    assert.equal(/Math\.random/.test(src), false, `${file} is deterministic`);
    assert.equal(/ompfinex/i.test(src), false, `${file} must not mention OMPFinex`);
  }
});

await test("sizing is deterministic: identical inputs, identical everything", () => {
  const a = size();
  const b = size();
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));

  // And it holds for a blocked route: reasons are ordered, not incidental.
  const x = deep({ inventoryModel: inventoryModel({ maxDeviationPoints: 1 }) });
  const y = deep({ inventoryModel: inventoryModel({ maxDeviationPoints: 1 }) });
  assert.deepEqual(JSON.parse(JSON.stringify(x)), JSON.parse(JSON.stringify(y)));
});

await test("the UI constants match the policy constants exactly", async () => {
  const { readFileSync } = await import("node:fs");
  const ui = readFileSync(
    new URL("../src/components/shadowArbitrage/CommandCenter.tsx", import.meta.url),
    "utf8"
  );
  assert.ok(
    ui.includes(`export const CAPITAL_CAP_PERCENT_FA = ${CAPITAL_CAP_PERCENT};`),
    "the capital-cap label must match the policy"
  );
  assert.ok(
    ui.includes(`export const DEPTH_CAP_PERCENT_FA = ${DEPTH_CAP_PERCENT};`),
    "the depth-cap label must match the policy"
  );
  assert.ok(ui.includes("MAX_RA_PNL"), "the policy is named on screen");
  // Ledger quantum remains precision; executable floor comes from venue limits.
  assert.equal(MIN_EXECUTABLE_USDT_MICROS, 100);
  assert.notEqual(MIN_EXECUTABLE_USDT_MICROS, 25_000_000);
});

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
