/**
 * PAPER-V2 REALISM-1 / FULL-NO-TRADE section E —
 * Delayed executable-book recheck before Paper fill acceptance.
 *
 * Pure module: no DB, no network, no real orders. Never records a fill unless
 * the rechecked quantity + economics pass. Detection-time books remain the
 * selection input; fill acceptance requires a delayed comparable-book recheck
 * at simulated order-arrival time.
 *
 * Outcomes:
 *  - FILL_FULL / FILL_PARTIAL when delayed books still support a profitable size
 *  - REJECT with an exact delayed_* / book / coherence reason
 *  - LEG_RISK_* when sequential legs would leave one side unfilled (no atomic
 *    fantasy fill; round-trip is rejected with leg-risk evidence)
 */
import {
  SHADOW_EVENT_COHERENCE_MAX_SKEW_MS,
  SHADOW_STALE_MS
} from "@/lib/shadowArbitrage/config";
import type { BookLevel, NormalizedSourceSnapshot, ShadowSourceId } from "@/lib/shadowArbitrage/types";
import {
  assessCrossVenueCoherence,
  type CoherenceResult
} from "@/lib/shadowArbitrage/streaming/eventFabric";
import {
  planFill,
  settlementFor,
  type FillPlan,
  type SideSettlement
} from "@/lib/shadowArbitrage/paper/broker";
import {
  microsToUsdt,
  usdtToMicros,
  validateBook,
  walkBook,
  type BookSide
} from "@/lib/shadowArbitrage/paper/liquidity";
import { feeFromBps } from "@/lib/shadowArbitrage/money";
import { PAPER_POLICY_MIN_USDT } from "@/lib/shadowArbitrage/paper/venueExecutionLimits";
import type { PaperReasonCode } from "@/lib/shadowArbitrage/paper/reasons";

/** Deterministic Paper latency model (ms). */
export type PaperLatencyModel = {
  /** Base order-arrival delay applied after venue estimates. */
  baseArrivalDelayMs: number;
  /** Hard cap on total simulated delay. */
  maxDelayMs: number;
  /** Optional fixed override (tests / replay). When set, ignores venue estimates. */
  fixedDelayMs?: number | null;
};

export const DEFAULT_PAPER_LATENCY_MODEL: PaperLatencyModel = {
  baseArrivalDelayMs: 250,
  maxDelayMs: 5_000,
  fixedDelayMs: null
};

export type PaperExecutionRealismConfig = {
  latency: PaperLatencyModel;
  /** When delayed depth cannot cover planned size, try a smaller profitable size. */
  allowPartialFill: boolean;
  /** Simulate buy→sell (or sell→buy) sequentially instead of atomic fantasy. */
  simulateLegRisk: boolean;
  firstLeg: "buy" | "sell";
  maxCrossVenueSkewMs?: number;
  maxAgeMs?: number;
  /** Policy risk-buffer bps applied to delayed buy notional (not a second static pad). */
  slippageBufferBps: number;
  minSizeUsdt?: number;
};

export const DEFAULT_PAPER_EXECUTION_REALISM: PaperExecutionRealismConfig = {
  latency: DEFAULT_PAPER_LATENCY_MODEL,
  allowPartialFill: true,
  simulateLegRisk: true,
  firstLeg: "buy",
  maxCrossVenueSkewMs: SHADOW_EVENT_COHERENCE_MAX_SKEW_MS,
  maxAgeMs: SHADOW_STALE_MS,
  slippageBufferBps: 5,
  minSizeUsdt: PAPER_POLICY_MIN_USDT
};

export type BookSideSnapshot = {
  sourceId: string;
  bids: BookLevel[] | null;
  asks: BookLevel[] | null;
  receivedAt: string | null;
  receiveTimestamp: string | null;
  sourceEventTimestamp: string | null;
  ageMs: number | null;
  stale: boolean;
  marketModel?: string | null;
};

export type DelayedRecheckOutcomeKind =
  | "FILL_FULL"
  | "FILL_PARTIAL"
  | "REJECT"
  | "LEG_RISK_SECOND_LEG_FAILED";

