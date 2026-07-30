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
  feeBasisFor,
  microsToUsdt,
  planFill,
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

export type PaperSkipCode = PaperRejectionCode | "already_executed" | "blocked_opportunity" | "size_not_selected";

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

/**
 * Deterministic size choice: at most one size per route per cycle.
 *
 * Highest net profit wins; ties break toward the larger size and then the
 * lexicographically smaller route key, so the same cycle always yields the same
 * selection regardless of iteration order.
 */
export function selectBestPerRoute(candidates: PaperCandidate[]): {
  selected: PaperCandidate[];
  dropped: PaperCandidate[];
} {
  const byRoute = new Map<string, PaperCandidate[]>();
  for (const c of candidates) {
    const key = `${c.buySourceId}->${c.sellSourceId}`;
    const list = byRoute.get(key);
    if (list) list.push(c);
    else byRoute.set(key, [c]);
  }

  const selected: PaperCandidate[] = [];
  const dropped: PaperCandidate[] = [];
  for (const list of [...byRoute.entries()].sort((a, b) => a[0].localeCompare(b[0])).map((e) => e[1])) {
    const ordered = [...list].sort(
      (a, b) =>
        b.netProfitToman - a.netProfitToman ||
        b.sizeUsdt - a.sizeUsdt ||
        a.routeKey.localeCompare(b.routeKey)
    );
    selected.push(ordered[0]);
    dropped.push(...ordered.slice(1));
  }
  // Stable, deterministic execution order across the whole cycle.
  selected.sort((a, b) => b.netProfitToman - a.netProfitToman || a.routeKey.localeCompare(b.routeKey));
  return { selected, dropped };
}

/** Same-cycle freshness: the snapshot must be inside the staleness budget. */
function snapshotUsable(s: NormalizedSourceSnapshot | undefined): boolean {
  if (!s) return false;
  if (s.stale) return false;
  if (s.health === "unavailable") return false;
  return s.ageMs <= SHADOW_STALE_MS;
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
    if (feeBasisFor(c.buySourceId) === "UNKNOWN" || feeBasisFor(c.sellSourceId) === "UNKNOWN") {
      skip(c, "fee_basis_unknown");
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

  // 2. One size per route, chosen deterministically.
  const { selected, dropped } = selectBestPerRoute(viable);
  for (const d of dropped) skip(d, "size_not_selected");

  // 3. Price and apply, sequentially, against the evolving virtual book.
  let book: VenueBalance[] = input.balances.map((b) => ({ ...b }));
  let executedCount = 0;

  for (const c of selected) {
    const plan = planFill({
      buySourceId: c.buySourceId,
      sellSourceId: c.sellSourceId,
      sizeUsdt: c.sizeUsdt,
      buyVwapToman: c.buyVwapToman,
      sellVwapToman: c.sellVwapToman,
      buyFeeBps: c.buyFeeBps,
      sellFeeBps: c.sellFeeBps,
      buyFeeBasis: feeBasisFor(c.buySourceId),
      sellFeeBasis: feeBasisFor(c.sellSourceId),
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
    eligibleCandidates: viable.length,
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
