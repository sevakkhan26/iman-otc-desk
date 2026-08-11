/**
 * Pure market-depth (order-book) projection for Exchange Status UI.
 *
 * Independent of Paper capital, balances, allocations, order caps, and risk
 * limits. Executable capacity remains in liquidity/venueCapacity — this module
 * never consults them.
 *
 * Definitions (user-facing Bid/Ask):
 *   Bid depth  = sum of bid quantities within max_slippage_bps below best bid
 *   Ask depth  = sum of ask quantities within max_slippage_bps above best ask
 *
 * USDT  = Σ amountUsdt of accepted levels
 * Toman = Σ (priceToman × amountUsdt) of accepted levels  (NOT USDT × best)
 */
import type { BookLevel } from "@/lib/shadowArbitrage/types";
import { orderedLevels, type BookSide } from "@/lib/shadowArbitrage/paper/liquidity";

export type AcceptedDepthLevel = {
  priceToman: number;
  amountUsdt: number;
};

export type MarketDepthSide = {
  /** Best bid (sell walk) or best ask (buy walk). */
  bestPriceToman: number | null;
  /** Inclusive price range of accepted levels [min, max]. */
  acceptedPriceMin: number | null;
  acceptedPriceMax: number | null;
  /** Exact sum of accepted level quantities (USDT). */
  depthUsdt: number | null;
  /** Exact Σ(priceToman × amountUsdt) across accepted levels. */
  depthToman: number | null;
  levelsAccepted: number | null;
  levelsExcluded: number | null;
  acceptedLevels: AcceptedDepthLevel[];
  maxSlippageBps: number | null;
  unavailable: boolean;
  unavailableFa: string | null;
};

export type MarketDepthCard = {
  sourceId: string;
  marketModel: string;
  asOf: string;
  snapshotAgeMs: number | null;
  maxSlippageBps: number | null;
  /** Bid book depth (user sells into bids). */
  bid: MarketDepthSide;
  /** Ask book depth (user buys from asks). */
  ask: MarketDepthSide;
  bookCrossed: boolean;
};

const NA = "ناموجود";

function emptySide(reasonFa: string, maxSlippageBps: number | null): MarketDepthSide {
  return {
    bestPriceToman: null,
    acceptedPriceMin: null,
    acceptedPriceMax: null,
    depthUsdt: null,
    depthToman: null,
    levelsAccepted: null,
    levelsExcluded: null,
    acceptedLevels: [],
    maxSlippageBps,
    unavailable: true,
    unavailableFa: reasonFa
  };
}

/**
 * Slippage-window market depth for one side of the book.
 * `side: "buy"` walks asks (Ask depth); `side: "sell"` walks bids (Bid depth).
 */
export function computeMarketDepthSide(
  levels: BookLevel[] | null | undefined,
  side: BookSide,
  maxSlippageBps: number | null,
  opts?: { forceUnavailableFa?: string | null }
): MarketDepthSide {
  if (opts?.forceUnavailableFa) {
    return emptySide(opts.forceUnavailableFa, maxSlippageBps);
  }
  if (maxSlippageBps === null || !Number.isFinite(maxSlippageBps) || maxSlippageBps < 0) {
    return emptySide("سقف لغزش (max_slippage_bps) برای محاسبهٔ عمق بازار تنظیم نشده", null);
  }
  if (!levels || !levels.length) {
    return emptySide("دفتر سفارش خالی یا در دسترس نیست", maxSlippageBps);
  }

  const ordered = orderedLevels(levels, side);
  if (!ordered.length) {
    return emptySide("دفتر سفارش پس از مرتب‌سازی سطحی ندارد", maxSlippageBps);
  }

  // Malformed prices/quantities → fail closed
  for (const l of ordered) {
    if (
      !Number.isFinite(l.priceToman) ||
      l.priceToman <= 0 ||
      !Number.isFinite(l.amountUsdt) ||
      l.amountUsdt < 0
    ) {
      return emptySide("دفتر سفارش ناقص یا نامعتبر است", maxSlippageBps);
    }
  }

  const best = ordered[0].priceToman;
  const accepted: AcceptedDepthLevel[] = [];
  let excluded = 0;

  for (const level of ordered) {
    const deviationBps =
      side === "buy"
        ? ((level.priceToman - best) / best) * 10_000
        : ((best - level.priceToman) / best) * 10_000;
    if (deviationBps > maxSlippageBps) {
      excluded = ordered.length - accepted.length;
      break;
    }
    accepted.push({ priceToman: level.priceToman, amountUsdt: level.amountUsdt });
  }
  if (accepted.length === 0) {
    return emptySide("هیچ سطحی داخل پنجرهٔ لغزش نیست", maxSlippageBps);
  }
  if (excluded === 0 && accepted.length < ordered.length) {
    excluded = ordered.length - accepted.length;
  }

  // Exact sums — no best-price shortcut for toman.
  let depthUsdt = 0;
  let depthToman = 0;
  for (const l of accepted) {
    depthUsdt += l.amountUsdt;
    depthToman += l.priceToman * l.amountUsdt;
  }

  const prices = accepted.map((l) => l.priceToman);
  return {
    bestPriceToman: best,
    acceptedPriceMin: Math.min(...prices),
    acceptedPriceMax: Math.max(...prices),
    depthUsdt,
    depthToman,
    levelsAccepted: accepted.length,
    levelsExcluded: excluded,
    acceptedLevels: accepted,
    maxSlippageBps,
    unavailable: false,
    unavailableFa: null
  };
}

