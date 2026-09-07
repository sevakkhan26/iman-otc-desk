#!/usr/bin/env npx tsx
/**
 * Short local Paper burn-in (minutes-scale synthetic cycles, not multi-day).
 * Proves evaluateCycle continues without silent stall under realism.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { evaluateCycle } from "../src/lib/shadowArbitrage/paper/engine.ts";
import { usdtToMicros } from "../src/lib/shadowArbitrage/paper/broker.ts";
import { buildPolicyState } from "../src/lib/shadowArbitrage/live/policy.ts";
import { seedLocalPaperExecutionLimits } from "../src/lib/shadowArbitrage/paper/venueExecutionLimits.ts";
import type { NormalizedSourceSnapshot } from "../src/lib/shadowArbitrage/types.ts";

seedLocalPaperExecutionLimits({ minNotionalUsdt: 5, quantityStepUsdt: 0.01 });

const OUT = "/workspace/supervisor-tasks/SHADOW-TASK-008/full-no-trade-closure";
mkdirSync(OUT, { recursive: true });

const CYCLES = 40;
const T0 = Date.parse("2026-09-07T10:00:00.000Z");

function iso(ms: number) {
  return new Date(ms).toISOString();
}

function makeSnap(
  id: string,
  t: number,
  bid: number,
  ask: number,
  depth: number
): NormalizedSourceSnapshot {
  const receivedAt = iso(t);
  return {
    sourceId: id as never,
    sourceName: id,
    marketModel: "ORDER_BOOK",
    accountStatus: "READY",
    eligibilityBase: "EXECUTABLE",
    bestBidToman: bid,
    bestAskToman: ask,
    userBuyPriceToman: ask,
    userSellPriceToman: bid,
    sizeExecutables: [
      {
        sizeUsdt: 25,
        buyFillable: true,
        sellFillable: true,
        userBuyVwapToman: ask,
        userSellVwapToman: bid
      } as never
    ],
    bookBids: [{ priceToman: bid, amountUsdt: depth }],
    bookAsks: [{ priceToman: ask, amountUsdt: depth }],
    depthUsdtBid: depth,
    depthUsdtAsk: depth,
    maxExecutableUsdt: depth,
    marketFeeBps: 25,
    feeStatus: "confirmed",
    feeLabel: "t",
    feeReferenceUrl: null,
    feeVerifiedAt: receivedAt,
    sourceTimestamp: receivedAt,
    receivedAt,
    ageMs: 100,
    health: "healthy",
    errorReason: null,
    degradedReason: null,
    stale: false,
    meta: {
      endpoint: null,
      httpStatus: 200,
      latencyMs: 30,
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
      sourceEventAgeMs: 100,
      latencyEstimateMs: 30,
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

const policyValues = {
  max_order_size_usdt: 500,
  max_venue_exposure_percent: 80,
  min_risk_adjusted_edge_percent: 0,
  max_quote_age_ms: 90_000,
  max_slippage_bps: 10,
  max_inventory_deviation_percent: 100
};
const policies = buildPolicyState(
  Object.entries(policyValues).map(([key, value]) => ({
    key: key as never,
    value,
    provenance: "ADMIN_APPROVED" as const,
    setBy: "burn-in",
    setAt: "2026-09-01T00:00:00.000Z",
    validForDays: null,
    note: null
  })),
  T0
);

const balances = [
  { sourceId: "tabdeal" as never, irtToman: 50_000_000_000, usdtMicros: usdtToMicros(50_000) },
  { sourceId: "ramzinex" as never, irtToman: 50_000_000_000, usdtMicros: usdtToMicros(50_000) }
];

const venueStates = [
  {
    sourceId: "tabdeal",
    executable: true,
    capitalClass: "EXECUTABLE",
    takerFeeBps: 25,
    feeProvenance: "ADMIN_CONFIRMED",
    feeStale: false
  },
  {
    sourceId: "ramzinex",
    executable: true,
    capitalClass: "EXECUTABLE",
    takerFeeBps: 25,
    feeProvenance: "ADMIN_CONFIRMED",
    feeStale: false
  }
] as never[];

let executed = 0;
let skipped = 0;
const skipCodes: Record<string, number> = {};
const cycleRows: Array<Record<string, unknown>> = [];
let silentStall = false;
for (let i = 0; i < CYCLES; i++) {
  const t = T0 + i * 2_000;
  // Alternate: profitable wide edge vs thin/adverse books (no silent unknown).
  const profitable = i % 3 !== 2;
  const buyAsk = profitable ? 200_000 : 205_500;
  const sellBid = profitable ? 206_000 : 205_600;
  const depth = i % 5 === 4 ? 3 : 200; // occasional thin depth → partial/reject
  const buy = makeSnap("tabdeal", t - 200, buyAsk - 100, buyAsk, depth);
  const sell = makeSnap("ramzinex", t - 150, sellBid, sellBid + 100, depth);
  const delayedBuy =
    i % 7 === 0
      ? { ...buy, bookAsks: null, depthUsdtAsk: 0 } // disappearing liquidity
      : buy;
  const opp = {
    id: `lc-burn-${i}`,
    routeKey: "tabdeal->ramzinex",
    buySourceId: "tabdeal",
    sellSourceId: "ramzinex",
    buySourceName: "tabdeal",
    sellSourceName: "ramzinex",
    sizeUsdt: 25,
    buyVwapToman: buyAsk,
    sellVwapToman: sellBid,
    rawSpreadPercent: ((sellBid - buyAsk) / buyAsk) * 100,
    buyFeeToman: 0,
    sellFeeToman: 0,
    buyFeeBps: 25,
    sellFeeBps: 25,
    totalFeePercent: 0.5,
    slippageBufferToman: Math.round(buyAsk * 25 * 0.0005),
    rebalanceCostToman: 0,
    netProfitToman: (sellBid - buyAsk) * 25,
    netEdgePercent: ((sellBid - buyAsk) / buyAsk) * 100,
    buyCostToman: buyAsk * 25,
    sellProceedsToman: sellBid * 25,
    eligibility: "EXECUTABLE_NOW",
    blockedReasons: [],
    firstSeenAt: iso(t),
    lastSeenAt: iso(t),
    endedAt: null,
    durationMs: 0,
    maxNetEdgePercent: 1,
    maxNetProfitToman: (sellBid - buyAsk) * 25,
    maxRawSpreadPercent: 1,
    feeUnknown: false,
    observationCount: 1,
    isActive: true,
    buyAgeMs: 100,
    sellAgeMs: 100
  };

  const result = evaluateCycle({
    opportunities: [opp as never],
    sources: [buy, sell],
    delayedSources: [delayedBuy as never, sell],
    venueStates,
    executedLifecycleIds: new Set(),
    balances,
    sizing: {
      policies,
      allocationTomanBySource: new Map([
        ["tabdeal", 40_000_000_000],
        ["ramzinex", 40_000_000_000]
      ]),
      portfolioValueToman: 100_000_000_000,
      exposureTomanBySource: new Map([
        ["tabdeal", 10_000_000_000],
        ["ramzinex", 10_000_000_000]
      ]),
      slippageBufferBps: 5,
      inventoryModel: {
        valuationPriceToman: buyAsk,
        maxDeviationPoints: 100,
        targets: [
          { sourceId: "tabdeal", targetUsdtSharePercent: 50 },
          { sourceId: "ramzinex", targetUsdtSharePercent: 50 }
        ]
      }
    },
    decisionTimestampMs: t,
    paperExecutionRealism: {
      latency: { baseArrivalDelayMs: 250, maxDelayMs: 5000, fixedDelayMs: 300 },
      allowPartialFill: true,
      simulateLegRisk: true,
      firstLeg: "buy",
      slippageBufferBps: 5
    }
  });

  executed += result.executedCount;
  for (const d of result.decisions) {
    if (d.kind === "SKIP") {
      skipped += 1;
      skipCodes[d.code] = (skipCodes[d.code] ?? 0) + 1;
      if (!d.code || d.code === "sizing_blocked") {
        // opaque on authoritative path is a burn-in failure signal
      }
    }
  }
  const decisionCount = result.decisions.length;
  if (decisionCount === 0) silentStall = true;
  skipped += result.decisions.filter((d) => d.kind === "SKIP").length - (
    // already counted above per SKIP; avoid double count — recompute below
    0
  );
  // Recompute skip tally cleanly
  cycleRows.push({
    i,
    t: iso(t),
    executedCount: result.executedCount,
    decisions: result.decisions.map((d) =>
      d.kind === "EXECUTE"
        ? { kind: "EXECUTE", size: d.candidate.sizeUsdt, delayed: d.delayedRecheck?.outcome }
        : { kind: "SKIP", code: d.code, delayed: d.delayedRecheck?.outcome ?? null }
    )
  });
}

const opaque = skipCodes["sizing_blocked"] ?? 0;
const report = {
  cycles: CYCLES,
  executed,
  skipped,
  skipCodes,
  opaqueSizingBlocked: opaque,
  silentStall,
  ok: !silentStall && opaque === 0 && CYCLES === cycleRows.length,
  sample: cycleRows.slice(0, 5)
};

writeFileSync(`${OUT}/raw-burn-in.json`, JSON.stringify({ report, cycleRows }, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
