#!/usr/bin/env npx tsx
/** Replay a preserved real positive book through the current pure Paper engine. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildPolicyState } from "../src/lib/shadowArbitrage/live/policy.ts";
import { evaluateCycle } from "../src/lib/shadowArbitrage/paper/engine.ts";
import type { NormalizedSourceSnapshot, ShadowOpportunity } from "../src/lib/shadowArbitrage/types.ts";

const evidencePath = process.env.REAL_POSITIVE_SNAPSHOT;
if (!evidencePath) throw new Error("REAL_POSITIVE_SNAPSHOT must point to preserved market evidence");
const proof = JSON.parse(await readFile(evidencePath, "utf8")) as {
  lifecycleId: string;
  routeKey: string;
  filled: {
    arrival_snapshot_ref: {
      buy: { sourceId: string; bids: Array<{ priceToman: number; amountUsdt: number }>; asks: Array<{ priceToman: number; amountUsdt: number }> };
      sell: { sourceId: string; bids: Array<{ priceToman: number; amountUsdt: number }>; asks: Array<{ priceToman: number; amountUsdt: number }> };
    };
  };
};

const now = Date.now();
const iso = new Date(now).toISOString();
const rawBuy = proof.filled.arrival_snapshot_ref.buy;
const rawSell = proof.filled.arrival_snapshot_ref.sell;
function snapshot(raw: typeof rawBuy): NormalizedSourceSnapshot {
  const bestBid = raw.bids[0]?.priceToman ?? null;
  const bestAsk = raw.asks[0]?.priceToman ?? null;
  const bidDepth = raw.bids.reduce((sum, level) => sum + level.amountUsdt, 0);
  const askDepth = raw.asks.reduce((sum, level) => sum + level.amountUsdt, 0);
  return {
    sourceId: raw.sourceId as never,
    sourceName: raw.sourceId,
    marketModel: "ORDER_BOOK",
    accountStatus: "READY",
    eligibilityBase: "EXECUTABLE",
    bestBidToman: bestBid,
    bestAskToman: bestAsk,
    userBuyPriceToman: bestAsk,
    userSellPriceToman: bestBid,
    sizeExecutables: [],
    bookBids: raw.bids,
    bookAsks: raw.asks,
    depthUsdtBid: bidDepth,
    depthUsdtAsk: askDepth,
    maxExecutableUsdt: Math.min(bidDepth, askDepth),
    marketFeeBps: raw.sourceId === "tetherland" ? 45 : 20,
    feeStatus: "confirmed",
    feeLabel: "preserved-real-market-evidence",
    feeReferenceUrl: null,
    feeVerifiedAt: iso,
    sourceTimestamp: iso,
    receivedAt: iso,
    ageMs: 0,
    health: "healthy",
    errorReason: null,
    degradedReason: null,
    stale: false,
    meta: {
      endpoint: `replay://${raw.sourceId}/preserved-real-book`,
      httpStatus: 200,
      latencyMs: 0,
      attempts: 1,
      rateLimited: false,
      timedOut: false,
      depthAvailable: true,
      directionVerified: true,
      priceUnit: "IRT",
      normalizationNote: `Preserved real book from ${evidencePath}`
    },
    sourceBlockedReasons: [],
    marketData: {
      transport: "REST",
      sequence: 1,
      sourceEventTimestamp: iso,
      receiveTimestamp: iso,
      sourceEventAgeMs: 0,
      latencyEstimateMs: 0,
      jitterMs: 0,
      reconnectCount: 0,
      gapCount: 0,
      outOfOrderCount: 0,
      resyncCount: 0,
      resyncProvenance: "preserved_real_snapshot",
      snapshotResyncState: "SYNCHRONIZED"
    }
  };
}

const buy = snapshot(rawBuy);
const sell = snapshot(rawSell);
function observedAt(source: NormalizedSourceSnapshot, timestampMs: number): NormalizedSourceSnapshot {
  const timestamp = new Date(timestampMs).toISOString();
  return {
    ...source,
    receivedAt: timestamp,
    sourceTimestamp: timestamp,
    marketData: source.marketData
      ? { ...source.marketData, receiveTimestamp: timestamp, sourceEventTimestamp: timestamp }
      : null
  };
}
const delayedBuy = observedAt(buy, now + 300);
const delayedSell = observedAt(sell, now + 300);
const postBuy = observedAt(buy, now + 600);
const postSell = observedAt(sell, now + 600);
const buyPx = buy.bestAskToman!;
const sellPx = sell.bestBidToman!;
const probeSize = 5;
const fees = { buy: 45, sell: 20 };
const gross = (sellPx - buyPx) * probeSize;
const feeToman = Math.round((buyPx * probeSize * fees.buy) / 10_000 + (sellPx * probeSize * fees.sell) / 10_000);
const opportunity: ShadowOpportunity = {
  id: `${proof.lifecycleId}-current-replay`, routeKey: proof.routeKey,
  buySourceId: rawBuy.sourceId as never, sellSourceId: rawSell.sourceId as never,
  buySourceName: rawBuy.sourceId, sellSourceName: rawSell.sourceId,
  sizeUsdt: probeSize, buyVwapToman: buyPx, sellVwapToman: sellPx,
  rawSpreadPercent: ((sellPx - buyPx) / buyPx) * 100,
  buyFeeToman: Math.round((buyPx * probeSize * fees.buy) / 10_000),
  sellFeeToman: Math.round((sellPx * probeSize * fees.sell) / 10_000),
  buyFeeBps: fees.buy, sellFeeBps: fees.sell, totalFeePercent: (fees.buy + fees.sell) / 100,
  slippageBufferToman: 0, rebalanceCostToman: 0,
  netProfitToman: gross - feeToman, netEdgePercent: ((gross - feeToman) / (buyPx * probeSize)) * 100,
  buyCostToman: buyPx * probeSize, sellProceedsToman: sellPx * probeSize,
  eligibility: "EXECUTABLE_NOW", blockedReasons: [], firstSeenAt: iso, lastSeenAt: iso,
  endedAt: null, durationMs: 0, maxNetEdgePercent: 1, maxNetProfitToman: gross - feeToman,
  maxRawSpreadPercent: 1, feeUnknown: false, observationCount: 1, isActive: true,
  buyAgeMs: 0, sellAgeMs: 0
};

const policies = buildPolicyState(Object.entries({
  max_order_size_usdt: 2_000,
  max_venue_exposure_percent: 65,
  min_risk_adjusted_edge_percent: 0,
  max_quote_age_ms: 60_000,
  max_slippage_bps: 10,
  max_inventory_deviation_percent: 100
}).map(([key, value]) => ({ key: key as never, value, provenance: "ADMIN_APPROVED" as const, setBy: "real-snapshot-replay", setAt: iso, validForDays: null, note: null })), now);

const result = evaluateCycle({
  opportunities: [opportunity], sources: [buy, sell], delayedSources: [delayedBuy, delayedSell],
  postFirstLegSources: [postBuy, postSell], arrivalTimestampMs: now + 300, postFirstLegTimestampMs: now + 600,
  decisionTimestampMs: now, decisionClock: () => now + 600,
  venueStates: [rawBuy.sourceId, rawSell.sourceId].map((sourceId) => ({ sourceId, executable: true, capitalClass: "EXECUTABLE", takerFeeBps: sourceId === "tetherland" ? 45 : 20, feeProvenance: "ADMIN_CONFIRMED", feeStale: false })) as never[],
  executedLifecycleIds: new Set(),
  balances: [
    { sourceId: rawBuy.sourceId as never, irtToman: 500_000_000, usdtMicros: 2_000_000_000 },
    { sourceId: rawSell.sourceId as never, irtToman: 500_000_000, usdtMicros: 2_000_000_000 }
  ],
  sizing: {
    policies, allocationTomanBySource: new Map([[rawBuy.sourceId, 500_000_000], [rawSell.sourceId, 500_000_000]]),
    portfolioValueToman: 1_000_000_000,
    exposureTomanBySource: new Map([[rawBuy.sourceId, 500_000_000], [rawSell.sourceId, 500_000_000]]),
    slippageBufferBps: 5,
    inventoryModel: { valuationPriceToman: Math.round((buyPx + sellPx) / 2), maxDeviationPoints: 100, targets: [
      { sourceId: rawBuy.sourceId, targetUsdtSharePercent: 50 }, { sourceId: rawSell.sourceId, targetUsdtSharePercent: 50 }
    ] }
  },
  portfolioLimits: { enabled: true, equityToman: 1_000_000_000, markPriceToman: Math.round((buyPx + sellPx) / 2), maxUtilizationPercent: 90, minReservePercent: 10, maxVenueExposurePercent: 65 },
  paperExecutionRealism: { latency: { baseArrivalDelayMs: 300, maxDelayMs: 5_000, fixedDelayMs: 300 }, allowPartialFill: true, simulateLegRisk: true, firstLeg: "buy", slippageBufferBps: 5, maxAgeMs: 60_000, requireArrivalObservation: true }
});
const filled = result.decisions.find((decision) => decision.kind === "EXECUTE" && decision.executionOutcome === "FILLED");
assert.ok(filled?.kind === "EXECUTE", JSON.stringify(result.decisions));
console.log(JSON.stringify({
  source: "PRESERVED_REAL_MARKET_BOOK", route: proof.routeKey,
  postFeePositiveAtProbe: opportunity.netProfitToman > 0,
  safeMaxUsdt: filled.sizing.maxFeasibleUsdtMicros! / 1_000_000,
  selectedSizeUsdt: filled.candidate.sizeUsdt,
  expectedPnlToman: filled.plan.economicNetPnlToman,
  bindingConstraint: filled.sizing.bindingConstraint,
  delayedRecheck: filled.delayedRecheck?.outcome,
  terminalOutcome: filled.executionOutcome
}, null, 2));
