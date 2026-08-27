/**
 * Portfolio-level Paper capital allocator.
 *
 * The new path performs an exact deterministic branch-and-bound search over
 * canonical per-route q* / legal quantity options. The historical sorted
 * first-fit implementation remains exported only for benchmark comparison.
 *
 * No target is a quota: zero selection is correct when no positive canonical
 * economics survive resources and risk constraints. Pure module.
 */
import {
  computeUtilization,
  routeCapitalToman,
  venueExposureAfter
} from "@/lib/shadowArbitrage/paper/utilization";
import {
  PAPER_4D_MAX_UTILIZATION_PERCENT,
  PAPER_4D_MAX_VENUE_EXPOSURE_PERCENT,
  PAPER_4D_MIN_RESERVE_PERCENT,
  PAPER_PORTFOLIO_FAILSAFE_VENUE_PERCENT,
  PAPER_PORTFOLIO_MAX_UTILIZATION_PERCENT,
  PAPER_PORTFOLIO_MIN_RESERVE_PERCENT
} from "@/lib/shadowArbitrage/paper/experimentPolicy";
import type { CandidateScoreBreakdown } from "@/lib/shadowArbitrage/paper/executionScoring";

export type AllocatorCandidate = {
  lifecycleId: string;
  /** Distinguishes legal q options for the same lifecycle inside outer search. */
  allocationKey?: string;
  routeKey: string;
  buySourceId: string;
  sellSourceId: string;
  sizeUsdt: number;
  buyVwapToman: number;
  sellVwapToman: number;
  riskAdjustedPnlToman: number;
  economicNetPnlToman: number;
  /** Paper capture/execution/inventory objective; canonical RA remains above. */
  adjustedScoreToman?: number;
  scoreBreakdown?: CandidateScoreBreakdown;
  /** Buy notional (IRT required). */
  buyNotionalToman: number;
  /** USDT micros required on sell venue (including fee pad when known). */
  sellUsdtMicros: number;
  /** Canonical fee-inclusive IRT debit. Defaults to buyNotionalToman. */
  buyIrtRequiredToman?: number;
  /** Canonical simultaneous capital lock. Defaults to routeCapitalToman(). */
  capitalLockedToman?: number;
  /** Accepted executable depth represented by this candidate's buy leg. */
  buyAcceptedDepthToman?: number;
  /** Accepted executable depth represented by this candidate's sell leg. */
  sellAcceptedDepthToman?: number;
  /** Canonical inventory tie-break. Negative is inventory-repairing. */
  inventoryImpactPoints?: number;
  /** Signed canonical balance movements, used by the aggregate inventory gate. */
  inventoryDeltas?: Array<{
    sourceId: string;
    deltaIrtToman: number;
    deltaUsdtMicros: number;
  }>;
  /** All three are mandatory true on the engine path; false fails closed. */
  readiness?: {
    healthy: boolean;
    fresh: boolean;
    feeCertain: boolean;
  };
};

export type AllocatorRejection = {
  lifecycleId: string;
  routeKey: string;
  code: string;
  reasonFa: string;
};

export type AllocatorSelection = {
  candidate: AllocatorCandidate;
  capitalUsedToman: number;
  utilizationBeforePercent: number;
  utilizationAfterPercent: number;
};

export type AllocatorResult = {
  selected: AllocatorSelection[];
  rejected: AllocatorRejection[];
  utilizationBefore: ReturnType<typeof computeUtilization>;
  utilizationAfter: ReturnType<typeof computeUtilization>;
};

export type PaperIdleReason =
  | "no_positive_edge"
  | "depth_limit"
  | "balance_limit"
  | "venue_concentration"
  | "inventory"
  | "reservation_conflict"
  | "readiness_freshness_fee_block"
  | "optimizer_budget"
  | "global_90_percent_cap";

export type PaperPortfolioTelemetry = {
  totalCapitalToman: number;
  maxDeployableCapitalToman: number;
  reserveCapitalToman: number;
  engagedCapitalToman: number;
  freeCapitalToman: number;
  utilizationPercent: number;
  selectedPortfolioRiskAdjustedPnlToman: number;
  selectedPortfolioEconomicNetPnlToman: number;
  selectedPortfolioAdjustedScoreToman: number;
  selectedCaptureAdjustmentToman: number;
  selectedExecutionAdjustmentToman: number;
  selectedInventoryOpportunityCostToman: number;
  optimizerSolveTimeMs: number;
  optimizerOptionsConsidered: number;
  optimizerNodesVisited: number;
  optimizerPrunedNodes: number;
  optimizerProofStatus: "EXACT_PROVEN" | "BUDGET_EXHAUSTED_FAIL_CLOSED";
  optimizerFailClosedReason:
    | "option_budget_exceeded"
    | "node_budget_exceeded"
    | null;
  profitableExecutableCapacityToman: number;
  allocatedProfitableCapacityToman: number;
  unallocatedProfitableCapacityToman: number;
  idleCapitalToman: number;
  idleReasons: Record<
    PaperIdleReason,
    { candidateCount: number; profitableCapacityToman: number }
  >;
  returnOnTotalCapital: number | null;
  returnOnEngagedCapital: number | null;
};

