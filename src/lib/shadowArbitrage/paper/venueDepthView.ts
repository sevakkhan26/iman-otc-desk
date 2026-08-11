/**
 * Per-venue market-depth card model for «سرمایه و حساب» / Exchange Status.
 *
 * Separates four facts that must never be conflated:
 *   موجودی          — Paper balances (not depth)
 *   عمق بازار       — order-book liquidity inside the admin slippage window
 *                     (rawDepthUsdt / rawDepthToman — pure market depth)
 *   ظرفیت قابل استفاده — min(depth, balance, policies) from venueCapacity()
 *   حجم پیشنهادی    — SMART_CAPITAL_DEPTH route size when present
 *
 * Pure: no network, no database, no clock. Uses the same cycle's book levels
 * the caller already holds — never re-fetches.
 *
 * v4.2.3: rawDepth* is pure market depth (Σ qty / Σ price×qty), independent of
 * capital, balances, allocations, order caps. UI must not display usableCapacity
 * as "depth".
 */
import type { BookLevel } from "@/lib/shadowArbitrage/types";
import {
  CAP_LABEL_FA,
  microsToUsdt,
  orderedLevels,
  usdtToMicros,
  venueCapacity,
  walkBook,
  type VenueCapacity,
  type VenueCapacityReason
} from "@/lib/shadowArbitrage/paper/liquidity";
import {
  buildMarketDepthCard,
  type AcceptedDepthLevel,
  type MarketDepthSide
} from "@/lib/shadowArbitrage/paper/marketDepth";

export type SideDepthView = {
  bestPriceToman: number | null;
  /**
   * Pure market depth inside max_slippage_bps (USDT = exact Σ quantities).
   * Never capital- or policy-capped.
   */
  rawDepthUsdt: number | null;
  /**
   * Exact Σ(priceToman × amountUsdt) of accepted levels — not USDT × best.
   */
  rawDepthToman: number | null;
  levelsAccepted: number | null;
  levelsExcluded: number | null;
  /** Accepted price band [min, max] inside the slippage window. */
  acceptedPriceMin?: number | null;
  acceptedPriceMax?: number | null;
  /** Levels that contributed to market depth (evidence / audit). */
  acceptedLevels?: AcceptedDepthLevel[];
  /** VWAP if the recommended smart size were walked; null when size/depth missing. */
  smartSizeVwapToman: number | null;
  /** Usable capacity after depth + balance + policies. Not market depth. */
  usableCapacityUsdt: number | null;
  usableCapacityToman: number | null;
  limitingKey: string | null;
  limitingLabelFa: string | null;
  reasonFa: string | null;
  /** True when market depth is genuinely unavailable (not zero liquidity). */
  unavailable: boolean;
  unavailableFa: string | null;
};

export type VenueDepthCard = {
  sourceId: string;
  nameFa: string | null;
  marketModel: string;
  asOf: string;
  snapshotAgeMs: number | null;
  /**
   * buy = Ask depth (user buys from asks);
   * sell = Bid depth (user sells into bids).
   */
  buy: SideDepthView;
  sell: SideDepthView;
  /** SMART_CAPITAL_DEPTH recommendation touching this venue, if any. */
  smartRecommendedUsdt: number | null;
  smartRouteKey: string | null;
  smartBindingConstraint: string | null;
  /** True when best bid > best ask — market depth is ناموجود. */
  bookCrossed?: boolean;
};

export type VenueDepthInput = {
  sourceId: string;
  nameFa?: string | null;
  marketModel: string;
  bookBids: BookLevel[] | null;
  bookAsks: BookLevel[] | null;
  irtToman: number | null;
  usdtMicros: number | null;
  feeBps: number | null;
  buyFeeAsset: string;
  sellFeeAsset: string;
  capitalShareToman: number | null;
  policyOrderSizeMicros: number | null;
  policyExposureMicros: number | null;
  maxSlippageBps: number | null;
  markPriceToman: number | null;
  sourceFailureFa?: string | null;
  stale?: boolean;
  maxQuoteAgeMs?: number | null;
  quote?: {
    userBuyPriceToman: number | null;
    userSellPriceToman: number | null;
    maxExecutableUsdt: number | null;
    ageMs: number | null;
    stale: boolean;
    maxQuoteAgeMs: number | null;
  };
  /** Recommended smart size that involves this venue (route-level). */
  smartRecommendedUsdt?: number | null;
  smartRouteKey?: string | null;
  smartBindingConstraint?: string | null;
  asOf: string;
  snapshotAgeMs?: number | null;
};

