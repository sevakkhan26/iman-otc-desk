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
import { SHADOW_STALE_MS, SHADOW_TRADE_SIZES } from "@/lib/shadowArbitrage/config";
import type { RiskPolicyState } from "@/lib/shadowArbitrage/live/policy";
import { computeRouteSize, type SizingResult } from "@/lib/shadowArbitrage/paper/sizing";
import type { VenueCapitalState } from "@/lib/shadowArbitrage/capital";
import {
  applyFill,
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
  | { kind: "EXECUTE"; candidate: PaperCandidate; plan: FillPlan; balancesAfter: VenueBalance[] }
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
   * Phase 8C-3 — the dynamic size worked out for each route this cycle, kept
   * whether it produced a size or a blocker. This is the evidence the UI shows
   * and the reason a route did or did not trade.
   */
  sizing: Array<{ routeKey: string; result: SizingResult }>;
};

/** A candidate whose economics have already been priced for this cycle. */
export type PricedCandidate = { candidate: PaperCandidate; plan: FillPlan };

/**
 * Deterministic global ranking.
 *
 * Candidates compete for the same virtual balance, so the order they are applied
 * in decides which ones fit. Ranking is therefore total and reproducible:
 * highest risk-adjusted PnL first, then larger size, then route key, then
 * lifecycle id. No two candidates can ever tie on all four.
 */
export function rankPricedCandidates(priced: PricedCandidate[]): PricedCandidate[] {
  return [...priced].sort(
    (a, b) =>
      b.plan.riskAdjustedPnlToman - a.plan.riskAdjustedPnlToman ||
      b.candidate.sizeUsdt - a.candidate.sizeUsdt ||
      a.candidate.routeKey.localeCompare(b.candidate.routeKey) ||
      a.candidate.lifecycleId.localeCompare(b.candidate.lifecycleId)
  );
}

/**
 * At most one size per route per cycle, chosen on risk-adjusted economic PnL —
 * never on cash PnL, which ignores the USDT the sell fee consumes.
 */
export function selectBestPerRoute(priced: PricedCandidate[]): {
  selected: PricedCandidate[];
  dropped: PricedCandidate[];
} {
  const byRoute = new Map<string, PricedCandidate[]>();
  for (const p of priced) {
    const key = `${p.candidate.buySourceId}->${p.candidate.sellSourceId}`;
    const list = byRoute.get(key);
    if (list) list.push(p);
    else byRoute.set(key, [p]);
  }

  const selected: PricedCandidate[] = [];
  const dropped: PricedCandidate[] = [];
  for (const key of [...byRoute.keys()].sort()) {
    const ordered = rankPricedCandidates(byRoute.get(key) ?? []);
    selected.push(ordered[0]);
    dropped.push(...ordered.slice(1));
  }
  return { selected: rankPricedCandidates(selected), dropped };
}

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
function depthUsable(
  s: NormalizedSourceSnapshot | undefined,
  sizeUsdt: number,
  side: "buy" | "sell"
): boolean {
  const ex = s?.sizeExecutables.find((x) => x.sizeUsdt === sizeUsdt);
  if (!ex) return false;
  return side === "buy"
    ? ex.buyFillable && ex.userBuyVwapToman !== null
    : ex.sellFillable && ex.userSellVwapToman !== null;
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
  probeSizesUsdt: readonly number[];
};