export type DelayedBookEvidence = {
  version: "paper_v2_delayed_recheck_v1";
  appliedDelayMs: number;
  decisionTimestampMs: number;
  arrivalTimestampMs: number;
  latencyModel: PaperLatencyModel;
  detection: {
    sizeUsdt: number;
    buyVwapToman: number;
    sellVwapToman: number;
    economicNetPnlToman: number | null;
    riskAdjustedPnlToman: number | null;
    buy: BookSideSnapshot;
    sell: BookSideSnapshot;
  };
  delayed: {
    sizeUsdt: number | null;
    buyVwapToman: number | null;
    sellVwapToman: number | null;
    economicNetPnlToman: number | null;
    riskAdjustedPnlToman: number | null;
    buyDepthUsdt: number | null;
    sellDepthUsdt: number | null;
    buy: BookSideSnapshot;
    sell: BookSideSnapshot;
    coherence: CoherenceResult | null;
  };
  outcome: DelayedRecheckOutcomeKind;
  rejectCode: PaperReasonCode | null;
  fillSizeUsdt: number | null;
  partial: boolean;
  legRisk: {
    simulated: boolean;
    firstLeg: "buy" | "sell";
    firstLegFilledUsdt: number | null;
    secondLegFilledUsdt: number | null;
    secondLegCode: PaperReasonCode | null;
  } | null;
};

export type DelayedRecheckPass = {
  ok: true;
  outcome: "FILL_FULL" | "FILL_PARTIAL";
  plan: FillPlan;
  fillSizeUsdt: number;
  partial: boolean;
  evidence: DelayedBookEvidence;
};

export type DelayedRecheckFail = {
  ok: false;
  outcome: "REJECT" | "LEG_RISK_SECOND_LEG_FAILED";
  code: PaperReasonCode;
  evidence: DelayedBookEvidence;
};

export type DelayedRecheckResult = DelayedRecheckPass | DelayedRecheckFail;

function clampNonNegInt(n: number, fallback = 0): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.round(n));
}

function venueLatencyMs(snap: NormalizedSourceSnapshot | undefined): number {
  const md = snap?.marketData;
  const candidates = [
    md?.latencyEstimateMs,
    md?.sourceEventLatencyMs,
    md?.sourceEventAgeMs,
    snap?.ageMs
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c >= 0) return Math.round(c);
  }
  return 0;
}

/**
 * Deterministic simulated order-arrival delay for a route.
 * Uses max(buy,sell) venue latency + base, capped. Fixed override for tests.
 */
export function resolveExecutionDelayMs(input: {
  buy: NormalizedSourceSnapshot | undefined;
  sell: NormalizedSourceSnapshot | undefined;
  model: PaperLatencyModel;
}): number {
  if (
    input.model.fixedDelayMs !== null &&
    input.model.fixedDelayMs !== undefined &&
    Number.isFinite(input.model.fixedDelayMs)
  ) {
    return Math.min(
      input.model.maxDelayMs,
      clampNonNegInt(input.model.fixedDelayMs as number)
    );
  }
  const venue = Math.max(venueLatencyMs(input.buy), venueLatencyMs(input.sell));
  const total = venue + clampNonNegInt(input.model.baseArrivalDelayMs);
  return Math.min(input.model.maxDelayMs, total);
}

function sideSnap(s: NormalizedSourceSnapshot | undefined, sourceId: string): BookSideSnapshot {
  return {
    sourceId,
    bids: s?.bookBids ?? null,
    asks: s?.bookAsks ?? null,
    receivedAt: s?.receivedAt ?? null,
    receiveTimestamp: s?.marketData?.receiveTimestamp ?? s?.receivedAt ?? null,
    sourceEventTimestamp:
      s?.marketData?.sourceEventTimestamp ?? s?.sourceTimestamp ?? null,
    ageMs: s?.ageMs ?? null,
    stale: Boolean(s?.stale),
    marketModel: s?.marketModel ?? null
  };
}

function depthUsdt(levels: BookLevel[] | null | undefined): number {
  if (!levels?.length) return 0;
  return levels.reduce((s, l) => s + (Number.isFinite(l.amountUsdt) ? l.amountUsdt : 0), 0);
}

