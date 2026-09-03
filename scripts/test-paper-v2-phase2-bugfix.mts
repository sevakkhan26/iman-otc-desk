#!/usr/bin/env npx tsx
/**
 * PAPER-V2 Phase 2 — STRICT_DEFECT_FIX_AND_REPLAY regression coverage.
 * Local only: no push / no deploy / no Live.
 */
import assert from "node:assert/strict";
import { SHADOW_EVENT_COHERENCE_MAX_SKEW_MS, SHADOW_STALE_MS } from "../src/lib/shadowArbitrage/config.ts";
import { assessCrossVenueCoherence } from "../src/lib/shadowArbitrage/streaming/eventFabric.ts";
import type { NormalizedSourceSnapshot } from "../src/lib/shadowArbitrage/types.ts";
import {
  paperReasonFromSizing,
  fromBrokerCode
} from "../src/lib/shadowArbitrage/paper/engine.ts";
import {
  computeRouteSize,
  type SizingResult
} from "../src/lib/shadowArbitrage/paper/sizing.ts";
import {
  validateFeeHorizonForRun,
  feeExpiryWarnings,
  assessRuntimeFeeHorizon,
  toEconomicsValidityAudit
} from "../src/lib/shadowArbitrage/paper/feeHorizon.ts";
import {
  classifyMarketDataHealth,
  classifyExecutionReadiness,
  buildVenueHealthSplit
} from "../src/lib/shadowArbitrage/paper/dataHealth.ts";
import type { VenueEffectiveFee } from "../src/lib/shadowArbitrage/effectiveFees.ts";
import { buildPolicyState } from "../src/lib/shadowArbitrage/live/policy.ts";
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

function snap(over: {
  sourceId: string;
  receivedAt: string;
  sourceEventTimestamp?: string | null;
  receiveTimestamp?: string;
  stale?: boolean;
  sourceTimestamp?: string | null;
  asks?: Array<{ priceToman: number; amountUsdt: number }>;
  bids?: Array<{ priceToman: number; amountUsdt: number }>;
}): NormalizedSourceSnapshot {
  const receiveTimestamp = over.receiveTimestamp ?? over.receivedAt;
  const bids = over.bids ?? [{ priceToman: 203_800, amountUsdt: 500 }];
  const asks = over.asks ?? [{ priceToman: 203_900, amountUsdt: 500 }];
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
    maxExecutableUsdt: 500,
    marketFeeBps: 25,
    feeStatus: "confirmed",
    feeLabel: "test",
    feeReferenceUrl: null,
    feeVerifiedAt: null,
    sourceTimestamp: over.sourceTimestamp ?? over.sourceEventTimestamp ?? null,
    receivedAt: over.receivedAt,
    ageMs: 0,
    health: "healthy",
    errorReason: null,
    degradedReason: null,
    stale: over.stale ?? false,
    meta: {
      endpoint: "test",
      httpStatus: 200,
      latencyMs: 10,
      attempts: 1,
      rateLimited: false,
      timedOut: false,
      depthAvailable: true,
      directionVerified: true,
      priceUnit: "IRT",
      normalizationNote: "phase2-fixture"
    },
    sourceBlockedReasons: [],
    marketData: {
      transport: "WS",
      sequence: 1,
      sourceEventTimestamp: over.sourceEventTimestamp ?? null,
      receiveTimestamp,
      sourceEventAgeMs: 0,
      latencyEstimateMs: 10,
      jitterMs: 1,
      reconnectCount: 0,
      gapCount: 0,
      outOfOrderCount: 0,
      resyncCount: 0,
      resyncProvenance: null,
      snapshotResyncState: "SYNCHRONIZED"
    }
  };
}

console.log("\n== Phase 2B — comparable-clock coherence ==");

await test("KEEP 2500ms gate constant", () => {
  assert.equal(SHADOW_EVENT_COHERENCE_MAX_SKEW_MS, 2_500);
});

