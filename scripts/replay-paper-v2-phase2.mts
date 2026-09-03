#!/usr/bin/env npx tsx
/**
 * Bounded deterministic replay of TASK-008 reject fixtures under Phase-2 fixes.
 * REPLAY ONLY — does not fabricate Live fills. Writes JSON under supervisor-tasks.
 */
import fs from "node:fs";
import path from "node:path";
import {
  SHADOW_EVENT_COHERENCE_MAX_SKEW_MS,
  SHADOW_STALE_MS
} from "../src/lib/shadowArbitrage/config.ts";
import { assessCrossVenueCoherence } from "../src/lib/shadowArbitrage/streaming/eventFabric.ts";
import type { NormalizedSourceSnapshot } from "../src/lib/shadowArbitrage/types.ts";
import { paperReasonFromSizing } from "../src/lib/shadowArbitrage/paper/engine.ts";
import { computeRouteSize } from "../src/lib/shadowArbitrage/paper/sizing.ts";
import { buildPolicyState } from "../src/lib/shadowArbitrage/live/policy.ts";
import { seedLocalPaperExecutionLimits } from "../src/lib/shadowArbitrage/paper/venueExecutionLimits.ts";

seedLocalPaperExecutionLimits({ minNotionalUsdt: 5, quantityStepUsdt: 0.01 });

const OUT_DIR =
  process.env.PHASE2_OUT_DIR ??
  "/workspace/supervisor-tasks/SHADOW-TASK-008/paper-v2-phase-2";
const REJECT_CASES =
  "/workspace/supervisor-tasks/SHADOW-TASK-008/postrun-forensic-2026-09-03/reject-cases.json";