function ageAtArrivalMs(
  snap: NormalizedSourceSnapshot | undefined,
  arrivalTimestampMs: number
): number | null {
  const receiveMs = Date.parse(
    snap?.marketData?.receiveTimestamp ?? snap?.receivedAt ?? ""
  );
  if (!Number.isFinite(receiveMs)) return snap?.ageMs ?? null;
  return Math.max(0, arrivalTimestampMs - receiveMs);
}

/**
 * Build a snapshot view as-of arrival: bump age / stale flags without inventing
 * prices. Used when no separate delayed book feed is supplied.
 */
export function snapshotAtArrival(
  snap: NormalizedSourceSnapshot,
  arrivalTimestampMs: number,
  maxAgeMs: number
): NormalizedSourceSnapshot {
  const ageMs = ageAtArrivalMs(snap, arrivalTimestampMs) ?? snap.ageMs;
  const stale = snap.stale || ageMs > maxAgeMs;
  return {
    ...snap,
    ageMs,
    stale,
    marketData: snap.marketData
      ? {
          ...snap.marketData,
          sourceEventAgeMs:
            snap.marketData.sourceEventAgeMs === null ||
            snap.marketData.sourceEventAgeMs === undefined
              ? snap.marketData.sourceEventAgeMs
              : ageMs
        }
      : snap.marketData
  };
}

function walkSide(
  snap: NormalizedSourceSnapshot | undefined,
  side: BookSide,
  sizeUsdt: number
): { ok: true; vwap: number; filledUsdt: number; complete: boolean } | { ok: false; code: PaperReasonCode } {
  if (!snap) return { ok: false, code: "delayed_liquidity_disappeared" };
  const bids = snap.bookBids;
  const asks = snap.bookAsks;
  const validation = validateBook(bids, asks, snap.marketModel);
  if (!validation.ok) {
    if (validation.problem === "book_crossed" || validation.problem === "book_unusable_level") {
      return { ok: false, code: "delayed_book_invalid" };
    }
    return { ok: false, code: "delayed_liquidity_disappeared" };
  }
  const levels = side === "buy" ? asks : bids;
  if (!levels?.length) return { ok: false, code: "delayed_liquidity_disappeared" };
  // Reject NaN / non-finite levels explicitly.
  for (const l of levels) {
    if (
      !Number.isFinite(l.priceToman) ||
      !Number.isFinite(l.amountUsdt) ||
      l.priceToman <= 0 ||
      l.amountUsdt < 0
    ) {
      return { ok: false, code: "delayed_book_invalid" };
    }
  }
  const walk = walkBook(levels, usdtToMicros(sizeUsdt), side);
  if (walk.filledMicros <= 0 || walk.vwapToman === null || !(walk.vwapToman > 0)) {
    return { ok: false, code: "delayed_liquidity_disappeared" };
  }
  return {
    ok: true,
    vwap: walk.vwapToman,
    filledUsdt: microsToUsdt(walk.filledMicros),
    complete: walk.complete
  };
}

function maxFillableBoth(
  buy: NormalizedSourceSnapshot | undefined,
  sell: NormalizedSourceSnapshot | undefined,
  requestedUsdt: number
): number {
  const buyWalk = walkSide(buy, "buy", requestedUsdt);
  const sellWalk = walkSide(sell, "sell", requestedUsdt);
  if (!buyWalk.ok || !sellWalk.ok) {
    // Try full depth on each side independently.
    const buyDepth = depthUsdt(buy?.bookAsks);
    const sellDepth = depthUsdt(sell?.bookBids);
    return Math.max(0, Math.min(buyDepth, sellDepth, requestedUsdt));
  }
  return Math.max(0, Math.min(buyWalk.filledUsdt, sellWalk.filledUsdt, requestedUsdt));
}

function riskBufferToman(buyVwap: number, sizeUsdt: number, bps: number): number {
  const notional = Math.round(buyVwap * sizeUsdt);
  return Math.max(0, feeFromBps(notional, Math.max(0, bps)));
}

