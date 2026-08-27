/**
 * Phase 6 — paper execution engine (selection and decision layer).
 *
 * Pure like the broker: it takes one already-collected cycle plus the current
 * virtual book and decides what a paper session *would* do. No network client,
 * no exchange adapter, no credentials, no real orders or transfers. A
 * structural test enforces the import restriction.
 *
 * Decisions use only same-cycle inputs: the order books collected in this
 * cycle, their VWAP depth for the traded size, fees that are known and fresh,
 * the slippage buffer, account readiness and the virtual balances.
 */
import {
  SHADOW_EVENT_COHERENCE_MAX_SKEW_MS,
  SHADOW_STALE_MS
} from "@/lib/shadowArbitrage/config";
import type { RiskPolicyState } from "@/lib/shadowArbitrage/live/policy";
import { computeRouteSize, type SizingResult } from "@/lib/shadowArbitrage/paper/sizing";
import {
  assessInventory,
  type InventoryModel
} from "@/lib/shadowArbitrage/paper/inventory";
import {
  availableBalances,
  commitHold,
  createReservationBook,
  releaseHold,
  reserveAtomic,
  settledBalances,
  totalReserved,
  type ReservationBook
} from "@/lib/shadowArbitrage/paper/reservations";
import type { QuoteCapacityInput } from "@/lib/shadowArbitrage/paper/liquidity";
import type { VenueCapitalState } from "@/lib/shadowArbitrage/capital";
import {
  microsToUsdt,
  planFill,
  settlementFor,
  settlementUsable,
  usdtToMicros,
  type FillPlan,
  type PaperRejectionCode,
  type VenueBalance
} from "@/lib/shadowArbitrage/paper/broker";
import { PAPER_REJECTION_FA } from "@/lib/shadowArbitrage/paper/broker";
import {
  normalizeReasons,
  primaryReason,
  reasonLabel,
  reasonsFromOpportunity,
  type PaperReasonCode
} from "@/lib/shadowArbitrage/paper/reasons";
import {
  computeUtilization,
  routeCapitalToman,
  venueExposureAfter
} from "@/lib/shadowArbitrage/paper/utilization";
import {
  PAPER_PORTFOLIO_FAILSAFE_VENUE_PERCENT,
  PAPER_PORTFOLIO_MAX_UTILIZATION_PERCENT,
  PAPER_PORTFOLIO_MIN_RESERVE_PERCENT
} from "@/lib/shadowArbitrage/paper/experimentPolicy";
import {
  allocatePaperRoutes,
  type PaperPortfolioTelemetry
} from "@/lib/shadowArbitrage/paper/portfolioAllocator";
import {
  applyInventoryShadowPrices,
  deriveInventoryShadowPrices,
  scorePaperCandidate,
  type CandidateScoreBreakdown
} from "@/lib/shadowArbitrage/paper/executionScoring";
import { estimateFromLifecycle } from "@/lib/shadowArbitrage/paper/opportunitySurvival";
import { assessCrossVenueCoherence } from "@/lib/shadowArbitrage/streaming/eventFabric";
import type {
  BlockedReasonCode,
  NormalizedSourceSnapshot,
  ShadowOpportunity,
  ShadowSourceId
} from "@/lib/shadowArbitrage/types";

/**
 * Every reason is exact. `PaperRejectionCode` values from the broker are a
 * subset of `PaperReasonCode`, so a broker rejection keeps its own precise
 * cause rather than being flattened into a generic message.
 */
export type PaperSkipCode = PaperReasonCode;

export const PAPER_SKIP_FA: Record<string, string> = { ...PAPER_REJECTION_FA };

/** Discovery-point telemetry that the full canonical optimizer must re-price. */
const OBSERVATION_ONLY_BLOCKED_REASONS = new Set<BlockedReasonCode>(["non_positive_net"]);

/** Broker rejection codes translated to the shared exact-reason vocabulary. */
const FROM_BROKER: Record<PaperRejectionCode, PaperReasonCode> = {
  same_venue: "same_venue",
  venue_not_executable: "venue_not_executable",
  fee_unknown: "fee_unknown",
  fee_settlement_unknown: "fee_settlement_unknown",
  fee_settlement_unsupported: "fee_settlement_unsupported",
  stale_market_data: "stale_market_data",
  insufficient_depth: "insufficient_depth",
  not_net_positive: "net_non_positive",
  insufficient_irt: "insufficient_irt",
  insufficient_usdt: "insufficient_usdt",
  negative_balance_guard: "negative_balance_guard",
  no_balance_record: "no_balance_record",
  mark_price_unavailable: "mark_price_unavailable"
};

export function fromBrokerCode(code: PaperRejectionCode): PaperReasonCode {
  return FROM_BROKER[code];
}

export type PaperCandidate = {
  lifecycleId: string;
  /** Exact outer-allocator route/quantity option selected for settlement. */
  allocationKey?: string;
  routeKey: string;
  buySourceId: ShadowSourceId;
  sellSourceId: ShadowSourceId;
  sizeUsdt: number;
  buyVwapToman: number;
  sellVwapToman: number;
  netProfitToman: number;
  slippageBufferToman: number;
  buyFeeBps: number | null;
  sellFeeBps: number | null;
  scoring?: CandidateScoreBreakdown;
};

export type PaperDecision =
  | {
      kind: "EXECUTE";
      candidate: PaperCandidate;
      plan: FillPlan;
      balancesAfter: VenueBalance[];
      /** The sizing that produced this fill — why this size and not a larger one. */
      sizing: SizingResult;
    }
  | {
      kind: "SKIP";
      candidate: PaperCandidate;
      /** Deterministic primary cause. */
      code: PaperSkipCode;
      /** Every cause that applied, canonically ordered. */
      codes: PaperSkipCode[];
      reasonFa: string;
      requiredRebalance: {
        sourceId: ShadowSourceId;
        irtTomanShort: number;
        usdtMicrosShort: number;
      } | null;
    };

export type CycleEvaluation = {
  decisions: PaperDecision[];
  /** Balances after applying every executed decision, in order. */
  balancesAfter: VenueBalance[];
  /** Opportunities that were eligible before balance checks. */
  eligibleCandidates: number;
  executedCount: number;
  /**
   * The calculated size for each route this cycle, kept whether it produced a
   * size or a blocker. This is the evidence the UI shows and the reason a route
   * did or did not trade.
   */
  sizing: Array<{ routeKey: string; result: SizingResult }>;
  /** Capacity still held when the cycle ended. Zero in a clean cycle. */
  reservations: { irtToman: number; usdtMicros: number; holds: number };
  /** Peak concurrent reserved utilization this cycle (null when limits off). */
  peakUtilizationPercent: number | null;
  /** Canonical management output from the outer Paper portfolio optimizer. */
  portfolio: PaperPortfolioTelemetry | null;
  marketData: {
    decisionTimestampMs: number;
    coherentRouteCount: number;
    blockedRouteCount: number;
    eventToDecisionLatencyMs: number[];
    venues: Array<{
      sourceId: string;
      transport: string;
      sourceEventAgeMs: number;
      latencyEstimateMs: number | null;
      jitterMs: number | null;
      reconnectCount: number;
      gapCount: number;
      resyncCount: number;
      snapshotResyncState: string;
    }>;
  };
};

/** Same-cycle freshness: the snapshot must be inside the staleness budget. */
function snapshotUsable(s: NormalizedSourceSnapshot | undefined): boolean {
  if (!s) return false;
  if (s.stale) return false;
  if (s.health === "unavailable") return false;
  if (s.marketData?.snapshotResyncState === "AWAITING_SNAPSHOT") return false;
  return s.ageMs <= SHADOW_STALE_MS;
}

