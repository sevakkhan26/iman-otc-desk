/**
 * Per-venue market-depth card model for «سرمایه و حساب».
 *
 * Separates four facts that must never be conflated:
 *   موجودی          — Paper balances (not depth)
 *   عمق بازار       — order-book liquidity inside the admin slippage window
 *   ظرفیت قابل استفاده — min(depth, balance, policies) from venueCapacity()
 *   حجم پیشنهادی    — SMART_CAPITAL_DEPTH route size when present
 *
 * Pure: no network, no database, no clock. Uses the same cycle's book levels
 * the caller already holds — never re-fetches.
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
import { slippageBoundedDepth } from "@/lib/shadowArbitrage/paper/smartCandidates";

export type SideDepthView = {
  bestPriceToman: number | null;
  /** Depth inside the active slippage window, USDT. */
  rawDepthUsdt: number | null;
  rawDepthToman: number | null;
  levelsAccepted: number | null;
  levelsExcluded: number | null;
  /** VWAP if the recommended smart size were walked; null when size/depth missing. */
  smartSizeVwapToman: number | null;
  /** Usable capacity after depth + balance + policies. Null = not computable. */
  usableCapacityUsdt: number | null;
  usableCapacityToman: number | null;
  limitingKey: string | null;
  limitingLabelFa: string | null;
  reasonFa: string | null;
  /** True when values are genuinely unavailable (not zero liquidity). */
  unavailable: boolean;
  unavailableFa: string | null;
};

