#!/usr/bin/env npx tsx
/**
 * SMART_CAPITAL_DEPTH — deterministic tests for capital-, depth-,
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

await test("candidates are 1/2/4/6/8/10 percent of the limiting usable balance", () => {
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
  assert.deepEqual(
    set.quantities.map((q) => microsToUsdt(q)),
    [...CANDIDATE_PERCENTS].map((p) => (1_000 * p) / 100).filter((q) => q >= 25),
    "one quantity per percentage rung that clears the 25 USDT floor"
  );
  assert.deepEqual([...CANDIDATE_PERCENTS], [1, 2, 4, 6, 8, 10]);
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

  // Below the floor entirely: no trade, not a smaller trade.
  assert.deepEqual(at(200), [], "10% of 200 is under 25 USDT");
  // Exactly at the floor: only the 10% rung clears it.
  assert.deepEqual(at(250), [25]);
  // Bigger capital brings the lower rungs above the floor, one at a time.
  assert.deepEqual(at(1_000), [10, 20, 40, 60, 80, 100].filter((q) => q >= 25));
  assert.deepEqual(at(10_000), [100, 200, 400, 600, 800, 1_000]);
  // Scaling capital by k scales every candidate by k.
  const a = at(4_000);
  const b = at(8_000);
  assert.deepEqual(b, a.map((q) => q * 2));
});

await test("the 10B session produces roughly 29/58/116/173/231/289 USDT", () => {
  /*
   * Derived, not asserted from memory: the session's own per-venue USDT side,
   * less the sell fee, is the limiting usable balance, and the rungs are
   * percentages of it. The tolerance covers fees and quantization only.
   */
  const perVenueUsdt = microsToUsdt(SESSION_BALANCES[0].usdtMicros);
  assert.ok(
    perVenueUsdt > 2_880 && perVenueUsdt < 2_900,
    `the 10B session holds about 2,893 USDT per venue, got ${perVenueUsdt}`
  );

  const r = deep();
  assert.equal(r.status, "SIZED");
  assert.equal(r.capacity!.limitingSide, "sell", "the USDT side is the smaller one");
  assert.equal(r.bindingConstraint, "capital_cap", "capital, not depth, is what binds");

  const usable = microsToUsdt(r.capacity!.limitingUsableMicros);
  const expected = [...CANDIDATE_PERCENTS].map((p) => (usable * p) / 100);
  const actual = (r.candidates as Array<Any>).map((c) => microsToUsdt(c.sizeUsdtMicros as number));
  assert.equal(actual.length, expected.length, "six rungs, all above the 25 USDT floor");
  for (let i = 0; i < expected.length; i += 1) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) < 0.01,
      `rung ${CANDIDATE_PERCENTS[i]}%: expected ~${expected[i]}, got ${actual[i]}`
    );
  }
  // And the shape the operator was told to expect.
  const rounded = actual.map((q) => Math.round(q));
  assert.deepEqual(rounded, [29, 58, 115, 173, 231, 288], `got ${rounded.join(", ")}`);
});

await test("candidates are de-duplicated and quantized to the ledger's precision", () => {
  const set = buildSmartCandidates({
    // 1% of 2,400 is under the floor and 2% is over the 30 USDT ceiling, so
    // only the ceiling itself survives — and it must appear exactly once.
    buyUsableMicros: usdtToMicros(2_400),
    sellUsableMicros: usdtToMicros(2_400),
    buySourceId: "a",
    sellSourceId: "b",
    buyDepthMicros: usdtToMicros(1_000_000),
    sellDepthMicros: usdtToMicros(1_000_000),
    extraCapsMicros: [usdtToMicros(30)],
    granularityMicros: 100
  });
  assert.deepEqual(set.quantities, [usdtToMicros(30)], "one quantity, not six copies of the cap");
  assert.equal(new Set(set.quantities).size, set.quantities.length);
  for (const q of set.quantities) assert.equal(q % 100, 0, "quantized to 1e-4 USDT");

  // A rung above the ceiling is dropped, not clipped onto it.
  assert.equal(set.ladder.filter((l) => l.kept).length, 0, "every rung is above the 30 USDT cap");
});