await test("FN fixture tabdeal→ramzinex: venue clocks offset >2500ms but receives coherent", () => {
  // Proven TASK-008 FN lifecycle 527f37cbfd9160d7d05fcdbb at 2026-08-29T12:00:00Z.
  // Old logic compared sourceEvent timestamps (3200ms skew) and rejected.
  // New logic compares receive timestamps (1000ms) and accepts.
  const buy = snap({
    sourceId: "tabdeal",
    receivedAt: "2026-08-29T12:00:00.000Z",
    receiveTimestamp: "2026-08-29T12:00:00.000Z",
    sourceEventTimestamp: "2026-08-29T11:59:57.000Z"
  });
  const sell = snap({
    sourceId: "ramzinex",
    receivedAt: "2026-08-29T12:00:01.000Z",
    receiveTimestamp: "2026-08-29T12:00:01.000Z",
    sourceEventTimestamp: "2026-08-29T11:59:53.800Z"
  });
  const r = assessCrossVenueCoherence({
    buy,
    sell,
    decisionTimestampMs: Date.parse("2026-08-29T12:00:01.500Z"),
    maxAgeMs: SHADOW_STALE_MS,
    maxSourceSkewMs: SHADOW_EVENT_COHERENCE_MAX_SKEW_MS
  });
  assert.equal(r.coherent, true);
  assert.equal(r.reason, "coherent");
  assert.equal(r.sourceSkewMs, 1_000); // receive skew
  assert.equal(r.venueClockSkewMs, 3_200); // still reported, not gated
});

await test("still rejects when local receive clocks diverge >2500ms", () => {
  const buy = snap({
    sourceId: "tabdeal",
    receivedAt: "2026-08-29T12:00:00.000Z",
    receiveTimestamp: "2026-08-29T12:00:00.000Z",
    sourceEventTimestamp: "2026-08-29T12:00:00.000Z"
  });
  const sell = snap({
    sourceId: "ramzinex",
    receivedAt: "2026-08-29T12:00:04.000Z",
    receiveTimestamp: "2026-08-29T12:00:04.000Z",
    sourceEventTimestamp: "2026-08-29T12:00:04.000Z"
  });
  const r = assessCrossVenueCoherence({
    buy,
    sell,
    decisionTimestampMs: Date.parse("2026-08-29T12:00:04.100Z"),
    maxAgeMs: SHADOW_STALE_MS,
    maxSourceSkewMs: SHADOW_EVENT_COHERENCE_MAX_SKEW_MS
  });
  assert.equal(r.coherent, false);
  assert.equal(r.reason, "cross_venue_time_skew");
  assert.equal(r.sourceSkewMs, 4_000);
});

await test("stale gate uses receive age, not venue-server age", () => {
  // Venue event looks 2 minutes old vs decision, but we received it 1s ago.
  const buy = snap({
    sourceId: "nobitex",
    receivedAt: "2026-08-29T12:00:00.000Z",
    receiveTimestamp: "2026-08-29T12:00:00.000Z",
    sourceEventTimestamp: "2026-08-29T11:58:00.000Z"
  });
  const sell = snap({
    sourceId: "wallex",
    receivedAt: "2026-08-29T12:00:00.200Z",
    receiveTimestamp: "2026-08-29T12:00:00.200Z",
    sourceEventTimestamp: "2026-08-29T12:00:00.200Z" // wallex uses receive as source
  });
  const r = assessCrossVenueCoherence({
    buy,
    sell,
    decisionTimestampMs: Date.parse("2026-08-29T12:00:01.000Z"),
    maxAgeMs: SHADOW_STALE_MS,
    maxSourceSkewMs: SHADOW_EVENT_COHERENCE_MAX_SKEW_MS
  });
  assert.equal(r.coherent, true);
  assert.ok((r.venueClockSkewMs ?? 0) > 100_000);
});