export type VenueDepthCard = {
  sourceId: string;
  nameFa: string | null;
  marketModel: string;
  asOf: string;
  snapshotAgeMs: number | null;
  buy: SideDepthView;
  sell: SideDepthView;
  /** SMART_CAPITAL_DEPTH recommendation touching this venue, if any. */
  smartRecommendedUsdt: number | null;
  smartRouteKey: string | null;
  smartBindingConstraint: string | null;
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

function sideFromBook(input: {
  levels: BookLevel[];
  side: "buy" | "sell";
  maxSlippageBps: number;
  capacity: VenueCapacity["buy"];
  smartSizeUsdt: number | null;
  markPriceToman: number | null;
}): SideDepthView {
  const { levels, side, maxSlippageBps, capacity, smartSizeUsdt, markPriceToman } = input;
  const bounded = slippageBoundedDepth(levels, side, maxSlippageBps);
  const best = bounded.bestPriceToman;
  const rawDepthUsdt =
    bounded.levelsIncluded > 0 ? microsToUsdt(bounded.depthMicros) : 0;
  const rawDepthToman =
    best !== null && bounded.depthMicros > 0
      ? Math.round(microsToUsdt(bounded.depthMicros) * best)
      : best !== null
        ? 0
        : null;

  let smartSizeVwapToman: number | null = null;
  if (smartSizeUsdt !== null && smartSizeUsdt > 0 && levels.length) {
    const walk = walkBook(levels, usdtToMicros(smartSizeUsdt), side);
    smartSizeVwapToman = walk.filledMicros > 0 ? walk.vwapToman : null;
  }

  const usableMicros = capacity.capacityUsdtMicros;
  const usableUsdt = usableMicros === null ? null : microsToUsdt(usableMicros);
  const priceForToman = best ?? markPriceToman;
  const usableToman =
    usableUsdt === null || priceForToman === null || priceForToman <= 0
      ? null
      : Math.round(usableUsdt * priceForToman);

  const unavailable = usableMicros === null && capacity.reason !== "ok" && capacity.reason !== "zero_balance";

  return {
    bestPriceToman: best,
    rawDepthUsdt: bounded.bestPriceToman === null ? null : rawDepthUsdt,
    rawDepthToman,
    levelsAccepted: bounded.bestPriceToman === null ? null : bounded.levelsIncluded,
    levelsExcluded: bounded.bestPriceToman === null ? null : bounded.levelsExcluded,
    smartSizeVwapToman,
    usableCapacityUsdt: usableUsdt,
    usableCapacityToman: usableToman,
    limitingKey: capacity.limitingCap,
    limitingLabelFa: capacity.limitingCap ? CAP_LABEL_FA[capacity.limitingCap] : null,
    reasonFa: capacity.reasonFa,
    unavailable: unavailable || bounded.bestPriceToman === null,
    unavailableFa:
      bounded.bestPriceToman === null
        ? capacity.reasonFa || "عمق دفتر قابل محاسبه نیست"
        : unavailable
          ? capacity.reasonFa
          : null
  };
}

/**
 * Build one venue's depth/capacity view from a single cycle snapshot.
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

  const maxSlip =
    input.maxSlippageBps !== null && Number.isFinite(input.maxSlippageBps)
      ? input.maxSlippageBps
      : Number.POSITIVE_INFINITY;

  const smart = input.smartRecommendedUsdt ?? null;

  if (input.marketModel === "OTC_QUOTE") {
    const q = input.quote;
    const quoteDetail =
      "این منبع نقل‌قول تک‌قیمتی است و اساساً دفتر سفارش چندسطحی ندارد؛ ظرفیت از حداکثر اعلام‌شدهٔ خودِ صرافی است.";
    const buyUsable =
      cap.buy.capacityUsdtMicros === null ? null : microsToUsdt(cap.buy.capacityUsdtMicros);
    const sellUsable =
      cap.sell.capacityUsdtMicros === null ? null : microsToUsdt(cap.sell.capacityUsdtMicros);
    const buyPrice = q?.userBuyPriceToman ?? null;
    const sellPrice = q?.userSellPriceToman ?? null;
    const maxUsdt = q?.maxExecutableUsdt ?? null;
    const buySide: SideDepthView = {
      bestPriceToman: buyPrice,
      rawDepthUsdt: maxUsdt,
      rawDepthToman:
        maxUsdt !== null && buyPrice !== null ? Math.round(maxUsdt * buyPrice) : null,
      levelsAccepted: null,
      levelsExcluded: null,
      smartSizeVwapToman: buyPrice,
      usableCapacityUsdt: buyUsable,
      usableCapacityToman:
        buyUsable !== null && buyPrice !== null ? Math.round(buyUsable * buyPrice) : null,
      limitingKey: cap.buy.limitingCap,
      limitingLabelFa: cap.buy.limitingCap ? CAP_LABEL_FA[cap.buy.limitingCap] : null,
      reasonFa: cap.buy.reasonFa,
      unavailable: maxUsdt === null && buyUsable === null,
      unavailableFa: maxUsdt === null ? quoteDetail : null
    };
    const sellSide: SideDepthView = {
      bestPriceToman: sellPrice,
      rawDepthUsdt: maxUsdt,
      rawDepthToman:
        maxUsdt !== null && sellPrice !== null ? Math.round(maxUsdt * sellPrice) : null,
      levelsAccepted: null,
      levelsExcluded: null,
      smartSizeVwapToman: sellPrice,
      usableCapacityUsdt: sellUsable,
      usableCapacityToman:
        sellUsable !== null && sellPrice !== null ? Math.round(sellUsable * sellPrice) : null,
      limitingKey: cap.sell.limitingCap,
      limitingLabelFa: cap.sell.limitingCap ? CAP_LABEL_FA[cap.sell.limitingCap] : null,
      reasonFa: cap.sell.reasonFa,
      unavailable: maxUsdt === null && sellUsable === null,
      unavailableFa: maxUsdt === null ? quoteDetail : null
    };
    return {
      sourceId: input.sourceId,
      nameFa: input.nameFa ?? null,
      marketModel: input.marketModel,
      asOf: input.asOf,
      snapshotAgeMs: input.snapshotAgeMs ?? q?.ageMs ?? null,
      buy: buySide,
      sell: sellSide,
      smartRecommendedUsdt: smart,
      smartRouteKey: input.smartRouteKey ?? null,
      smartBindingConstraint: input.smartBindingConstraint ?? null
    };
  }

  if (!input.bookAsks || !input.bookBids) {
    const reason = cap.buy.reasonFa || "دفتر سفارش در دسترس نیست";
    return {
      sourceId: input.sourceId,
      nameFa: input.nameFa ?? null,
      marketModel: input.marketModel,
      asOf: input.asOf,
      snapshotAgeMs: input.snapshotAgeMs ?? null,
      buy: emptySide(reason),
      sell: emptySide(reason),
      smartRecommendedUsdt: smart,
      smartRouteKey: input.smartRouteKey ?? null,
      smartBindingConstraint: input.smartBindingConstraint ?? null
    };
  }

  return {
    sourceId: input.sourceId,
    nameFa: input.nameFa ?? null,
    marketModel: input.marketModel,
    asOf: input.asOf,
    snapshotAgeMs: input.snapshotAgeMs ?? null,
    buy: sideFromBook({
      levels: input.bookAsks,
      side: "buy",
      maxSlippageBps: maxSlip,
      capacity: cap.buy,
      smartSizeUsdt: smart,
      markPriceToman: input.markPriceToman
    }),
    sell: sideFromBook({
      levels: input.bookBids,
      side: "sell",
      maxSlippageBps: maxSlip,
      capacity: cap.sell,
      smartSizeUsdt: smart,
      markPriceToman: input.markPriceToman
    }),
    smartRecommendedUsdt: smart,
    smartRouteKey: input.smartRouteKey ?? null,
    smartBindingConstraint: input.smartBindingConstraint ?? null
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