export type DelayedRecheckInput = {
  buySourceId: ShadowSourceId;
  sellSourceId: ShadowSourceId;
  plannedSizeUsdt: number;
  detectionBuy: NormalizedSourceSnapshot | undefined;
  detectionSell: NormalizedSourceSnapshot | undefined;
  /** Books at simulated arrival. Defaults to detection books aged to arrival. */
  delayedBuy?: NormalizedSourceSnapshot | undefined;
  delayedSell?: NormalizedSourceSnapshot | undefined;
  decisionTimestampMs: number;
  buyFeeBps: number;
  sellFeeBps: number;
  buySettlement?: SideSettlement;
  sellSettlement?: SideSettlement;
  markPriceToman: number;
  detectionBuyVwapToman: number;
  detectionSellVwapToman: number;
  detectionEconomicNetPnlToman?: number | null;
  detectionRiskAdjustedPnlToman?: number | null;
  /**
   * Optional books observed after the first leg would have filled.
   * When simulateLegRisk is on and these are supplied, the second leg is
   * evaluated against them (disappearing liquidity / adverse move between legs).
   * When omitted, both legs use the same delayed books (no synthetic leg fail).
   */
  postFirstLegBuy?: NormalizedSourceSnapshot | undefined;
  postFirstLegSell?: NormalizedSourceSnapshot | undefined;
  config?: Partial<PaperExecutionRealismConfig>;
};

function fail(
  code: PaperReasonCode,
  outcome: "REJECT" | "LEG_RISK_SECOND_LEG_FAILED",
  evidence: DelayedBookEvidence
): DelayedRecheckFail {
  return {
    ok: false,
    outcome,
    code,
    evidence: { ...evidence, outcome, rejectCode: code }
  };
}

/**
 * Re-evaluate executable quantity + economics on the delayed comparable book.
 * Never returns ok=true unless planFill on the delayed book is net-positive.
 */