function emptySide(unavailableFa: string): SideDepthView {
  return {
    bestPriceToman: null,
    rawDepthUsdt: null,
    rawDepthToman: null,
    levelsAccepted: null,
    levelsExcluded: null,
    acceptedPriceMin: null,
    acceptedPriceMax: null,
    acceptedLevels: [],
    smartSizeVwapToman: null,
    usableCapacityUsdt: null,
    usableCapacityToman: null,
    limitingKey: null,
    limitingLabelFa: null,
    reasonFa: unavailableFa,
    unavailable: true,
    unavailableFa
  };
}

function marketToSide(
  market: MarketDepthSide,
  capacity: VenueCapacity["buy"] | VenueCapacity["sell"],
  levels: BookLevel[] | null | undefined,
  side: "buy" | "sell",
  smartSizeUsdt: number | null,
  markPriceToman: number | null
): SideDepthView {
  let smartSizeVwapToman: number | null = null;
  if (smartSizeUsdt !== null && smartSizeUsdt > 0 && levels?.length) {
    const walk = walkBook(levels, usdtToMicros(smartSizeUsdt), side);
    smartSizeVwapToman = walk.filledMicros > 0 ? walk.vwapToman : null;
  }

  const usableMicros = capacity.capacityUsdtMicros;
  const usableUsdt = usableMicros === null ? null : microsToUsdt(usableMicros);
  const priceForToman = market.bestPriceToman ?? markPriceToman;
  const usableToman =
    usableUsdt === null || priceForToman === null || priceForToman <= 0
      ? null
      : Math.round(usableUsdt * priceForToman);

  // Market-depth unavailability is independent of capacity.
  return {
    bestPriceToman: market.bestPriceToman,
    rawDepthUsdt: market.depthUsdt,
    rawDepthToman: market.depthToman,
    levelsAccepted: market.levelsAccepted,
    levelsExcluded: market.levelsExcluded,
    acceptedPriceMin: market.acceptedPriceMin,
    acceptedPriceMax: market.acceptedPriceMax,
    acceptedLevels: market.acceptedLevels,
    smartSizeVwapToman,
    usableCapacityUsdt: usableUsdt,
    usableCapacityToman: usableToman,
    limitingKey: capacity.limitingCap,
    limitingLabelFa: capacity.limitingCap ? CAP_LABEL_FA[capacity.limitingCap] : null,
    reasonFa: market.unavailable ? market.unavailableFa : capacity.reasonFa,
    unavailable: market.unavailable,
    unavailableFa: market.unavailableFa
  };
}

/**
 * Build one venue's depth/capacity view from a single cycle snapshot.
 * Market depth (rawDepth*) is pure book depth; usableCapacity* is separate.
 */