function snap(over: {
  sourceId: string;
  receivedAt: string;
  sourceEventTimestamp?: string | null;
  receiveTimestamp?: string;
  ask: number;
  bid: number;
  depth?: number;
}): NormalizedSourceSnapshot {
  const depth = over.depth ?? 100;
  const receiveTimestamp = over.receiveTimestamp ?? over.receivedAt;
  const asks = [{ priceToman: over.ask, amountUsdt: depth }];
  const bids = [{ priceToman: over.bid, amountUsdt: depth }];
  return {
    sourceId: over.sourceId as never,
    sourceName: over.sourceId,
    marketModel: "ORDER_BOOK",
    accountStatus: "READY",
    eligibilityBase: "EXECUTABLE",
    bestBidToman: over.bid,
    bestAskToman: over.ask,
    userBuyPriceToman: over.ask,
    userSellPriceToman: over.bid,
    sizeExecutables: [],
    bookBids: bids,
    bookAsks: asks,
    depthUsdtBid: depth,
    depthUsdtAsk: depth,
    maxExecutableUsdt: depth,
    marketFeeBps: 25,
    feeStatus: "confirmed",
    feeLabel: "replay",
    feeReferenceUrl: null,
    feeVerifiedAt: null,
    sourceTimestamp: over.sourceEventTimestamp ?? null,
    receivedAt: over.receivedAt,
    ageMs: 0,
    health: "healthy",
    errorReason: null,
    degradedReason: null,
    stale: false,
    meta: {
      endpoint: "replay",
      httpStatus: 200,
      latencyMs: 10,
      attempts: 1,
      rateLimited: false,
      timedOut: false,
      depthAvailable: true,
      directionVerified: true,
      priceUnit: "IRT",
      normalizationNote: "phase2-replay"
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

/** Legacy gate: compare venue sourceEvent clocks (pre-fix defect). */
function legacyAssess(input: {
  buy: NormalizedSourceSnapshot;
  sell: NormalizedSourceSnapshot;
  decisionTimestampMs: number;
  maxAgeMs: number;
  maxSourceSkewMs: number;
}) {
  const buyEventMs = Date.parse(
    input.buy.marketData?.sourceEventTimestamp ??
      input.buy.sourceTimestamp ??
      input.buy.receivedAt
  );
  const sellEventMs = Date.parse(
    input.sell.marketData?.sourceEventTimestamp ??
      input.sell.sourceTimestamp ??
      input.sell.receivedAt
  );
  const skew = Math.abs(buyEventMs - sellEventMs);
  const stale =
    input.buy.stale ||
    input.sell.stale ||
    input.decisionTimestampMs - buyEventMs > input.maxAgeMs ||
    input.decisionTimestampMs - sellEventMs > input.maxAgeMs;
  if (stale) return { coherent: false, reason: "stale_snapshot", sourceSkewMs: skew };
  if (skew > input.maxSourceSkewMs)
    return { coherent: false, reason: "cross_venue_time_skew", sourceSkewMs: skew };
  return { coherent: true, reason: "coherent", sourceSkewMs: skew };
}

function policies() {
  return buildPolicyState(
    [
      "max_order_size_usdt",
      "max_venue_exposure_percent",
      "min_risk_adjusted_edge_percent",
      "max_quote_age_ms",
      "max_slippage_bps",
      "max_inventory_deviation_percent"
    ].map((key) => ({
      key: key as never,
      value:
        key === "max_order_size_usdt"
          ? 1000
          : key === "max_venue_exposure_percent"
            ? 100
            : key === "min_risk_adjusted_edge_percent"
              ? 0
              : key === "max_quote_age_ms"
                ? 60_000
                : key === "max_slippage_bps"
                  ? 50
                  : 100,
      provenance: "ADMIN_APPROVED" as const,
      setBy: "replay",
      setAt: "2026-08-01T00:00:00.000Z",
      validForDays: null,
      note: null
    })),
    Date.parse("2026-08-29T12:00:00.000Z")
  );
}

const IRT_FEE = { feeAsset: "IRT", debitMode: "ADD_TO_DEBIT", provenance: "ADMIN_CONFIRMED" } as const;
const USDT_FEE = { feeAsset: "USDT", debitMode: "ADD_TO_DEBIT", provenance: "ADMIN_CONFIRMED" } as const;

type RejectCases = {
  classes: {
    sizing_blocked: { samples: Array<Record<string, unknown>> };
    market_data_time_incoherent: { samples: Array<Record<string, unknown>> };
  };
};

const reject = JSON.parse(fs.readFileSync(REJECT_CASES, "utf8")) as RejectCases;

// --- Coherence replay ---
const coherenceFixtures = [
  {
    id: "527f37cbfd9160d7d05fcdbb",
    route: "tabdeal->ramzinex",
    classification_before: "FALSE_NEGATIVE",
    // Phase-1 diagnostic mirror: venue clocks 3200ms apart, receives 1000ms apart
    buy: {
      sourceId: "tabdeal",
      receivedAt: "2026-08-29T12:00:00.000Z",
      sourceEventTimestamp: "2026-08-29T11:59:57.000Z",
      ask: 203_620,
      bid: 203_600
    },
    sell: {
      sourceId: "ramzinex",
      receivedAt: "2026-08-29T12:00:01.000Z",
      sourceEventTimestamp: "2026-08-29T11:59:53.800Z",
      ask: 203_900,
      bid: 203_860
    },
    decisionAt: "2026-08-29T12:00:01.500Z",
    gross_px: 240
  },
  {
    id: "synthetic-receive-divergent",
    route: "tabdeal->ramzinex",
    classification_before: "CORRECT_STALE_PAIR",
    buy: {
      sourceId: "tabdeal",
      receivedAt: "2026-08-29T12:00:00.000Z",
      sourceEventTimestamp: "2026-08-29T12:00:00.000Z",
      ask: 203_620,
      bid: 203_600
    },
    sell: {
      sourceId: "ramzinex",
      receivedAt: "2026-08-29T12:00:05.000Z",
      sourceEventTimestamp: "2026-08-29T12:00:05.000Z",
      ask: 203_900,
      bid: 203_860
    },
    decisionAt: "2026-08-29T12:00:05.100Z",
    gross_px: 240
  }
];

const coherenceReplay = coherenceFixtures.map((fx) => {
  const buy = snap(fx.buy);
  const sell = snap(fx.sell);
  const decisionTimestampMs = Date.parse(fx.decisionAt);
  const args = {
    buy,
    sell,
    decisionTimestampMs,
    maxAgeMs: SHADOW_STALE_MS,
    maxSourceSkewMs: SHADOW_EVENT_COHERENCE_MAX_SKEW_MS
  };
  const before = legacyAssess(args);
  const after = assessCrossVenueCoherence(args);
  return {
    lifecycle_id: fx.id,
    route: fx.route,
    classification_before: fx.classification_before,
    gross_px: fx.gross_px,
    before,
    after: {
      coherent: after.coherent,
      reason: after.reason,
      sourceSkewMs: after.sourceSkewMs,
      venueClockSkewMs: after.venueClockSkewMs
    },
    reclassification:
      before.coherent === false && after.coherent === true
        ? "FN_FIXED_COMPARABLE_CLOCK"
        : before.coherent === false && after.coherent === false
          ? "LEGITIMATE_REJECT_PRESERVED"
          : before.coherent === true && after.coherent === true
            ? "STILL_COHERENT"
            : "UNEXPECTED"
  };
});

// --- Sizing replay from decision_trace samples ---
const sizingSamples = reject.classes.sizing_blocked.samples.filter(
  (s) => s.source === "decision_trace"
);

const sizingReplay = sizingSamples.map((s) => {
  const buyId = String(s.buy_source_id);
  const sellId = String(s.sell_source_id);
  const buyVwap = Number(s.buy_vwap_toman);
  const sellVwap = Number(s.sell_vwap_toman);
  const buyFee = Number(s.buy_fee_bps);
  const sellFee = Number(s.sell_fee_bps);
  const result = computeRouteSize({
    buySourceId: buyId,
    sellSourceId: sellId,
    buySnapshot: snap({
      sourceId: buyId,
      receivedAt: String(s.occurred_at),
      ask: buyVwap,
      bid: buyVwap - 50,
      depth: 50
    }),
    sellSnapshot: snap({
      sourceId: sellId,
      receivedAt: String(s.occurred_at),
      ask: sellVwap + 50,
      bid: sellVwap,
      depth: 50
    }),
    buyFeeBps: buyFee,
    sellFeeBps: sellFee,
    buySettlement: IRT_FEE,
    sellSettlement: USDT_FEE,
    balances: [
      { sourceId: buyId, irtToman: 1_000_000_000, usdtMicros: 5_000_000_000 },
      { sourceId: sellId, irtToman: 1_000_000_000, usdtMicros: 5_000_000_000 }
    ],
    buyVenueAllocationToman: 1_000_000_000,
    portfolioValueToman: 10_000_000_000,
    buyVenueExposureToman: 0,
    policies: policies(),
    slippageBufferBps: 5,
    inventoryModel: {
      valuationPriceToman: Math.round((buyVwap + sellVwap) / 2),
      targets: [
        { sourceId: buyId, targetUsdtSharePercent: 50 },
        { sourceId: sellId, targetUsdtSharePercent: 50 }
      ],
      maxDeviationPoints: 100
    }
  } as never);
  const newCode = result.status === "SIZED" ? "SIZED" : paperReasonFromSizing(result);
  const oldCode = "sizing_blocked";
  const forensicClass = String(s.classification ?? "INDETERMINATE");
  return {
    lifecycle_id: s.lifecycle_id,
    route_key: s.route_key,
    forensic_classification: forensicClass,
    old_reason: oldCode,
    new_reason: newCode,
    status: result.status,
    sizeUsdt: result.sizeUsdt,
    blockerCodes: (result.blockers ?? []).map((b) => b.code),
    reclassification:
      result.status === "SIZED"
        ? "NOW_SIZED"
        : newCode === "net_non_positive"
          ? "RELABEL_LEGITIMATE_NET_NON_POSITIVE"
          : newCode === oldCode
            ? "STILL_SIZING_BLOCKED"
            : `RELABEL_${newCode}`
  };
});

const fnFixed = coherenceReplay.filter((r) => r.reclassification === "FN_FIXED_COMPARABLE_CLOCK");
const legitimateCoherence = coherenceReplay.filter(
  (r) => r.reclassification === "LEGITIMATE_REJECT_PRESERVED"
);
const sizingRelabelNet = sizingReplay.filter(
  (r) => r.reclassification === "RELABEL_LEGITIMATE_NET_NON_POSITIVE"
);
const sizingNowSized = sizingReplay.filter((r) => r.reclassification === "NOW_SIZED");

const summary = {
  generatedAt: new Date().toISOString(),
  gate_ms_unchanged: SHADOW_EVENT_COHERENCE_MAX_SKEW_MS,
  coherence: {
    fixtures: coherenceReplay.length,
    proven_FN_fixed: fnFixed.length,
    legitimate_rejects_preserved: legitimateCoherence.length,
    samples_fn_fixed: fnFixed.map((r) => r.lifecycle_id),
    samples_legitimate: legitimateCoherence.map((r) => r.lifecycle_id)
  },
  sizing: {
    decision_trace_samples: sizingReplay.length,
    now_sized: sizingNowSized.length,
    relabeled_net_non_positive: sizingRelabelNet.length,
    still_sizing_blocked: sizingReplay.filter((r) => r.reclassification === "STILL_SIZING_BLOCKED")
      .length,
    note:
      "Replay uses TOB at recorded VWAP± as single-level books; NOW_SIZED would indicate a sizing logic FN. Expected for TASK-008 CORRECT samples: RELABEL_LEGITIMATE_NET_NON_POSITIVE."
  },
  fill_eligible_before_after: {
    scope: "REPLAY_ONLY",
    coherence_fill_eligible_before: coherenceReplay.filter((r) => r.before.coherent).length,
    coherence_fill_eligible_after: coherenceReplay.filter((r) => r.after.coherent).length,
    sizing_sized_before: 0, // all samples were sizing_blocked
    sizing_sized_after: sizingNowSized.length,
    do_not_fabricate_live_fills: true
  },
  remaining_indeterminate: {
    ledger_sizing_blocked_without_audit: "telemetry gap closed in Phase-1 for future runs; historical ledger rows still lack VWAP",
    incoherent_without_skewMs: "Phase-1+2 persist receive skew + venueClockSkewMs going forward"
  },
  production_incident:
    "Collector-lease / missing prod prices remain SEPARATE. These fixes do not restore production prices."
};

fs.mkdirSync(path.join(OUT_DIR, "raw"), { recursive: true });
fs.writeFileSync(
  path.join(OUT_DIR, "raw", "replay-result.json"),
  JSON.stringify({ summary, coherenceReplay, sizingReplay }, null, 2)
);
fs.writeFileSync(path.join(OUT_DIR, "raw", "replay-summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
