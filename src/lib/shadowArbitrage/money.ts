/**
 * Exact money helpers for Shadow Arbitrage.
 * All IRT display prices are integer toman (no IRR×10 ambiguity in stored form).
 * Avoid IEEE float for fee/edge chains — use integer toman + basis points.
 */

const USDT_SCALE = 1_000_000; // micros as number (safe for our sizes)

/**
 * Plausibility band for USDT/IRT in integer toman.
 * Tight enough that a rial value mislabelled as toman (≈10×) falls outside it,
 * which is what makes unit resolution deterministic instead of a guess.
 */
export const USDT_IRT_MIN_TOMAN = 20_000;
export const USDT_IRT_MAX_TOMAN = 800_000;

/** True when both toman and rial readings of the same raw value look plausible. */
export function unitReadingIsAmbiguous(raw: number): boolean {
  const asToman = raw >= USDT_IRT_MIN_TOMAN && raw <= USDT_IRT_MAX_TOMAN;
  const asRial = raw / 10 >= USDT_IRT_MIN_TOMAN && raw / 10 <= USDT_IRT_MAX_TOMAN;
  return asToman && asRial;
}

/** Parse unknown to finite number or null. */
export function parseNum(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Convert raw price to integer toman.
 * unit "rial" divides by 10; rejects values that look like double-converted rial.
 */
export function toIntegerToman(value: unknown, unit: "toman" | "rial" = "toman"): number | null {
  const n = parseNum(value);
  if (n === null || n <= 0) return null;
  const toman = unit === "rial" ? n / 10 : n;
  if (!Number.isFinite(toman) || toman <= 0) return null;
  // Domestic USDT/IRT sanity
  if (toman < USDT_IRT_MIN_TOMAN || toman > USDT_IRT_MAX_TOMAN) return null;
  return Math.round(toman);
}

/** Detect likely rial-as-toman mistake (price ~10× too high). */
export function looksLikeRialMislabelledAsToman(toman: number): boolean {
  return toman > 800_000 && toman < 20_000_000;
}

/**
 * costToman = round(priceToman * sizeUsdt)
 * uses integer micros for size to avoid float drift on fee chain.
 */
export function mulPriceSizeToman(priceToman: number, sizeUsdt: number): number {
  const p = Math.round(priceToman);
  const micros = Math.round(sizeUsdt * USDT_SCALE);
  return Math.round((p * micros) / USDT_SCALE);
}

/** fee = round(amount * bps / 10000) */
export function feeFromBps(amountToman: number, bps: number): number {
  return Math.round((Math.round(amountToman) * Math.round(bps)) / 10_000);
}

export function percentOf(numerator: number, denominator: number): number {
  if (!denominator || !Number.isFinite(numerator) || !Number.isFinite(denominator)) return 0;
  return (numerator / denominator) * 100;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
