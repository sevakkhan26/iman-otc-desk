/**
 * Phase 8C-4 — cumulative order-book liquidity for paper sizing.
 *
 * A 10,000,000,000-toman portfolio cannot be sized from one headline price or
 * from a 25 USDT probe. This module works with the levels themselves: it walks
 * a real book, reports what each quantity would actually cost, and simulates a
 * large order as a ladder of child fills that consume depth exactly once.
 *
 * Three rules keep it honest:
 *
 * NEVER EXTRAPOLATE. A walk stops at the last observed level. Asking for more
 * than the book holds returns a short fill with the remainder stated — it never
 * invents a level, and it never assumes the next price is "about the same".
 *
 * VALIDATE BEFORE WALKING. A missing, empty, crossed or unsorted book blocks
 * with its own reason. A book whose bid is above its ask is not a tight market,
 * it is a parsing error or a stale merge, and sizing against it would produce
 * confident nonsense.
 *
 * DEPTH IS CONSUMED ONCE. The child-fill ladder decrements the remaining
 * quantity at each level; no level can back two fills. This is what makes a
 * large simulated order behave like a large order rather than like N copies of
 * a small one.
 *
 * Pure module: no database, no network, no clock, no exchange client. Nothing
 * here can place an order or move funds.
 */
import type { BookLevel } from "@/lib/shadowArbitrage/types";

/** USDT is integer micros everywhere money is compared or stored. */
export const USDT_MICROS = 1_000_000;

export function usdtToMicros(units: number): number {
  return Math.round(units * USDT_MICROS);
}

export function microsToUsdt(micros: number): number {
  return micros / USDT_MICROS;
}

export type BookSide = "buy" | "sell";

export type BookProblem =
  | "book_missing"
  | "book_empty"
  | "book_crossed"
  | "book_unusable_level";

export const BOOK_PROBLEM_FA: Record<BookProblem, string> = {
  book_missing: "دفتر سفارش برای این منبع ثبت نشده است",
  book_empty: "دفتر سفارش هیچ سطح قابل استفاده‌ای ندارد",
  book_crossed: "دفتر متقاطع است (بهترین خرید بالاتر از بهترین فروش)",
  book_unusable_level: "سطحی با قیمت یا مقدار نامعتبر در دفتر وجود دارد"
};

/**
 * Is this pair of books safe to size against?
 *
 * Checked per venue, before any arithmetic. The crossed check compares the
 * venue's own best bid and ask: within one book that ordering is an invariant,
 * and a violation means the data is wrong, not that the market is unusual.
 */
export function validateBook(
  bids: BookLevel[] | null,
  asks: BookLevel[] | null
): { ok: true } | { ok: false; problem: BookProblem; detailFa: string } {
  if (!bids || !asks) {
    return { ok: false, problem: "book_missing", detailFa: BOOK_PROBLEM_FA.book_missing };
  }
  const usable = (l: BookLevel) =>
    Number.isFinite(l.priceToman) &&
    Number.isFinite(l.amountUsdt) &&
    l.priceToman > 0 &&
    l.amountUsdt > 0;

  if (bids.some((l) => !usable(l)) || asks.some((l) => !usable(l))) {
    return {
      ok: false,
      problem: "book_unusable_level",
      detailFa: BOOK_PROBLEM_FA.book_unusable_level
    };
  }
  if (!bids.length || !asks.length) {
    return { ok: false, problem: "book_empty", detailFa: BOOK_PROBLEM_FA.book_empty };
  }

  const bestBid = Math.max(...bids.map((l) => l.priceToman));
  const bestAsk = Math.min(...asks.map((l) => l.priceToman));
  if (bestBid >= bestAsk) {
    return {
      ok: false,
      problem: "book_crossed",
      detailFa: `${BOOK_PROBLEM_FA.book_crossed} — بهترین خرید ${bestBid.toLocaleString("en-US")} و بهترین فروش ${bestAsk.toLocaleString("en-US")}`
    };
  }
  return { ok: true };
}

/** Levels in the order they would be consumed: asks ascending, bids descending. */
export function orderedLevels(levels: BookLevel[], side: BookSide): BookLevel[] {
  return [...levels]
    .filter((l) => l.priceToman > 0 && l.amountUsdt > 0)
    .sort((a, b) => (side === "buy" ? a.priceToman - b.priceToman : b.priceToman - a.priceToman));
}

export type CumulativePoint = {
  /** Cumulative quantity available up to and including this level, in micros. */
  cumulativeMicros: number;
  /** The level's own price. */
  priceToman: number;
  /** Notional to consume everything up to here, in integer toman. */
  cumulativeNotionalToman: number;
  /** VWAP if exactly this much were taken. */
  vwapToman: number;
};

/**
 * The cumulative curve of a book side.
 *
 * Each entry is a breakpoint: the quantity at which the next level's price
 * starts applying. These are the only quantities where marginal cost changes,
 * which is why they — and nothing between them — are the candidates worth
 * evaluating. Notional is accumulated in integer toman at every step so the
 * curve and a later walk agree to the rial.
 */