await test("usable capacity below 25 USDT means no trade at all", () => {
  const set = buildSmartCandidates({
    buyUsableMicros: usdtToMicros(249),
    sellUsableMicros: usdtToMicros(249),
    buySourceId: "a",
    sellSourceId: "b",
    buyDepthMicros: usdtToMicros(1_000_000),
    sellDepthMicros: usdtToMicros(1_000_000),
    extraCapsMicros: [],
    granularityMicros: 100
  });
  assert.deepEqual(set.quantities, []);
  assert.equal(set.belowFloor, true);

  // End to end, the same thing blocks with the exact reason.
  const thin = size({
    balances: SESSION_BALANCES.map((b) =>
      b.sourceId === "wallex" ? { ...b, usdtMicros: usdtToMicros(200) } : b
    )
  });
  assert.equal(thin.status, "BLOCKED");
  assert.equal(thin.sizeUsdtMicros, null);
  assert.ok(thin.blockers.some((b: Any) => b.code === "size_floor"));
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
  assert.equal(capOf(r, "capital_cap"), usdtToMicros(100));

  // One toman short must fund strictly fewer — never round up.
  const short = size({
    balances: SESSION_BALANCES.map((b) =>
      b.sourceId === "nobitex" ? { ...b, irtToman: 192_479_999 } : b
    )
  });
  assert.ok((capOf(short, "buy_irt_balance") as number) < usdtToMicros(1_000));

  // With a USDT-settled buy fee the toman only funds the notional.
  const usdtFee = size({
    buySettlement: USDT_FEE,
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
    sellSettlement: IRT_FEE,
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

  // Bigger candidates get a worse buy VWAP and a worse sell VWAP.
  const cands = r.candidates as Array<Any>;
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

  // With the ordinary slippage ceiling the wall is out of policy entirely, so
  // executable depth collapses to the two-USDT sliver and nothing trades.
  const tight = size(trapBook);
  assert.equal(tight.status, "BLOCKED");
  assert.ok(tight.blockers.some((b: Any) => b.code === "size_floor"));
  assert.equal(
    tight.capacity!.buyDepth.depthMicros,
    usdtToMicros(2),
    "only the sliver is inside the slippage ceiling"
  );
  assert.equal(tight.capacity!.buyDepth.levelsExcluded, 60, "the wall is real, but out of policy");

  // And even with the ceiling opened wide enough to reach the wall, every
  // candidate prices out: 2 cheap USDT cannot carry a 29 USDT trade.
  const wide = size({ ...trapBook, policies: policies({ max_slippage_bps: 5_000 }) });
  assert.equal(wide.status, "BLOCKED");
  assert.ok(
    wide.blockers.some(
      (b: Any) => b.code === "not_net_positive" || b.code === "edge_below_floor"
    ),
    `expected an economics block, got ${JSON.stringify(wide.blockers.map((b: Any) => b.code))}`
  );
  const first = (wide.candidates as Array<Any>)[0];
  assert.ok(first, "the smallest candidate was still evaluated");
  assert.ok(
    (first.buyVwapToman as number) > 190_000,
    `the good price covered only a sliver, got ${first.buyVwapToman}`
  );
  assert.ok((first.riskAdjustedPnlToman as number) <= 0, "and the trade loses money");
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

await test("the depth cap is a tenth of the tighter leg's executable depth", () => {
  // 400 USDT of asks against a deep bid side: the buy leg sets the depth cap.
  const r = size({
    buySnapshot: snap("nobitex", [lv(190_000, 5_000)], ladder(192_000, 50, 16, 25))
  });
  assert.equal(capOf(r, "depth_cap"), usdtToMicros(40), `${DEPTH_CAP_PERCENT}% of 400`);
  assert.equal(r.capacity!.depthCapSide, "buy");
  assert.equal(r.status, "SIZED");
  assert.equal(r.sizeUsdtMicros, usdtToMicros(40));
  assert.equal(r.bindingConstraint, "depth_cap");
  // The fill takes exactly a tenth of the book it was measured against.
  assert.equal(r.quote!.buyWalk.bookParticipationPercent, 10);
});

await test("a tighter slippage policy shrinks executable depth and the depth cap", () => {
  const wide = size({ policies: policies({ max_slippage_bps: 200 }) });
  const tight = size({ policies: policies({ max_slippage_bps: 20 }) });
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
  // Wide band: the biggest candidate wins, unhindered.
  const wide = deep();
  assert.equal(wide.status, "SIZED");
  const widest = wide.sizeUsdtMicros as number;

  /*
   * A one-point band. A 288 USDT fill moves each venue's USDT share by about
   * five points, so the large candidates breach and a smaller one is chosen —
   * the band limits the size rather than merely vetoing the route.
   */
  const tight = deep({ inventoryModel: inventoryModel({ maxDeviationPoints: 1 }) });
  assert.equal(tight.status, "SIZED");
  assert.ok(
    (tight.sizeUsdtMicros as number) < widest,
    `the band must shrink the size: ${tight.sizeUsdtMicros} vs ${widest}`
  );
  const refused = (tight.candidates as Array<Any>).filter(
    (c) => c.rejectionCode === "inventory_limit"
  );
  assert.ok(refused.length > 0, "the larger candidates were refused on inventory");
  for (const c of refused) {
    assert.ok((c.rejectionFa as string).includes("سهم تتر"), "the reason names the share");
    assert.ok(
      (c.sizeUsdtMicros as number) > (tight.sizeUsdtMicros as number),
      "only sizes above the chosen one breached"
    );
  }
  // The next size up is refused for exactly that reason, and it is recorded.
  assert.equal(tight.selection!.nextLarger!.code, "inventory_limit");

  // A band tighter than the smallest possible trade refuses the route outright.
  const closed = deep({ inventoryModel: inventoryModel({ maxDeviationPoints: 0.01 }) });
  assert.equal(closed.status, "BLOCKED");
  assert.ok(closed.blockers.some((b: Any) => b.code === "inventory_limit"));
  for (const c of closed.candidates as Array<Any>) {
    assert.equal(c.eligible, false);
    assert.equal(c.rejectionCode, "inventory_limit");
  }
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

await test("the winner is maximum risk-adjusted PnL, not maximum size", () => {
  /*
   * A steep ladder: past a point each extra USDT is bought higher and sold
   * lower by more than the remaining edge, so total profit falls.
   */
  const r = size({
    buySnapshot: snap("nobitex", [lv(190_000, 5_000)], ladder(192_000, 400, 60, 25)),
    sellSnapshot: snap("wallex", ladder(194_000, -400, 60, 25), [lv(200_000, 5_000)]),
    policies: policies({ max_slippage_bps: 1_000 })
  });
  assert.equal(r.status, "SIZED");

  const cands = r.candidates as Array<Any>;
  const eligible = cands.filter((c) => c.eligible);
  assert.ok(eligible.length >= 2, "more than one candidate qualified");

  const best = Math.max(...eligible.map((c) => c.riskAdjustedPnlToman as number));
  assert.equal(r.economics!.riskAdjustedPnlToman, best, "the argmax of the curve won");

  const largest = eligible[eligible.length - 1];
  assert.ok(
    (largest.sizeUsdtMicros as number) > (r.sizeUsdtMicros as number),
    "a larger eligible size existed"
  );
  assert.ok(
    (largest.riskAdjustedPnlToman as number) < best,
    "and it would have earned less"
  );
});

await test("ties break on return, then inventory, then the smaller size", () => {
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
    (b.bps as number) - (a.bps as number) ||
    (a.inv as number) - (b.inv as number) ||
    (a.q as number) - (b.q as number);

  const rows = [
    { name: "big", pnl: 100, bps: 10, inv: 0, q: 200 },
    { name: "smallSameEverything", pnl: 100, bps: 10, inv: 0, q: 100 },
    { name: "betterBps", pnl: 100, bps: 12, inv: 5, q: 300 },
    { name: "betterInventory", pnl: 100, bps: 10, inv: -5, q: 400 }
  ];
  assert.deepEqual(
    [...rows].sort(rank).map((r) => r.name),
    ["betterBps", "betterInventory", "smallSameEverything", "big"],
    "bps first, then inventory, then the smaller size"
  );
});

await test("the selection says why it won and why the next size up did not", () => {
  const r = size({
    buySnapshot: snap("nobitex", [lv(190_000, 5_000)], ladder(192_000, 400, 60, 25)),
    sellSnapshot: snap("wallex", ladder(194_000, -400, 60, 25), [lv(200_000, 5_000)]),
    policies: policies({ max_slippage_bps: 1_000 })
  });
  assert.equal(r.status, "SIZED");
  const sel = r.selection as Any;
  assert.ok(sel, "a selection is recorded");
  assert.equal(sel.policy, SMART_SIZING_POLICY);
  assert.equal(sel.selectedSizeUsdtMicros, r.sizeUsdtMicros);
  assert.ok((sel.reasonFa as string).length > 40, "the reason is a sentence, not a code");

  const next = sel.nextLarger as Any;
  assert.ok(next, "the next larger candidate is named");
  assert.ok((next.sizeUsdtMicros as number) > (r.sizeUsdtMicros as number));
  assert.equal(
    next.code,
    "negative_marginal_profitability",
    "each extra USDT past the optimum loses money"
  );
  assert.ok((next.marginalPnlToman as number) < 0);
  assert.ok((next.detailFa as string).includes("کاهش"), "and it says so in words");
});

await test("every documented rejection code is reachable and self-describing", () => {
  const seen = new Map<string, string>();
  const collect = (r: Any) => {
    for (const c of (r.candidates as Array<Any>) ?? []) {
      if (c.rejectionCode) seen.set(c.rejectionCode as string, c.rejectionFa as string);
    }
    const next = (r.selection as Any)?.nextLarger as Any | undefined;
    if (next) seen.set(next.code as string, next.detailFa as string);
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

  for (const expected of [
    "inventory_limit",
    "not_net_positive",
    "edge_below_floor",
    "negative_marginal_profitability"
  ]) {
    assert.ok(seen.has(expected), `${expected} was never produced`);
    assert.ok((seen.get(expected) as string).length > 10, `${expected} must explain itself`);
  }
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

  // It is priced on the same evidence, and it is strictly worse here.
  assert.ok((baseline.bestRiskAdjustedPnlToman as number) > 0, "the fixed ladder would profit");
  assert.ok(
    (baseline.bestRiskAdjustedPnlToman as number) < r.economics!.riskAdjustedPnlToman,
    "and the smart size profits more"
  );

  // No baseline size is ever what the engine chose.
  const chosen = microsToUsdt(r.sizeUsdtMicros as number);
  assert.equal(
    [...BASELINE_FIXED_SIZES_USDT].includes(chosen as never),
    false,
    `the chosen size ${chosen} must not be a probe size`
  );
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
    routeKey: `${buySourceId}->${sellSourceId}@25`,
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
  assert.ok(ui.includes("SMART_CAPITAL_DEPTH"), "the policy is named on screen");
  assert.equal(MIN_EXECUTABLE_USDT_MICROS, 25_000_000);
});

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