await test("truly stale receive still fail-closed", () => {
  const buy = snap({
    sourceId: "nobitex",
    receivedAt: "2026-08-29T11:50:00.000Z",
    receiveTimestamp: "2026-08-29T11:50:00.000Z",
    sourceEventTimestamp: "2026-08-29T11:50:00.000Z"
  });
  const sell = snap({
    sourceId: "wallex",
    receivedAt: "2026-08-29T12:00:00.000Z",
    receiveTimestamp: "2026-08-29T12:00:00.000Z",
    sourceEventTimestamp: "2026-08-29T12:00:00.000Z"
  });
  const r = assessCrossVenueCoherence({
    buy,
    sell,
    decisionTimestampMs: Date.parse("2026-08-29T12:00:01.000Z"),
    maxAgeMs: SHADOW_STALE_MS,
    maxSourceSkewMs: SHADOW_EVENT_COHERENCE_MAX_SKEW_MS
  });
  assert.equal(r.coherent, false);
  assert.equal(r.reason, "stale_snapshot");
});

console.log("\n== Phase 2A — sizing reason precision ==");

await test("not_net_positive maps to net_non_positive (not opaque sizing_blocked)", () => {
  const sizing = {
    status: "BLOCKED",
    blockers: [
      {
        code: "not_net_positive",
        subject: "bitpin→bit24",
        detailFa: "سود مثبت نیست"
      }
    ],
    candidates: [
      {
        sizeUsdtMicros: 5_000_000,
        rejectionCode: "not_net_positive",
        rejectionFa: "سود تعدیل‌شده در این حجم مثبت نیست",
        eligible: false
      }
    ]
  } as unknown as SizingResult;
  assert.equal(paperReasonFromSizing(sizing), "net_non_positive");
  assert.equal(fromBrokerCode("not_net_positive"), "net_non_positive");
});

await test("inventory_limit and depth map exactly", () => {
  assert.equal(
    paperReasonFromSizing({
      status: "BLOCKED",
      blockers: [{ code: "inventory_limit", subject: "x", detailFa: "y" }],
      candidates: []
    } as unknown as SizingResult),
    "inventory_limit"
  );
  assert.equal(
    paperReasonFromSizing({
      status: "BLOCKED",
      blockers: [{ code: "depth_exhausted", subject: "x", detailFa: "y" }],
      candidates: [
        {
          sizeUsdtMicros: 5_000_000,
          rejectionCode: "insufficient_depth",
          rejectionFa: "عمق",
          eligible: false
        }
      ]
    } as unknown as SizingResult),
    "insufficient_depth"
  );
});

function policies(over: Partial<Record<string, number>> = {}) {
  const base: Record<string, number> = {
    max_order_size_usdt: 1_000,
    max_venue_exposure_percent: 100,
    min_risk_adjusted_edge_percent: 0,
    max_quote_age_ms: 60_000,
    max_slippage_bps: 50,
    max_inventory_deviation_percent: 100
  };
  const merged = { ...base, ...over };
  return buildPolicyState(
    Object.entries(merged).map(([key, value]) => ({
      key: key as never,
      value,
      provenance: "ADMIN_APPROVED" as const,
      setBy: "test",
      setAt: "2026-08-01T00:00:00.000Z",
      validForDays: null,
      note: null
    })),
    Date.parse("2026-08-29T12:00:00.000Z")
  );
}

const IRT_FEE = { feeAsset: "IRT", debitMode: "ADD_TO_DEBIT", provenance: "ADMIN_CONFIRMED" } as const;
const USDT_FEE = { feeAsset: "USDT", debitMode: "ADD_TO_DEBIT", provenance: "ADMIN_CONFIRMED" } as const;