export type DynamicVenueCap = {
  sourceId: string;
  capToman: number;
  headroomToman: number;
  failSafeCeilingToman: number;
  availableBalanceToman: number;
  acceptedDepthToman: number;
  readinessPassed: boolean;
};

export type PortfolioAllocatorResult = AllocatorResult & {
  algorithm: "EXACT_BRANCH_AND_BOUND_V1";
  telemetry: PaperPortfolioTelemetry;
  dynamicVenueCaps: DynamicVenueCap[];
  search: {
    candidates: number;
    optionsConsidered: number;
    nodesVisited: number;
    prunedNodes: number;
    solveTimeMs: number;
    maxOptions: number;
    maxNodes: number;
    budgetProvenance: "DEFAULT_PAPER_POLICY" | "CALLER_OVERRIDE";
    proofStatus: "EXACT_PROVEN" | "BUDGET_EXHAUSTED_FAIL_CLOSED";
    failClosedReason: "option_budget_exceeded" | "node_budget_exceeded" | null;
  };
};

export const PAPER_ALLOCATOR_DEFAULT_MAX_OPTIONS = 128;
export const PAPER_ALLOCATOR_DEFAULT_MAX_NODES = 250_000;

export type PaperAllocatorInput = {
  candidates: AllocatorCandidate[];
  equityToman: number;
  markPriceToman: number;
  /** Capital already engaged at each venue, not the venue's whole cash book. */
  venueExposureToman: Map<string, number>;
  /** Available balances for double-spend checks. */
  availableIrtByVenue: Map<string, number>;
  availableUsdtMicrosByVenue: Map<string, number>;
  maxUtilizationPercent?: number;
  minReservePercent?: number;
  /** @deprecated Historical experiment input; not applied as a fixed route cap. */
  maxRouteCapitalPercent?: number;
  maxVenueExposurePercent?: number;
  /** Existing Paper reservations, included before this snapshot's allocation. */
  reservedBuyIrtToman?: number;
  reservedSellUsdtMicros?: number;
  reservedIrtByVenue?: Map<string, number>;
  reservedUsdtMicrosByVenue?: Map<string, number>;
  /**
   * Aggregate inventory check over a proposed set. The engine supplies the
   * canonical inventory model; direct allocator fixtures may omit it.
   */
  inventoryFeasible?: (candidates: AllocatorCandidate[]) => boolean;
  /**
   * Deterministic proof budget. Exhaustion invalidates every partial incumbent
   * and returns zero selections with an explicit Paper diagnostic.
   */
  searchBudget?: {
    maxOptions?: number;
    maxNodes?: number;
  };
};

/**
 * Historical comparator only: first-fit after sorting by route RA PnL.
 * New Paper execution must call allocatePaperRoutes(), never this function.
 */