/**
 * Same-cycle deterministic mark / replacement price for USDT.
 *
 * Documented rule: the executable buy VWAP for this size on the buy venue in
 * THIS cycle — what the desk actually paid to acquire USDT moments ago, so it
 * is the honest replacement cost of the USDT a sell-side fee consumes. Returns
 * null when the snapshot is missing, unusable or stale; the caller then blocks
 * rather than valuing the fee against a guess.
 */
export function resolveMarkPriceToman(
  sources: NormalizedSourceSnapshot[],
  buySourceId: string,
  sizeUsdt: number
): number | null {
  const snap = sources.find((s) => s.sourceId === buySourceId);
  if (!snapshotUsable(snap)) return null;
  const ex = snap?.sizeExecutables.find((x) => x.sizeUsdt === sizeUsdt);
  const price = ex?.userBuyVwapToman ?? null;
  if (price === null || !Number.isFinite(price) || price <= 0) return null;
  return Math.round(price);
}

/** The venue must actually have walkable depth for the size being traded. */
/**
 * Soft depth gate before capital-aware sizing.
 * Prefer real books; fall back to any fillable sizeExecutable entry.
 * Never requires the obsolete fixed ladder size to match.
 */
function depthUsable(
  s: NormalizedSourceSnapshot | undefined,
  _sizeUsdt: number,
  side: "buy" | "sell"
): boolean {
  if (!s) return false;
  const book = side === "buy" ? s.bookAsks : s.bookBids;
  if (book && book.length > 0) {
    const total = book.reduce((a, l) => a + (l.amountUsdt ?? 0), 0);
    if (total > 0) return true;
  }
  const any = s.sizeExecutables?.find((x) =>
    side === "buy"
      ? x.buyFillable && x.userBuyVwapToman !== null
      : x.sellFillable && x.userSellVwapToman !== null
  );
  return Boolean(any);
}

/**
 * Everything dynamic sizing needs that the cycle itself does not carry.
 *
 * There is no optional fallback to the fixed probe ladder: if the caller cannot
 * supply this, sizing blocks. Silently trading a diagnostic probe size because
 * the risk context was unavailable is exactly the failure this phase removes.
 */
export type SizingContext = {
  policies: RiskPolicyState[];
  /** Capital-plan share per venue, in toman. Missing venues size as unknown. */
  allocationTomanBySource: Map<string, number>;
  /** Marked value of the whole virtual portfolio. Null blocks concentration. */
  portfolioValueToman: number | null;
  /** Marked value each venue currently holds. */
  exposureTomanBySource: Map<string, number>;
  slippageBufferBps: number;
  /**
   * Opening USDT shares per venue and the admin's deviation band. Inventory
   * that cannot be measured blocks sizing rather than being ignored — an
   * unmeasured limit is not a satisfied one.
   */
  inventoryModel: InventoryModel;
  /** Per-venue dealer quotes, for OTC sources. */
  quoteBySource?: Map<string, QuoteCapacityInput>;
};

/**
 * Portfolio-level capital limits (aggregate util, reserve, route, venue).
 *
 * Always required on the Paper execution path (run.ts attaches defaults).
 * evaluateCycle applies them whenever equity and mark are known; unit tests
 * that pass neither portfolioLimits nor portfolioValueToman skip only the
 * portfolio-layer checks (risk policies still bind).
 *
 * New-session defaults: max util 90%, min reserve 10%; dynamic venue cap with
 * a configurable 65% fail-safe concentration ceiling.
 * Missing limits on the live Paper path fail closed — never permissive.
 */
export type PortfolioLimits = {
  enabled: boolean;
  equityToman: number;
  markPriceToman: number;
  maxUtilizationPercent?: number;
  minReservePercent?: number;
  maxRouteCapitalPercent?: number;
  maxVenueExposurePercent?: number;
};

export type EvaluateInput = {
  opportunities: ShadowOpportunity[];
  sources: NormalizedSourceSnapshot[];
  venueStates: VenueCapitalState[];
  /** Lifecycle ids this session already filled — each executes at most once. */
  executedLifecycleIds: Set<string>;
  balances: VenueBalance[];
  sizing: SizingContext;
  portfolioLimits?: PortfolioLimits;
  /** Supplied by replay/collector so event-to-decision latency stays deterministic. */
  decisionTimestampMs?: number;
  maxCrossVenueSkewMs?: number;
};

/**
 * Evaluate one collection cycle.
 *
 * Everything is decided here; nothing is written. The caller persists the
 * result, which is what keeps the engine testable without a database.
 */
