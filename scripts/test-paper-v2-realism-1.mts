#!/usr/bin/env npx tsx
/**
 * PAPER-V2 REALISM-1 + FULL-NO-TRADE section E regressions.
 * Local only: PUSH=NO DEPLOY=NO LIVE=false
 */
import assert from "node:assert/strict";
import {
  recheckDelayedExecutableBook,
  resolveExecutionDelayMs,
  snapshotAtArrival,
  DEFAULT_PAPER_EXECUTION_REALISM,
  type DelayedRecheckResult
} from "../src/lib/shadowArbitrage/paper/delayedBookRecheck.ts";
import { planFill, settlementFor } from "../src/lib/shadowArbitrage/paper/broker.ts";
import { paperReasonFromSizing } from "../src/lib/shadowArbitrage/paper/engine.ts";
import type { SizingResult } from "../src/lib/shadowArbitrage/paper/sizing.ts";
import type { NormalizedSourceSnapshot } from "../src/lib/shadowArbitrage/types.ts";
import { seedLocalPaperExecutionLimits } from "../src/lib/shadowArbitrage/paper/venueExecutionLimits.ts";

seedLocalPaperExecutionLimits({ minNotionalUsdt: 5, quantityStepUsdt: 0.01 });

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

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function snap(over: {
  sourceId: string;
  receivedAtMs: number;
  bids?: Array<{ priceToman: number; amountUsdt: number }>;
  asks?: Array<{ priceToman: number; amountUsdt: number }>;
  stale?: boolean;
  ageMs?: number;
  latencyEstimateMs?: number | null;
}): NormalizedSourceSnapshot {
  const bids = over.bids ?? [{ priceToman: 199_000, amountUsdt: 200 }];
  const asks = over.asks ?? [{ priceToman: 200_000, amountUsdt: 200 }];
  const receivedAt = iso(over.receivedAtMs);
  return {
    sourceId: over.sourceId as never,
    sourceName: over.sourceId,
    marketModel: "ORDER_BOOK",
    accountStatus: "READY",
    eligibilityBase: "EXECUTABLE",
    bestBidToman: bids[0]!.priceToman,
    bestAskToman: asks[0]!.priceToman,
    userBuyPriceToman: asks[0]!.priceToman,
    userSellPriceToman: bids[0]!.priceToman,
    sizeExecutables: [],
    bookBids: bids,
    bookAsks: asks,
    depthUsdtBid: bids.reduce((s, l) => s + l.amountUsdt, 0),
    depthUsdtAsk: asks.reduce((s, l) => s + l.amountUsdt, 0),
    maxExecutableUsdt: 200,
    marketFeeBps: 25,
    feeStatus: "confirmed",
    feeLabel: "test",
    feeReferenceUrl: null,
    feeVerifiedAt: receivedAt,
    sourceTimestamp: receivedAt,
    receivedAt,
    ageMs: over.ageMs ?? 100,
    health: "healthy",
    errorReason: null,
    degradedReason: null,
    stale: over.stale ?? false,
    meta: {
      endpoint: null,
      httpStatus: 200,
      latencyMs: over.latencyEstimateMs ?? 50,
      attempts: 1,
      rateLimited: false,
      timedOut: false,
      depthAvailable: true,
      directionVerified: true,
      priceUnit: "IRT",
      normalizationNote: null
    },
    marketData: {
      transport: "WS",
      sequence: 1,
      sourceEventTimestamp: receivedAt,
      receiveTimestamp: receivedAt,
      sourceEventAgeMs: over.ageMs ?? 100,
      latencyEstimateMs: over.latencyEstimateMs ?? 50,
      jitterMs: 0,
      reconnectCount: 0,
      gapCount: 0,
      outOfOrderCount: 0,
      resyncCount: 0,
      resyncProvenance: null,
      snapshotResyncState: "SYNCHRONIZED"
    }
  };
}

const T0 = Date.parse("2026-09-07T09:00:00.000Z");

