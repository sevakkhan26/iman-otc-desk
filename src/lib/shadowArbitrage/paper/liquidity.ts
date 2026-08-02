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
  | "quote_only_no_order_book"
  | "book_missing"
  | "book_empty"
  | "book_crossed"
  | "book_unusable_level";

export const BOOK_PROBLEM_FA: Record<BookProblem, string> = {
  /*
   * Structural, not a fault: an OTC dealer quotes one price and publishes no
   * ladder. It must never be reported alongside a venue whose book simply
   * failed to arrive — one can never have depth, the other is missing it right
   * now, and the operator actions are completely different.
   */
  quote_only_no_order_book: "این منبع نقل‌قول تک‌قیمتی است و اساساً دفتر سفارش ندارد",
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
  asks: BookLevel[] | null,
  /**
   * The venue's market model. An OTC quote has no ladder by design, which is a
   * different fact from a book that should exist and did not arrive — grouping
   * the two hides a real outage behind a permanent, expected limitation.
   */
  marketModel?: string
): { ok: true } | { ok: false; problem: BookProblem; detailFa: string } {
  if (!bids || !asks) {
    const structural = marketModel === "OTC_QUOTE";
    const problem: BookProblem = structural ? "quote_only_no_order_book" : "book_missing";
    return { ok: false, problem, detailFa: BOOK_PROBLEM_FA[problem] };
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

/* ── Phase 8C-5 — per-venue capacity, with one exact reason each ─────────── */

export type VenueCapacityReason =
  | "ok"
  | "quote_only_no_order_book"
  | "book_missing"
  | "book_empty"
  | "book_crossed"
  | "book_unusable_level"
  | "no_balance_record"
  | "no_confirmed_fee"
  | "zero_balance"
  | "quote_capacity_unverified"
  | "quote_missing"
  | "quote_stale"
  | "quote_direction_unverified";

export const VENUE_CAPACITY_REASON_FA: Record<VenueCapacityReason, string> = {
  ok: "ظرفیت محاسبه شد",
  quote_only_no_order_book: "نقل‌قول تک‌قیمتی — بدون دفتر سفارش (محدودیت ساختاری، نه خرابی)",
  book_missing: "دفتر سفارش در این چرخه دریافت نشد",
  book_empty: "دفتر سفارش هیچ سطح قابل استفاده‌ای ندارد",
  book_crossed: "دفتر متقاطع است — دادهٔ نامعتبر",
  book_unusable_level: "سطحی با قیمت یا مقدار نامعتبر در دفتر وجود دارد",
  no_balance_record: "موجودی مجازی برای این صرافی ثبت نشده است",
  no_confirmed_fee: "کارمزد تأییدشده برای این صرافی موجود نیست",
  zero_balance: "موجودی این سمت صفر است",
  /*
   * A dealer quote with no published maximum. We know the price but not how
   * much of it is real, and a quote without a size is not a capacity claim —
   * so capacity stays null rather than borrowing a number from somewhere else.
   */
  quote_capacity_unverified: "نقل‌قول منتشر شده اما حداکثر حجم اجراپذیر اعلام نشده است",
  quote_missing: "نقل‌قول این چرخه دریافت نشد",
  quote_stale: "نقل‌قول از بودجهٔ تازگی عبور کرده است",
  quote_direction_unverified: "جهت نقل‌قول تأیید نشد (خرید پایین‌تر از فروش)"
};

/**
 * A dealer quote modelled as executable capacity.
 *
 * An OTC dealer publishes ONE price good for any size up to a stated maximum —
 * there is no ladder, so VWAP does not degrade with size and there are no
 * breakpoints. That is a different market model, not a degenerate order book,
 * and it is modelled directly rather than by inventing levels.
 *
 * The published maximum is the venue's own number. Without it the price is
 * still a price but not a capacity, and capacity is null with an exact reason.
 */
export type QuoteCapacityInput = {
  userBuyPriceToman: number | null;
  userSellPriceToman: number | null;
  /** Published by the venue. Null means it stated no executable size. */
  maxExecutableUsdt: number | null;
  ageMs: number;
  stale: boolean;
  maxQuoteAgeMs: number | null;
};

export type QuoteCheck =
  | { ok: true; maxMicros: number; buyPriceToman: number; sellPriceToman: number }
  | { ok: false; reason: VenueCapacityReason; detailFa: string };

export function checkQuote(q: QuoteCapacityInput): QuoteCheck {
  const { userBuyPriceToman: buy, userSellPriceToman: sell } = q;
  if (buy === null || sell === null || buy <= 0 || sell <= 0) {
    return { ok: false, reason: "quote_missing", detailFa: VENUE_CAPACITY_REASON_FA.quote_missing };
  }
  // A dealer never sells below its own bid; the reverse means bad parsing.
  if (buy < sell) {
    return {
      ok: false,
      reason: "quote_direction_unverified",
      detailFa: VENUE_CAPACITY_REASON_FA.quote_direction_unverified
    };
  }
  if (q.stale || (q.maxQuoteAgeMs !== null && q.ageMs > q.maxQuoteAgeMs)) {
    return {
      ok: false,
      reason: "quote_stale",
      detailFa: `${VENUE_CAPACITY_REASON_FA.quote_stale} — سن ${Math.round(q.ageMs)} میلی‌ثانیه`
    };
  }
  if (q.maxExecutableUsdt === null || !(q.maxExecutableUsdt > 0)) {
    return {
      ok: false,
      reason: "quote_capacity_unverified",
      detailFa: VENUE_CAPACITY_REASON_FA.quote_capacity_unverified
    };
  }
  return {
    ok: true,
    maxMicros: usdtToMicros(q.maxExecutableUsdt),
    buyPriceToman: Math.round(buy),
    sellPriceToman: Math.round(sell)
  };
}

/** One capped quantity with the evidence behind it. */
export type CapacityCap = {
  key: "depth" | "irt_balance" | "usdt_balance" | "capital_share" | "policy_order_size" | "policy_exposure";
  labelFa: string;
  /** Null means NOT APPLIED — an unset policy or an unmeasurable input. */
  capUsdtMicros: number | null;
  detailFa: string;
};

export type VenueSideCapacity = {
  /** The binding minimum across every applied cap. Null when not computable. */
  capacityUsdtMicros: number | null;
  reason: VenueCapacityReason;
  reasonFa: string;
  /** Which cap produced the minimum. Null when capacity is null. */
  limitingCap: CapacityCap["key"] | null;
  caps: CapacityCap[];
};

export type VenueCapacity = {
  sourceId: string;
  marketModel: string;
  /** Buying USDT here: funded by toman, limited by the ask ladder. */
  buy: VenueSideCapacity;
  /** Selling USDT here: funded by USDT, limited by the bid ladder. */
  sell: VenueSideCapacity;
};

/**
 * Persian labels for the caps. Exported so the UI can NAME a limiter without
 * re-deriving it — `venueCapacity()` stays the only place a capacity or a
 * limiter is decided.
 */
export const CAP_LABEL_FA: Record<CapacityCap["key"], string> = {
  depth: "عمق دفتر",
  irt_balance: "موجودی تومانی",
  usdt_balance: "موجودی تتری",
  capital_share: "سهم طرح سرمایه",
  policy_order_size: "سقف حجم سفارش (سیاست)",
  policy_exposure: "سقف تمرکز (سیاست)"
};

function sideUnavailable(reason: VenueCapacityReason, caps: CapacityCap[] = []): VenueSideCapacity {
  return {
    capacityUsdtMicros: null,
    reason,
    reasonFa: VENUE_CAPACITY_REASON_FA[reason],
    limitingCap: null,
    caps
  };
}

function resolveSide(caps: CapacityCap[]): VenueSideCapacity {
  const applied = caps.filter((c) => c.capUsdtMicros !== null);
  if (!applied.length) return sideUnavailable("no_balance_record", caps);
  let min = Number.POSITIVE_INFINITY;
  let limiting: CapacityCap["key"] | null = null;
  for (const c of applied) {
    if ((c.capUsdtMicros as number) < min) {
      min = c.capUsdtMicros as number;
      limiting = c.key;
    }
  }
  return {
    capacityUsdtMicros: min,
    reason: min > 0 ? "ok" : "zero_balance",
    reasonFa: VENUE_CAPACITY_REASON_FA[min > 0 ? "ok" : "zero_balance"],
    limitingCap: limiting,
    caps
  };
}

/**
 * How much this venue could buy and sell, side by side, with the exact reason
 * whenever it could not be measured.
 *
 * Every venue answers independently. Two venues with no capacity may have
 * completely different causes — one is an OTC dealer that will never publish a
 * ladder, another simply missed a cycle — and reporting them together hides a
 * real outage behind a permanent, expected limitation. That is why the reason
 * lives on the venue rather than being inferred by whoever renders the table.
 *
 * A policy that is UNSET contributes `null`, meaning NOT APPLIED. It is never
 * a cap of zero and never an invented default; execution is blocked elsewhere.
 */
export function venueCapacity(input: {
  sourceId: string;
  marketModel: string;
  bookBids: BookLevel[] | null;
  bookAsks: BookLevel[] | null;
  irtToman: number | null;
  usdtMicros: number | null;
  /** Admin-confirmed taker fee. Null blocks the side that pays it. */
  feeBps: number | null;
  buyFeeAsset: string;
  sellFeeAsset: string;
  /** Best executable prices, for turning toman ceilings into quantities. */
  capitalShareToman: number | null;
  policyOrderSizeMicros: number | null;
  policyExposureMicros: number | null;
  /** Present for OTC dealers. Order-book venues leave it undefined. */
  quote?: QuoteCapacityInput;
}): VenueCapacity {
  const base = { sourceId: input.sourceId, marketModel: input.marketModel };

  /*
   * A dealer quote is measured on its own terms. Its order-book fields stay
   * null — nothing is fabricated — and its capacity comes from the price and
   * the maximum the venue itself published.
   */
  if (input.marketModel === "OTC_QUOTE") {
    return quoteVenueCapacity(input, base);
  }

  const check = validateBook(input.bookBids, input.bookAsks, input.marketModel);
  if (!check.ok) {
    const r = check.problem as VenueCapacityReason;
    return { ...base, buy: sideUnavailable(r), sell: sideUnavailable(r) };
  }
  if (input.irtToman === null || input.usdtMicros === null) {
    return {
      ...base,
      buy: sideUnavailable("no_balance_record"),
      sell: sideUnavailable("no_balance_record")
    };
  }
  if (input.feeBps === null) {
    return {
      ...base,
      buy: sideUnavailable("no_confirmed_fee"),
      sell: sideUnavailable("no_confirmed_fee")
    };
  }

  const asks = input.bookAsks as BookLevel[];
  const bids = input.bookBids as BookLevel[];
  const bestAsk = orderedLevels(asks, "buy")[0]?.priceToman ?? 0;

  const cap = (
    key: CapacityCap["key"],
    capUsdtMicros: number | null,
    detailFa: string
  ): CapacityCap => ({ key, labelFa: CAP_LABEL_FA[key], capUsdtMicros, detailFa });

  const tomanToMicros = (toman: number, price: number) =>
    price > 0 ? Math.floor((toman / price) * USDT_MICROS) : 0;

  /* Buying here: the ask ladder and this venue's toman, fee-inclusive. */
  const buyPerUsdt = input.buyFeeAsset === "IRT" ? bestAsk * (1 + input.feeBps / 10_000) : bestAsk;
  const buyCaps: CapacityCap[] = [
    cap("depth", totalDepthMicros(asks), `${asks.length} سطح فروش در دفتر`),
    cap(
      "irt_balance",
      buyPerUsdt > 0 ? Math.floor((input.irtToman / buyPerUsdt) * USDT_MICROS) : 0,
      `${input.irtToman.toLocaleString("en-US")} تومان با کارمزد ${input.feeBps} bps در ${input.buyFeeAsset}`
    ),
    cap(
      "capital_share",
      input.capitalShareToman === null ? null : tomanToMicros(input.capitalShareToman, bestAsk),
      input.capitalShareToman === null
        ? "سهم طرح در دسترس نیست؛ اعمال نشد."
        : `${input.capitalShareToman.toLocaleString("en-US")} تومان`
    ),
    cap(
      "policy_order_size",
      input.policyOrderSizeMicros,
      input.policyOrderSizeMicros === null ? "تعیین‌نشده — اعمال نشد" : "سیاست حداکثر حجم سفارش"
    ),
    cap(
      "policy_exposure",
      input.policyExposureMicros,
      input.policyExposureMicros === null ? "تعیین‌نشده — اعمال نشد" : "سیاست سقف تمرکز"
    )
  ];

  /*
   * Selling here: the bid ladder and this venue's USDT. When the sell fee is
   * taken in USDT the venue is debited quantity PLUS fee, so the balance must
   * cover size × (1 + fee) — dividing by (1 + fee) is what makes the reported
   * capacity actually deliverable rather than one fee short.
   */
  const sellCapMicros =
    input.sellFeeAsset === "USDT"
      ? Math.floor(input.usdtMicros / (1 + input.feeBps / 10_000))
      : input.usdtMicros;

  const sellCaps: CapacityCap[] = [
    cap("depth", totalDepthMicros(bids), `${bids.length} سطح خرید در دفتر`),
    cap(
      "usdt_balance",
      sellCapMicros,
      `${microsToUsdt(input.usdtMicros)} تتر با کارمزد ${input.feeBps} bps در ${input.sellFeeAsset}` +
        (input.sellFeeAsset === "USDT"
          ? ` → ${microsToUsdt(sellCapMicros)} تتر قابل تحویل`
          : "")
    ),
    cap(
      "policy_order_size",
      input.policyOrderSizeMicros,
      input.policyOrderSizeMicros === null ? "تعیین‌نشده — اعمال نشد" : "سیاست حداکثر حجم سفارش"
    )
  ];

  return { ...base, buy: resolveSide(buyCaps), sell: resolveSide(sellCaps) };
}

/**
 * Capacity for an OTC dealer.
 *
 * The published maximum caps both sides; balances, the capital share and the
 * policy caps apply exactly as they do to a book venue. There is no depth cap
 * because there is no ladder — the quote's own maximum IS the depth statement.
 */
function quoteVenueCapacity(
  input: {
    irtToman: number | null;
    usdtMicros: number | null;
    feeBps: number | null;
    buyFeeAsset: string;
    sellFeeAsset: string;
    capitalShareToman: number | null;
    policyOrderSizeMicros: number | null;
    quote?: QuoteCapacityInput;
  },
  base: { sourceId: string; marketModel: string }
): VenueCapacity {
  if (!input.quote) {
    return {
      ...base,
      buy: sideUnavailable("quote_missing"),
      sell: sideUnavailable("quote_missing")
    };
  }
  const q = checkQuote(input.quote);
  if (!q.ok) {
    return { ...base, buy: sideUnavailable(q.reason), sell: sideUnavailable(q.reason) };
  }
  if (input.irtToman === null || input.usdtMicros === null) {
    return {
      ...base,
      buy: sideUnavailable("no_balance_record"),
      sell: sideUnavailable("no_balance_record")
    };
  }
  if (input.feeBps === null) {
    return {
      ...base,
      buy: sideUnavailable("no_confirmed_fee"),
      sell: sideUnavailable("no_confirmed_fee")
    };
  }

  const cap = (
    key: CapacityCap["key"],
    capUsdtMicros: number | null,
    detailFa: string
  ): CapacityCap => ({ key, labelFa: CAP_LABEL_FA[key], capUsdtMicros, detailFa });

  const buyPerUsdt =
    input.buyFeeAsset === "IRT" ? q.buyPriceToman * (1 + input.feeBps / 10_000) : q.buyPriceToman;
  const sellCapMicros =
    input.sellFeeAsset === "USDT"
      ? Math.floor(input.usdtMicros / (1 + input.feeBps / 10_000))
      : input.usdtMicros;

  const quoteDetail = `حداکثر اجراپذیر اعلام‌شدهٔ خودِ صرافی: ${microsToUsdt(q.maxMicros)} تتر (بدون دفتر سفارش)`;

  const buyCaps: CapacityCap[] = [
    cap("depth", q.maxMicros, quoteDetail),
    cap(
      "irt_balance",
      buyPerUsdt > 0 ? Math.floor((input.irtToman / buyPerUsdt) * USDT_MICROS) : 0,
      `${input.irtToman.toLocaleString("en-US")} تومان با کارمزد ${input.feeBps} bps در ${input.buyFeeAsset}`
    ),
    cap(
      "capital_share",
      input.capitalShareToman === null
        ? null
        : Math.floor((input.capitalShareToman / q.buyPriceToman) * USDT_MICROS),
      input.capitalShareToman === null
        ? "سهم طرح در دسترس نیست؛ اعمال نشد."
        : `${input.capitalShareToman.toLocaleString("en-US")} تومان`
    ),
    cap(
      "policy_order_size",
      input.policyOrderSizeMicros,
      input.policyOrderSizeMicros === null ? "تعیین‌نشده — اعمال نشد" : "سیاست حداکثر حجم سفارش"
    )
  ];

  const sellCaps: CapacityCap[] = [
    cap("depth", q.maxMicros, quoteDetail),
    cap(
      "usdt_balance",
      sellCapMicros,
      `${microsToUsdt(input.usdtMicros)} تتر با کارمزد ${input.feeBps} bps در ${input.sellFeeAsset}` +
        (input.sellFeeAsset === "USDT" ? ` → ${microsToUsdt(sellCapMicros)} تتر قابل تحویل` : "")
    ),
    cap(
      "policy_order_size",
      input.policyOrderSizeMicros,
      input.policyOrderSizeMicros === null ? "تعیین‌نشده — اعمال نشد" : "سیاست حداکثر حجم سفارش"
    )
  ];

  return { ...base, buy: resolveSide(buyCaps), sell: resolveSide(sellCaps) };
}