export function allocatePaperRoutesGreedy(input: PaperAllocatorInput): AllocatorResult {
  const maxUtil = input.maxUtilizationPercent ?? PAPER_4D_MAX_UTILIZATION_PERCENT;
  const minReserve = input.minReservePercent ?? PAPER_4D_MIN_RESERVE_PERCENT;
  const maxVenue = input.maxVenueExposurePercent ?? PAPER_4D_MAX_VENUE_EXPOSURE_PERCENT;

  const utilBefore = computeUtilization({
    equityToman: input.equityToman,
    markPriceToman: input.markPriceToman,
    reservedBuyIrtToman: input.reservedBuyIrtToman ?? 0,
    reservedSellUsdtMicros: input.reservedSellUsdtMicros ?? 0
  });

  // Deterministic rank: risk-adjusted PnL desc, then routeKey, then lifecycleId.
  const ranked = [...input.candidates].sort((a, b) => {
    if (b.riskAdjustedPnlToman !== a.riskAdjustedPnlToman) {
      return b.riskAdjustedPnlToman - a.riskAdjustedPnlToman;
    }
    const rk = a.routeKey.localeCompare(b.routeKey);
    if (rk !== 0) return rk;
    return a.lifecycleId.localeCompare(b.lifecycleId);
  });

  const selected: AllocatorSelection[] = [];
  const rejected: AllocatorRejection[] = [];
  let reservedBuy = input.reservedBuyIrtToman ?? 0;
  let reservedSell = input.reservedSellUsdtMicros ?? 0;
  const irtLeft = new Map(input.availableIrtByVenue);
  const usdtLeft = new Map(input.availableUsdtMicrosByVenue);
  const exposure = new Map(input.venueExposureToman);

  for (const c of ranked) {
    if (!(c.riskAdjustedPnlToman > 0) || !(c.economicNetPnlToman > 0)) {
      rejected.push({
        lifecycleId: c.lifecycleId,
        routeKey: c.routeKey,
        code: "net_non_positive",
        reasonFa: "سود اقتصادی تعدیل‌شده مثبت نیست — تخصیص صفر"
      });
      continue;
    }
    if (!(c.sizeUsdt > 0) || !(c.buyVwapToman > 0)) {
      rejected.push({
        lifecycleId: c.lifecycleId,
        routeKey: c.routeKey,
        code: "invalid_size",
        reasonFa: "حجم یا قیمت نامعتبر است"
      });
      continue;
    }

    const capital = routeCapitalToman({
      sizeUsdt: c.sizeUsdt,
      buyVwapToman: c.buyVwapToman,
      sellVwapToman: c.sellVwapToman,
      markPriceToman: input.markPriceToman
    });
    const utilNow = computeUtilization({
      equityToman: input.equityToman,
      markPriceToman: input.markPriceToman,
      reservedBuyIrtToman: reservedBuy,
      reservedSellUsdtMicros: reservedSell
    });
    if (utilNow.wouldBreach(capital, maxUtil, minReserve)) {
      rejected.push({
        lifecycleId: c.lifecycleId,
        routeKey: c.routeKey,
        code: "portfolio_utilization_cap",
        reasonFa: `تخصیص از سقف ${maxUtil}٪ استفاده یا کف ${minReserve}٪ نقدینگی آزاد عبور می‌کند`
      });
      continue;
    }

    const buyExp = exposure.get(c.buySourceId) ?? 0;
    const sellExp = exposure.get(c.sellSourceId) ?? 0;
    const buyAdd = c.buyNotionalToman;
    const sellAdd = Math.round(c.sizeUsdt * (c.sellVwapToman || input.markPriceToman));
    if (
      !venueExposureAfter({
        currentExposureToman: buyExp,
        addToman: buyAdd,
        equityToman: input.equityToman,
        maxVenuePercent: maxVenue
      }) ||
      !venueExposureAfter({
        currentExposureToman: sellExp,
        addToman: sellAdd,
        equityToman: input.equityToman,
        maxVenuePercent: maxVenue
      })
    ) {
      rejected.push({
        lifecycleId: c.lifecycleId,
        routeKey: c.routeKey,
        code: "venue_exposure_cap",
        reasonFa: `تمرکز روی صرافی از ${maxVenue}٪ سهام تجاوز می‌کند`
      });
      continue;
    }

    const irtAvail = irtLeft.get(c.buySourceId) ?? 0;
    const usdtAvail = usdtLeft.get(c.sellSourceId) ?? 0;
    if (c.buyNotionalToman > irtAvail) {
      rejected.push({
        lifecycleId: c.lifecycleId,
        routeKey: c.routeKey,
        code: "insufficient_irt",
        reasonFa: "موجودی تومانی آزاد برای این مسیر کافی نیست (بدون دوباره‌خرجی)"
      });
      continue;
    }
    if (c.sellUsdtMicros > usdtAvail) {
      rejected.push({
        lifecycleId: c.lifecycleId,
        routeKey: c.routeKey,
        code: "insufficient_usdt",
        reasonFa: "موجودی تتری آزاد برای این مسیر کافی نیست (بدون دوباره‌خرجی)"
      });
      continue;
    }

    const beforePct = utilNow.utilizationPercent;
    reservedBuy += c.buyNotionalToman;
    reservedSell += c.sellUsdtMicros;
    irtLeft.set(c.buySourceId, irtAvail - c.buyNotionalToman);
    usdtLeft.set(c.sellSourceId, usdtAvail - c.sellUsdtMicros);
    exposure.set(c.buySourceId, buyExp + buyAdd);
    exposure.set(c.sellSourceId, sellExp + sellAdd);

    const after = computeUtilization({
      equityToman: input.equityToman,
      markPriceToman: input.markPriceToman,
      reservedBuyIrtToman: reservedBuy,
      reservedSellUsdtMicros: reservedSell
    });

    selected.push({
      candidate: c,
      capitalUsedToman: capital,
      utilizationBeforePercent: beforePct,
      utilizationAfterPercent: after.utilizationPercent
    });
  }

  const utilAfter = computeUtilization({
    equityToman: input.equityToman,
    markPriceToman: input.markPriceToman,
    reservedBuyIrtToman: reservedBuy,
    reservedSellUsdtMicros: reservedSell
  });

  return {
    selected,
    rejected,
    utilizationBefore: utilBefore,
    utilizationAfter: utilAfter
  };
}

type Prepared = {
  candidate: AllocatorCandidate;
  capital: number;
  buyIrt: number;
  sellUsdtMicros: number;
  buyVenueCapital: number;
  sellVenueCapital: number;
};

const IDLE_REASONS: PaperIdleReason[] = [
  "no_positive_edge",
  "depth_limit",
  "balance_limit",
  "venue_concentration",
  "inventory",
  "reservation_conflict",
  "readiness_freshness_fee_block",
  "optimizer_budget",
  "global_90_percent_cap"
];