export function evaluateCycle(input: EvaluateInput): CycleEvaluation {
  const sourceById = new Map(input.sources.map((s) => [s.sourceId as string, s]));
  const stateById = new Map(input.venueStates.map((v) => [v.sourceId as string, v]));
  const decisions: PaperDecision[] = [];
  const decisionTimestampMs =
    input.decisionTimestampMs ??
    Math.max(
      0,
      ...input.sources.map((source) => Date.parse(source.receivedAt)).filter(Number.isFinite)
    );
  const eventToDecisionLatencyMs: number[] = [];
  let coherentRouteCount = 0;
  let blockedRouteCount = 0;
  const venueMarketData = [...input.sources]
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
    .map((source) => ({
      sourceId: source.sourceId,
      transport: source.marketData?.transport ?? "REST_FALLBACK",
      sourceEventAgeMs: source.marketData?.sourceEventAgeMs ?? source.ageMs,
      latencyEstimateMs:
        source.marketData?.latencyEstimateMs ?? source.meta.latencyMs,
      jitterMs: source.marketData?.jitterMs ?? null,
      reconnectCount: source.marketData?.reconnectCount ?? 0,
      gapCount: source.marketData?.gapCount ?? 0,
      resyncCount: source.marketData?.resyncCount ?? 0,
      snapshotResyncState:
        source.marketData?.snapshotResyncState ?? "SYNCHRONIZED"
    }));

  /** Records a skip with every exact cause, never a generic substitute. */
  const skip = (candidate: PaperCandidate, causes: PaperReasonCode[]): void => {
    const codes = normalizeReasons(causes);
    const code = primaryReason(codes);
    decisions.push({
      kind: "SKIP",
      candidate,
      code,
      codes,
      reasonFa: codes.map(reasonLabel).join(" · "),
      requiredRebalance: null
    });
  };

  // 1. Shape every active opportunity into a candidate.
  const raw: PaperCandidate[] = input.opportunities
    .filter((o) => o.isActive)
    .map((o) => ({
      lifecycleId: o.id,
      routeKey: o.routeKey,
      buySourceId: o.buySourceId,
      sellSourceId: o.sellSourceId,
      sizeUsdt: o.sizeUsdt,
      buyVwapToman: o.buyVwapToman,
      sellVwapToman: o.sellVwapToman,
      netProfitToman: o.netProfitToman,
      slippageBufferToman: o.slippageBufferToman,
      buyFeeBps: o.feeUnknown ? null : o.buyFeeBps,
      sellFeeBps: o.feeUnknown ? null : o.sellFeeBps
    }));

  const byId = new Map(input.opportunities.map((o) => [o.id, o]));
  const viable: PaperCandidate[] = [];

  for (const c of raw) {
    const o = byId.get(c.lifecycleId);
    if (input.executedLifecycleIds.has(c.lifecycleId)) {
      skip(c, ["lifecycle_already_processed"]);
      continue;
    }
    const buyState = stateById.get(c.buySourceId);
    const sellState = stateById.get(c.sellSourceId);

    /*
     * Carry structural upstream causes through verbatim. Observation PnL is
     * different: a single cheap q can be red while a later legal breakpoint is
     * positive, so `non_positive_net` must reach computeRouteSize. Accept the
     * legacy persisted shape (`BLOCKED` solely for that code) as well as the new
     * EXECUTABLE_NOW shape emitted by discovery.
     */
    const structuralBlockedReasons =
      o?.blockedReasons.filter((reason) => !OBSERVATION_ONLY_BLOCKED_REASONS.has(reason)) ?? [];
    const legacyObservationOnlyBlock =
      o?.eligibility === "BLOCKED" &&
      o.blockedReasons.length > 0 &&
      structuralBlockedReasons.length === 0;
    if (
      !o ||
      structuralBlockedReasons.length > 0 ||
      (o.eligibility !== "EXECUTABLE_NOW" && !legacyObservationOnlyBlock)
    ) {
      const causes = o
        ? reasonsFromOpportunity({
            eligibility: o.eligibility,
            blockedReasons: structuralBlockedReasons,
            feeUnknown: o.feeUnknown,
            buyFeeStale: buyState?.feeStale,
            sellFeeStale: sellState?.feeStale
          })
        : ["market_data_missing" as PaperReasonCode];
      skip(c, causes.length ? causes : ["market_data_missing"]);
      continue;
    }
    if (!buyState?.executable || !sellState?.executable) {
      // Say WHY the venue is not executable, not merely that it is not.
      const causes: PaperReasonCode[] = [];
      for (const st of [buyState, sellState]) {
        if (!st || st.executable) continue;
        if (st.capitalClass === "REFERENCE_ONLY") causes.push("reference_only");
        else if (st.takerFeeBps === null || st.feeProvenance === "UNKNOWN") causes.push("fee_unknown");
        else if (st.feeStale) causes.push("fee_stale");
        else causes.push("account_not_ready");
      }
      skip(c, causes.length ? causes : ["venue_not_executable"]);
      continue;
    }
    if (o.feeUnknown || c.buyFeeBps === null || c.sellFeeBps === null) {
      skip(c, ["fee_unknown"]);
      continue;
    }
    if (buyState.feeStale || sellState.feeStale) {
      skip(c, ["fee_stale"]);
      continue;
    }
    // Settlement is per venue AND per side: the buy side of one venue and the
    // sell side of the other must both be admin-confirmed.
    if (
      !settlementUsable(settlementFor(c.buySourceId, "buy")) ||
      !settlementUsable(settlementFor(c.sellSourceId, "sell"))
    ) {
      skip(c, ["fee_settlement_unknown"]);
      continue;
    }
    const buySnap = sourceById.get(c.buySourceId);
    const sellSnap = sourceById.get(c.sellSourceId);
    if (buySnap?.marketData || sellSnap?.marketData) {
      const coherence = assessCrossVenueCoherence({
        buy: buySnap,
        sell: sellSnap,
        decisionTimestampMs,
        maxAgeMs: SHADOW_STALE_MS,
        maxSourceSkewMs:
          input.maxCrossVenueSkewMs ?? SHADOW_EVENT_COHERENCE_MAX_SKEW_MS
      });
      if (!coherence.coherent) {
        blockedRouteCount += 1;
        skip(c, [
          coherence.reason === "awaiting_resync"
            ? "market_data_resync"
            : coherence.reason === "cross_venue_time_skew"
              ? "market_data_time_incoherent"
              : "stale_market_data"
        ]);
        continue;
      }
      coherentRouteCount += 1;
      if (coherence.eventToDecisionLatencyMs !== null) {
        eventToDecisionLatencyMs.push(coherence.eventToDecisionLatencyMs);
      }
    }
    if (!snapshotUsable(buySnap) || !snapshotUsable(sellSnap)) {
      const unhealthy = [buySnap, sellSnap].some((x) => x?.health === "unavailable");
      skip(c, unhealthy ? ["source_unhealthy"] : ["stale_market_data"]);
      continue;
    }
    /*
     * Probe size on the opportunity is only a discovery hint. Depth is re-checked
     * by capital-aware sizing (full walk) — do not refuse the route because the
     * obsolete 5/10/20/25 ladder probe did not match. Soft depth gate: at least
     * one side must show some walkable liquidity at a minimal size.
     */
    if (!depthUsable(buySnap, 1, "buy") || !depthUsable(sellSnap, 1, "sell")) {
      skip(c, ["insufficient_depth"]);
      continue;
    }
    // Discovery economics are only a size-free route observation. A red legacy
    // probe must not gate a route whose canonical curve becomes eligible later.
    viable.push(c);
  }

  /*
   * 2. One representative candidate per route.
   *
   * Sizing is a property of the ROUTE — the same books, the same balances, the
   * same policies — so every live lifecycle on a route would be sized
   * identically. Executing more than one of them would spend the same capacity
   * twice for a single opportunity, so the lowest lifecycle id represents the
   * route and the rest are recorded as not selected, deterministically.
   */
  const sourceForSizing = (id: string) => input.sources.find((s) => s.sourceId === id);
  const byRoute = new Map<string, PaperCandidate[]>();
  for (const c of viable) {
    const key = `${c.buySourceId}->${c.sellSourceId}`;
    const list = byRoute.get(key);
    if (list) list.push(c);
    else byRoute.set(key, [c]);
  }

  const representatives: PaperCandidate[] = [];
  for (const key of [...byRoute.keys()].sort()) {
    const ordered = [...(byRoute.get(key) ?? [])].sort((a, b) =>
      a.lifecycleId.localeCompare(b.lifecycleId)
    );
    representatives.push(ordered[0]);
    for (const rest of ordered.slice(1)) skip(rest, ["size_not_selected"]);
  }

  /*
   * 3. The capacity ledger.
   *
   * Every size from here on is calculated against the UNRESERVED balances, so
   * two routes can never be sized to spend the same toman. Without it both
   * would look affordable, the first would commit, and the second would be
   * recorded as "insufficient balance" as though the market had moved — when in
   * fact the desk had already spent the money on itself.
   */
  const ledger: ReservationBook = createReservationBook(input.balances);
  const sizingByRoute = new Map<string, SizingResult>();

  const sizeRoute = (
    c: PaperCandidate,
    dynamicRisk?: Parameters<typeof computeRouteSize>[0]["dynamicRisk"]
  ): SizingResult =>
    computeRouteSize({
      buySourceId: c.buySourceId,
      sellSourceId: c.sellSourceId,
      buySnapshot: sourceForSizing(c.buySourceId),
      sellSnapshot: sourceForSizing(c.sellSourceId),
      buyFeeBps: c.buyFeeBps,
      sellFeeBps: c.sellFeeBps,
      buySettlement: settlementFor(c.buySourceId, "buy"),
      sellSettlement: settlementFor(c.sellSourceId, "sell"),
      // The unreserved view — never the full book.
      balances: availableBalances(ledger),
      buyVenueAllocationToman: input.sizing.allocationTomanBySource.get(c.buySourceId) ?? null,
      portfolioValueToman: input.sizing.portfolioValueToman,
      buyVenueExposureToman: input.sizing.exposureTomanBySource.get(c.buySourceId) ?? null,
      policies: input.sizing.policies,
      slippageBufferBps: input.sizing.slippageBufferBps,
      inventoryModel: input.sizing.inventoryModel,
      dynamicRisk,
      portfolioAllocatorMode: "DYNAMIC_PORTFOLIO",
      buyQuote: input.sizing.quoteBySource?.get(c.buySourceId),
      sellQuote: input.sizing.quoteBySource?.get(c.sellSourceId)
    });

  /*
   * 4. Provisional pass — ranking only.
   *
   * Nothing is reserved here and nothing is committed. Its single job is to put
   * the routes in a deterministic order of merit before capacity starts being
   * consumed, so the most profitable route gets first claim on a shared balance
   * rather than whichever route happened to be evaluated first.
   */
  const provisional = representatives.map((c) => ({ c, sizing: sizeRoute(c) }));
  let rankedRoutes = [...provisional].sort(
    (a, b) =>
      (b.sizing.economics?.riskAdjustedPnlToman ?? 0) - (a.sizing.economics?.riskAdjustedPnlToman ?? 0) ||
      (b.sizing.economics?.capitalEfficiencyBps ?? 0) -
        (a.sizing.economics?.capitalEfficiencyBps ?? 0) ||
      (a.sizing.inventory?.impactPoints ?? 0) - (b.sizing.inventory?.impactPoints ?? 0) ||
      (a.sizing.economics?.capitalLockedToman ?? Number.MAX_SAFE_INTEGER) -
        (b.sizing.economics?.capitalLockedToman ?? Number.MAX_SAFE_INTEGER) ||
      (a.sizing.sizeUsdtMicros ?? Number.MAX_SAFE_INTEGER) -
        (b.sizing.sizeUsdtMicros ?? Number.MAX_SAFE_INTEGER) ||
      a.c.routeKey.localeCompare(b.c.routeKey) ||
      a.c.lifecycleId.localeCompare(b.c.lifecycleId)
  );

  /*
   * 5. Authoritative pass — reserve, plan, commit, in selected-option order.
   *
   * Once the exact outer allocator runs, its allocationKey and canonical
   * sizing are pinned through settlement. The ledger and limit checks remain
   * authoritative safety guards, but they must not independently re-optimize
   * a selected route and consume capacity assigned to another selected option.
   */
  let executedCount = 0;
  let eligibleCandidates = 0;
  /*
   * Portfolio limits are mandatory when a capital basis exists. Defaults from
   * PAPER_4D_* attach whenever the caller did not supply explicit percents —
   * never an optional experiment-only wrapper. Without equity/mark we cannot
   * measure util/route/venue and skip only that layer (pure unit tests).
   */
  const equityToman =
    input.portfolioLimits?.equityToman ??
    (input.sizing.portfolioValueToman !== null && input.sizing.portfolioValueToman > 0
      ? input.sizing.portfolioValueToman
      : null);
  const invMark = input.sizing.inventoryModel.valuationPriceToman;
  const markPriceToman =
    input.portfolioLimits?.markPriceToman ??
    (typeof invMark === "number" && invMark > 0 ? invMark : null);
  const wantLimits =
    input.portfolioLimits?.enabled !== false &&
    equityToman !== null &&
    markPriceToman !== null &&
    equityToman > 0 &&
    markPriceToman > 0;
  const limits = wantLimits
    ? {
        enabled: true as const,
        equityToman: equityToman as number,
        markPriceToman: markPriceToman as number,
        maxUtilizationPercent:
          input.portfolioLimits?.maxUtilizationPercent ??
          PAPER_PORTFOLIO_MAX_UTILIZATION_PERCENT,
        minReservePercent:
          input.portfolioLimits?.minReservePercent ??
          PAPER_PORTFOLIO_MIN_RESERVE_PERCENT,
        maxVenueExposurePercent:
          input.portfolioLimits?.maxVenueExposurePercent ??
          PAPER_PORTFOLIO_FAILSAFE_VENUE_PERCENT
      }
    : null;
  // Fail closed when the caller required portfolio limits but capital is missing.
  if (input.portfolioLimits?.enabled === true && !limits) {
    for (const { c } of rankedRoutes) {
      skip(c, ["sizing_blocked"]);
    }
    return {
      decisions,
      balancesAfter: settledBalances(ledger),
      eligibleCandidates: 0,
      executedCount: 0,
      sizing: [...sizingByRoute.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([routeKey, result]) => ({ routeKey, result })),
      reservations: totalReserved(ledger),
      peakUtilizationPercent: null,
      portfolio: null,
      marketData: {
        decisionTimestampMs,
        coherentRouteCount,
        blockedRouteCount,
        eventToDecisionLatencyMs,
        venues: venueMarketData
      }
    };
  }
  const maxUtil =
    limits?.maxUtilizationPercent ?? PAPER_PORTFOLIO_MAX_UTILIZATION_PERCENT;
  const minReserve =
    limits?.minReservePercent ?? PAPER_PORTFOLIO_MIN_RESERVE_PERCENT;
  const maxVenue =
    limits?.maxVenueExposurePercent ?? PAPER_PORTFOLIO_FAILSAFE_VENUE_PERCENT;
  // Running reserved capital across concurrent selections this cycle.
  let reservedBuyIrt = 0;
  let reservedSellUsdtMicros = 0;
  // Venue exposure snapshot that grows with selections (no double-count of same capital).
  const liveExposure = new Map<string, number>();
  let portfolioTelemetry: PaperPortfolioTelemetry | null = null;
  const sizingByAllocationKey = new Map<string, SizingResult>();
  const scoringByAllocationKey = new Map<string, CandidateScoreBreakdown>();
  const selectedAllocationKeyByLifecycleId = new Map<string, string>();

  /*
   * 4b. Exact outer allocation over the inner solver's q* rows.
   *
   * This is deliberately before any reservation or settlement. Every route is
   * priced from the same snapshot and full free Paper book, then the allocator
   * chooses the globally best compatible subset. The authoritative pass below
   * rechecks and atomically settles only that subset.
   */
  const allocatorMark =
    limits?.markPriceToman ??
    (typeof markPriceToman === "number" && markPriceToman > 0 ? markPriceToman : 0);
  const allocatorEquity =
    limits?.equityToman ??
    input.balances.reduce(
      (sum, balance) =>
        sum +
        balance.irtToman +
        Math.round(microsToUsdt(balance.usdtMicros) * allocatorMark),
      0
    );
  if (allocatorMark > 0 && allocatorEquity > 0) {
    let allocatorRows = provisional.flatMap((row) => {
      const { c } = row;
      const initialDeployableToman = limits
        ? Math.floor(
            (limits.equityToman *
              Math.min(
                limits.maxUtilizationPercent,
                Math.max(0, 100 - limits.minReservePercent)
              )) /
              100
          )
        : null;
      const initialVenueHeadroomToman = limits
        ? Math.floor(
            (limits.equityToman * limits.maxVenueExposurePercent) / 100
          )
        : null;
      const initialDynamicRisk =
        limits && initialDeployableToman !== null
          ? {
              freePaperCapitalToman: initialDeployableToman,
              remainingGlobalUtilizationToman: initialDeployableToman,
              globalReserveHeadroomToman: initialDeployableToman,
              buyConcentrationHeadroomToman: initialVenueHeadroomToman,
              sellConcentrationHeadroomToman: initialVenueHeadroomToman
            }
          : undefined;
      const sizing =
        limits && initialDeployableToman !== null
          ? sizeRoute(c, initialDynamicRisk)
          : row.sizing;
      row.sizing = sizing;
      const venuePairKey = `${c.buySourceId}->${c.sellSourceId}`;
      sizingByRoute.set(venuePairKey, sizing);
      if (
        sizing.status !== "SIZED" ||
        sizing.sizeUsdtMicros === null ||
        !sizing.quote ||
        !sizing.economics
      ) {
        return [];
      }
      /*
       * Keep q* as the inner objective, but expose every already-legal,
       * canonical profitable breakpoint down to the route floor as a
       * multiple-choice option. This lets two routes share a balance instead
       * of forcing an all-or-nothing choice between their independent q*s.
       */
      const optionCaps = [
        sizing.sizeUsdtMicros,
        ...sizing.candidates
          .filter((candidate) => candidate.eligible)
          .map((candidate) => candidate.sizeUsdtMicros)
      ];
      const options = new Map<number, SizingResult>();
      for (const cap of [...new Set(optionCaps)].sort((a, b) => b - a)) {
        const option =
          cap === sizing.sizeUsdtMicros
            ? sizing
            : sizeRoute(c, {
                ...initialDynamicRisk,
                lateNumericCapUsdtMicros: cap
              });
        if (
          option.status === "SIZED" &&
          option.sizeUsdtMicros !== null &&
          option.quote &&
          option.economics
        ) {
          options.set(option.sizeUsdtMicros, option);
        }
      }
      return [...options.values()].flatMap((option) => {
        const sized = {
          ...c,
          sizeUsdt: microsToUsdt(option.sizeUsdtMicros as number),
          buyVwapToman: option.quote!.buyVwapToman,
          sellVwapToman: option.quote!.sellVwapToman,
          slippageBufferToman: option.economics!.slippageBufferToman
        };
        const plan = planFill({
          buySourceId: sized.buySourceId,
          sellSourceId: sized.sellSourceId,
          sizeUsdt: sized.sizeUsdt,
          buyVwapToman: sized.buyVwapToman,
          sellVwapToman: sized.sellVwapToman,
          buyFeeBps: sized.buyFeeBps,
          sellFeeBps: sized.sellFeeBps,
          buySettlement: settlementFor(sized.buySourceId, "buy"),
          sellSettlement: settlementFor(sized.sellSourceId, "sell"),
          markPriceToman: option.quote!.markPriceToman,
          slippageBufferToman: sized.slippageBufferToman
        });
        if (!plan.ok) return [];
        const candidateAllocationKey = `${c.lifecycleId}@${option.sizeUsdtMicros}`;
        const opportunity = byId.get(c.lifecycleId);
        const buyMarket = sourceForSizing(c.buySourceId);
        const sellMarket = sourceForSizing(c.sellSourceId);
        const survival = opportunity
          ? estimateFromLifecycle({
              routeKey: opportunity.routeKey,
              firstSeenAt: opportunity.firstSeenAt,
              lastSeenAt: opportunity.lastSeenAt,
              durationMs: opportunity.durationMs,
              observationCount: opportunity.observationCount
            })
          : estimateFromLifecycle({
              routeKey: c.routeKey,
              firstSeenAt: new Date(decisionTimestampMs).toISOString(),
              lastSeenAt: new Date(decisionTimestampMs).toISOString(),
              durationMs: 0,
              observationCount: 0
            });
        const sourceAgeMs = Math.max(
          buyMarket?.ageMs ?? SHADOW_STALE_MS,
          sellMarket?.ageMs ?? SHADOW_STALE_MS
        );
        const venueLatencyMs = Math.max(
          buyMarket?.marketData?.latencyEstimateMs ??
            buyMarket?.meta.latencyMs ??
            0,
          sellMarket?.marketData?.latencyEstimateMs ??
            sellMarket?.meta.latencyMs ??
            0
        );
        const venueJitterMs = Math.max(
          buyMarket?.marketData?.jitterMs ?? 0,
          sellMarket?.marketData?.jitterMs ?? 0
        );
        const scoring = scorePaperCandidate({
          canonicalRiskAdjustedPnlToman:
            option.economics!.riskAdjustedPnlToman,
          survival,
          fillConfidence: 1,
          fillConfidenceProvenance:
            "CANONICAL_FULL_BOOK_WALK_FILLABLE_AT_SELECTED_SIZE",
          sourceAgeMs,
          venueLatencyMs,
          venueJitterMs,
          buyIrtRequiredToman: Math.max(0, -plan.buyLeg.deltaIrtToman),
          sellUsdtMicros: Math.max(0, -plan.sellLeg.deltaUsdtMicros),
          buySourceId: c.buySourceId,
          sellSourceId: c.sellSourceId,
          inventoryImpactPoints: option.inventory?.impactPoints ?? 0
        });
        sizingByAllocationKey.set(candidateAllocationKey, option);
        scoringByAllocationKey.set(candidateAllocationKey, scoring);
        return [{
          lifecycleId: c.lifecycleId,
          allocationKey: candidateAllocationKey,
          routeKey: c.routeKey,
          buySourceId: c.buySourceId,
          sellSourceId: c.sellSourceId,
          sizeUsdt: sized.sizeUsdt,
          buyVwapToman: sized.buyVwapToman,
          sellVwapToman: sized.sellVwapToman,
          riskAdjustedPnlToman: option.economics!.riskAdjustedPnlToman,
          economicNetPnlToman: option.economics!.economicNetPnlToman,
          adjustedScoreToman: scoring.adjustedObjectiveToman,
          scoreBreakdown: scoring,
          buyNotionalToman: plan.buyLeg.notionalToman,
          buyIrtRequiredToman: Math.max(0, -plan.buyLeg.deltaIrtToman),
          sellUsdtMicros: Math.max(0, -plan.sellLeg.deltaUsdtMicros),
          capitalLockedToman: option.economics!.capitalLockedToman,
          buyAcceptedDepthToman:
            microsToUsdt(option.capacity?.buyDepth.depthMicros ?? 0) *
            sized.buyVwapToman,
          sellAcceptedDepthToman:
            microsToUsdt(option.capacity?.sellDepth.depthMicros ?? 0) *
            allocatorMark,
          inventoryImpactPoints: option.inventory?.impactPoints ?? 0,
          inventoryDeltas: [
            {
              sourceId: plan.buyLeg.sourceId,
              deltaIrtToman: plan.buyLeg.deltaIrtToman,
              deltaUsdtMicros: plan.buyLeg.deltaUsdtMicros
            },
            {
              sourceId: plan.sellLeg.sourceId,
              deltaIrtToman: plan.sellLeg.deltaIrtToman,
              deltaUsdtMicros: plan.sellLeg.deltaUsdtMicros
            }
          ],
          readiness: { healthy: true, fresh: true, feeCertain: true }
        }];
      });
    });
    const largestOptionByLifecycle = new Map<
      string,
      (typeof allocatorRows)[number]
    >();
    for (const candidate of allocatorRows) {
      const current = largestOptionByLifecycle.get(candidate.lifecycleId);
      if (
        !current ||
        candidate.capitalLockedToman! > current.capitalLockedToman!
      ) {
        largestOptionByLifecycle.set(candidate.lifecycleId, candidate);
      }
    }
    const inventoryAvailable = new Map<string, number>();
    for (const balance of input.balances) {
      inventoryAvailable.set(
        `${balance.sourceId}|IRT`,
        Math.max(0, balance.irtToman)
      );
      inventoryAvailable.set(
        `${balance.sourceId}|USDT_MICRO`,
        Math.max(0, balance.usdtMicros)
      );
    }
    const inventoryShadowPrices = deriveInventoryShadowPrices({
      availableUnits: inventoryAvailable,
      futureDemand: [...largestOptionByLifecycle.values()].flatMap(
        (candidate) => [
          {
            sourceId: candidate.buySourceId,
            asset: "IRT" as const,
            requiredUnits: candidate.buyIrtRequiredToman ?? 0,
            canonicalRiskAdjustedPnlToman:
              candidate.riskAdjustedPnlToman,
            captureConfidence:
              candidate.scoreBreakdown?.captureFactor ?? 0
          },
          {
            sourceId: candidate.sellSourceId,
            asset: "USDT_MICRO" as const,
            requiredUnits: candidate.sellUsdtMicros,
            canonicalRiskAdjustedPnlToman:
              candidate.riskAdjustedPnlToman,
            captureConfidence:
              candidate.scoreBreakdown?.captureFactor ?? 0
          }
        ]
      )
    });
    allocatorRows = allocatorRows.map((candidate) => {
      if (!candidate.scoreBreakdown) return candidate;
      const scoreBreakdown = applyInventoryShadowPrices({
        score: candidate.scoreBreakdown,
        shadowPrices: inventoryShadowPrices,
        buySourceId: candidate.buySourceId,
        sellSourceId: candidate.sellSourceId,
        buyIrtRequiredToman: candidate.buyIrtRequiredToman ?? 0,
        sellUsdtMicros: candidate.sellUsdtMicros,
        inventoryImpactPoints: candidate.inventoryImpactPoints ?? 0
      });
      if (candidate.allocationKey) {
        scoringByAllocationKey.set(candidate.allocationKey, scoreBreakdown);
      }
      return {
        ...candidate,
        adjustedScoreToman: scoreBreakdown.adjustedObjectiveToman,
        scoreBreakdown
      };
    });
    const allocation = allocatePaperRoutes({
      candidates: allocatorRows,
      equityToman: allocatorEquity,
      markPriceToman: allocatorMark,
      venueExposureToman: new Map(),
      availableIrtByVenue: new Map(
        input.balances.map((balance) => [balance.sourceId as string, balance.irtToman])
      ),
      availableUsdtMicrosByVenue: new Map(
        input.balances.map((balance) => [
          balance.sourceId as string,
          balance.usdtMicros
        ])
      ),
      maxUtilizationPercent: limits?.maxUtilizationPercent ?? 100,
      minReservePercent: limits?.minReservePercent ?? 0,
      maxVenueExposurePercent: limits?.maxVenueExposurePercent ?? 100,
      inventoryFeasible(candidates) {
        const aggregate = new Map<
          string,
          { sourceId: string; deltaIrtToman: number; deltaUsdtMicros: number }
        >();
        for (const candidate of candidates) {
          for (const delta of candidate.inventoryDeltas ?? []) {
            const current = aggregate.get(delta.sourceId) ?? {
              sourceId: delta.sourceId,
              deltaIrtToman: 0,
              deltaUsdtMicros: 0
            };
            current.deltaIrtToman += delta.deltaIrtToman;
            current.deltaUsdtMicros += delta.deltaUsdtMicros;
            aggregate.set(delta.sourceId, current);
          }
        }
        if (!aggregate.size) return true;
        return assessInventory({
          balances: input.balances,
          deltas: [...aggregate.values()],
          model: input.sizing.inventoryModel
        }).withinBand;
      }
    });
    portfolioTelemetry = allocation.telemetry;
    const selectedOptions = allocation.selected.flatMap((row) => {
      const key = row.candidate.allocationKey;
      if (!key || !sizingByAllocationKey.has(key)) return [];
      selectedAllocationKeyByLifecycleId.set(row.candidate.lifecycleId, key);
      return [{ lifecycleId: row.candidate.lifecycleId, allocationKey: key }];
    });
    const selectedIds = new Set(selectedOptions.map((row) => row.lifecycleId));
    const allocatorRejected = new Map(
      allocation.rejected.map((row) => [row.lifecycleId, row])
    );
    for (const row of provisional) {
      if (selectedIds.has(row.c.lifecycleId) || row.sizing.status !== "SIZED") {
        continue;
      }
      const rejection = allocatorRejected.get(row.c.lifecycleId);
      const code = (
        rejection?.code === "invalid_size"
          ? "sizing_blocked"
          : rejection?.code ?? "portfolio_not_selected"
      ) as PaperReasonCode;
      skip(row.c, [code]);
    }
    const selectedOrder = new Map(
      selectedOptions.map((selection, index) => [selection.lifecycleId, index])
    );
    rankedRoutes = rankedRoutes
      .filter(
        (row) =>
          selectedIds.has(row.c.lifecycleId) || row.sizing.status !== "SIZED"
      )
      .sort(
        (a, b) =>
          (selectedOrder.get(a.c.lifecycleId) ?? Number.MAX_SAFE_INTEGER) -
            (selectedOrder.get(b.c.lifecycleId) ?? Number.MAX_SAFE_INTEGER) ||
          a.c.routeKey.localeCompare(b.c.routeKey)
      );
  }

  for (const { c } of rankedRoutes) {
    const venuePairKey = `${c.buySourceId}->${c.sellSourceId}`;
    const selectedAllocationKey =
      selectedAllocationKeyByLifecycleId.get(c.lifecycleId);
    const pinnedSizing = selectedAllocationKey
      ? sizingByAllocationKey.get(selectedAllocationKey)
      : undefined;
    const freeBalances = availableBalances(ledger);
    const freeBuy = freeBalances.find((b) => b.sourceId === c.buySourceId);
    const freeSell = freeBalances.find((b) => b.sourceId === c.sellSourceId);
    const buySnapshot = sourceForSizing(c.buySourceId);
    const bestAsk = buySnapshot?.bookAsks
      ?.filter((l) => l.priceToman > 0 && l.amountUsdt > 0)
      .reduce<number | null>(
        (best, l) => (best === null ? l.priceToman : Math.min(best, l.priceToman)),
        null
      );
    const buyFeeFactor =
      settlementFor(c.buySourceId, "buy").feeAsset === "IRT"
        ? 1 + (c.buyFeeBps ?? 0) / 10_000
        : 1;
    const sellFeeFactor =
      settlementFor(c.sellSourceId, "sell").feeAsset === "USDT"
        ? 1 + (c.sellFeeBps ?? 0) / 10_000
        : 1;
    const reservationHeadroomMicros =
      freeBuy && freeSell && bestAsk && bestAsk > 0
        ? Math.min(
            Math.floor((freeBuy.irtToman / (bestAsk * buyFeeFactor)) * 1_000_000),
            Math.floor(freeSell.usdtMicros / sellFeeFactor)
          )
        : null;
    const utilBefore = limits
      ? computeUtilization({
          equityToman: limits.equityToman,
          markPriceToman: limits.markPriceToman,
          reservedBuyIrtToman: reservedBuyIrt,
          reservedSellUsdtMicros
        })
      : null;
    const allowedUtilPercent = Math.min(maxUtil, Math.max(0, 100 - minReserve));
    const allowedUtilToman = limits
      ? Math.floor((limits.equityToman * allowedUtilPercent) / 100)
      : null;
    const remainingUtilToman =
      utilBefore && allowedUtilToman !== null
        ? Math.max(0, allowedUtilToman - utilBefore.utilizedToman)
        : null;
    const dynamicRisk = {
      concurrentReservationHeadroomMicros: reservationHeadroomMicros,
      ...(limits
        ? {
            freePaperCapitalToman: utilBefore?.freeToman ?? null,
            remainingGlobalUtilizationToman: remainingUtilToman,
            globalReserveHeadroomToman: remainingUtilToman,
            buyConcentrationHeadroomToman: Math.max(
              0,
              Math.floor((limits.equityToman * maxVenue) / 100) -
                (liveExposure.get(c.buySourceId) ?? 0)
            ),
            sellConcentrationHeadroomToman: Math.max(
              0,
              Math.floor((limits.equityToman * maxVenue) / 100) -
                (liveExposure.get(c.sellSourceId) ?? 0)
            )
          }
        : {})
    };
    let sizing = pinnedSizing ?? sizeRoute(c, dynamicRisk);
    sizingByRoute.set(venuePairKey, sizing);

    if (sizing.status !== "SIZED" || sizing.sizeUsdtMicros === null || !sizing.quote || !sizing.economics) {
      skip(c, ["sizing_blocked"]);
      continue;
    }

    // From here the candidate carries the CALCULATED size, not the probe size,
    // so the ledger records what actually traded.
    let sizedCandidate: PaperCandidate = {
      ...c,
      ...(selectedAllocationKey
        ? {
            allocationKey: selectedAllocationKey,
            scoring: scoringByAllocationKey.get(selectedAllocationKey)
          }
        : {}),
      sizeUsdt: microsToUsdt(sizing.sizeUsdtMicros),
      buyVwapToman: sizing.quote.buyVwapToman,
      sellVwapToman: sizing.quote.sellVwapToman,
      slippageBufferToman: sizing.economics.slippageBufferToman
    };
    let plan = planFill({
      buySourceId: sizedCandidate.buySourceId,
      sellSourceId: sizedCandidate.sellSourceId,
      sizeUsdt: sizedCandidate.sizeUsdt,
      buyVwapToman: sizedCandidate.buyVwapToman,
      sellVwapToman: sizedCandidate.sellVwapToman,
      buyFeeBps: sizedCandidate.buyFeeBps,
      sellFeeBps: sizedCandidate.sellFeeBps,
      buySettlement: settlementFor(sizedCandidate.buySourceId, "buy"),
      sellSettlement: settlementFor(sizedCandidate.sellSourceId, "sell"),
      markPriceToman: sizing.quote.markPriceToman,
      slippageBufferToman: sizedCandidate.slippageBufferToman
    });
    if (!plan.ok) {
      const code = fromBrokerCode(plan.code);
      decisions.push({
        kind: "SKIP",
        candidate: sizedCandidate,
        code,
        codes: [code],
        reasonFa: reasonLabel(code),
        requiredRebalance: plan.requiredRebalance
      });
      continue;
    }

    /*
     * Portfolio utilization + route/venue capital fractions (four-day experiment).
     * Applied after sizing and economic plan so we never force deployment and
     * never lower the edge threshold to hit a utilization target.
     */
    if (limits && plan.ok) {
      let capital = routeCapitalToman({
        sizeUsdt: sizedCandidate.sizeUsdt,
        buyVwapToman: sizedCandidate.buyVwapToman,
        sellVwapToman: sizedCandidate.sellVwapToman,
        markPriceToman: limits.markPriceToman
      });
      const utilNow = computeUtilization({
        equityToman: limits.equityToman,
        markPriceToman: limits.markPriceToman,
        reservedBuyIrtToman: reservedBuyIrt,
        reservedSellUsdtMicros
      });
      let buyAdd = Math.round(plan.buyLeg.notionalToman);
      let sellAdd = Math.round(
        sizedCandidate.sizeUsdt * (sizedCandidate.sellVwapToman || limits.markPriceToman)
      );
      const buyExp = liveExposure.get(sizedCandidate.buySourceId) ?? 0;
      const sellExp = liveExposure.get(sizedCandidate.sellSourceId) ?? 0;
      const utilBreached = utilNow.wouldBreach(capital, maxUtil, minReserve);
      const buyVenueBreached = !venueExposureAfter({
          currentExposureToman: buyExp,
          addToman: buyAdd,
          equityToman: limits.equityToman,
          maxVenuePercent: maxVenue
        });
      const sellVenueBreached = !venueExposureAfter({
          currentExposureToman: sellExp,
          addToman: sellAdd,
          equityToman: limits.equityToman,
          maxVenuePercent: maxVenue
        });

      // Numeric cap became tighter than the selected point: clip the domain
      // once and solve F again only when no exact outer option was selected.
      // A selected option is indivisible here: clipping it would discard the
      // exact portfolio and could starve a partner route.
      if (utilBreached || buyVenueBreached || sellVenueBreached) {
        if (selectedAllocationKey) {
          skip(sizedCandidate, [
            utilBreached
              ? "portfolio_utilization_cap"
              : "venue_exposure_cap"
          ]);
          continue;
        }
        const q = sizing.sizeUsdtMicros as number;
        const caps: number[] = [];
        if (utilBreached && capital > 0) {
          const utilHeadroom = Math.max(0, (allowedUtilToman ?? 0) - utilNow.utilizedToman);
          caps.push(Math.floor((q * utilHeadroom) / capital));
        }
        const venueCeiling = Math.floor((limits.equityToman * maxVenue) / 100);
        if (buyVenueBreached && buyAdd > 0) {
          caps.push(Math.floor((q * Math.max(0, venueCeiling - buyExp)) / buyAdd));
        }
        if (sellVenueBreached && sellAdd > 0) {
          caps.push(Math.floor((q * Math.max(0, venueCeiling - sellExp)) / sellAdd));
        }
        const lateNumericCapUsdtMicros = Math.min(...caps);
        sizing = sizeRoute(c, { ...dynamicRisk, lateNumericCapUsdtMicros });
        sizingByRoute.set(venuePairKey, sizing);
        if (
          sizing.status !== "SIZED" ||
          sizing.sizeUsdtMicros === null ||
          !sizing.quote ||
          !sizing.economics
        ) {
          skip(c, [utilBreached ? "portfolio_utilization_cap" : "venue_exposure_cap"]);
          continue;
        }
        sizedCandidate = {
          ...c,
          sizeUsdt: microsToUsdt(sizing.sizeUsdtMicros),
          buyVwapToman: sizing.quote.buyVwapToman,
          sellVwapToman: sizing.quote.sellVwapToman,
          slippageBufferToman: sizing.economics.slippageBufferToman
        };
        plan = planFill({
          buySourceId: sizedCandidate.buySourceId,
          sellSourceId: sizedCandidate.sellSourceId,
          sizeUsdt: sizedCandidate.sizeUsdt,
          buyVwapToman: sizedCandidate.buyVwapToman,
          sellVwapToman: sizedCandidate.sellVwapToman,
          buyFeeBps: sizedCandidate.buyFeeBps,
          sellFeeBps: sizedCandidate.sellFeeBps,
          buySettlement: settlementFor(sizedCandidate.buySourceId, "buy"),
          sellSettlement: settlementFor(sizedCandidate.sellSourceId, "sell"),
          markPriceToman: sizing.quote.markPriceToman,
          slippageBufferToman: sizedCandidate.slippageBufferToman
        });
        if (!plan.ok) {
          skip(c, [fromBrokerCode(plan.code)]);
          continue;
        }
        capital = routeCapitalToman({
          sizeUsdt: sizedCandidate.sizeUsdt,
          buyVwapToman: sizedCandidate.buyVwapToman,
          sellVwapToman: sizedCandidate.sellVwapToman,
          markPriceToman: limits.markPriceToman
        });
        buyAdd = Math.round(plan.buyLeg.notionalToman);
        sellAdd = Math.round(
          sizedCandidate.sizeUsdt * (sizedCandidate.sellVwapToman || limits.markPriceToman)
        );
        if (
          utilNow.wouldBreach(capital, maxUtil, minReserve) ||
          !venueExposureAfter({ currentExposureToman: buyExp, addToman: buyAdd, equityToman: limits.equityToman, maxVenuePercent: maxVenue }) ||
          !venueExposureAfter({ currentExposureToman: sellExp, addToman: sellAdd, equityToman: limits.equityToman, maxVenuePercent: maxVenue })
        ) {
          skip(c, [utilBreached ? "portfolio_utilization_cap" : "venue_exposure_cap"]);
          continue;
        }
      }
    }

    eligibleCandidates += 1;

    /*
     * Hold both legs together or hold neither. The hold is keyed by the
     * lifecycle id, so a cycle re-run after a restart cannot reserve the same
     * capacity a second time.
     */
    const held = reserveAtomic(ledger, sizedCandidate.lifecycleId, [
      { sourceId: plan.buyLeg.sourceId, irtToman: -plan.buyLeg.deltaIrtToman, usdtMicros: 0 },
      { sourceId: plan.sellLeg.sourceId, irtToman: 0, usdtMicros: -plan.sellLeg.deltaUsdtMicros }
    ]);
    if (!held.ok) {
      const transferWouldBeRequired =
        held.code !== "no_balance_record" &&
        (held.shortfallIrtToman > 0 || held.shortfallUsdtMicros > 0);
      const code: PaperReasonCode = transferWouldBeRequired
        ? "rebalance_required_unpriced"
        : held.code === "no_balance_record"
            ? "no_balance_record"
            : held.code === "duplicate_hold"
              ? "lifecycle_already_processed"
              : held.code === "insufficient_usdt"
                ? "insufficient_usdt"
                : "insufficient_irt";
      decisions.push({
        kind: "SKIP",
        candidate: sizedCandidate,
        code,
        codes: [code],
        reasonFa: reasonLabel(code),
        requiredRebalance:
          held.sourceId && (held.shortfallIrtToman > 0 || held.shortfallUsdtMicros > 0)
            ? {
                sourceId: held.sourceId as ShadowSourceId,
                irtTomanShort: held.shortfallIrtToman,
                usdtMicrosShort: held.shortfallUsdtMicros
              }
            : null
      });
      continue;
    }

    // Settle the hold into real movements. A failure releases nothing implicitly
    // — the hold is dropped explicitly so the capacity returns to the cycle.
    const committed = commitHold(ledger, sizedCandidate.lifecycleId, [
      {
        sourceId: plan.buyLeg.sourceId,
        deltaIrtToman: plan.buyLeg.deltaIrtToman,
        deltaUsdtMicros: plan.buyLeg.deltaUsdtMicros
      },
      {
        sourceId: plan.sellLeg.sourceId,
        deltaIrtToman: plan.sellLeg.deltaIrtToman,
        deltaUsdtMicros: plan.sellLeg.deltaUsdtMicros
      }
    ]);
    if (!committed.ok) {
      releaseHold(ledger, sizedCandidate.lifecycleId);
      const code: PaperReasonCode = "negative_balance_guard";
      decisions.push({
        kind: "SKIP",
        candidate: sizedCandidate,
        code,
        codes: [code],
        reasonFa: reasonLabel(code),
        requiredRebalance: null
      });
      continue;
    }

    if (limits) {
      reservedBuyIrt += Math.round(plan.buyLeg.notionalToman);
      reservedSellUsdtMicros += Math.max(0, -plan.sellLeg.deltaUsdtMicros);
      const buyAdd = Math.round(plan.buyLeg.notionalToman);
      const sellAdd = Math.round(
        sizedCandidate.sizeUsdt * (sizedCandidate.sellVwapToman || limits.markPriceToman)
      );
      liveExposure.set(
        sizedCandidate.buySourceId,
        (liveExposure.get(sizedCandidate.buySourceId) ?? 0) + buyAdd
      );
      liveExposure.set(
        sizedCandidate.sellSourceId,
        (liveExposure.get(sizedCandidate.sellSourceId) ?? 0) + sellAdd
      );
    }

    executedCount += 1;
    decisions.push({
      kind: "EXECUTE",
      candidate: sizedCandidate,
      plan,
      balancesAfter: committed.balancesAfter,
      sizing
    });
  }

  const peakUtilizationPercent =
    limits && limits.equityToman > 0
      ? computeUtilization({
          equityToman: limits.equityToman,
          markPriceToman: limits.markPriceToman,
          reservedBuyIrtToman: reservedBuyIrt,
          reservedSellUsdtMicros
        }).utilizationPercent
      : null;
  if (portfolioTelemetry) {
    const executed = decisions.filter(
      (decision): decision is Extract<PaperDecision, { kind: "EXECUTE" }> =>
        decision.kind === "EXECUTE"
    );
    const actualCapital = executed.reduce(
      (sum, decision) =>
        sum + (decision.sizing.economics?.capitalLockedToman ?? 0),
      0
    );
    const actualRa = executed.reduce(
      (sum, decision) => sum + decision.plan.riskAdjustedPnlToman,
      0
    );
    const actualEconomic = executed.reduce(
      (sum, decision) => sum + decision.plan.economicNetPnlToman,
      0
    );
    const actualAdjusted = executed.reduce(
      (sum, decision) =>
        sum +
        (decision.candidate.scoring?.adjustedObjectiveToman ??
          decision.plan.riskAdjustedPnlToman),
      0
    );
    const actualCaptureAdjustment = executed.reduce(
      (sum, decision) =>
        sum + (decision.candidate.scoring?.captureAdjustmentToman ?? 0),
      0
    );
    const actualExecutionAdjustment = executed.reduce(
      (sum, decision) =>
        sum + (decision.candidate.scoring?.executionAdjustmentToman ?? 0),
      0
    );
    const actualInventoryCost = executed.reduce(
      (sum, decision) =>
        sum +
        (decision.candidate.scoring?.inventoryOpportunityCostToman ?? 0),
      0
    );
    const previouslyEngaged = Math.max(
      0,
      portfolioTelemetry.engagedCapitalToman -
        portfolioTelemetry.allocatedProfitableCapacityToman
    );
    const engaged = Math.min(
      portfolioTelemetry.maxDeployableCapitalToman,
      previouslyEngaged + actualCapital
    );
    const actualProfitableCapacity = Math.max(
      portfolioTelemetry.profitableExecutableCapacityToman,
      actualCapital
    );
    portfolioTelemetry = {
      ...portfolioTelemetry,
      engagedCapitalToman: engaged,
      freeCapitalToman: Math.max(
        0,
        portfolioTelemetry.maxDeployableCapitalToman - engaged
      ),
      utilizationPercent:
        portfolioTelemetry.totalCapitalToman > 0
          ? (engaged / portfolioTelemetry.totalCapitalToman) * 100
          : 0,
      selectedPortfolioRiskAdjustedPnlToman: actualRa,
      selectedPortfolioEconomicNetPnlToman: actualEconomic,
      selectedPortfolioAdjustedScoreToman: actualAdjusted,
      selectedCaptureAdjustmentToman: actualCaptureAdjustment,
      selectedExecutionAdjustmentToman: actualExecutionAdjustment,
      selectedInventoryOpportunityCostToman: actualInventoryCost,
      profitableExecutableCapacityToman: actualProfitableCapacity,
      allocatedProfitableCapacityToman: actualCapital,
      unallocatedProfitableCapacityToman: Math.max(
        0,
        actualProfitableCapacity - actualCapital
      ),
      idleCapitalToman: Math.max(
        0,
        portfolioTelemetry.maxDeployableCapitalToman - engaged
      ),
      returnOnTotalCapital:
        portfolioTelemetry.totalCapitalToman > 0
          ? actualRa / portfolioTelemetry.totalCapitalToman
          : null,
      returnOnEngagedCapital: engaged > 0 ? actualRa / engaged : null
    };
  }

  return {
    decisions,
    balancesAfter: settledBalances(ledger),
    eligibleCandidates,
    executedCount,
    // Sorted so two runs over the same cycle report routes in the same order.
    sizing: [...sizingByRoute.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([routeKey, result]) => ({ routeKey, result })),
    reservations: totalReserved(ledger),
    peakUtilizationPercent,
    portfolio: portfolioTelemetry,
    marketData: {
      decisionTimestampMs,
      coherentRouteCount,
      blockedRouteCount,
      eventToDecisionLatencyMs: [...eventToDecisionLatencyMs].sort(
        (a, b) => a - b
      ),
      venues: venueMarketData
    }
  };
}

/** Human-readable rebalance requirement, for the UI and the ledger. */
export function describeRebalance(
  required: { sourceId: ShadowSourceId; irtTomanShort: number; usdtMicrosShort: number } | null
): string | null {
  if (!required) return null;
  if (required.irtTomanShort > 0) {
    return `انتقال شبیه‌سازی‌شدهٔ ${Math.round(required.irtTomanShort).toLocaleString("en-US")} تومان به ${required.sourceId} لازم است.`;
  }
  if (required.usdtMicrosShort > 0) {
    return `انتقال شبیه‌سازی‌شدهٔ ${microsToUsdt(required.usdtMicrosShort).toFixed(2)} تتر به ${required.sourceId} لازم است.`;
  }
  return null;
}

/** Opening virtual book from a capital plan. Integer micros, never floats. */
export function balancesFromAllocations(
  allocations: Array<{ sourceId: string; irtToman: number; usdtUnits: number }>
): VenueBalance[] {
  return allocations.map((a) => ({
    sourceId: a.sourceId as ShadowSourceId,
    irtToman: Math.max(0, Math.round(a.irtToman)),
    usdtMicros: Math.max(0, usdtToMicros(a.usdtUnits))
  }));
}
