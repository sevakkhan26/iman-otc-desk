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
import { SHADOW_STALE_MS } from "@/lib/shadowArbitrage/config";
import type { RiskPolicyState } from "@/lib/shadowArbitrage/live/policy";
import { computeRouteSize, type SizingResult } from "@/lib/shadowArbitrage/paper/sizing";
import type { InventoryModel } from "@/lib/shadowArbitrage/paper/inventory";
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
  PAPER_4D_MAX_UTILIZATION_PERCENT,
  PAPER_4D_MAX_VENUE_EXPOSURE_PERCENT,
  PAPER_4D_MIN_RESERVE_PERCENT
} from "@/lib/shadowArbitrage/paper/experimentPolicy";
import type {
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
};

/** Same-cycle freshness: the snapshot must be inside the staleness budget. */
function snapshotUsable(s: NormalizedSourceSnapshot | undefined): boolean {
  if (!s) return false;
  if (s.stale) return false;
  if (s.health === "unavailable") return false;
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
 * Defaults: max util 80%, min reserve 20%, max route 10%, max venue 20%.
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

    // Carry the upstream causes through verbatim — this is the whole point.
    if (!o || o.eligibility !== "EXECUTABLE_NOW" || o.blockedReasons.length > 0) {
      const causes = o
        ? reasonsFromOpportunity({
            eligibility: o.eligibility,
            blockedReasons: o.blockedReasons,
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
  const rankedRoutes = [...provisional].sort(
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
   * 5. Authoritative pass — size, reserve, plan, commit, in rank order.
   *
   * The size is recalculated here against the capacity that is still free, so
   * the number that reaches the ledger is the number that was actually
   * affordable at the moment it was taken.
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
          input.portfolioLimits?.maxUtilizationPercent ?? PAPER_4D_MAX_UTILIZATION_PERCENT,
        minReservePercent:
          input.portfolioLimits?.minReservePercent ?? PAPER_4D_MIN_RESERVE_PERCENT,
        maxVenueExposurePercent:
          input.portfolioLimits?.maxVenueExposurePercent ?? PAPER_4D_MAX_VENUE_EXPOSURE_PERCENT
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
      peakUtilizationPercent: null
    };
  }
  const maxUtil = limits?.maxUtilizationPercent ?? PAPER_4D_MAX_UTILIZATION_PERCENT;
  const minReserve = limits?.minReservePercent ?? PAPER_4D_MIN_RESERVE_PERCENT;
  const maxVenue = limits?.maxVenueExposurePercent ?? PAPER_4D_MAX_VENUE_EXPOSURE_PERCENT;
  // Running reserved capital across concurrent selections this cycle.
  let reservedBuyIrt = 0;
  let reservedSellUsdtMicros = 0;
  // Venue exposure snapshot that grows with selections (no double-count of same capital).
  const liveExposure = new Map(input.sizing.exposureTomanBySource);

  for (const { c } of rankedRoutes) {
    const venuePairKey = `${c.buySourceId}->${c.sellSourceId}`;
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
    let sizing = sizeRoute(c, dynamicRisk);
    sizingByRoute.set(venuePairKey, sizing);

    if (sizing.status !== "SIZED" || sizing.sizeUsdtMicros === null || !sizing.quote || !sizing.economics) {
      skip(c, ["sizing_blocked"]);
      continue;
    }

    // From here the candidate carries the CALCULATED size, not the probe size,
    // so the ledger records what actually traded.
    let sizedCandidate: PaperCandidate = {
      ...c,
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
      // once and solve F again. Structural failures never enter this path.
      if (utilBreached || buyVenueBreached || sellVenueBreached) {
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
    peakUtilizationPercent
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