export type EvaluateInput = {
  opportunities: ShadowOpportunity[];
  sources: NormalizedSourceSnapshot[];
  venueStates: VenueCapitalState[];
  /** Lifecycle ids this session already filled — each executes at most once. */
  executedLifecycleIds: Set<string>;
  balances: VenueBalance[];
  sizing: SizingContext;
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
    if (
      !depthUsable(buySnap, c.sizeUsdt, "buy") ||
      !depthUsable(sellSnap, c.sizeUsdt, "sell") ||
      !SHADOW_TRADE_SIZES.includes(c.sizeUsdt as (typeof SHADOW_TRADE_SIZES)[number])
    ) {
      skip(c, ["insufficient_depth"]);
      continue;
    }
    if (c.netProfitToman <= 0) {
      skip(c, ["net_non_positive"]);
      continue;
    }
    viable.push(c);
  }

  /*
   * 2. Size every route, then price it.
   *
   * The candidate's own `sizeUsdt` is a diagnostic probe of the order book and
   * is NOT what trades. One size is calculated per route from depth, balances,
   * the capital plan and the risk policies, and every candidate on that route
   * is priced at it. A route whose size cannot be justified is skipped with the
   * exact reasons — never quietly executed at a probe size.
   */
  const priced: PricedCandidate[] = [];
  const sizingByRoute = new Map<string, SizingResult>();
  const sourceForSizing = (id: string) => input.sources.find((s) => s.sourceId === id);

  for (const c of viable) {
    const routeKey = `${c.buySourceId}->${c.sellSourceId}`;
    let sizing = sizingByRoute.get(routeKey);
    if (!sizing) {
      sizing = computeRouteSize({
        buySourceId: c.buySourceId,
        sellSourceId: c.sellSourceId,
        buySnapshot: sourceForSizing(c.buySourceId),
        sellSnapshot: sourceForSizing(c.sellSourceId),
        buyFeeBps: c.buyFeeBps,
        sellFeeBps: c.sellFeeBps,
        buySettlement: settlementFor(c.buySourceId, "buy"),
        sellSettlement: settlementFor(c.sellSourceId, "sell"),
        balances: input.balances,
        buyVenueAllocationToman: input.sizing.allocationTomanBySource.get(c.buySourceId) ?? null,
        portfolioValueToman: input.sizing.portfolioValueToman,
        buyVenueExposureToman: input.sizing.exposureTomanBySource.get(c.buySourceId) ?? null,
        policies: input.sizing.policies,
        slippageBufferBps: input.sizing.slippageBufferBps,
        probeSizesUsdt: input.sizing.probeSizesUsdt
      });
      sizingByRoute.set(routeKey, sizing);
    }

    if (sizing.status !== "SIZED" || sizing.sizeUsdtMicros === null || !sizing.quote || !sizing.economics) {
      skip(c, ["sizing_blocked"]);
      continue;
    }

    // From here the candidate carries the CALCULATED size, not the probe size,
    // so the ledger records what actually traded.
    const sizedCandidate: PaperCandidate = {
      ...c,
      sizeUsdt: microsToUsdt(sizing.sizeUsdtMicros),
      buyVwapToman: sizing.quote.buyVwapToman,
      sellVwapToman: sizing.quote.sellVwapToman,
      slippageBufferToman: sizing.economics.slippageBufferToman
    };
    const markPriceToman = sizing.quote.markPriceToman;
    const plan = planFill({
      buySourceId: sizedCandidate.buySourceId,
      sellSourceId: sizedCandidate.sellSourceId,
      sizeUsdt: sizedCandidate.sizeUsdt,
      buyVwapToman: sizedCandidate.buyVwapToman,
      sellVwapToman: sizedCandidate.sellVwapToman,
      buyFeeBps: sizedCandidate.buyFeeBps,
      sellFeeBps: sizedCandidate.sellFeeBps,
      buySettlement: settlementFor(sizedCandidate.buySourceId, "buy"),
      sellSettlement: settlementFor(sizedCandidate.sellSourceId, "sell"),
      markPriceToman,
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
    priced.push({ candidate: sizedCandidate, plan });
  }

  // 3. One size per route, then a total order across the whole cycle.
  const { selected, dropped } = selectBestPerRoute(priced);
  for (const d of dropped) skip(d.candidate, ["size_not_selected"]);

  // 4. Apply in rank order against the evolving virtual book.
  let book: VenueBalance[] = input.balances.map((b) => ({ ...b }));
  let executedCount = 0;

  for (const { candidate: c, plan } of selected) {
    const applied = applyFill(plan, book);
    if (!applied.ok) {
      const code = fromBrokerCode(applied.code);
      decisions.push({
        kind: "SKIP",
        candidate: c,
        code,
        codes: [code],
        reasonFa: reasonLabel(code),
        requiredRebalance: applied.requiredRebalance
      });
      continue;
    }

    // Commit both legs together — the book only changes on a complete fill.
    const updated = new Map(applied.balancesAfter.map((b) => [b.sourceId as string, b]));
    book = book.map((b) => updated.get(b.sourceId) ?? b);
    executedCount += 1;
    decisions.push({ kind: "EXECUTE", candidate: c, plan, balancesAfter: applied.balancesAfter });
  }

  return {
    decisions,
    balancesAfter: book,
    eligibleCandidates: priced.length,
    executedCount,
    // Sorted so two runs over the same cycle report routes in the same order.
    sizing: [...sizingByRoute.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([routeKey, result]) => ({ routeKey, result }))
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
