/**
 * Market bubble pure math (Dirham↔Dollar, Gold Mazane vs international ounce).
 * Multiplier and conversion constants are fixed by desk policy — do not alter silently.
 */

/** Exact UAE Dirham → USD free-market conversion factor. */
export const DIRHAM_TO_USD_MULTIPLIER = 3.6725;

/** Troy ounce mass used for global gold kg conversion. */
export const GOLD_OUNCE_GRAMS = 31.104;

/** Mazane (مثقال) → one gram 18K (desk spreadsheet factor). */
export const MAZANE_TO_GRAM18 = 4.3318;

/** Grams of 18K per kg of pure gold (desk spreadsheet factor). */
export const GRAM18_PER_PURE_KG = 1333.2;

/** |percent| below this is treated as near-zero alignment. */
export const NEAR_ZERO_BUBBLE_PERCENT = 0.15;

export type BubbleSign = "positive" | "negative" | "near_zero";

export function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** realDollarToman = dirhamToman × 3.6725 */
export function realDollarFromDirham(dirhamToman: number): number | null {
  if (!isFinitePositive(dirhamToman)) return null;
  const real = dirhamToman * DIRHAM_TO_USD_MULTIPLIER;
  return Number.isFinite(real) && real > 0 ? real : null;
}

export function dollarBubbleToman(marketDollarToman: number, realDollarToman: number): number | null {
  if (!isFinitePositive(marketDollarToman) || !isFinitePositive(realDollarToman)) return null;
  const bubble = marketDollarToman - realDollarToman;
  return Number.isFinite(bubble) ? bubble : null;
}

export function dollarBubblePercent(bubbleToman: number, realDollarToman: number): number | null {
  if (!Number.isFinite(bubbleToman) || !isFinitePositive(realDollarToman)) return null;
  const pct = (bubbleToman / realDollarToman) * 100;
  return Number.isFinite(pct) ? pct : null;
}

/**
 * International pure-gold kilogram in USD:
 * globalGoldKgUsd = (ounceUsd × 1000) / 31.104
 */
export function globalGoldKgUsd(ounceUsd: number): number | null {
  if (!isFinitePositive(ounceUsd)) return null;
  const kg = (ounceUsd * 1000) / GOLD_OUNCE_GRAMS;
  return Number.isFinite(kg) && kg > 0 ? kg : null;
}

export function globalGoldKgToman(globalGoldKgUsdValue: number, realDollarToman: number): number | null {
  if (!isFinitePositive(globalGoldKgUsdValue) || !isFinitePositive(realDollarToman)) return null;
  const t = globalGoldKgUsdValue * realDollarToman;
  return Number.isFinite(t) && t > 0 ? t : null;
}

/** gram18Toman = mazaneToman / 4.3318 */
export function gram18FromMazane(mazaneToman: number): number | null {
  if (!isFinitePositive(mazaneToman)) return null;
  const g = mazaneToman / MAZANE_TO_GRAM18;
  return Number.isFinite(g) && g > 0 ? g : null;
}

/** localPureGoldKgToman = gram18Toman × 1333.2 */
export function localPureGoldKgFromGram18(gram18Toman: number): number | null {
  if (!isFinitePositive(gram18Toman)) return null;
  const kg = gram18Toman * GRAM18_PER_PURE_KG;
  return Number.isFinite(kg) && kg > 0 ? kg : null;
}

export function goldBubbleTomanPerKg(localKg: number, globalKg: number): number | null {
  if (!isFinitePositive(localKg) || !isFinitePositive(globalKg)) return null;
  const b = localKg - globalKg;
  return Number.isFinite(b) ? b : null;
}

export function goldBubbleUsdPerKg(bubbleToman: number, realDollarToman: number): number | null {
  if (!Number.isFinite(bubbleToman) || !isFinitePositive(realDollarToman)) return null;
  const u = bubbleToman / realDollarToman;
  return Number.isFinite(u) ? u : null;
}

export function goldBubblePercent(bubbleToman: number, globalKgToman: number): number | null {
  if (!Number.isFinite(bubbleToman) || !isFinitePositive(globalKgToman)) return null;
  const pct = (bubbleToman / globalKgToman) * 100;
  return Number.isFinite(pct) ? pct : null;
}

