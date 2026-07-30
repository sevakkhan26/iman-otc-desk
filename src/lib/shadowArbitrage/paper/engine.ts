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
import type {
  NormalizedSourceSnapshot,
  ShadowOpportunity,
  ShadowSourceId
} from "@/lib/shadowArbitrage/types";

export type PaperSkipCode =
  | PaperRejectionCode
  | "already_executed"
  | "blocked_opportunity"
  | "size_not_selected";

export const PAPER_SKIP_FA: Record<string, string> = {
  ...PAPER_REJECTION_FA,
  already_executed: "این فرصت قبلاً یک‌بار در همین نشست اجرا شده است",
  blocked_opportunity: "فرصت در همین چرخه مسدود بوده است",
  size_not_selected: "حجم بهتری برای همین مسیر انتخاب شد"
};

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
      code: PaperSkipCode;
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

export type EvaluateInput = {
  opportunities: ShadowOpportunity[];
  sources: NormalizedSourceSnapshot[];
  venueStates: VenueCapitalState[];
  /** Lifecycle ids this session already filled — each executes at most once. */
  executedLifecycleIds: Set<string>;
  balances: VenueBalance[];
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

  const skip = (candidate: PaperCandidate, code: PaperSkipCode): void => {
    decisions.push({
      kind: "SKIP",
      candidate,
      code,
      reasonFa: PAPER_SKIP_FA[code] ?? code,
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
      skip(c, "already_executed");
      continue;
    }
    if (!o || o.eligibility !== "EXECUTABLE_NOW" || o.blockedReasons.length > 0) {
      skip(c, "blocked_opportunity");
      continue;
    }
    if (!stateById.get(c.buySourceId)?.executable || !stateById.get(c.sellSourceId)?.executable) {
      skip(c, "venue_not_executable");
      continue;
    }
    if (o.feeUnknown || c.buyFeeBps === null || c.sellFeeBps === null) {
      skip(c, "fee_unknown");
      continue;
    }
    // Settlement is per venue AND per side: the buy side of one venue and the
    // sell side of the other must both be admin-confirmed.
    if (
      !settlementUsable(settlementFor(c.buySourceId, "buy")) ||
      !settlementUsable(settlementFor(c.sellSourceId, "sell"))
    ) {
      skip(c, "fee_settlement_unknown");
      continue;
    }
    const buySnap = sourceById.get(c.buySourceId);
    const sellSnap = sourceById.get(c.sellSourceId);
    if (!snapshotUsable(buySnap) || !snapshotUsable(sellSnap)) {
      skip(c, "stale_market_data");
      continue;
    }
    if (
      !depthUsable(buySnap, c.sizeUsdt, "buy") ||
      !depthUsable(sellSnap, c.sizeUsdt, "sell") ||
      !SHADOW_TRADE_SIZES.includes(c.sizeUsdt as (typeof SHADOW_TRADE_SIZES)[number])
    ) {
      skip(c, "insufficient_depth");
      continue;
    }
    if (c.netProfitToman <= 0) {
      skip(c, "not_net_positive");
      continue;
    }
    viable.push(c);
  }

  // 2. Price every viable candidate for this cycle. Pricing needs the mark
  //    price, so an unpriceable candidate is skipped here with its own reason.
  const priced: PricedCandidate[] = [];
  for (const c of viable) {
    const markPriceToman = resolveMarkPriceToman(input.sources, c.buySourceId, c.sizeUsdt);
    const plan = planFill({
      buySourceId: c.buySourceId,
      sellSourceId: c.sellSourceId,
      sizeUsdt: c.sizeUsdt,
      buyVwapToman: c.buyVwapToman,
      sellVwapToman: c.sellVwapToman,
      buyFeeBps: c.buyFeeBps,
      sellFeeBps: c.sellFeeBps,
      buySettlement: settlementFor(c.buySourceId, "buy"),
      sellSettlement: settlementFor(c.sellSourceId, "sell"),
      markPriceToman,
      slippageBufferToman: c.slippageBufferToman
    });
    if (!plan.ok) {
      decisions.push({
        kind: "SKIP",
        candidate: c,
        code: plan.code,
        reasonFa: plan.reasonFa,
        requiredRebalance: plan.requiredRebalance
      });
      continue;
    }
    priced.push({ candidate: c, plan });
  }

  // 3. One size per route, then a total order across the whole cycle.
  const { selected, dropped } = selectBestPerRoute(priced);
  for (const d of dropped) skip(d.candidate, "size_not_selected");

  // 4. Apply in rank order against the evolving virtual book.
  let book: VenueBalance[] = input.balances.map((b) => ({ ...b }));
  let executedCount = 0;

  for (const { candidate: c, plan } of selected) {
    const applied = applyFill(plan, book);
    if (!applied.ok) {
      decisions.push({
        kind: "SKIP",
        candidate: c,
        code: applied.code,
        reasonFa: applied.reasonFa,
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
    executedCount
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