export function cumulativeCurve(levels: BookLevel[], side: BookSide): CumulativePoint[] {
  const ordered = orderedLevels(levels, side);
  const out: CumulativePoint[] = [];
  let cumMicros = 0;
  let cumNotional = 0;
  for (const level of ordered) {
    const levelMicros = usdtToMicros(level.amountUsdt);
    if (levelMicros <= 0) continue;
    cumMicros += levelMicros;
    cumNotional += Math.round((levelMicros / USDT_MICROS) * level.priceToman);
    out.push({
      cumulativeMicros: cumMicros,
      priceToman: level.priceToman,
      cumulativeNotionalToman: cumNotional,
      vwapToman: Math.round(cumNotional / (cumMicros / USDT_MICROS))
    });
  }
  return out;
}

/** Total quantity a side can absorb, in micros. */
export function totalDepthMicros(levels: BookLevel[]): number {
  return levels
    .filter((l) => l.priceToman > 0 && l.amountUsdt > 0)
    .reduce((sum, l) => sum + usdtToMicros(l.amountUsdt), 0);
}

export type ChildFill = {
  /** 1-based index in the ladder. */
  index: number;
  priceToman: number;
  quantityMicros: number;
  notionalToman: number;
};

export type BookWalk = {
  /** True only when the full requested quantity was available. */
  complete: boolean;
  requestedMicros: number;
  filledMicros: number;
  /** Requested − filled. Zero on a complete walk; never negative. */
  unfilledMicros: number;
  notionalToman: number;
  vwapToman: number | null;
  /** Price of the first level touched — the best price in the walk. */
  bestPriceToman: number | null;
  /** Price of the last level touched — the worst price in the walk. */
  worstPriceToman: number | null;
  /** Deterministic child fills, in consumption order. */
  fills: ChildFill[];
  /** Filled ÷ the side's total depth, in percent. */
  bookParticipationPercent: number;
  /** |vwap − best| ÷ best, in percent. What the size itself cost. */
  priceImpactPercent: number;
};

/**
 * Walk one side of a book for a quantity, producing the child-fill ladder.
 *
 * Depth is consumed once: `remaining` decreases at every level, so a level that
 * backed part of this walk cannot back any of it again. The walk stops at the
 * last observed level and reports the shortfall — it never extrapolates a price
 * beyond the book.
 */
export function walkBook(levels: BookLevel[], quantityMicros: number, side: BookSide): BookWalk {
  const ordered = orderedLevels(levels, side);
  const total = totalDepthMicros(levels);
  const requested = Math.max(0, Math.round(quantityMicros));

  let remaining = requested;
  let filled = 0;
  let notional = 0;
  const fills: ChildFill[] = [];

  for (const level of ordered) {
    if (remaining <= 0) break;
    const levelMicros = usdtToMicros(level.amountUsdt);
    if (levelMicros <= 0) continue;
    const take = Math.min(remaining, levelMicros);
    const notionalHere = Math.round((take / USDT_MICROS) * level.priceToman);
    fills.push({
      index: fills.length + 1,
      priceToman: level.priceToman,
      quantityMicros: take,
      notionalToman: notionalHere
    });
    notional += notionalHere;
    filled += take;
    remaining -= take;
  }

  const vwap = filled > 0 ? Math.round(notional / (filled / USDT_MICROS)) : null;
  const best = fills.length ? fills[0].priceToman : null;
  const worst = fills.length ? fills[fills.length - 1].priceToman : null;

  return {
    complete: filled >= requested && requested > 0,
    requestedMicros: requested,
    filledMicros: filled,
    unfilledMicros: Math.max(0, requested - filled),
    notionalToman: notional,
    vwapToman: vwap,
    bestPriceToman: best,
    worstPriceToman: worst,
    fills,
    bookParticipationPercent:
      total > 0 ? Math.round((filled / total) * 1_000_000) / 10_000 : 0,
    priceImpactPercent:
      best && vwap ? Math.round((Math.abs(vwap - best) / best) * 1_000_000) / 10_000 : 0
  };
}

/**
 * Quantities worth evaluating for a route.
 *
 * Marginal economics only change where a level is exhausted, so the candidate
 * set is the union of both books' breakpoints, plus every hard cap, plus the
 * caps themselves — clipped to the ceiling and de-duplicated. Evaluating the
 * union rather than a grid is what makes the search exact instead of sampled:
 * the optimum of a piecewise-linear profit curve is always at a breakpoint or
 * at a cap, never strictly between two of them.
 */
export function candidateQuantities(input: {
  buyAsks: BookLevel[];
  sellBids: BookLevel[];
  /** Hard ceilings in micros: balances, allocation, policy caps. */
  capsMicros: number[];
  /** Smallest quantity worth simulating. */
  minMicros: number;
  /** Rounding granularity the ledger can store. */
  granularityMicros: number;
}): number[] {
  const ceiling = input.capsMicros.length ? Math.min(...input.capsMicros) : 0;
  if (ceiling < input.minMicros) return [];

  const points = new Set<number>();
  const add = (micros: number) => {
    const q = Math.floor(micros / input.granularityMicros) * input.granularityMicros;
    if (q >= input.minMicros && q <= ceiling) points.add(q);
  };

  for (const p of cumulativeCurve(input.buyAsks, "buy")) add(p.cumulativeMicros);
  for (const p of cumulativeCurve(input.sellBids, "sell")) add(p.cumulativeMicros);
  for (const cap of input.capsMicros) add(cap);
  add(ceiling);

  return [...points].sort((a, b) => a - b);
}