export type BuildMarketDepthInput = {
  sourceId: string;
  marketModel: string;
  bookBids: BookLevel[] | null | undefined;
  bookAsks: BookLevel[] | null | undefined;
  maxSlippageBps: number | null;
  asOf: string;
  snapshotAgeMs?: number | null;
  /** When true (stale snapshot), both sides are ناموجود. */
  stale?: boolean;
  sourceFailureFa?: string | null;
  /** Optional max age; if snapshotAgeMs exceeds it, fail closed. */
  maxQuoteAgeMs?: number | null;
};

/**
 * Build Bid + Ask pure market depth for one venue from its own book.
 * Never reuses another venue's book or shared values.
 */
export function buildMarketDepthCard(input: BuildMarketDepthInput): MarketDepthCard {
  const maxSlip = input.maxSlippageBps;
  let forceFa: string | null = null;

  if (input.marketModel === "OTC_QUOTE") {
    forceFa =
      "این منبع نقل‌قول تک‌قیمتی است و دفتر سفارش چندسطحی ندارد — عمق بازار ناموجود";
  } else if (input.stale) {
    forceFa = "دادهٔ بازار کهنه است — عمق بازار ناموجود";
  } else if (
    input.maxQuoteAgeMs != null &&
    input.snapshotAgeMs != null &&
    Number.isFinite(input.maxQuoteAgeMs) &&
    Number.isFinite(input.snapshotAgeMs) &&
    input.snapshotAgeMs > input.maxQuoteAgeMs
  ) {
    forceFa = "سن اسنپ‌شات از سقف مجاز گذشته — عمق بازار ناموجود";
  } else if (input.sourceFailureFa) {
    forceFa = `خطای منبع: ${input.sourceFailureFa}`;
  } else if (!input.bookBids || !input.bookAsks) {
    forceFa = "دفتر سفارش (دو طرف) در این چرخه موجود نیست";
  }

  // Crossed book: best bid > best ask
  let bookCrossed = false;
  if (!forceFa && input.bookBids?.length && input.bookAsks?.length) {
    const bidOrdered = orderedLevels(input.bookBids, "sell");
    const askOrdered = orderedLevels(input.bookAsks, "buy");
    const bestBid = bidOrdered[0]?.priceToman ?? null;
    const bestAsk = askOrdered[0]?.priceToman ?? null;
    if (
      bestBid !== null &&
      bestAsk !== null &&
      Number.isFinite(bestBid) &&
      Number.isFinite(bestAsk) &&
      bestBid > bestAsk
    ) {
      bookCrossed = true;
      forceFa = "دفتر متقاطع است (بهترین خرید بالاتر از بهترین فروش) — عمق بازار ناموجود";
    }
  }

  const bid = computeMarketDepthSide(input.bookBids, "sell", maxSlip, {
    forceUnavailableFa: forceFa
  });
  const ask = computeMarketDepthSide(input.bookAsks, "buy", maxSlip, {
    forceUnavailableFa: forceFa
  });

  return {
    sourceId: input.sourceId,
    marketModel: input.marketModel,
    asOf: input.asOf,
    snapshotAgeMs: input.snapshotAgeMs ?? null,
    maxSlippageBps: maxSlip,
    bid,
    ask,
    bookCrossed
  };
}

/** Recompute depth totals from accepted levels — for independent evidence checks. */
export function recomputeDepthTotals(levels: AcceptedDepthLevel[]): {
  depthUsdt: number;
  depthToman: number;
} {
  let depthUsdt = 0;
  let depthToman = 0;
  for (const l of levels) {
    depthUsdt += l.amountUsdt;
    depthToman += l.priceToman * l.amountUsdt;
  }
  return { depthUsdt, depthToman };
}

export const MARKET_DEPTH_NA_FA = NA;
