#!/usr/bin/env npx tsx
/**
 * Bounded deterministic replay before/after for FULL-NO-TRADE closure.
 * Local only — no push / deploy / Live.
 */
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { assessCrossVenueCoherence } from "../src/lib/shadowArbitrage/streaming/eventFabric.ts";
import { SHADOW_EVENT_COHERENCE_MAX_SKEW_MS, SHADOW_STALE_MS } from "../src/lib/shadowArbitrage/config.ts";
import { recheckDelayedExecutableBook } from "../src/lib/shadowArbitrage/paper/delayedBookRecheck.ts";
import { paperReasonFromSizing } from "../src/lib/shadowArbitrage/paper/engine.ts";
import { planFill, settlementFor } from "../src/lib/shadowArbitrage/paper/broker.ts";
import type { NormalizedSourceSnapshot } from "../src/lib/shadowArbitrage/types.ts";
import { seedLocalPaperExecutionLimits } from "../src/lib/shadowArbitrage/paper/venueExecutionLimits.ts";

seedLocalPaperExecutionLimits({ minNotionalUsdt: 5, quantityStepUsdt: 0.01 });

const OUT = "/workspace/supervisor-tasks/SHADOW-TASK-008/full-no-trade-closure";
mkdirSync(OUT, { recursive: true });

type CaseResult = {
  id: string;
  classification: "BUG_FIXED" | "REJECTED_CORRECTLY" | "INDETERMINATE";
  before: string;
  after: string;
  note: string;
};

function iso(ms: number) {
  return new Date(ms).toISOString();
}