function baseInput(over: Partial<Parameters<typeof recheckDelayedExecutableBook>[0]> = {}) {
  const buy = snap({ sourceId: "tabdeal", receivedAtMs: T0 - 200 });
  const sell = snap({
    sourceId: "ramzinex",
    receivedAtMs: T0 - 150,
    bids: [{ priceToman: 206_000, amountUsdt: 200 }],
    asks: [{ priceToman: 206_100, amountUsdt: 200 }]
  });
  const size = 50;
  const buyVwap = 200_000;
  const sellVwap = 206_000;
  const detectionPlan = planFill({
    buySourceId: "tabdeal" as never,
    sellSourceId: "ramzinex" as never,
    sizeUsdt: size,
    buyVwapToman: buyVwap,
    sellVwapToman: sellVwap,
    buyFeeBps: 25,
    sellFeeBps: 25,
    buySettlement: settlementFor("tabdeal" as never, "buy"),
    sellSettlement: settlementFor("ramzinex" as never, "sell"),
    markPriceToman: buyVwap,
    slippageBufferToman: Math.round(buyVwap * size * 0.0005)
  });
  if (!detectionPlan.ok) {
    throw new Error(`fixture detection plan not profitable: ${detectionPlan.code}`);
  }
  return {
    buySourceId: "tabdeal" as never,
    sellSourceId: "ramzinex" as never,
    plannedSizeUsdt: size,
    detectionBuy: buy,
    detectionSell: sell,
    delayedBuy: buy,
    delayedSell: sell,
    decisionTimestampMs: T0,
    buyFeeBps: 25,
    sellFeeBps: 25,
    markPriceToman: buyVwap,
    detectionBuyVwapToman: buyVwap,
    detectionSellVwapToman: sellVwap,
    detectionEconomicNetPnlToman: detectionPlan.ok ? detectionPlan.economicNetPnlToman : null,
    detectionRiskAdjustedPnlToman: detectionPlan.ok ? detectionPlan.riskAdjustedPnlToman : null,
    config: {
      ...DEFAULT_PAPER_EXECUTION_REALISM,
      latency: { baseArrivalDelayMs: 250, maxDelayMs: 5_000, fixedDelayMs: 300 },
      allowPartialFill: false,
      simulateLegRisk: false,
      slippageBufferBps: 5
    },
    ...over
  };
}

console.log("\nPAPER-V2 REALISM-1 / FULL-NO-TRADE E\n");

await test("1. liquidity survives => remains fill-eligible", () => {
  const r = recheckDelayedExecutableBook(baseInput());
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.outcome, "FILL_FULL");
    assert.equal(r.partial, false);
    assert.ok(r.plan.riskAdjustedPnlToman > 0);
    assert.equal(r.evidence.appliedDelayMs, 300);
    assert.ok(r.evidence.detection.buy.asks?.length);
    assert.ok(r.evidence.delayed.buy.asks?.length);
  }
});

await test("2. best level disappears => reject", () => {
  const buyGone = snap({
    sourceId: "tabdeal",
    receivedAtMs: T0 - 200,
    asks: [{ priceToman: 200_000, amountUsdt: 200 }],
    bids: [{ priceToman: 199_000, amountUsdt: 200 }]
  });
  const r = recheckDelayedExecutableBook(
    baseInput({
      delayedBuy: {
        ...buyGone,
        bookAsks: null,
        bookBids: [{ priceToman: 199_000, amountUsdt: 200 }],
        bestAskToman: null,
        userBuyPriceToman: null,
        depthUsdtAsk: 0
      }
    })
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(
      ["delayed_liquidity_disappeared", "delayed_book_invalid"].includes(r.code),
      r.code
    );
  }
});

await test("3. depth shrinks below plan (no partial) => reject exact blocker", () => {
  const thinBuy = snap({
    sourceId: "tabdeal",
    receivedAtMs: T0 - 200,
    asks: [{ priceToman: 200_000, amountUsdt: 10 }], // plan 50
    bids: [{ priceToman: 199_000, amountUsdt: 200 }]
  });
  const thinSell = snap({
    sourceId: "ramzinex",
    receivedAtMs: T0 - 150,
    bids: [{ priceToman: 206_000, amountUsdt: 10 }],
    asks: [{ priceToman: 206_100, amountUsdt: 200 }]
  });
  const r = recheckDelayedExecutableBook(
    baseInput({
      delayedBuy: thinBuy,
      delayedSell: thinSell,
      config: {
        ...DEFAULT_PAPER_EXECUTION_REALISM,
        latency: { baseArrivalDelayMs: 250, maxDelayMs: 5000, fixedDelayMs: 300 },
        allowPartialFill: false,
        simulateLegRisk: false,
        slippageBufferBps: 5
      }
    })
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "delayed_depth_insufficient");
});

await test("3b. depth shrinks but partial allowed => FILL_PARTIAL when still profitable", () => {
  const thinBuy = snap({
    sourceId: "tabdeal",
    receivedAtMs: T0 - 200,
    asks: [{ priceToman: 200_000, amountUsdt: 20 }],
    bids: [{ priceToman: 199_000, amountUsdt: 200 }]
  });
  const thinSell = snap({
    sourceId: "ramzinex",
    receivedAtMs: T0 - 150,
    bids: [{ priceToman: 206_000, amountUsdt: 20 }],
    asks: [{ priceToman: 206_100, amountUsdt: 200 }]
  });
  const r = recheckDelayedExecutableBook(
    baseInput({
      delayedBuy: thinBuy,
      delayedSell: thinSell,
      config: {
        ...DEFAULT_PAPER_EXECUTION_REALISM,
        latency: { baseArrivalDelayMs: 250, maxDelayMs: 5000, fixedDelayMs: 300 },
        allowPartialFill: true,
        simulateLegRisk: false,
        slippageBufferBps: 5,
        minSizeUsdt: 5
      }
    })
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.outcome, "FILL_PARTIAL");
    assert.ok(r.fillSizeUsdt <= 20);
    assert.ok(r.fillSizeUsdt >= 5);
    assert.ok(r.plan.riskAdjustedPnlToman > 0);
  }
});