export function buildVenueDepthCard(input: VenueDepthInput): VenueDepthCard {
  const cap = venueCapacity({
    sourceId: input.sourceId,
    marketModel: input.marketModel,
    bookBids: input.bookBids,
    bookAsks: input.bookAsks,
    irtToman: input.irtToman,
    usdtMicros: input.usdtMicros,
    feeBps: input.feeBps,
    buyFeeAsset: input.buyFeeAsset,
    sellFeeAsset: input.sellFeeAsset,
    capitalShareToman: input.capitalShareToman,
    policyOrderSizeMicros: input.policyOrderSizeMicros,
    policyExposureMicros: input.policyExposureMicros,
    quote: input.quote
      ? {
          userBuyPriceToman: input.quote.userBuyPriceToman,
          userSellPriceToman: input.quote.userSellPriceToman,
          maxExecutableUsdt: input.quote.maxExecutableUsdt,
          ageMs: input.quote.ageMs ?? 0,
          stale: input.quote.stale,
          maxQuoteAgeMs: input.quote.maxQuoteAgeMs
        }
      : undefined,
    sourceFailureFa: input.sourceFailureFa
  });

  const smart = input.smartRecommendedUsdt ?? null;
  const stale = Boolean(input.stale || input.quote?.stale);
  const maxQuoteAgeMs = input.maxQuoteAgeMs ?? input.quote?.maxQuoteAgeMs ?? null;
  const snapshotAgeMs = input.snapshotAgeMs ?? input.quote?.ageMs ?? null;

  const market = buildMarketDepthCard({
    sourceId: input.sourceId,
    marketModel: input.marketModel,
    bookBids: input.bookBids,
    bookAsks: input.bookAsks,
    maxSlippageBps: input.maxSlippageBps,
    asOf: input.asOf,
    snapshotAgeMs,
    stale,
    sourceFailureFa: input.sourceFailureFa,
    maxQuoteAgeMs
  });

  if (input.marketModel === "OTC_QUOTE") {
    // Market depth is unavailable for OTC quotes; capacity may still be set.
    const q = input.quote;
    const buyUsable =
      cap.buy.capacityUsdtMicros === null ? null : microsToUsdt(cap.buy.capacityUsdtMicros);
    const sellUsable =
      cap.sell.capacityUsdtMicros === null ? null : microsToUsdt(cap.sell.capacityUsdtMicros);
    const buyPrice = q?.userBuyPriceToman ?? null;
    const sellPrice = q?.userSellPriceToman ?? null;
    const na = market.ask.unavailableFa ?? "عمق بازار دفتر برای نقل‌قول تک‌قیمتی ناموجود است";
    const buySide: SideDepthView = {
      ...emptySide(na),
      bestPriceToman: buyPrice,
      smartSizeVwapToman: buyPrice,
      usableCapacityUsdt: buyUsable,
      usableCapacityToman:
        buyUsable !== null && buyPrice !== null ? Math.round(buyUsable * buyPrice) : null,
      limitingKey: cap.buy.limitingCap,
      limitingLabelFa: cap.buy.limitingCap ? CAP_LABEL_FA[cap.buy.limitingCap] : null,
      reasonFa: cap.buy.reasonFa
    };
    const sellSide: SideDepthView = {
      ...emptySide(na),
      bestPriceToman: sellPrice,
      smartSizeVwapToman: sellPrice,
      usableCapacityUsdt: sellUsable,
      usableCapacityToman:
        sellUsable !== null && sellPrice !== null ? Math.round(sellUsable * sellPrice) : null,
      limitingKey: cap.sell.limitingCap,
      limitingLabelFa: cap.sell.limitingCap ? CAP_LABEL_FA[cap.sell.limitingCap] : null,
      reasonFa: cap.sell.reasonFa
    };
    return {
      sourceId: input.sourceId,
      nameFa: input.nameFa ?? null,
      marketModel: input.marketModel,
      asOf: input.asOf,
      snapshotAgeMs: snapshotAgeMs,
      buy: buySide,
      sell: sellSide,
      smartRecommendedUsdt: smart,
      smartRouteKey: input.smartRouteKey ?? null,
      smartBindingConstraint: input.smartBindingConstraint ?? null,
      bookCrossed: market.bookCrossed
    };
  }

  return {
    sourceId: input.sourceId,
    nameFa: input.nameFa ?? null,
    marketModel: input.marketModel,
    asOf: input.asOf,
    snapshotAgeMs: snapshotAgeMs,
    // buy view = Ask market depth; sell view = Bid market depth
    buy: marketToSide(
      market.ask,
      cap.buy,
      input.bookAsks,
      "buy",
      smart,
      input.markPriceToman
    ),
    sell: marketToSide(
      market.bid,
      cap.sell,
      input.bookBids,
      "sell",
      smart,
      input.markPriceToman
    ),
    smartRecommendedUsdt: smart,
    smartRouteKey: input.smartRouteKey ?? null,
    smartBindingConstraint: input.smartBindingConstraint ?? null,
    bookCrossed: market.bookCrossed
  };
}

/** Best price helpers for tests — buy walks asks, sell walks bids. */
export function bestAskToman(asks: BookLevel[]): number | null {
  const o = orderedLevels(asks, "buy");
  return o[0]?.priceToman ?? null;
}

export function bestBidToman(bids: BookLevel[]): number | null {
  const o = orderedLevels(bids, "sell");
  return o[0]?.priceToman ?? null;
}

export type { VenueCapacityReason };