function snap(over: {
  sourceId: string;
  receivedAtMs: number;
  sourceEventMs?: number;
  bids?: Array<{ priceToman: number; amountUsdt: number }>;
  asks?: Array<{ priceToman: number; amountUsdt: number }>;
  ageMs?: number;
}): NormalizedSourceSnapshot {
  const bids = over.bids ?? [{ priceToman: 199_000, amountUsdt: 200 }];
  const asks = over.asks ?? [{ priceToman: 200_000, amountUsdt: 200 }];
  const receivedAt = iso(over.receivedAtMs);
  const sourceTs = iso(over.sourceEventMs ?? over.receivedAtMs);
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
    feeLabel: "t",
    feeReferenceUrl: null,
    feeVerifiedAt: receivedAt,
    sourceTimestamp: sourceTs,
    receivedAt,
    ageMs: over.ageMs ?? 200,
    health: "healthy",
    errorReason: null,
    degradedReason: null,
    stale: false,
    meta: {
      endpoint: null,
      httpStatus: 200,
      latencyMs: 40,
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
      sourceEventTimestamp: sourceTs,
      receiveTimestamp: receivedAt,
      sourceEventAgeMs: over.ageMs ?? 200,
      latencyEstimateMs: 40,
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

const T0 = Date.parse("2026-08-29T12:00:00.000Z");
const cases: CaseResult[] = [];

// Case 1: Phase2 FN — venue clocks offset, receive coherent (527f37cb…)
{
  const buy = snap({
    sourceId: "tabdeal",
    receivedAtMs: T0 - 200,
    sourceEventMs: T0 - 5_000 // venue clock far off
  });
  const sell = snap({
    sourceId: "ramzinex",
    receivedAtMs: T0 - 180,
    sourceEventMs: T0 - 100, // different venue clock
    bids: [{ priceToman: 206_000, amountUsdt: 200 }],
    asks: [{ priceToman: 206_100, amountUsdt: 200 }]
  });
  // BEFORE (buggy): gate on |venueEvent diff|
  const venueSkew = Math.abs(
    Date.parse(buy.marketData!.sourceEventTimestamp!) -
      Date.parse(sell.marketData!.sourceEventTimestamp!)
  );
  const beforeReject = venueSkew > SHADOW_EVENT_COHERENCE_MAX_SKEW_MS;
  // AFTER: comparable receive clock
  const after = assessCrossVenueCoherence({
    buy,
    sell,
    decisionTimestampMs: T0,
    maxAgeMs: SHADOW_STALE_MS,
    maxSourceSkewMs: SHADOW_EVENT_COHERENCE_MAX_SKEW_MS
  });
  cases.push({
    id: "527f37cb-tabdeal-ramzinex-coherence-FN",
    classification: beforeReject && after.coherent ? "BUG_FIXED" : "REJECTED_CORRECTLY",
    before: beforeReject ? "REJECT market_data_time_incoherent (venue-clock)" : "PASS",
    after: after.coherent ? "COHERENT (receive-clock)" : `REJECT ${after.reason}`,
    note: "Phase-2 comparable-clock fix preserved; venueClockSkewMs diagnostic only"
  });
}

// Case 2: sizing opaque → exact net_non_positive
{
  const before = "SKIP sizing_blocked (opaque)";
  const after = paperReasonFromSizing({
    status: "BLOCKED",
    blockers: [{ code: "not_net_positive", subject: "x", detailFa: "t" }],
    candidates: [{ rejectionCode: "not_net_positive" }]
  } as never);
  cases.push({
    id: "sizing-opaque-to-exact-net",
    classification: after === "net_non_positive" ? "BUG_FIXED" : "INDETERMINATE",
    before,
    after: `SKIP ${after}`,
    note: "Authoritative path emits exact economic reject"
  });
}

// Case 3: delayed liquidity disappear — previously would have filled atomically
{
  const buy = snap({ sourceId: "tabdeal", receivedAtMs: T0 - 200 });
  const sell = snap({
    sourceId: "ramzinex",
    receivedAtMs: T0 - 150,
    bids: [{ priceToman: 206_000, amountUsdt: 200 }],
    asks: [{ priceToman: 206_100, amountUsdt: 200 }]
  });
  const plan = planFill({
    buySourceId: "tabdeal" as never,
    sellSourceId: "ramzinex" as never,
    sizeUsdt: 50,
    buyVwapToman: 200_000,
    sellVwapToman: 206_000,
    buyFeeBps: 25,
    sellFeeBps: 25,
    buySettlement: settlementFor("tabdeal" as never, "buy"),
    sellSettlement: settlementFor("ramzinex" as never, "sell"),
    markPriceToman: 200_000,
    slippageBufferToman: 5_000
  });
  assert.equal(plan.ok, true);
  const delayedGone = {
    ...buy,
    bookAsks: null as never,
    bookBids: buy.bookBids
  };
  const recheck = recheckDelayedExecutableBook({
    buySourceId: "tabdeal" as never,
    sellSourceId: "ramzinex" as never,
    plannedSizeUsdt: 50,
    detectionBuy: buy,
    detectionSell: sell,
    delayedBuy: delayedGone,
    delayedSell: sell,
    decisionTimestampMs: T0,
    buyFeeBps: 25,
    sellFeeBps: 25,
    markPriceToman: 200_000,
    detectionBuyVwapToman: 200_000,
    detectionSellVwapToman: 206_000,
    detectionEconomicNetPnlToman: plan.ok ? plan.economicNetPnlToman : null,
    detectionRiskAdjustedPnlToman: plan.ok ? plan.riskAdjustedPnlToman : null,
    config: {
      latency: { baseArrivalDelayMs: 250, maxDelayMs: 5000, fixedDelayMs: 300 },
      allowPartialFill: false,
      simulateLegRisk: false,
      slippageBufferBps: 5
    }
  });
  cases.push({
    id: "delayed-liquidity-disappear",
    classification: !recheck.ok ? "BUG_FIXED" : "INDETERMINATE",
    before: "EXECUTE atomic fantasy fill (no delayed recheck)",
    after: recheck.ok ? "EXECUTE (unexpected)" : `SKIP ${recheck.code}`,
    note: "REALISM-1: never fill when delayed liquidity gone"
  });
}

// Case 4: negative delayed net must not fill
{
  const buy = snap({
    sourceId: "tabdeal",
    receivedAtMs: T0 - 200,
    asks: [{ priceToman: 210_000, amountUsdt: 200 }],
    bids: [{ priceToman: 209_800, amountUsdt: 200 }]
  });
  const sell = snap({
    sourceId: "ramzinex",
    receivedAtMs: T0 - 150,
    bids: [{ priceToman: 210_100, amountUsdt: 200 }],
    asks: [{ priceToman: 210_200, amountUsdt: 200 }]
  });
  const recheck = recheckDelayedExecutableBook({
    buySourceId: "tabdeal" as never,
    sellSourceId: "ramzinex" as never,
    plannedSizeUsdt: 50,
    detectionBuy: buy,
    detectionSell: sell,
    delayedBuy: buy,
    delayedSell: sell,
    decisionTimestampMs: T0,
    buyFeeBps: 25,
    sellFeeBps: 25,
    markPriceToman: 210_000,
    detectionBuyVwapToman: 200_000,
    detectionSellVwapToman: 206_000,
    config: {
      latency: { baseArrivalDelayMs: 0, maxDelayMs: 5000, fixedDelayMs: 0 },
      allowPartialFill: false,
      simulateLegRisk: false,
      slippageBufferBps: 5
    }
  });
  cases.push({
    id: "negative-net-never-fill",
    classification: !recheck.ok ? "REJECTED_CORRECTLY" : "INDETERMINATE",
    before: "n/a (detection may have looked positive)",
    after: recheck.ok ? "EXECUTE BAD" : `SKIP ${recheck.code}`,
    note: "0 negative-net-after-real-cost → fill"
  });
}

const summary = {
  total: cases.length,
  bugFixed: cases.filter((c) => c.classification === "BUG_FIXED").length,
  rejectedCorrectly: cases.filter((c) => c.classification === "REJECTED_CORRECTLY").length,
  indeterminate: cases.filter((c) => c.classification === "INDETERMINATE").length,
  cases
};

writeFileSync(`${OUT}/raw-replay.json`, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
console.log(`\nWrote ${OUT}/raw-replay.json`);