/** equivalentGram18Bubble = goldBubbleTomanPerKg / gram18Toman */
export function equivalentGram18Bubble(bubbleTomanPerKg: number, gram18Toman: number): number | null {
  if (!Number.isFinite(bubbleTomanPerKg) || !isFinitePositive(gram18Toman)) return null;
  const eq = bubbleTomanPerKg / gram18Toman;
  return Number.isFinite(eq) ? eq : null;
}

export function classifyBubble(percent: number | null): BubbleSign | null {
  if (percent === null || !Number.isFinite(percent)) return null;
  if (Math.abs(percent) < NEAR_ZERO_BUBBLE_PERCENT) return "near_zero";
  return percent > 0 ? "positive" : "negative";
}

export type DollarBubbleLegs = {
  realDollarToman: number;
  marketDollarToman: number;
  bubbleToman: number;
  bubblePercent: number;
  sign: BubbleSign;
};

export function computeDollarBubble(
  dirhamToman: number,
  marketDollarToman: number
): DollarBubbleLegs | null {
  const real = realDollarFromDirham(dirhamToman);
  if (real === null) return null;
  const bubbleToman = dollarBubbleToman(marketDollarToman, real);
  if (bubbleToman === null) return null;
  const bubblePercent = dollarBubblePercent(bubbleToman, real);
  if (bubblePercent === null) return null;
  const sign = classifyBubble(bubblePercent);
  if (!sign) return null;
  return {
    realDollarToman: real,
    marketDollarToman,
    bubbleToman,
    bubblePercent,
    sign
  };
}

export type GoldBubbleDetail = {
  ounceUsd: number;
  dirhamToman: number;
  realDollarToman: number;
  mazaneToman: number;
  gram18Toman: number;
  globalGoldKgUsd: number;
  globalGoldKgToman: number;
  localPureGoldKgToman: number;
  impliedLocalGoldKgUsd: number;
  goldBubbleTomanPerKg: number;
  goldBubbleUsdPerKg: number;
  goldBubblePercent: number;
  equivalentGram18Bubble: number;
  sign: BubbleSign;
};

export function computeGoldBubble(
  ounceUsd: number,
  dirhamToman: number,
  mazaneToman: number
): GoldBubbleDetail | null {
  const realDollarToman = realDollarFromDirham(dirhamToman);
  if (realDollarToman === null) return null;
  const kgUsd = globalGoldKgUsd(ounceUsd);
  if (kgUsd === null) return null;
  const kgToman = globalGoldKgToman(kgUsd, realDollarToman);
  if (kgToman === null) return null;
  const gram18 = gram18FromMazane(mazaneToman);
  if (gram18 === null) return null;
  const localKg = localPureGoldKgFromGram18(gram18);
  if (localKg === null) return null;
  const bubbleToman = goldBubbleTomanPerKg(localKg, kgToman);
  if (bubbleToman === null) return null;
  const bubbleUsd = goldBubbleUsdPerKg(bubbleToman, realDollarToman);
  if (bubbleUsd === null) return null;
  const pct = goldBubblePercent(bubbleToman, kgToman);
  if (pct === null) return null;
  const eqGram = equivalentGram18Bubble(bubbleToman, gram18);
  if (eqGram === null) return null;
  const impliedLocalUsd = localKg / realDollarToman;
  if (!Number.isFinite(impliedLocalUsd) || impliedLocalUsd <= 0) return null;
  const sign = classifyBubble(pct);
  if (!sign) return null;
  return {
    ounceUsd,
    dirhamToman,
    realDollarToman,
    mazaneToman,
    gram18Toman: gram18,
    globalGoldKgUsd: kgUsd,
    globalGoldKgToman: kgToman,
    localPureGoldKgToman: localKg,
    impliedLocalGoldKgUsd: impliedLocalUsd,
    goldBubbleTomanPerKg: bubbleToman,
    goldBubbleUsdPerKg: bubbleUsd,
    goldBubblePercent: pct,
    equivalentGram18Bubble: eqGram,
    sign
  };
}