function emptyIdleReasons(): PaperPortfolioTelemetry["idleReasons"] {
  return Object.fromEntries(
    IDLE_REASONS.map((reason) => [
      reason,
      { candidateCount: 0, profitableCapacityToman: 0 }
    ])
  ) as PaperPortfolioTelemetry["idleReasons"];
}

function deterministicCandidateOrder(a: Prepared, b: Prepared): number {
  return (
    (b.candidate.adjustedScoreToman ?? b.candidate.riskAdjustedPnlToman) -
      (a.candidate.adjustedScoreToman ?? a.candidate.riskAdjustedPnlToman) ||
    b.candidate.riskAdjustedPnlToman - a.candidate.riskAdjustedPnlToman ||
    b.candidate.economicNetPnlToman - a.candidate.economicNetPnlToman ||
    (a.candidate.inventoryImpactPoints ?? 0) - (b.candidate.inventoryImpactPoints ?? 0) ||
    a.capital - b.capital ||
    a.candidate.routeKey.localeCompare(b.candidate.routeKey) ||
    a.candidate.lifecycleId.localeCompare(b.candidate.lifecycleId)
  );
}

function allocationKey(candidate: AllocatorCandidate): string {
  return (
    candidate.allocationKey ??
    `${candidate.routeKey}|${candidate.lifecycleId}|${candidate.sizeUsdt}`
  );
}

/**
 * Exact deterministic 0/1 multidimensional portfolio search.
 *
 * Each input is the canonical q* chosen by the inner route solver. The search
 * chooses zero or one q* per route and maximizes Σ canonical RA PnL under
 * global utilization, per-venue IRT/USDT, dynamic venue and aggregate inventory
 * constraints. Inventory is evaluated when a prefix is considered as a
 * candidate solution, not as an include-pruning condition: a temporarily
 * worsening route may still be completed by a complementary repair. For M
 * legal route/quantity options and V venues, worst-case time is
 * O(2^M * (M + V)); one-option-per-route checks, suffix-PnL bounds and
 * immediate resource checks prune normal Paper snapshots. Memory is O(M + V).
 */