await test("economically legal wide spread sizes; fee-killed probe stays net_non_positive", () => {
  const buySnap = snap({
    sourceId: "tabdeal",
    receivedAt: "2026-08-29T12:00:00.000Z",
    asks: [
      { priceToman: 200_000, amountUsdt: 200 },
      { priceToman: 200_050, amountUsdt: 200 }
    ],
    bids: [{ priceToman: 199_900, amountUsdt: 200 }]
  });
  const sellSnap = snap({
    sourceId: "ramzinex",
    receivedAt: "2026-08-29T12:00:00.500Z",
    bids: [
      { priceToman: 201_000, amountUsdt: 200 },
      { priceToman: 200_950, amountUsdt: 200 }
    ],
    asks: [{ priceToman: 201_100, amountUsdt: 200 }]
  });
  const legal = computeRouteSize({
    buySourceId: "tabdeal",
    sellSourceId: "ramzinex",
    buySnapshot: buySnap,
    sellSnapshot: sellSnap,
    buyFeeBps: 0,
    sellFeeBps: 0,
    buySettlement: IRT_FEE,
    sellSettlement: USDT_FEE,
    balances: [
      { sourceId: "tabdeal", irtToman: 1_000_000_000, usdtMicros: 5_000_000_000 },
      { sourceId: "ramzinex", irtToman: 1_000_000_000, usdtMicros: 5_000_000_000 }
    ],
    buyVenueAllocationToman: 1_000_000_000,
    portfolioValueToman: 10_000_000_000,
    buyVenueExposureToman: 0,
    policies: policies(),
    slippageBufferBps: 5,
    inventoryModel: {
      valuationPriceToman: 200_500,
      targets: [
        { sourceId: "tabdeal", targetUsdtSharePercent: 50 },
        { sourceId: "ramzinex", targetUsdtSharePercent: 50 }
      ],
      maxDeviationPoints: 100
    }
  } as never);
  assert.equal(legal.status, "SIZED");
  assert.ok((legal.sizeUsdtMicros ?? 0) >= 5_000_000);

  // TASK-008 sample bitpin→bit24: probe gross ~760 << fees+slip ~6109.
  const killed = computeRouteSize({
    buySourceId: "bitpin",
    sellSourceId: "bit24",
    buySnapshot: snap({
      sourceId: "bitpin",
      receivedAt: "2026-08-29T12:00:00.000Z",
      asks: [{ priceToman: 203_638, amountUsdt: 50 }],
      bids: [{ priceToman: 203_600, amountUsdt: 50 }]
    }),
    sellSnapshot: snap({
      sourceId: "bit24",
      receivedAt: "2026-08-29T12:00:00.200Z",
      bids: [{ priceToman: 203_790, amountUsdt: 50 }],
      asks: [{ priceToman: 203_800, amountUsdt: 50 }]
    }),
    buyFeeBps: 35,
    sellFeeBps: 20,
    buySettlement: IRT_FEE,
    sellSettlement: USDT_FEE,
    balances: [
      { sourceId: "bitpin", irtToman: 1_000_000_000, usdtMicros: 5_000_000_000 },
      { sourceId: "bit24", irtToman: 1_000_000_000, usdtMicros: 5_000_000_000 }
    ],
    buyVenueAllocationToman: 1_000_000_000,
    portfolioValueToman: 10_000_000_000,
    buyVenueExposureToman: 0,
    policies: policies(),
    slippageBufferBps: 5,
    inventoryModel: {
      valuationPriceToman: 203_700,
      targets: [
        { sourceId: "bitpin", targetUsdtSharePercent: 50 },
        { sourceId: "bit24", targetUsdtSharePercent: 50 }
      ],
      maxDeviationPoints: 100
    }
  } as never);
  assert.equal(killed.status, "BLOCKED");
  assert.equal(paperReasonFromSizing(killed), "net_non_positive");
});

console.log("\n== Phase 2C — fee horizon regression ==");