await test("4. delayed VWAP makes net <= 0 => reject", () => {
  // Adverse move: buy ask up, sell bid down => edge dies
  const badBuy = snap({
    sourceId: "tabdeal",
    receivedAtMs: T0 - 200,
    asks: [{ priceToman: 205_200, amountUsdt: 200 }],
    bids: [{ priceToman: 205_000, amountUsdt: 200 }]
  });
  const badSell = snap({
    sourceId: "ramzinex",
    receivedAtMs: T0 - 150,
    bids: [{ priceToman: 205_050, amountUsdt: 200 }],
    asks: [{ priceToman: 205_100, amountUsdt: 200 }]
  });
  const r = recheckDelayedExecutableBook(
    baseInput({ delayedBuy: badBuy, delayedSell: badSell })
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "delayed_net_non_positive");
});

await test("5. delayed book stale/incoherent => reject", () => {
  const staleBuy = snap({
    sourceId: "tabdeal",
    receivedAtMs: T0 - 200_000,
    ageMs: 200_000,
    stale: false
  });
  const staleSell = snap({
    sourceId: "ramzinex",
    receivedAtMs: T0 - 200_000,
    ageMs: 200_000,
    bids: [{ priceToman: 205_000, amountUsdt: 200 }],
    asks: [{ priceToman: 205_100, amountUsdt: 200 }]
  });
  const r = recheckDelayedExecutableBook(
    baseInput({
      delayedBuy: staleBuy,
      delayedSell: staleSell,
      config: {
        ...DEFAULT_PAPER_EXECUTION_REALISM,
        latency: { baseArrivalDelayMs: 0, maxDelayMs: 5000, fixedDelayMs: 0 },
        allowPartialFill: false,
        simulateLegRisk: false,
        slippageBufferBps: 5,
        maxAgeMs: 90_000
      }
    })
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(
      ["delayed_book_stale", "delayed_book_incoherent", "stale_market_data"].includes(r.code),
      r.code
    );
  }

  const skewBuy = snap({ sourceId: "tabdeal", receivedAtMs: T0 - 5_000 });
  const skewSell = snap({
    sourceId: "ramzinex",
    receivedAtMs: T0 - 100,
    bids: [{ priceToman: 205_000, amountUsdt: 200 }],
    asks: [{ priceToman: 205_100, amountUsdt: 200 }]
  });
  const r2 = recheckDelayedExecutableBook(
    baseInput({
      delayedBuy: skewBuy,
      delayedSell: skewSell,
      config: {
        ...DEFAULT_PAPER_EXECUTION_REALISM,
        latency: { baseArrivalDelayMs: 0, maxDelayMs: 5000, fixedDelayMs: 0 },
        allowPartialFill: false,
        simulateLegRisk: false,
        slippageBufferBps: 5,
        maxCrossVenueSkewMs: 2_500
      }
    })
  );
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.code, "delayed_book_incoherent");
});

await test("6. original+delayed evidence persisted", () => {
  const r = recheckDelayedExecutableBook(baseInput());
  assert.ok(r.evidence.version === "paper_v2_delayed_recheck_v1");
  assert.ok(r.evidence.detection.sizeUsdt === 50);
  assert.ok(r.evidence.detection.buy.sourceId === "tabdeal");
  assert.ok(r.evidence.delayed.buy.sourceId === "tabdeal");
  assert.equal(r.evidence.appliedDelayMs, 300);
  assert.ok(r.evidence.arrivalTimestampMs === T0 + 300);
});

await test("7. deterministic replay stable", () => {
  const input = baseInput();
  const a = recheckDelayedExecutableBook(input);
  const b = recheckDelayedExecutableBook(input);
  assert.deepEqual(
    JSON.parse(JSON.stringify(a.evidence)),
    JSON.parse(JSON.stringify(b.evidence))
  );
  assert.equal(a.ok, b.ok);
  if (a.ok && b.ok) {
    assert.equal(a.plan.riskAdjustedPnlToman, b.plan.riskAdjustedPnlToman);
    assert.equal(a.fillSizeUsdt, b.fillSizeUsdt);
  }
});