export function allocatePaperRoutes(input: PaperAllocatorInput): PortfolioAllocatorResult {
  const solveStartedAt = performance.now();
  const maxOptions = Math.max(
    1,
    Math.floor(input.searchBudget?.maxOptions ?? PAPER_ALLOCATOR_DEFAULT_MAX_OPTIONS)
  );
  const maxNodes = Math.max(
    1,
    Math.floor(input.searchBudget?.maxNodes ?? PAPER_ALLOCATOR_DEFAULT_MAX_NODES)
  );
  const budgetProvenance =
    input.searchBudget === undefined ? "DEFAULT_PAPER_POLICY" : "CALLER_OVERRIDE";
  const maxUtil =
    input.maxUtilizationPercent ?? PAPER_PORTFOLIO_MAX_UTILIZATION_PERCENT;
  const minReserve =
    input.minReservePercent ?? PAPER_PORTFOLIO_MIN_RESERVE_PERCENT;
  const failSafeVenue =
    input.maxVenueExposurePercent ?? PAPER_PORTFOLIO_FAILSAFE_VENUE_PERCENT;
  const allowedPercent = Math.min(maxUtil, Math.max(0, 100 - minReserve));
  const totalCapital = Math.max(0, Math.round(input.equityToman));
  const maxDeployable = Math.floor((totalCapital * allowedPercent) / 100);
  const reserveCapital = Math.max(0, totalCapital - maxDeployable);
  const initialBuyReserved = Math.max(0, Math.round(input.reservedBuyIrtToman ?? 0));
  const initialSellReserved = Math.max(0, Math.round(input.reservedSellUsdtMicros ?? 0));
  const utilBefore = computeUtilization({
    equityToman: totalCapital,
    markPriceToman: input.markPriceToman,
    reservedBuyIrtToman: initialBuyReserved,
    reservedSellUsdtMicros: initialSellReserved
  });
  const initialEngaged = utilBefore.utilizedToman;
  const globalHeadroom = Math.max(0, maxDeployable - initialEngaged);

  const rejected: AllocatorRejection[] = [];
  const idleReasons = emptyIdleReasons();
  const prepared: Prepared[] = [];
  const addIdle = (
    reason: PaperIdleReason,
    candidate: AllocatorCandidate,
    capital: number
  ) => {
    idleReasons[reason].candidateCount += 1;
    if (candidate.riskAdjustedPnlToman > 0 && candidate.economicNetPnlToman > 0) {
      idleReasons[reason].profitableCapacityToman += Math.max(0, capital);
    }
  };
  const reject = (
    candidate: AllocatorCandidate,
    code: string,
    reasonFa: string,
    idle: PaperIdleReason,
    capital: number
  ) => {
    rejected.push({
      lifecycleId: candidate.lifecycleId,
      routeKey: candidate.routeKey,
      code,
      reasonFa
    });
    addIdle(idle, candidate, capital);
  };

  for (const candidate of input.candidates) {
    const capital = Math.max(
      0,
      Math.round(
        candidate.capitalLockedToman ??
          routeCapitalToman({
            sizeUsdt: candidate.sizeUsdt,
            buyVwapToman: candidate.buyVwapToman,
            sellVwapToman: candidate.sellVwapToman,
            markPriceToman: input.markPriceToman
          })
      )
    );
    if (!(candidate.riskAdjustedPnlToman > 0) || !(candidate.economicNetPnlToman > 0)) {
      reject(
        candidate,
        "net_non_positive",
        "سود اقتصادی تعدیل‌شده مثبت نیست — تخصیص صفر",
        "no_positive_edge",
        capital
      );
      continue;
    }
    if (
      !((candidate.adjustedScoreToman ?? candidate.riskAdjustedPnlToman) > 0)
    ) {
      reject(
        candidate,
        "adjusted_score_non_positive",
        "اقتصاد خام مثبت است اما امتیاز موردانتظار Paper پس از تعدیلات مثبت نیست",
        "no_positive_edge",
        capital
      );
      continue;
    }
    if (!(candidate.sizeUsdt > 0) || !(candidate.buyVwapToman > 0) || !(capital > 0)) {
      reject(candidate, "invalid_size", "حجم یا قیمت نامعتبر است", "depth_limit", capital);
      continue;
    }
    const ready = candidate.readiness;
    if (ready && (!ready.healthy || !ready.fresh || !ready.feeCertain)) {
      reject(
        candidate,
        "readiness_block",
        "سلامت، تازگی یا اطمینان کارمزد برای مسیر کامل نیست",
        "readiness_freshness_fee_block",
        capital
      );
      continue;
    }
    const buyIrt = Math.max(
      0,
      Math.round(candidate.buyIrtRequiredToman ?? candidate.buyNotionalToman)
    );
    const sellUsdtMicros = Math.max(0, Math.round(candidate.sellUsdtMicros));
    prepared.push({
      candidate,
      capital,
      buyIrt,
      sellUsdtMicros,
      buyVenueCapital: buyIrt,
      sellVenueCapital: Math.round(
        candidate.sizeUsdt * candidate.sellVwapToman
      )
    });
  }
  prepared.sort(deterministicCandidateOrder);

  const venueIds = new Set<string>();
  for (const p of prepared) {
    venueIds.add(p.candidate.buySourceId);
    venueIds.add(p.candidate.sellSourceId);
  }
  for (const id of input.venueExposureToman.keys()) venueIds.add(id);

  const dynamicVenueCaps: DynamicVenueCap[] = [...venueIds]
    .sort()
    .map((sourceId) => {
      const current = Math.max(0, input.venueExposureToman.get(sourceId) ?? 0);
      const availableIrt = Math.max(0, input.availableIrtByVenue.get(sourceId) ?? 0);
      const availableUsdtToman = Math.round(
        ((input.availableUsdtMicrosByVenue.get(sourceId) ?? 0) / 1_000_000) *
          input.markPriceToman
      );
      const availableBalanceToman = availableIrt + Math.max(0, availableUsdtToman);
      const acceptedDepthToman = prepared.reduce((sum, p) => {
        if (p.candidate.buySourceId === sourceId) {
          sum += Math.max(
            p.buyVenueCapital,
            Math.round(p.candidate.buyAcceptedDepthToman ?? 0)
          );
        }
        if (p.candidate.sellSourceId === sourceId) {
          sum += Math.max(
            p.sellVenueCapital,
            Math.round(p.candidate.sellAcceptedDepthToman ?? 0)
          );
        }
        return sum;
      }, 0);
      const readinessPassed = prepared.some(
        (p) =>
          p.candidate.buySourceId === sourceId ||
          p.candidate.sellSourceId === sourceId
      );
      const failSafeCeilingToman = Math.floor((totalCapital * failSafeVenue) / 100);
      const headroomToman = readinessPassed
        ? Math.max(
            0,
            Math.min(
              failSafeCeilingToman - current,
              globalHeadroom,
              availableBalanceToman,
              acceptedDepthToman
            )
          )
        : 0;
      return {
        sourceId,
        capToman: current + headroomToman,
        headroomToman,
        failSafeCeilingToman,
        availableBalanceToman,
        acceptedDepthToman,
        readinessPassed
      };
    });
  const venueHeadroom = new Map(
    dynamicVenueCaps.map((cap) => [cap.sourceId, cap.headroomToman])
  );

  const initialIrt = new Map<string, number>();
  const initialUsdt = new Map<string, number>();
  for (const id of venueIds) {
    initialIrt.set(
      id,
      Math.max(0, Math.round(input.reservedIrtByVenue?.get(id) ?? 0))
    );
    initialUsdt.set(
      id,
      Math.max(0, Math.round(input.reservedUsdtMicrosByVenue?.get(id) ?? 0))
    );
  }

  const suffixAdjusted = new Array<number>(prepared.length + 1).fill(0);
  const suffixCapital = new Array<number>(prepared.length + 1).fill(0);
  for (let i = prepared.length - 1; i >= 0; i -= 1) {
    suffixAdjusted[i] =
      suffixAdjusted[i + 1] +
      (prepared[i].candidate.adjustedScoreToman ??
        prepared[i].candidate.riskAdjustedPnlToman);
    suffixCapital[i] = suffixCapital[i + 1] + prepared[i].capital;
  }

  type Best = {
    rows: Prepared[];
    adjusted: number;
    ra: number;
    economic: number;
    capital: number;
    signature: string;
  };
  let best: Best = {
    rows: [],
    adjusted: 0,
    ra: 0,
    economic: 0,
    capital: 0,
    signature: ""
  };
  let maxCapacity: Best = best;
  let nodesVisited = 0;
  let prunedNodes = 0;
  let failClosedReason:
    | "option_budget_exceeded"
    | "node_budget_exceeded"
    | null = prepared.length > maxOptions ? "option_budget_exceeded" : null;
  const irtUsed = new Map(initialIrt);
  const usdtUsed = new Map(initialUsdt);
  const venueUsed = new Map<string, number>();
  const routeUsed = new Set<string>();
  const chosen: Prepared[] = [];

  const signatureOf = (rows: Prepared[]) =>
    rows
      .map((p) => allocationKey(p.candidate))
      .sort()
      .join(",");
  const betterObjective = (candidate: Best, incumbent: Best) => {
    if (candidate.adjusted !== incumbent.adjusted) {
      return candidate.adjusted > incumbent.adjusted;
    }
    if (candidate.ra !== incumbent.ra) return candidate.ra > incumbent.ra;
    if (candidate.economic !== incumbent.economic) {
      return candidate.economic > incumbent.economic;
    }
    if (candidate.capital !== incumbent.capital) {
      return candidate.capital < incumbent.capital;
    }
    return candidate.signature.localeCompare(incumbent.signature) < 0;
  };
  const betterCapacity = (candidate: Best, incumbent: Best) =>
    candidate.capital > incumbent.capital ||
    (candidate.capital === incumbent.capital &&
      (candidate.ra > incumbent.ra ||
        (candidate.ra === incumbent.ra &&
          candidate.signature.localeCompare(incumbent.signature) < 0)));

  const inventoryOk = (rows: Prepared[]) =>
    input.inventoryFeasible?.(rows.map((row) => row.candidate)) ?? true;
  const canInclude = (p: Prepared, capital: number): boolean => {
    if (routeUsed.has(p.candidate.routeKey)) return false;
    if (capital + p.capital > globalHeadroom) return false;
    const buy = p.candidate.buySourceId;
    const sell = p.candidate.sellSourceId;
    if (
      (irtUsed.get(buy) ?? 0) + p.buyIrt >
      Math.max(0, input.availableIrtByVenue.get(buy) ?? 0)
    ) {
      return false;
    }
    if (
      (usdtUsed.get(sell) ?? 0) + p.sellUsdtMicros >
      Math.max(0, input.availableUsdtMicrosByVenue.get(sell) ?? 0)
    ) {
      return false;
    }
    if (
      (venueUsed.get(buy) ?? 0) + p.buyVenueCapital >
        (venueHeadroom.get(buy) ?? 0) ||
      (venueUsed.get(sell) ?? 0) + p.sellVenueCapital >
        (venueHeadroom.get(sell) ?? 0)
    ) {
      return false;
    }
    return true;
  };

  const search = (
    index: number,
    adjusted: number,
    ra: number,
    economic: number,
    capital: number
  ) => {
    if (failClosedReason) return;
    if (nodesVisited >= maxNodes) {
      failClosedReason = "node_budget_exceeded";
      return;
    }
    nodesVisited += 1;
    const signature = signatureOf(chosen);
    const current: Best = {
      rows: [...chosen],
      adjusted,
      ra,
      economic,
      capital,
      signature
    };
    // Only legal final portfolios may become incumbents. Do not prune the DFS
    // merely because an intermediate prefix is inventory-infeasible: a later
    // route can repair the aggregate venue/asset position.
    if (inventoryOk(chosen)) {
      if (betterObjective(current, best)) best = current;
      if (betterCapacity(current, maxCapacity)) maxCapacity = current;
    }
    if (index >= prepared.length) return;
    if (
      adjusted + suffixAdjusted[index] < best.adjusted &&
      capital + suffixCapital[index] <= maxCapacity.capital
    ) {
      prunedNodes += 1;
      return;
    }

    const p = prepared[index];
    if (canInclude(p, capital)) {
      const buy = p.candidate.buySourceId;
      const sell = p.candidate.sellSourceId;
      chosen.push(p);
      routeUsed.add(p.candidate.routeKey);
      irtUsed.set(buy, (irtUsed.get(buy) ?? 0) + p.buyIrt);
      usdtUsed.set(sell, (usdtUsed.get(sell) ?? 0) + p.sellUsdtMicros);
      venueUsed.set(buy, (venueUsed.get(buy) ?? 0) + p.buyVenueCapital);
      venueUsed.set(sell, (venueUsed.get(sell) ?? 0) + p.sellVenueCapital);
      search(
        index + 1,
        adjusted +
          (p.candidate.adjustedScoreToman ??
            p.candidate.riskAdjustedPnlToman),
        ra + p.candidate.riskAdjustedPnlToman,
        economic + p.candidate.economicNetPnlToman,
        capital + p.capital
      );
      venueUsed.set(buy, (venueUsed.get(buy) ?? 0) - p.buyVenueCapital);
      venueUsed.set(sell, (venueUsed.get(sell) ?? 0) - p.sellVenueCapital);
      usdtUsed.set(sell, (usdtUsed.get(sell) ?? 0) - p.sellUsdtMicros);
      irtUsed.set(buy, (irtUsed.get(buy) ?? 0) - p.buyIrt);
      routeUsed.delete(p.candidate.routeKey);
      chosen.pop();
    }
    if (failClosedReason) return;
    search(index + 1, adjusted, ra, economic, capital);
  };
  if (!failClosedReason) search(0, 0, 0, 0, 0);
  const solveTimeMs = Math.max(0, performance.now() - solveStartedAt);
  const exactProven = failClosedReason === null;
  const emptyBest: Best = {
    rows: [],
    adjusted: 0,
    ra: 0,
    economic: 0,
    capital: 0,
    signature: ""
  };
  const solvedBest = exactProven ? best : emptyBest;
  const solvedMaxCapacity = exactProven ? maxCapacity : emptyBest;

  const selectedKeys = new Set(
    solvedBest.rows.map((p) => allocationKey(p.candidate))
  );
  const selected: AllocatorSelection[] = [];
  let runningCapital = initialEngaged;
  for (const p of [...solvedBest.rows].sort(deterministicCandidateOrder)) {
    const before = totalCapital > 0 ? (runningCapital / totalCapital) * 100 : 0;
    runningCapital += p.capital;
    selected.push({
      candidate: p.candidate,
      capitalUsedToman: p.capital,
      utilizationBeforePercent: before,
      utilizationAfterPercent:
        totalCapital > 0 ? (runningCapital / totalCapital) * 100 : 0
    });
  }

  const selectedIrt = new Map(initialIrt);
  const selectedUsdt = new Map(initialUsdt);
  const selectedVenue = new Map<string, number>();
  const selectedRoutes = new Set<string>();
  for (const p of solvedBest.rows) {
    selectedRoutes.add(p.candidate.routeKey);
    selectedIrt.set(
      p.candidate.buySourceId,
      (selectedIrt.get(p.candidate.buySourceId) ?? 0) + p.buyIrt
    );
    selectedUsdt.set(
      p.candidate.sellSourceId,
      (selectedUsdt.get(p.candidate.sellSourceId) ?? 0) + p.sellUsdtMicros
    );
    selectedVenue.set(
      p.candidate.buySourceId,
      (selectedVenue.get(p.candidate.buySourceId) ?? 0) + p.buyVenueCapital
    );
    selectedVenue.set(
      p.candidate.sellSourceId,
      (selectedVenue.get(p.candidate.sellSourceId) ?? 0) + p.sellVenueCapital
    );
  }

  for (const p of prepared) {
    const key = allocationKey(p.candidate);
    if (selectedKeys.has(key)) continue;
    if (failClosedReason) {
      reject(
        p.candidate,
        "optimizer_budget_exhausted",
        failClosedReason === "option_budget_exceeded"
          ? `بودجهٔ قطعی گزینه‌های بهینه‌ساز (${maxOptions}) کافی نیست — تخصیص بسته شد`
          : `بودجهٔ قطعی گره‌های بهینه‌ساز (${maxNodes}) تمام شد — تخصیص بسته شد`,
        "optimizer_budget",
        p.capital
      );
      continue;
    }
    // Other legal quantities of a selected route are counterfactual sizing
    // points, not idle portfolio capacity and not rejected routes.
    if (selectedRoutes.has(p.candidate.routeKey)) continue;
    let idle: PaperIdleReason = "reservation_conflict";
    let code = "portfolio_not_selected";
    let reasonFa = "ترکیب دیگری سود تعدیل‌شدهٔ کل بیشتری دارد";
    if (solvedBest.capital + p.capital > globalHeadroom) {
      idle = "global_90_percent_cap";
      code = "portfolio_utilization_cap";
      reasonFa = `سقف جهانی ${allowedPercent}٪ یک سقف است، نه سهمیهٔ اجباری`;
    } else if (
      (selectedIrt.get(p.candidate.buySourceId) ?? 0) + p.buyIrt >
        (input.availableIrtByVenue.get(p.candidate.buySourceId) ?? 0) ||
      (selectedUsdt.get(p.candidate.sellSourceId) ?? 0) + p.sellUsdtMicros >
        (input.availableUsdtMicrosByVenue.get(p.candidate.sellSourceId) ?? 0)
    ) {
      idle = "balance_limit";
      code =
        (selectedIrt.get(p.candidate.buySourceId) ?? 0) + p.buyIrt >
        (input.availableIrtByVenue.get(p.candidate.buySourceId) ?? 0)
          ? "insufficient_irt"
          : "insufficient_usdt";
      reasonFa = "موجودی آزاد مشترک برای افزودن این مسیر کافی نیست";
    } else if (
      (selectedVenue.get(p.candidate.buySourceId) ?? 0) + p.buyVenueCapital >
        (venueHeadroom.get(p.candidate.buySourceId) ?? 0) ||
      (selectedVenue.get(p.candidate.sellSourceId) ?? 0) + p.sellVenueCapital >
        (venueHeadroom.get(p.candidate.sellSourceId) ?? 0)
    ) {
      idle = "venue_concentration";
      code = "venue_exposure_cap";
      reasonFa = "سقف پویای تمرکز صرافی برای افزودن این مسیر کافی نیست";
    } else if (!inventoryOk([...solvedBest.rows, p])) {
      idle = "inventory";
      code = "inventory_limit";
      reasonFa = "ترکیب مسیرها باند موجودی را بدتر و نقض می‌کند";
    }
    reject(p.candidate, code, reasonFa, idle, p.capital);
  }

  const selectedBuy = solvedBest.rows.reduce((sum, p) => sum + p.buyIrt, 0);
  const selectedSell = solvedBest.rows.reduce(
    (sum, p) => sum + p.sellUsdtMicros,
    0
  );
  const utilAfter = computeUtilization({
    equityToman: totalCapital,
    markPriceToman: input.markPriceToman,
    reservedBuyIrtToman: initialBuyReserved + selectedBuy,
    reservedSellUsdtMicros: initialSellReserved + selectedSell
  });
  const engagedCapital = Math.min(maxDeployable, initialEngaged + solvedBest.capital);
  const freeCapital = Math.max(0, maxDeployable - engagedCapital);
  const profitableCapacity = solvedMaxCapacity.capital;
  const allocatedCapacity = solvedBest.capital;

  return {
    selected,
    rejected: rejected.sort(
      (a, b) =>
        a.routeKey.localeCompare(b.routeKey) ||
        a.lifecycleId.localeCompare(b.lifecycleId)
    ),
    utilizationBefore: utilBefore,
    utilizationAfter: utilAfter,
    algorithm: "EXACT_BRANCH_AND_BOUND_V1",
    dynamicVenueCaps,
    search: {
      candidates: prepared.length,
      optionsConsidered: prepared.length,
      nodesVisited,
      prunedNodes,
      solveTimeMs,
      maxOptions,
      maxNodes,
      budgetProvenance,
      proofStatus: exactProven
        ? "EXACT_PROVEN"
        : "BUDGET_EXHAUSTED_FAIL_CLOSED",
      failClosedReason
    },
    telemetry: {
      totalCapitalToman: totalCapital,
      maxDeployableCapitalToman: maxDeployable,
      reserveCapitalToman: reserveCapital,
      engagedCapitalToman: engagedCapital,
      freeCapitalToman: freeCapital,
      utilizationPercent:
        totalCapital > 0 ? (engagedCapital / totalCapital) * 100 : 0,
      selectedPortfolioRiskAdjustedPnlToman: solvedBest.ra,
      selectedPortfolioEconomicNetPnlToman: solvedBest.economic,
      selectedPortfolioAdjustedScoreToman: solvedBest.adjusted,
      selectedCaptureAdjustmentToman: solvedBest.rows.reduce(
        (sum, row) =>
          sum + (row.candidate.scoreBreakdown?.captureAdjustmentToman ?? 0),
        0
      ),
      selectedExecutionAdjustmentToman: solvedBest.rows.reduce(
        (sum, row) =>
          sum + (row.candidate.scoreBreakdown?.executionAdjustmentToman ?? 0),
        0
      ),
      selectedInventoryOpportunityCostToman: solvedBest.rows.reduce(
        (sum, row) =>
          sum +
          (row.candidate.scoreBreakdown?.inventoryOpportunityCostToman ?? 0),
        0
      ),
      optimizerSolveTimeMs: solveTimeMs,
      optimizerOptionsConsidered: prepared.length,
      optimizerNodesVisited: nodesVisited,
      optimizerPrunedNodes: prunedNodes,
      optimizerProofStatus: exactProven
        ? "EXACT_PROVEN"
        : "BUDGET_EXHAUSTED_FAIL_CLOSED",
      optimizerFailClosedReason: failClosedReason,
      profitableExecutableCapacityToman: profitableCapacity,
      allocatedProfitableCapacityToman: allocatedCapacity,
      unallocatedProfitableCapacityToman: Math.max(
        0,
        profitableCapacity - allocatedCapacity
      ),
      idleCapitalToman: freeCapital,
      idleReasons,
      returnOnTotalCapital:
        totalCapital > 0 ? solvedBest.ra / totalCapital : null,
      returnOnEngagedCapital:
        engagedCapital > 0 ? solvedBest.ra / engagedCapital : null
    }
  };
}