function venue(over: Partial<VenueEffectiveFee> & { sourceId: string }): VenueEffectiveFee {
  return {
    sourceId: over.sourceId,
    nameFa: over.nameFa ?? over.sourceId,
    executionMode: over.executionMode ?? "ORDER_BOOK",
    executionModeFa: "دفتر سفارش",
    currentTierLabel: over.currentTierLabel ?? "Base",
    evidenceTierLabel: over.evidenceTierLabel ?? "Base",
    ok: over.ok ?? true,
    makerFeeBps: over.makerFeeBps ?? 25,
    takerFeeBps: over.takerFeeBps ?? 25,
    provenance: over.provenance ?? "ADMIN_CONFIRMED_SCREENSHOT",
    evidenceKey: over.evidenceKey ?? "k",
    confirmedBy: over.confirmedBy ?? "test",
    confirmedAt: over.confirmedAt ?? "2026-08-01T13:00:00.000Z",
    validForDays: over.validForDays ?? 30,
    expiresAt: over.expiresAt !== undefined ? over.expiresAt : "2026-08-31T13:00:00.000Z",
    sourceUrl: null,
    note: null,
    miss: over.miss ?? null,
    blockerFa: over.blockerFa ?? null,
    executable: over.executable ?? true,
    referenceModes: [],
    noticesFa: [],
    history: []
  };
}

const NOW = Date.parse("2026-08-25T12:00:00.000Z");
const PLANNED_END = Date.parse("2026-09-01T12:00:00.000Z");

await test("valid-through-end starts; expires-before-end blocked", () => {
  const ok = validateFeeHorizonForRun({
    venues: [venue({ sourceId: "nobitex", expiresAt: "2026-09-02T00:00:00.000Z" })],
    plannedEndMs: PLANNED_END,
    nowMs: NOW
  });
  assert.equal(ok.ok, true);
  const bad = validateFeeHorizonForRun({
    venues: [venue({ sourceId: "nobitex", expiresAt: "2026-08-31T13:00:00.000Z" })],
    plannedEndMs: PLANNED_END,
    nowMs: NOW
  });
  assert.equal(bad.ok, false);
});

await test("T-24h / T-6h warnings", () => {
  assert.equal(
    feeExpiryWarnings({
      venues: [venue({ sourceId: "a", expiresAt: new Date(NOW + 5 * 3600_000).toISOString() })],
      nowMs: NOW
    })[0]?.level,
    "T_6H"
  );
  assert.equal(
    feeExpiryWarnings({
      venues: [venue({ sourceId: "b", expiresAt: new Date(NOW + 20 * 3600_000).toISOString() })],
      nowMs: NOW
    })[0]?.level,
    "T_24H"
  );
});

await test("mid-run expiry marks ECONOMICS_INVALID; refresh recovers; data stays visible", () => {
  const expiresAt = "2026-08-31T13:00:00.000Z";
  const after = assessRuntimeFeeHorizon({
    venues: [
      venue({
        sourceId: "nobitex",
        expiresAt,
        ok: false,
        takerFeeBps: null,
        miss: "expired"
      })
    ],
    nowMs: Date.parse("2026-08-31T13:00:00.000Z")
  });
  assert.equal(after.economicsState, "ECONOMICS_INVALID");
  assert.equal(toEconomicsValidityAudit(after, Date.parse(expiresAt)).reportState, "DEGRADED_FROM_TIMESTAMP");

  const refreshed = validateFeeHorizonForRun({
    venues: [
      venue({
        sourceId: "nobitex",
        confirmedAt: "2026-09-01T00:00:00.000Z",
        expiresAt: "2026-10-01T00:00:00.000Z",
        ok: true
      })
    ],
    plannedEndMs: Date.parse("2026-09-08T00:00:00.000Z"),
    nowMs: Date.parse("2026-09-01T00:00:00.000Z")
  });
  assert.equal(refreshed.ok, true);

  assert.equal(classifyMarketDataHealth({ health: "healthy" }), "healthy");
  const split = buildVenueHealthSplit({
    sourceId: "nobitex",
    health: "healthy",
    feeOk: false,
    feeMiss: "expired",
    takerFeeBps: null,
    executionEligible: true,
    accountState: "VERIFIED"
  });
  assert.equal(split.marketDataVisible, true);
  assert.equal(split.executionAllowed, false);
  assert.equal(
    classifyExecutionReadiness({ feeOk: false, feeMiss: "expired", takerFeeBps: null }),
    "blocked_fee_stale"
  );
});

console.log(`\nPhase2 bugfix: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
