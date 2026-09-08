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
 *    round-trip completion; actual simulated first-leg balances are preserved)
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
  planBuyLeg, planSellLeg, settleObservedLegs,
  settlementFor,
  type FillPlan,
  type SideSettlement
} from "@/lib/shadowArbitrage/paper/broker";
import {
  microsToUsdt,
  usdtToMicros,
  validateBook,
  executableLadder,
  walkBook,
  type BookSide
} from "@/lib/shadowArbitrage/paper/liquidity";
import { feeFromBps } from "@/lib/shadowArbitrage/money";
import { resolvePaperRouteFloor, getVenueExecutionLimit, quantizeDownToStep, PAPER_POLICY_MIN_USDT } from "@/lib/shadowArbitrage/paper/venueExecutionLimits";
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
  maxSlippageBps?: number;
  /** Require supplied observations instead of inventing arrival liquidity. */
  requireArrivalObservation?: boolean;
};

export const DEFAULT_PAPER_EXECUTION_REALISM: PaperExecutionRealismConfig = {
  latency: DEFAULT_PAPER_LATENCY_MODEL,
  allowPartialFill: true,
  simulateLegRisk: true,
  firstLeg: "buy",
  maxCrossVenueSkewMs: SHADOW_EVENT_COHERENCE_MAX_SKEW_MS,
  maxAgeMs: SHADOW_STALE_MS,
  slippageBufferBps: 5,
  requireArrivalObservation: true,
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
  | "LEG_RISK_SECOND_LEG_FAILED"
  | "LEG_RISK";

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
  postFirstLeg?: { buy: BookSideSnapshot; sell: BookSideSnapshot; timestampMs: number };
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
  outcome: "FILL_FULL" | "FILL_PARTIAL" | "LEG_RISK";
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
  sizeUsdt: number,
  maxSlippageBps = 10
): { ok: true; vwap: number; filledUsdt: number; complete: boolean } | { ok: false; code: PaperReasonCode } {
  if (!snap) return { ok: false, code: "delayed_liquidity_disappeared" };
  const bids = snap.bookBids;
  const asks = snap.bookAsks;
  const ladder = executableLadder({ marketModel: snap.marketModel, bookBids: bids, bookAsks: asks, side,
    quote: snap.marketModel === "OTC_QUOTE" ? { userBuyPriceToman: snap.userBuyPriceToman,
      userSellPriceToman: snap.userSellPriceToman, maxExecutableUsdt: snap.maxExecutableUsdt,
      ageMs: snap.ageMs, stale: snap.stale, maxQuoteAgeMs: null } : undefined });
  const validation = validateBook(bids, asks, snap.marketModel);
  if (!ladder.ok) {
    if ((!validation.ok && (validation.problem === "book_crossed" || validation.problem === "book_unusable_level"))) {
      return { ok: false, code: "delayed_book_invalid" };
    }
    return { ok: false, code: "delayed_liquidity_disappeared" };
  }
  const levels = ladder.levels;
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
  // Preserve the sizing engine's accepted-depth ceiling at the new book.
  const best = levels[0].priceToman;
  const ceiling = Math.min(10, Math.max(0,maxSlippageBps));
  const accepted = levels.filter(l => (side === "buy" ? l.priceToman-best : best-l.priceToman) / best * 10000 <= ceiling + 1e-9);
  const walk = walkBook(accepted, usdtToMicros(sizeUsdt), side);
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
  requestedUsdt: number,
  maxSlippageBps = 10
): number {
  const buyWalk = walkSide(buy, "buy", requestedUsdt, maxSlippageBps);
  const sellWalk = walkSide(sell, "sell", requestedUsdt, maxSlippageBps);
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
  arrivalTimestampMs?: number;
  postFirstLegTimestampMs?: number;
  /** Called before a first leg is considered filled, and again before the second. */
  validatePlan?: (plan: FillPlan, sizeUsdt: number) => PaperReasonCode | null;
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
 * ok=true represents either a validated round trip or recorded unmatched leg exposure.
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
  const floor = resolvePaperRouteFloor(input.buySourceId, input.sellSourceId);
  const minSize = Math.max(cfg.minSizeUsdt ?? PAPER_POLICY_MIN_USDT, microsToUsdt(floor.minMicros),
    microsToUsdt(getVenueExecutionLimit(input.buySourceId)?.minNotionalUsdtMicros ?? 0),
    microsToUsdt(getVenueExecutionLimit(input.sellSourceId)?.minNotionalUsdtMicros ?? 0));
  const delayMs = resolveExecutionDelayMs({
    buy: input.detectionBuy,
    sell: input.detectionSell,
    model: cfg.latency
  });
  const arrivalTimestampMs = input.arrivalTimestampMs ?? input.decisionTimestampMs + delayMs;
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

  if (cfg.requireArrivalObservation && (!input.delayedBuy || !input.delayedSell)) {
    return fail("delayed_observation_missing", "REJECT", evidenceBase());
  }
  if (!Number.isFinite(arrivalTimestampMs) || arrivalTimestampMs < input.decisionTimestampMs + delayMs) {
    return fail("delayed_book_invalid", "REJECT", evidenceBase());
  }
  if (!delayedBuyRaw || !delayedSellRaw) {
    return fail("delayed_liquidity_disappeared", "REJECT", evidenceBase());
  }

  const received = (snap: NormalizedSourceSnapshot) => Date.parse(snap.marketData?.receiveTimestamp ?? snap.receivedAt);
  if ([delayedBuyRaw, delayedSellRaw].some(s => !Number.isFinite(received(s)) || received(s) > arrivalTimestampMs ||
    (cfg.requireArrivalObservation && received(s) < input.decisionTimestampMs + delayMs)))
    return fail("delayed_book_invalid", "REJECT", evidenceBase());
  if ([delayedBuyRaw, delayedSellRaw].some(s => s.health === "unavailable" || s.health === "degraded"))
    return fail("source_unhealthy", "REJECT", evidenceBase());
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

  if (planned < minSize || quantizeDownToStep(usdtToMicros(planned), floor.stepMicros) !== usdtToMicros(planned)) {
    return fail("partial_below_minimum", "REJECT", ev0);
  }
  let targetSize = planned;
  const buyAtPlan = walkSide(delayedBuyRaw, "buy", planned, cfg.maxSlippageBps);
  const sellAtPlan = walkSide(delayedSellRaw, "sell", planned, cfg.maxSlippageBps);

  if (!buyAtPlan.ok) return fail(buyAtPlan.code, "REJECT", ev0);
  if (!sellAtPlan.ok) return fail(sellAtPlan.code, "REJECT", ev0);

  const fullOk = buyAtPlan.complete && sellAtPlan.complete;
  if (!fullOk) {
    if (!cfg.allowPartialFill) {
      return fail("delayed_depth_insufficient", "REJECT", ev0);
    }
    const fillable = maxFillableBoth(delayedBuyRaw, delayedSellRaw, planned, cfg.maxSlippageBps);
    if (fillable + 1e-12 < minSize) {
      return fail("partial_below_minimum", "REJECT", ev0);
    }
    targetSize = microsToUsdt(quantizeDownToStep(usdtToMicros(fillable), floor.stepMicros));
    if (targetSize < minSize) {
      return fail("partial_below_minimum", "REJECT", ev0);
    }
  }

  const buyWalk = walkSide(delayedBuyRaw, "buy", targetSize, cfg.maxSlippageBps);
  const sellWalk = walkSide(delayedSellRaw, "sell", targetSize, cfg.maxSlippageBps);
  if (!buyWalk.ok) return fail(buyWalk.code, "REJECT", ev0);
  if (!sellWalk.ok) return fail(sellWalk.code, "REJECT", ev0);
  if (!buyWalk.complete || !sellWalk.complete) {
    // Even after shrinking, a side could not fill — treat as depth insufficient.
    return fail("delayed_depth_insufficient", "REJECT", ev0);
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
    markPriceToman: buyWalk.vwap,
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
    legRisk: null
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

  const policyReject = input.validatePlan?.(plan, targetSize);
  if (policyReject) return fail(policyReject, "REJECT", ev);
  if (cfg.simulateLegRisk) {
    const firstBuy = cfg.firstLeg === "buy";
    const secondSnap = firstBuy ? input.postFirstLegSell : input.postFirstLegBuy;
    const postAt = input.postFirstLegTimestampMs ?? arrivalTimestampMs;
    // Without any post-leg observation, no sequential execution can be asserted.
    if (!secondSnap) return fail("post_leg_observation_missing", "REJECT", ev);
    const secondCheck = assessCrossVenueCoherence({ buy: secondSnap, sell: secondSnap,
      decisionTimestampMs: postAt, maxAgeMs, maxSourceSkewMs: cfg.maxCrossVenueSkewMs ?? SHADOW_EVENT_COHERENCE_MAX_SKEW_MS });
    let secondCode: PaperReasonCode | null = !Number.isFinite(postAt) || postAt < arrivalTimestampMs || !Number.isFinite(received(secondSnap)) || received(secondSnap) > postAt || received(secondSnap) < arrivalTimestampMs
      ? "delayed_book_invalid" : !secondCheck.coherent || secondSnap.stale ? "delayed_book_stale"
      : secondSnap.health !== "healthy" ? "source_unhealthy" : null;
    const secondWalk = secondCode ? null : walkSide(secondSnap, firstBuy ? "sell" : "buy", targetSize, cfg.maxSlippageBps);
    if (secondWalk && !secondWalk.ok) secondCode = secondWalk.code;
    let secondSize = secondWalk?.ok ? secondWalk.filledUsdt : 0;
    let resultPlan = plan;
    if (secondWalk?.ok) {
      const secondPreview = planFill({ ...input, sizeUsdt: targetSize,
        buyVwapToman: firstBuy ? buyWalk.vwap : secondWalk.vwap,
        sellVwapToman: firstBuy ? secondWalk.vwap : sellWalk.vwap,
        buySettlement: input.buySettlement ?? settlementFor(input.buySourceId, "buy"),
        sellSettlement: input.sellSettlement ?? settlementFor(input.sellSourceId, "sell"),
        markPriceToman: firstBuy ? buyWalk.vwap : secondWalk.vwap, slippageBufferToman: slip });
      if (!secondPreview.ok) secondCode = "delayed_net_non_positive";
      else secondCode = input.validatePlan?.(secondPreview, targetSize) ?? null;
      if (secondCode) secondSize = 0;
      else resultPlan = secondPreview as FillPlan;
    }
    const complete = !secondCode && secondSize === targetSize;
    if (!complete) {
      const buyLeg = firstBuy ? plan.buyLeg : planBuyLeg(input.buySourceId,
        secondWalk?.ok ? secondWalk.vwap : buyWalk.vwap, secondSize, input.buyFeeBps, plan.buyLeg.settlement);
      const sellLeg = firstBuy ? planSellLeg(input.sellSourceId,
        secondWalk?.ok ? secondWalk.vwap : sellWalk.vwap, secondSize, input.sellFeeBps, plan.sellLeg.settlement) : plan.sellLeg;
      resultPlan = settleObservedLegs(buyLeg, sellLeg, plan.markPriceToman, slip);
    }
    const evidence: DelayedBookEvidence = { ...ev,
      outcome: complete ? (partial ? "FILL_PARTIAL" : "FILL_FULL") : "LEG_RISK",
      rejectCode: complete ? null : (secondCode ?? "delayed_depth_insufficient"),
      postFirstLeg: { buy: sideSnap(input.postFirstLegBuy, input.buySourceId), sell: sideSnap(input.postFirstLegSell, input.sellSourceId), timestampMs: postAt },
      legRisk: { simulated: true, firstLeg: cfg.firstLeg, firstLegFilledUsdt: targetSize,
        secondLegFilledUsdt: secondSize, secondLegCode: complete ? null : (secondCode ?? "delayed_depth_insufficient") },
      delayed: { ...ev.delayed, buyVwapToman: resultPlan.buyLeg.vwapToman, sellVwapToman: resultPlan.sellLeg.vwapToman,
        economicNetPnlToman: resultPlan.economicNetPnlToman, riskAdjustedPnlToman: resultPlan.riskAdjustedPnlToman } };
    return { ok: true, outcome: evidence.outcome as "FILL_FULL" | "FILL_PARTIAL" | "LEG_RISK",
      plan: resultPlan, fillSizeUsdt: targetSize, partial, evidence };
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