await test("8. no negative-after-fee route becomes fillable", () => {
  const r = recheckDelayedExecutableBook(
    baseInput({
      // Force detection-like bad prices on delayed book
      delayedBuy: snap({
        sourceId: "tabdeal",
        receivedAtMs: T0 - 200,
        asks: [{ priceToman: 210_000, amountUsdt: 200 }],
        bids: [{ priceToman: 209_800, amountUsdt: 200 }]
      }),
      delayedSell: snap({
        sourceId: "ramzinex",
        receivedAtMs: T0 - 150,
        bids: [{ priceToman: 210_050, amountUsdt: 200 }],
        asks: [{ priceToman: 210_100, amountUsdt: 200 }]
      })
    })
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, "delayed_net_non_positive");
    assert.ok(
      r.evidence.delayed.riskAdjustedPnlToman === null ||
        (r.evidence.delayed.riskAdjustedPnlToman as number) <= 0 ||
        r.evidence.rejectCode === "delayed_net_non_positive"
    );
  }
});

await test("E. leg-risk second leg fails => reject (no atomic fantasy)", () => {
  const postSell = snap({
    sourceId: "ramzinex",
    receivedAtMs: T0 - 150,
    bids: [{ priceToman: 206_000, amountUsdt: 200 }],
    asks: [{ priceToman: 206_100, amountUsdt: 200 }]
  });
  const r = recheckDelayedExecutableBook(
    baseInput({
      postFirstLegSell: {
        ...postSell,
        bookBids: null,
        bookAsks: [{ priceToman: 206_100, amountUsdt: 200 }],
        bestBidToman: null,
        userSellPriceToman: null,
        depthUsdtBid: 0
      },
      config: {
        ...DEFAULT_PAPER_EXECUTION_REALISM,
        latency: { baseArrivalDelayMs: 250, maxDelayMs: 5000, fixedDelayMs: 300 },
        allowPartialFill: false,
        simulateLegRisk: true,
        firstLeg: "buy",
        slippageBufferBps: 5
      }
    })
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.outcome, "LEG_RISK_SECOND_LEG_FAILED");
    assert.equal(r.code, "leg_risk_second_leg_failed");
    assert.ok(r.evidence.legRisk?.simulated);
  }
});

await test("E. crossed/NaN delayed book => delayed_book_invalid", () => {
  const crossed = snap({
    sourceId: "tabdeal",
    receivedAtMs: T0 - 200,
    bids: [{ priceToman: 201_000, amountUsdt: 50 }],
    asks: [{ priceToman: 200_000, amountUsdt: 50 }] // crossed
  });
  const r = recheckDelayedExecutableBook(baseInput({ delayedBuy: crossed }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "delayed_book_invalid");
});

await test("F. sizing exact blocker codes (no opaque collapse for known blockers)", () => {
  const mk = (code: string): SizingResult =>
    ({
      status: "BLOCKED",
      sizeUsdtMicros: null,
      quote: null,
      economics: null,
      blockers: [{ code, subject: "x", detailFa: "t" }],
      candidates: [],
      constraints: []
    }) as unknown as SizingResult;
  assert.equal(paperReasonFromSizing(mk("missing_policy")), "sizing_missing_policy");
  assert.equal(paperReasonFromSizing(mk("expired_policy")), "sizing_expired_policy");
  assert.equal(paperReasonFromSizing(mk("slippage_over_limit")), "sizing_slippage_over_limit");
  assert.equal(paperReasonFromSizing(mk("size_floor")), "sizing_size_floor");
  assert.equal(paperReasonFromSizing(mk("not_net_positive")), "net_non_positive");
  assert.equal(paperReasonFromSizing(mk("depth_exhausted")), "insufficient_depth");
});

await test("latency model deterministic + capped", () => {
  const buy = snap({ sourceId: "tabdeal", receivedAtMs: T0, latencyEstimateMs: 9_000 });
  const sell = snap({ sourceId: "ramzinex", receivedAtMs: T0, latencyEstimateMs: 100 });
  const d = resolveExecutionDelayMs({
    buy,
    sell,
    model: { baseArrivalDelayMs: 250, maxDelayMs: 5_000, fixedDelayMs: null }
  });
  assert.equal(d, 5_000);
  const fixed = resolveExecutionDelayMs({
    buy,
    sell,
    model: { baseArrivalDelayMs: 250, maxDelayMs: 5_000, fixedDelayMs: 400 }
  });
  assert.equal(fixed, 400);
  const aged = snapshotAtArrival(buy, T0 + 1_000, 90_000);
  assert.ok(aged.ageMs >= 1000 || aged.ageMs === buy.ageMs);
});

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
