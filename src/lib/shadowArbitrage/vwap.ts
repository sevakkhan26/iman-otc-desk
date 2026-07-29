import { parseNum, USDT_IRT_MAX_TOMAN, USDT_IRT_MIN_TOMAN } from "@/lib/shadowArbitrage/money";
import type { BookLevel } from "@/lib/shadowArbitrage/types";

/**
 * Executable VWAP walking the book for `sizeUsdt`.
 * For buy (user buys USDT): walk asks ascending.
 * For sell (user sells USDT): walk bids descending.
 */
export function executableVwap(
  levels: BookLevel[],
  sizeUsdt: number,
  side: "buy" | "sell"
): { vwapToman: number | null; filledUsdt: number; fillable: boolean } {
  if (!levels.length || sizeUsdt <= 0) {
    return { vwapToman: null, filledUsdt: 0, fillable: false };
  }

  const sorted =
    side === "buy"
      ? [...levels].sort((a, b) => a.priceToman - b.priceToman)
      : [...levels].sort((a, b) => b.priceToman - a.priceToman);

  let remaining = sizeUsdt;
  let notional = 0;
  let filled = 0;

  for (const lvl of sorted) {
    if (remaining <= 0) break;
    if (lvl.priceToman <= 0 || lvl.amountUsdt <= 0) continue;
    const take = Math.min(remaining, lvl.amountUsdt);
    notional += take * lvl.priceToman;
    filled += take;
    remaining -= take;
  }

  if (filled <= 0) return { vwapToman: null, filledUsdt: 0, fillable: false };
  const vwap = Math.round(notional / filled);
  // Require ≥99.5% fill to count as fillable for the requested size
  const fillable = filled + 1e-9 >= sizeUsdt * 0.995;
  return { vwapToman: vwap, filledUsdt: filled, fillable };
}

/** Parse generic [price, amount] levels to toman + USDT. */
export function parseLevels(
  raw: unknown,
  priceUnit: "toman" | "rial",
  amountIsUsdt = true
): BookLevel[] {
  if (!Array.isArray(raw)) return [];
  const out: BookLevel[] = [];
  for (const row of raw) {
    let priceRaw: unknown;
    let amountRaw: unknown;
    if (Array.isArray(row)) {
      priceRaw = row[0];
      amountRaw = row[1];
    } else if (row && typeof row === "object") {
      const o = row as Record<string, unknown>;
      priceRaw = o.price ?? o.p ?? o[0];
      amountRaw = o.amount ?? o.quantity ?? o.qty ?? o.volume ?? o[1];
    } else continue;

    const priceN = parseNum(priceRaw);
    const amountN = parseNum(amountRaw);
    if (priceN === null || amountN === null || priceN <= 0 || amountN <= 0) continue;
    const priceToman = Math.round(priceUnit === "rial" ? priceN / 10 : priceN);
    if (priceToman < USDT_IRT_MIN_TOMAN || priceToman > USDT_IRT_MAX_TOMAN) continue;
    out.push({ priceToman, amountUsdt: amountIsUsdt ? amountN : amountN });
  }
  return out;
}

/** Levels that survived parsing vs levels the venue actually sent. */
export function parseLevelsWithLoss(
  raw: unknown,
  priceUnit: "toman" | "rial"
): { levels: BookLevel[]; received: number; rejected: number } {
  const received = Array.isArray(raw) ? raw.length : 0;
  const levels = parseLevels(raw, priceUnit);
  return { levels, received, rejected: Math.max(0, received - levels.length) };
}

export function sumDepth(levels: BookLevel[]): number {
  return levels.reduce((s, l) => s + l.amountUsdt, 0);
}