export function recheckDelayedExecutableBook(
  input: DelayedRecheckInput
): DelayedRecheckResult {
  const cfg: PaperExecutionRealismConfig = {
    ...DEFAULT_PAPER_EXECUTION_REALISM,
    ...input.config,
    latency: {
      ...DEFAULT_PAPER_LATENCY_MODEL,
      ...(input.config?.latency ?? {})
    }
  };
  const minSize = cfg.minSizeUsdt ?? PAPER_POLICY_MIN_USDT;
  const delayMs = resolveExecutionDelayMs({
    buy: input.detectionBuy,
    sell: input.detectionSell,
    model: cfg.latency
  });
  const arrivalTimestampMs = input.decisionTimestampMs + delayMs;
  const maxAgeMs = cfg.maxAgeMs ?? SHADOW_STALE_MS;

  const delayedBuyRaw =
    input.delayedBuy ??
    (input.detectionBuy
      ? snapshotAtArrival(input.detectionBuy, arrivalTimestampMs, maxAgeMs)
      : undefined);
  const delayedSellRaw =
    input.delayedSell ??
    (input.detectionSell
      ? snapshotAtArrival(input.detectionSell, arrivalTimestampMs, maxAgeMs)
      : undefined);

  const evidenceBase = (): DelayedBookEvidence => ({
    version: "paper_v2_delayed_recheck_v1",
    appliedDelayMs: delayMs,
    decisionTimestampMs: input.decisionTimestampMs,
    arrivalTimestampMs,
    latencyModel: cfg.latency,
    detection: {
      sizeUsdt: input.plannedSizeUsdt,
      buyVwapToman: input.detectionBuyVwapToman,
      sellVwapToman: input.detectionSellVwapToman,
      economicNetPnlToman: input.detectionEconomicNetPnlToman ?? null,
      riskAdjustedPnlToman: input.detectionRiskAdjustedPnlToman ?? null,
      buy: sideSnap(input.detectionBuy, input.buySourceId),
      sell: sideSnap(input.detectionSell, input.sellSourceId)
    },
    delayed: {
      sizeUsdt: null,
      buyVwapToman: null,
      sellVwapToman: null,
      economicNetPnlToman: null,
      riskAdjustedPnlToman: null,
      buyDepthUsdt: depthUsdt(delayedBuyRaw?.bookAsks),
      sellDepthUsdt: depthUsdt(delayedSellRaw?.bookBids),
      buy: sideSnap(delayedBuyRaw, input.buySourceId),
      sell: sideSnap(delayedSellRaw, input.sellSourceId),
      coherence: null
    },
    outcome: "REJECT",
    rejectCode: null,
    fillSizeUsdt: null,
    partial: false,
    legRisk: null
  });

  if (!delayedBuyRaw || !delayedSellRaw) {
    return fail("delayed_liquidity_disappeared", "REJECT", evidenceBase());
  }

  const coherence = assessCrossVenueCoherence({
    buy: delayedBuyRaw,
    sell: delayedSellRaw,
    decisionTimestampMs: arrivalTimestampMs,
    maxAgeMs,
    maxSourceSkewMs: cfg.maxCrossVenueSkewMs ?? SHADOW_EVENT_COHERENCE_MAX_SKEW_MS
  });
  const ev0 = evidenceBase();
  ev0.delayed.coherence = coherence;

  if (!coherence.coherent) {
    if (coherence.reason === "cross_venue_time_skew") {
      return fail("delayed_book_incoherent", "REJECT", ev0);
    }
    if (coherence.reason === "awaiting_resync") {
      return fail("market_data_resync", "REJECT", ev0);
    }
    return fail("delayed_book_stale", "REJECT", ev0);
  }

  const planned = input.plannedSizeUsdt;
  if (!(planned > 0) || !Number.isFinite(planned)) {
    return fail("delayed_book_invalid", "REJECT", ev0);
  }

  let targetSize = planned;
  const buyAtPlan = walkSide(delayedBuyRaw, "buy", planned);
  const sellAtPlan = walkSide(delayedSellRaw, "sell", planned);

  if (!buyAtPlan.ok) return fail(buyAtPlan.code, "REJECT", ev0);
  if (!sellAtPlan.ok) return fail(sellAtPlan.code, "REJECT", ev0);

  const fullOk = buyAtPlan.complete && sellAtPlan.complete;
  if (!fullOk) {
    if (!cfg.allowPartialFill) {
      return fail("delayed_depth_insufficient", "REJECT", ev0);
    }
    const fillable = maxFillableBoth(delayedBuyRaw, delayedSellRaw, planned);
    if (fillable + 1e-12 < minSize) {
      return fail("partial_below_minimum", "REJECT", ev0);
    }
    // Quantize down to 0.01 USDT step.
    targetSize = Math.floor(fillable * 100) / 100;
    if (targetSize < minSize) {
      return fail("partial_below_minimum", "REJECT", ev0);
    }
  }

  const buyWalk = walkSide(delayedBuyRaw, "buy", targetSize);
  const sellWalk = walkSide(delayedSellRaw, "sell", targetSize);
  if (!buyWalk.ok) return fail(buyWalk.code, "REJECT", ev0);
  if (!sellWalk.ok) return fail(sellWalk.code, "REJECT", ev0);
  if (!buyWalk.complete || !sellWalk.complete) {
    // Even after shrinking, a side could not fill — treat as depth insufficient.
    return fail("delayed_depth_insufficient", "REJECT", ev0);
  }

  // Leg-risk: when a post-first-leg book is supplied, evaluate the second leg
  // against it. Independent same-cycle books do not invent a leg failure.
  if (cfg.simulateLegRisk && (input.postFirstLegBuy || input.postFirstLegSell)) {
    const first = cfg.firstLeg;
    const firstWalk = first === "buy" ? buyWalk : sellWalk;
    const secondSnap =
      first === "buy"
        ? (input.postFirstLegSell ?? delayedSellRaw)
        : (input.postFirstLegBuy ?? delayedBuyRaw);
    const secondSide: BookSide = first === "buy" ? "sell" : "buy";
    const secondWalk = walkSide(secondSnap, secondSide, targetSize);
    const legEv = {
      ...ev0,
      delayed: {
        ...ev0.delayed,
        sizeUsdt: targetSize,
        buyVwapToman: buyWalk.vwap,
        sellVwapToman: sellWalk.vwap
      },
      legRisk: {
        simulated: true,
        firstLeg: first,
        firstLegFilledUsdt: firstWalk.ok ? firstWalk.filledUsdt : null,
        secondLegFilledUsdt: secondWalk.ok ? secondWalk.filledUsdt : 0,
        secondLegCode: null as PaperReasonCode | null
      }
    };
    if (!secondWalk.ok || !secondWalk.complete) {
      legEv.legRisk!.secondLegCode = secondWalk.ok
        ? "delayed_depth_insufficient"
        : secondWalk.code;
      return fail("leg_risk_second_leg_failed", "LEG_RISK_SECOND_LEG_FAILED", legEv);
    }
  }

  const slip = riskBufferToman(buyWalk.vwap, targetSize, cfg.slippageBufferBps);
  const plan = planFill({
    buySourceId: input.buySourceId,
    sellSourceId: input.sellSourceId,
    sizeUsdt: targetSize,
    buyVwapToman: buyWalk.vwap,
    sellVwapToman: sellWalk.vwap,
    buyFeeBps: input.buyFeeBps,
    sellFeeBps: input.sellFeeBps,
    buySettlement: input.buySettlement ?? settlementFor(input.buySourceId, "buy"),
    sellSettlement: input.sellSettlement ?? settlementFor(input.sellSourceId, "sell"),
    markPriceToman: input.markPriceToman,
    slippageBufferToman: slip
  });

  const partial = targetSize + 1e-12 < planned;
  const ev: DelayedBookEvidence = {
    ...ev0,
    delayed: {
      ...ev0.delayed,
      sizeUsdt: targetSize,
      buyVwapToman: buyWalk.vwap,
      sellVwapToman: sellWalk.vwap,
      economicNetPnlToman: plan.ok ? plan.economicNetPnlToman : null,
      riskAdjustedPnlToman: plan.ok ? plan.riskAdjustedPnlToman : null,
      buyDepthUsdt: depthUsdt(delayedBuyRaw.bookAsks),
      sellDepthUsdt: depthUsdt(delayedSellRaw.bookBids),
      buy: sideSnap(delayedBuyRaw, input.buySourceId),
      sell: sideSnap(delayedSellRaw, input.sellSourceId),
      coherence
    },
    fillSizeUsdt: plan.ok ? targetSize : null,
    partial,
    outcome: plan.ok ? (partial ? "FILL_PARTIAL" : "FILL_FULL") : "REJECT",
    rejectCode: plan.ok ? null : "delayed_net_non_positive",
    legRisk: cfg.simulateLegRisk
      ? {
          simulated: true,
          firstLeg: cfg.firstLeg,
          firstLegFilledUsdt: targetSize,
          secondLegFilledUsdt: targetSize,
          secondLegCode: null
        }
      : null
  };

  if (!plan.ok) {
    // Map broker rejects onto delayed vocabulary when economic.
    const code: PaperReasonCode =
      plan.code === "not_net_positive"
        ? "delayed_net_non_positive"
        : plan.code === "insufficient_depth"
          ? "delayed_depth_insufficient"
          : plan.code === "fee_unknown"
            ? "fee_unknown"
            : plan.code === "mark_price_unavailable"
              ? "mark_price_unavailable"
              : "delayed_net_non_positive";
    return fail(code, "REJECT", ev);
  }

  // Hard gate: never accept non-positive risk-adjusted after delayed costs.
  if (plan.riskAdjustedPnlToman <= 0 || plan.economicNetPnlToman <= 0) {
    return fail("delayed_net_non_positive", "REJECT", ev);
  }

  return {
    ok: true,
    outcome: partial ? "FILL_PARTIAL" : "FILL_FULL",
    plan,
    fillSizeUsdt: targetSize,
    partial,
    evidence: { ...ev, outcome: partial ? "FILL_PARTIAL" : "FILL_FULL", rejectCode: null }
  };
}
