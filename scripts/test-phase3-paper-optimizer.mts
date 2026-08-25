#!/usr/bin/env npx tsx
/** Phase-3 PAPER/FAKE optimizer acceptance tests. Pure: no DB/network/browser. */
import assert from "node:assert/strict";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error instanceof Error ? error.stack ?? error.message : error}`);
    failed += 1;
  }
}

const { computeRouteSize, SMART_SIZING_POLICY } = await import(
  "../src/lib/shadowArbitrage/paper/sizing.ts"
);
const { buildOpportunitiesDetailed } = await import("../src/lib/shadowArbitrage/calculate.ts");
const { buildPolicyState } = await import("../src/lib/shadowArbitrage/live/policy.ts");
const { evaluateCycle } = await import("../src/lib/shadowArbitrage/paper/engine.ts");
const { buildLiquidityAwarePlan, buildOpeningAllocationEvidence } = await import(
  "../src/lib/shadowArbitrage/paper/allocation.ts"
);
const { registerVenueExecutionLimit, seedLocalPaperExecutionLimits } = await import(
  "../src/lib/shadowArbitrage/paper/venueExecutionLimits.ts"
);
const { usdtToMicros } = await import("../src/lib/shadowArbitrage/paper/broker.ts");
const { LIVE_EXECUTION_IMPLEMENTED } = await import(
  "../src/lib/shadowArbitrage/live/capability.ts"
);
const { computeCanonicalEconomics } = await import(
  "../src/lib/shadowArbitrage/paper/canonicalEconomics.ts"
);

seedLocalPaperExecutionLimits({ minNotionalUsdt: 5, quantityStepUsdt: 0.1 });

type Any = Record<string, any>;
const NOW_ISO = "2026-08-25T12:00:00.000Z";
const NOW = Date.parse(NOW_ISO);
const lv = (priceToman: number, amountUsdt: number) => ({ priceToman, amountUsdt });
const IRT_FEE = {
  feeAsset: "IRT",
  debitMode: "ADD_TO_DEBIT",
  provenance: "ADMIN_CONFIRMED"
} as const;
const USDT_FEE = {
  feeAsset: "USDT",
  debitMode: "ADD_TO_DEBIT",
  provenance: "ADMIN_CONFIRMED"
} as const;

function policies(over: Record<string, number | undefined> = {}) {
  const values: Record<string, number | undefined> = {
    max_order_size_usdt: 10_000,
    max_venue_exposure_percent: 100,
    min_risk_adjusted_edge_percent: 0.05,
    max_quote_age_ms: 30_000,
    max_slippage_bps: 10,
    max_inventory_deviation_percent: 100,
    ...over
  };
  return buildPolicyState(
    Object.entries(values)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => ({
        key: key as never,
        value: value as number,
        provenance: "ADMIN_APPROVED" as const,
        setBy: "phase3-test",
        setAt: NOW_ISO,
        validForDays: null,
        note: null
      })),
    NOW
  );
}

function snap(sourceId: string, bids: Any[], asks: Any[], over: Any = {}): Any {
  const bestBid = bids.length ? Math.max(...bids.map((l) => l.priceToman)) : null;
  const bestAsk = asks.length ? Math.min(...asks.map((l) => l.priceToman)) : null;
  return {
    sourceId,
    sourceName: sourceId,
    marketModel: "ORDER_BOOK",
    accountStatus: "verified",
    eligibilityBase: "EXECUTABLE_NOW",
    bestBidToman: bestBid,
    bestAskToman: bestAsk,
    userBuyPriceToman: bestAsk,
    userSellPriceToman: bestBid,
    sizeExecutables: [5, 10, 20, 25].map((sizeUsdt) => ({
      sizeUsdt,
      userBuyVwapToman: bestAsk,
      userSellVwapToman: bestBid,
      buyFillable: true,
      sellFillable: sizeUsdt !== 25,
      buyFilledUsdt: sizeUsdt,
      sellFilledUsdt: sizeUsdt === 25 ? 24 : sizeUsdt
    })),
    bookBids: bids,
    bookAsks: asks,
    depthUsdtBid: bids.reduce((s, l) => s + l.amountUsdt, 0),
    depthUsdtAsk: asks.reduce((s, l) => s + l.amountUsdt, 0),
    maxExecutableUsdt: Math.min(
      bids.reduce((s, l) => s + l.amountUsdt, 0),
      asks.reduce((s, l) => s + l.amountUsdt, 0)
    ),
    marketFeeBps: 25,
    feeStatus: "official",
    feeLabel: "test",
    feeReferenceUrl: null,
    feeVerifiedAt: NOW_ISO,
    sourceTimestamp: NOW_ISO,
    receivedAt: NOW_ISO,
    ageMs: 1_000,
    health: "healthy",
    errorReason: null,
    degradedReason: null,
    stale: false,
    meta: {
      endpoint: "paper://fixture",
      httpStatus: 200,
      latencyMs: 1,
      attempts: 1,
      rateLimited: false,
      timedOut: false,
      depthAvailable: true,
      directionVerified: true,
      priceUnit: "IRT",
      normalizationNote: null
    },
    sourceBlockedReasons: [],
    ...over
  };
}

function sizingInput(over: Any = {}): Any {
  const buy = over.buySnapshot ?? snap("nobitex", [lv(99_900, 20_000)], [lv(100_000, 20_000)]);
  const sell = over.sellSnapshot ?? snap("wallex", [lv(100_800, 20_000)], [lv(100_900, 20_000)]);
  const balances = over.balances ?? [
    { sourceId: "nobitex", irtToman: 2_000_000_000, usdtMicros: usdtToMicros(10_000) },
    { sourceId: "wallex", irtToman: 1_000_000_000, usdtMicros: usdtToMicros(10_000) }
  ];
  return {
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    buySnapshot: buy,
    sellSnapshot: sell,
    buyFeeBps: 25,
    sellFeeBps: 25,
    buySettlement: IRT_FEE,
    sellSettlement: USDT_FEE,
    balances,
    buyVenueAllocationToman: 2_000_000_000,
    portfolioValueToman: 10_000_000_000,
    buyVenueExposureToman: 0,
    policies: over.policies ?? policies(),
    slippageBufferBps: 5,
    inventoryModel: over.inventoryModel ?? {
      valuationPriceToman: 100_000,
      targets: balances.map((b: Any) => ({ sourceId: b.sourceId, targetUsdtSharePercent: 50 })),
      maxDeviationPoints: 100
    },
    dynamicRisk: over.dynamicRisk,
    ...over
  };
}

const size = (over: Any = {}) => computeRouteSize(sizingInput(over));

await test("canonical mixed-settlement economics marks USDT fees at THIS-q buy VWAP", () => {
  const priced = computeCanonicalEconomics({
    sizeUsdtMicros: usdtToMicros(100),
    buy: { complete: true, notionalToman: 10_000_000, vwapToman: 100_000, bestPriceToman: 100_000 },
    sell: { complete: true, notionalToman: 10_100_000, vwapToman: 101_000, bestPriceToman: 101_000 },
    buyFeeBps: 25,
    sellFeeBps: 25,
    buySettlement: IRT_FEE,
    sellSettlement: USDT_FEE,
    capitalMarkPriceToman: 200_000,
    riskBufferBps: 5
  });
  assert.equal(priced.ok, true);
  if (!priced.ok) return;
  assert.equal(priced.economics.buyFeeToman, 25_000);
  assert.equal(priced.economics.sellFeeUsdtMicros, 250_000);
  assert.equal(priced.economics.usdtFeeValueToman, 25_000);
  assert.equal(priced.economics.cashPnlIrtToman, 75_000);
  assert.equal(priced.economics.economicNetPnlToman, 50_000);
  assert.equal(priced.economics.riskAdjustedPnlToman, 45_000);
  const unpriced = computeCanonicalEconomics({
    sizeUsdtMicros: usdtToMicros(100),
    buy: { complete: true, notionalToman: 10_000_000, vwapToman: 100_000, bestPriceToman: 100_000 },
    sell: { complete: true, notionalToman: 10_100_000, vwapToman: 101_000, bestPriceToman: 101_000 },
    buyFeeBps: 25,
    sellFeeBps: 25,
    buySettlement: IRT_FEE,
    sellSettlement: USDT_FEE,
    capitalMarkPriceToman: 200_000,
    rebalanceRequired: true,
    rebalanceCostToman: 0
  });
  assert.deepEqual(unpriced, { ok: false, code: "rebalance_required_unpriced" });
});

await test("non-round optimum 437.6 without preferred-size snapping", () => {
  const result = size({ policies: policies({ max_order_size_usdt: 437.63 }) });
  assert.equal(result.status, "SIZED");
  assert.equal(result.sizeUsdt, 437.6);
  assert.equal(result.audit?.objective, "MAX_RA_PNL");
  assert.equal(result.audit?.waterfall.optimizerF.qPreUsdtMicros, 437_630_000);
  assert.ok(![5, 10, 20, 25, 50, 100, 400, 500, 1000].includes(result.sizeUsdt!));
});

await test("opportunity profitable only above 25 is still discovered", () => {
  const buy = snap("nobitex", [lv(99_900, 500)], [lv(100_000, 500)]);
  const sell = snap("wallex", [lv(100_800, 500)], [lv(100_900, 500)]);
  // Legacy 25 probe is explicitly marked unfillable; the real books are deep.
  const built = buildOpportunitiesDetailed([buy, sell], [], NOW_ISO, {
    confirmedFeeBps: { nobitex: 25, wallex: 25 }
  });
  const route = built.opportunities.find((o) => o.routeKey === "nobitex->wallex");
  assert.ok(route);
  assert.ok(!route!.routeKey.includes("@25"));
  for (const sourceId of ["nobitex", "wallex"]) {
    registerVenueExecutionLimit({
      sourceId,
      minNotionalUsdtMicros: usdtToMicros(50),
      quantityStepUsdtMicros: usdtToMicros(0.1),
      provenance: "PHASE3_TEST",
      evidenceKey: `phase3-min-50-${sourceId}`,
      confirmedAt: NOW_ISO,
      note: null
    });
  }
  try {
    const result = size({
      buySnapshot: buy,
      sellSnapshot: sell,
      policies: policies({ max_order_size_usdt: 200 })
    });
    assert.equal(result.audit?.limits.minExecutableUsdtMicros, usdtToMicros(50));
    assert.ok((result.sizeUsdt ?? 0) > 25);
  } finally {
    seedLocalPaperExecutionLimits({ minNotionalUsdt: 5, quantityStepUsdt: 0.1 });
  }
});

await test("small-q PnL peak beats larger still-positive q", () => {
  const buy = snap("nobitex", [lv(99_900, 2_000)], [lv(100_000, 400), lv(100_100, 1_600)]);
  const sell = snap("wallex", [lv(100_750, 400), lv(100_650, 1_600)], [lv(100_900, 2_000)]);
  const result = size({ buySnapshot: buy, sellSnapshot: sell, policies: policies({ max_order_size_usdt: 1_200 }) });
  assert.equal(result.sizeUsdt, 400);
  assert.ok(result.candidates.some((c: Any) => c.sizeUsdtMicros > usdtToMicros(400) && c.riskAdjustedPnlToman > 0));
});

await test("raw 1000 but accepted 80 never selects 1000", () => {
  const buy = snap("nobitex", [lv(99_900, 1_000)], [lv(100_000, 1_000)]);
  const sell = snap("wallex", [lv(100_800, 80), lv(100_680, 920)], [lv(100_900, 1_000)]);
  const result = size({ buySnapshot: buy, sellSnapshot: sell, policies: policies({ max_order_size_usdt: 1_000 }) });
  assert.equal(result.audit?.waterfall.rawVisibleA.sellUsdtMicros, usdtToMicros(1_000));
  assert.equal(result.audit?.waterfall.acceptedDepthB.sellUsdtMicros, usdtToMicros(80));
  assert.ok((result.sizeUsdt ?? Infinity) <= 80);
  assert.notEqual(result.sizeUsdt, 1_000);
});

await test("simulated about 1000 may be selected when two-leg depth, balances, profitability and dynamic risk headroom genuinely allow it", () => {
  const result = size({ policies: policies({ max_order_size_usdt: 1_000 }) });
  assert.ok((result.sizeUsdt ?? 0) >= 990 && (result.sizeUsdt ?? Infinity) <= 1010);
  assert.equal(result.sizeUsdt, 1_000);
});

await test("same market with concentration/reservations/inventory pressure shrinks feasible domain and re-optimizes", () => {
  const wide = size({ policies: policies({ max_order_size_usdt: 1_000 }) });
  const tight = size({
    policies: policies({ max_order_size_usdt: 1_000 }),
    dynamicRisk: { concurrentReservationHeadroomMicros: usdtToMicros(612.37) }
  });
  assert.equal(wide.sizeUsdt, 1_000);
  assert.equal(tight.status, "SIZED");
  assert.equal(tight.sizeUsdt, 612.3);
  assert.ok(tight.sizeUsdt! < wide.sizeUsdt!);
});

await test("raw 5000 with lower PnL peak chooses the peak, not max size", () => {
  const buy = snap("nobitex", [lv(99_900, 5_000)], [lv(100_000, 800), lv(100_100, 4_200)]);
  const sell = snap("wallex", [lv(100_750, 800), lv(100_650, 4_200)], [lv(100_900, 5_000)]);
  const result = size({ buySnapshot: buy, sellSnapshot: sell, policies: policies({ max_order_size_usdt: 5_000 }) });
  assert.equal(result.sizeUsdt, 800);
  assert.notEqual(result.sizeUsdt, 5_000);
  assert.ok(result.candidates.some((c: Any) => c.sizeUsdtMicros > usdtToMicros(800) && c.riskAdjustedPnlToman > 0));
});

function opportunity(id: string, buy: string, sell: string): Any {
  return {
    id,
    routeKey: `${buy}->${sell}`,
    buySourceId: buy,
    sellSourceId: sell,
    buySourceName: buy,
    sellSourceName: sell,
    sizeUsdt: 0,
    buyVwapToman: 100_000,
    sellVwapToman: 100_800,
    rawSpreadPercent: 0.8,
    buyFeeToman: 0,
    sellFeeToman: 0,
    buyFeeBps: 25,
    sellFeeBps: 25,
    totalFeePercent: 0.5,
    slippageBufferToman: 0,
    rebalanceCostToman: 0,
    netProfitToman: -1,
    netEdgePercent: -1,
    buyCostToman: 0,
    sellProceedsToman: 0,
    eligibility: "EXECUTABLE_NOW",
    blockedReasons: [],
    firstSeenAt: NOW_ISO,
    lastSeenAt: NOW_ISO,
    endedAt: null,
    durationMs: 0,
    maxNetEdgePercent: 0,
    maxNetProfitToman: 0,
    maxRawSpreadPercent: 0.8,
    feeUnknown: false,
    observationCount: 1,
    isActive: true,
    buyAgeMs: 1_000,
    sellAgeMs: 1_000
  };
}

await test("concurrent routes cannot double-reserve the same simulated funds", () => {
  const sources = [
    snap("nobitex", [lv(99_900, 2_000)], [lv(100_000, 2_000)]),
    snap("tabdeal", [lv(99_900, 2_000)], [lv(100_050, 2_000)]),
    snap("wallex", [lv(100_800, 2_000)], [lv(100_900, 2_000)])
  ];
  const balances = [
    { sourceId: "nobitex", irtToman: 200_000_000, usdtMicros: usdtToMicros(1_000) },
    { sourceId: "tabdeal", irtToman: 200_000_000, usdtMicros: usdtToMicros(1_000) },
    { sourceId: "wallex", irtToman: 100_000_000, usdtMicros: usdtToMicros(1_500) }
  ];
  const evaluation = evaluateCycle({
    opportunities: [opportunity("r1", "nobitex", "wallex"), opportunity("r2", "tabdeal", "wallex")],
    sources,
    venueStates: ["nobitex", "tabdeal", "wallex"].map((sourceId) => ({
      sourceId,
      executable: true,
      capitalClass: "EXECUTABLE",
      takerFeeBps: 25,
      feeProvenance: "ADMIN_CONFIRMED",
      feeStale: false
    })) as never,
    executedLifecycleIds: new Set(),
    balances: balances as never,
    sizing: {
      policies: policies({ max_order_size_usdt: 1_000 }),
      allocationTomanBySource: new Map([["nobitex", 200_000_000], ["tabdeal", 200_000_000], ["wallex", 200_000_000]]),
      portfolioValueToman: 1_000_000_000,
      exposureTomanBySource: new Map([["nobitex", 0], ["tabdeal", 0], ["wallex", 0]]),
      slippageBufferBps: 5,
      inventoryModel: {
        valuationPriceToman: 100_000,
        targets: balances.map((b) => ({ sourceId: b.sourceId, targetUsdtSharePercent: 50 })),
        maxDeviationPoints: 100
      }
    },
    portfolioLimits: { enabled: false, equityToman: 1_000_000_000, markPriceToman: 100_000 }
  } as never);
  const fills = evaluation.decisions.filter((d: Any) => d.kind === "EXECUTE") as Any[];
  assert.equal(fills.length, 2);
  const debited = fills.reduce((sum, d) => sum + -d.plan.sellLeg.deltaUsdtMicros, 0);
  assert.ok(debited <= usdtToMicros(1_500));
  assert.equal(evaluation.reservations.holds, 0);
});

await test("stale/unknown-fee/missing-required-data fails closed", () => {
  assert.equal(size({ buySnapshot: snap("nobitex", [lv(99_900, 100)], [lv(100_000, 100)], { stale: true }) }).status, "BLOCKED");
  assert.equal(size({ buyFeeBps: null }).status, "BLOCKED");
  assert.equal(size({ policies: policies({ max_quote_age_ms: undefined }) }).status, "BLOCKED");
});

await test("venue rounding/min-notional boundaries", () => {
  const below = size({ policies: policies({ max_order_size_usdt: 4.99 }) });
  assert.equal(below.status, "BLOCKED");
  assert.equal(below.sizeUsdt, null);
  const rounded = size({ policies: policies({ max_order_size_usdt: 437.63 }) });
  assert.equal(rounded.sizeUsdt, 437.6);
  assert.ok(rounded.sizeUsdt! <= 437.63);
});

await test("legacy 5/10/20/25 discovery cannot gate execution", () => {
  const buy = snap("nobitex", [lv(99_900, 500)], [lv(100_000, 500)]);
  const sell = snap("wallex", [lv(100_800, 500)], [lv(100_900, 500)]);
  sell.sizeExecutables = sell.sizeExecutables.map((x: Any) =>
    x.sizeUsdt === 25 ? { ...x, sellFillable: false, sellFilledUsdt: 20 } : x
  );
  const built = buildOpportunitiesDetailed([buy, sell], [], NOW_ISO, {
    confirmedFeeBps: { nobitex: 25, wallex: 25 }
  });
  assert.ok(built.opportunities.some((o) => o.routeKey === "nobitex->wallex"));
  const result = size({ buySnapshot: buy, sellSnapshot: sell, policies: policies({ max_order_size_usdt: 200 }) });
  assert.equal(result.sizeUsdt, 200);
});

await test("fresh session bootstrap is role-aware, HARD-10-bps bounded, and conserves reserve", () => {
  const buy = snap(
    "nobitex",
    [lv(99_900, 1_000)],
    [lv(100_000, 100), lv(100_200, 900)]
  );
  const sell = snap(
    "wallex",
    [lv(100_800, 80), lv(100_600, 920)],
    [lv(100_900, 1_000)]
  );
  const evidence = buildOpeningAllocationEvidence(
    [buy, sell].map((s: Any) => ({
      sourceId: s.sourceId,
      stale: s.stale,
      health: s.health,
      executionEligible: true,
      feeCertain: true,
      feeBps: 25,
      userBuyToman: s.userBuyPriceToman,
      userSellToman: s.userSellPriceToman,
      bookAsks: s.bookAsks,
      bookBids: s.bookBids
    }))
  );
  assert.deepEqual(evidence.eligibleVenueIds, ["nobitex", "wallex"]);
  assert.equal(evidence.observations.length, 1);
  assert.equal(evidence.observations[0].capacityUsdtMicros, usdtToMicros(80));
  const plan = buildLiquidityAwarePlan({
    totalCapitalToman: 100_000_000,
    valuationPriceToman: 100_000,
    venueIds: evidence.eligibleVenueIds,
    observations: evidence.observations,
    reservePercent: 20,
    requireComplementaryVenues: true,
    minOperableUsdt: 5
  });
  assert.equal(plan.valid, true);
  assert.equal(plan.reserveToman, 20_000_000);
  assert.equal(plan.allocatedToman + plan.reserveToman, 100_000_000);
  assert.equal(plan.rows.find((r: Any) => r.sourceId === "nobitex")?.role, "BUY_SIDE");
  assert.equal(plan.rows.find((r: Any) => r.sourceId === "wallex")?.role, "SELL_SIDE");
});

await test("fresh session without complementary venues remains entirely in reserve", () => {
  const plan = buildLiquidityAwarePlan({
    totalCapitalToman: 100_000_000,
    valuationPriceToman: 100_000,
    venueIds: ["nobitex"],
    observations: [],
    reservePercent: 20,
    requireComplementaryVenues: true,
    minOperableUsdt: 5
  });
  assert.equal(plan.valid, false);
  assert.equal(plan.rows.length, 0);
  assert.equal(plan.reserveToman, 100_000_000);
  assert.equal(plan.residualToman, 0);
});

await test("LIVE_EXECUTION_IMPLEMENTED remains false", () => {
  assert.equal(LIVE_EXECUTION_IMPLEMENTED, false);
  assert.equal(SMART_SIZING_POLICY, "MAX_RA_PNL");
});

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
