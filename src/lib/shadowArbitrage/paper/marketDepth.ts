/**
 * Visible order-book volume for Exchange Status UI (v4.2.4).
 *
 * Buyer volume  = Σ quantity of every valid received Bid level.
 * Seller volume = Σ quantity of every valid received Ask level.
 * Toman         = Σ (priceToman × quantity) across all included levels.
 *
 * Independent of max_slippage_bps, Paper capital, balances, allocations,
 * order caps, risk limits, and executable capacity. Slippage-bounded depth
 * used by the trading/sizing engine lives elsewhere and is unchanged.
 *
 * Never fabricates values. Stale/missing/empty/malformed/crossed → ناموجود.
 * Quote-only venues → «دفتر سفارش چندسطحی ارائه نمی‌شود».
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
  /** Inclusive price range of included levels [min, max]. */
  acceptedPriceMin: number | null;
  acceptedPriceMax: number | null;
  /** Exact sum of all valid received level quantities (USDT). */
  depthUsdt: number | null;
  /** Exact Σ(priceToman × amountUsdt) across all included levels. */
  depthToman: number | null;
  /** Count of valid received levels included. */
  levelsAccepted: number | null;
  /**
   * Always 0 for visible volume (no slippage exclusion). Kept for API shape.
   */
  levelsExcluded: number | null;
  acceptedLevels: AcceptedDepthLevel[];
  /** Not applied to visible volume; retained for evidence only when known. */
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
  /** Bid book volume (all received bids). */
  bid: MarketDepthSide;
  /** Ask book volume (all received asks). */
  ask: MarketDepthSide;
  bookCrossed: boolean;
  /** UI label key for operator clarity. */
  displayKind: "visible_received_book";
};

const NA = "ناموجود";
export const QUOTE_ONLY_FA = "دفتر سفارش چندسطحی ارائه نمی‌شود";

function emptySide(
  reasonFa: string,
  maxSlippageBps: number | null = null
): MarketDepthSide {
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
 * Visible volume for one side of the book — every valid received level.
 * `side: "buy"` walks asks (seller volume); `side: "sell"` walks bids (buyer volume).
 * maxSlippageBps is ignored (not applied).
 */
export function computeVisibleBookVolumeSide(
  levels: BookLevel[] | null | undefined,
  side: BookSide,
  opts?: { forceUnavailableFa?: string | null; maxSlippageBps?: number | null }
): MarketDepthSide {
  const maxSlippageBps = opts?.maxSlippageBps ?? null;
  if (opts?.forceUnavailableFa) {
    return emptySide(opts.forceUnavailableFa, maxSlippageBps);
  }
  if (!levels || !levels.length) {
    return emptySide("دفتر سفارش خالی یا در دسترس نیست", maxSlippageBps);
  }

  const ordered = orderedLevels(levels, side);
  if (!ordered.length) {
    return emptySide("دفتر سفارش پس از مرتب‌سازی سطحی ندارد", maxSlippageBps);
  }

  const included: AcceptedDepthLevel[] = [];
  for (const l of ordered) {
    if (
      !Number.isFinite(l.priceToman) ||
      l.priceToman <= 0 ||
      !Number.isFinite(l.amountUsdt) ||
      l.amountUsdt < 0
    ) {
      return emptySide("دفتر سفارش ناقص یا نامعتبر است", maxSlippageBps);
    }
    included.push({ priceToman: l.priceToman, amountUsdt: l.amountUsdt });
  }

  let depthUsdt = 0;
  let depthToman = 0;
  for (const l of included) {
    depthUsdt += l.amountUsdt;
    depthToman += l.priceToman * l.amountUsdt;
  }

  const prices = included.map((l) => l.priceToman);
  return {
    bestPriceToman: ordered[0].priceToman,
    acceptedPriceMin: Math.min(...prices),
    acceptedPriceMax: Math.max(...prices),
    depthUsdt,
    depthToman,
    levelsAccepted: included.length,
    levelsExcluded: 0,
    acceptedLevels: included,
    maxSlippageBps,
    unavailable: false,
    unavailableFa: null
  };
}

/**
 * @deprecated Use computeVisibleBookVolumeSide. Kept name for call-site stability;
 * no longer applies max_slippage_bps.
 */
export function computeMarketDepthSide(
  levels: BookLevel[] | null | undefined,
  side: BookSide,
  maxSlippageBps: number | null,
  opts?: { forceUnavailableFa?: string | null }
): MarketDepthSide {
  return computeVisibleBookVolumeSide(levels, side, {
    forceUnavailableFa: opts?.forceUnavailableFa,
    maxSlippageBps
  });
}

export type BuildMarketDepthInput = {
  sourceId: string;
  marketModel: string;
  bookBids: BookLevel[] | null | undefined;
  bookAsks: BookLevel[] | null | undefined;
  /** Not used for visible volume; retained for evidence/API compatibility. */
  maxSlippageBps?: number | null;
  asOf: string;
  snapshotAgeMs?: number | null;
  stale?: boolean;
  sourceFailureFa?: string | null;
  maxQuoteAgeMs?: number | null;
};

/**
 * Build Bid + Ask visible received-book volume for one venue.
 * Never reuses another venue's book or shared values.
 */
export function buildMarketDepthCard(input: BuildMarketDepthInput): MarketDepthCard {
  const maxSlip = input.maxSlippageBps ?? null;
  let forceFa: string | null = null;

  if (input.marketModel === "OTC_QUOTE") {
    forceFa = QUOTE_ONLY_FA;
  } else if (input.stale) {
    forceFa = "دادهٔ بازار کهنه است — حجم دفتر ناموجود";
  } else if (
    input.maxQuoteAgeMs != null &&
    input.snapshotAgeMs != null &&
    Number.isFinite(input.maxQuoteAgeMs) &&
    Number.isFinite(input.snapshotAgeMs) &&
    input.snapshotAgeMs > input.maxQuoteAgeMs
  ) {
    forceFa = "سن اسنپ‌شات از سقف مجاز گذشته — حجم دفتر ناموجود";
  } else if (input.sourceFailureFa) {
    forceFa = `خطای منبع: ${input.sourceFailureFa}`;
  } else if (!input.bookBids || !input.bookAsks) {
    forceFa = "دفتر سفارش (دو طرف) در این چرخه موجود نیست";
  }

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
      forceFa = "دفتر متقاطع است (بهترین خرید بالاتر از بهترین فروش) — حجم دفتر ناموجود";
    }
  }

  const bid = computeVisibleBookVolumeSide(input.bookBids, "sell", {
    forceUnavailableFa: forceFa,
    maxSlippageBps: maxSlip
  });
  const ask = computeVisibleBookVolumeSide(input.bookAsks, "buy", {
    forceUnavailableFa: forceFa,
    maxSlippageBps: maxSlip
  });

  return {
    sourceId: input.sourceId,
    marketModel: input.marketModel,
    asOf: input.asOf,
    snapshotAgeMs: input.snapshotAgeMs ?? null,
    maxSlippageBps: maxSlip,
    bid,
    ask,
    bookCrossed,
    displayKind: "visible_received_book"
  };
}

/** Recompute totals from levels — independent evidence check. */
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
export const VISIBLE_BOOK_VOLUME_LABEL_FA = "حجم قابل‌مشاهده در دفتر سفارش دریافتی";
