/**
 * Capital-aware candidate generation for paper sizing.
 *
 * Safe maximum (execution ceiling):
 *
 *   finalSafe = min(
 *     capitalLimit,      // usable balances after fees + capital plan share
 *     buyBalanceLimit,
 *     sellBalanceLimit,
 *     buyDepthLimit,     // full slippage-bounded depth (not a fixed ladder)
 *     sellDepthLimit,
 *     orderCap, venueCap, inventoryCap (extra hard ceilings from caller)
 *   )
 *
 * That ceiling is always evaluated. Analysis-only probes are derived FROM the
 * ceiling (fractions of it) so they never cap the final trade. The obsolete
 * 5/10/20/25 USDT ladder is not used for execution ranking or capping.
 *
 * Pure module: no database, no network, no clock, no exchange client.
 */
import { orderedLevels, usdtToMicros, type BookSide } from "@/lib/shadowArbitrage/paper/liquidity";
import type { BookLevel } from "@/lib/shadowArbitrage/types";

/** The name this sizing policy is recorded and displayed under. */
export const SMART_SIZING_POLICY = "CAPITAL_AWARE_MAX_SAFE" as const;

/**
 * Dust floor — not a ladder rung. Below this the two legs are not worth trading.
 * Never used as an upper cap on finalSize.
 */
export const MIN_EXECUTABLE_USDT_MICROS = 25_000_000;

/**
 * Analysis-only fractions of the safe maximum.
 * Never execution caps — labeled probes for the profit curve only.
 */
export const ANALYSIS_PROBE_FRACTIONS = [0.1, 0.25, 0.5, 0.75, 1.0] as const;

/** @deprecated Use ANALYSIS_PROBE_FRACTIONS — kept for UI comparison labels. */
export const CANDIDATE_PERCENTS = [10, 25, 50, 75, 100] as const;

/**
 * Usable-balance participation: 100% of fee-inclusive capacity may be considered.
 * (Portfolio utilization targets are applied elsewhere and never force size.)
 */
export const CAPITAL_CAP_PERCENT = 100;

/**
 * Depth participation: 100% of slippage-bounded executable depth may be used
 * so multi-level VWAP can consume deep books when balances allow.
 */
export const DEPTH_CAP_PERCENT = 100;

/**
 * Historical fixed probe ladder — analysis-only baseline.
 * Never executable; never a cap on finalSize.
 */
export const BASELINE_FIXED_SIZES_USDT = [5, 10, 20, 25] as const;
export const BASELINE_POLICY = "ANALYSIS_ONLY_FIXED_PROBE" as const;

export type SlippageBoundedDepth = {
  /** Quantity reachable inside the slippage ceiling, in micros. */
  depthMicros: number;
  /** Total quantity the side holds, ceiling ignored. */
  totalDepthMicros: number;
  levelsIncluded: number;
  levelsExcluded: number;
  bestPriceToman: number | null;
  /** Worst price still inside the ceiling. Null when no level qualifies. */
  worstAllowedPriceToman: number | null;
  /** The ceiling actually applied, echoed back for the UI. */
  maxSlippageBps: number;
};

/**
 * Depth this desk is permitted to reach, not depth the venue happens to show.
 *
 * A level priced further from the top of book than `max_slippage_bps` is real
 * liquidity, but taking it would breach the administrator's own slippage
 * ceiling — so it is excluded from the depth the caps are computed from. The
 * count of excluded levels is reported rather than dropped, because "the book
 * is thin" and "the book is deep but most of it is out of policy" are different
 * facts with different answers.
 *
 * Levels are consumed in price order, so exclusion is a suffix: once one level
 * is out of range every later one is too.
 */
export function slippageBoundedDepth(
  levels: BookLevel[],
  side: BookSide,
  maxSlippageBps: number
): SlippageBoundedDepth {
  const ordered = orderedLevels(levels, side);
  const total = ordered.reduce((s, l) => s + usdtToMicros(l.amountUsdt), 0);
  if (!ordered.length) {
    return {
      depthMicros: 0,
      totalDepthMicros: 0,
      levelsIncluded: 0,
      levelsExcluded: 0,
      bestPriceToman: null,
      worstAllowedPriceToman: null,
      maxSlippageBps
    };
  }

  const best = ordered[0].priceToman;
  let depthMicros = 0;
  let included = 0;
  let worstAllowed: number | null = null;

  for (const level of ordered) {
    /*
     * Adverse deviation only. Buying, a HIGHER price is worse; selling, a LOWER
     * price is worse. A level that is better than the top of book cannot breach
     * a slippage ceiling and is never excluded by one.
     */
    const deviationBps =
      side === "buy"
        ? ((level.priceToman - best) / best) * 10_000
        : ((best - level.priceToman) / best) * 10_000;
    if (deviationBps > maxSlippageBps) break;
    depthMicros += usdtToMicros(level.amountUsdt);
    worstAllowed = level.priceToman;
    included += 1;
  }

  return {
    depthMicros,
    totalDepthMicros: total,
    levelsIncluded: included,
    levelsExcluded: ordered.length - included,
    bestPriceToman: best,
    worstAllowedPriceToman: worstAllowed,
    maxSlippageBps
  };
}

export type SmartCandidateSet = {
  /** Quantities to evaluate, ascending, deduplicated and quantized. */
  quantities: number[];
  /** min(usable buy side, usable sell side), before any cap. */
  limitingUsableMicros: number;
  /** Which side was the smaller one. */
  limitingSide: "buy" | "sell";
  limitingSourceId: string;
  /** CAPITAL_CAP_PERCENT of the limiting usable balance. */
  capitalCapMicros: number;
  /** DEPTH_CAP_PERCENT of the tighter leg's slippage-bounded depth. */
  depthCapMicros: number;
  /** Which leg's depth bound the depth cap. */
  depthCapSide: "buy" | "sell";
  /** The binding minimum of every cap supplied, including the two above. */
  ceilingMicros: number;
  /** True when the ceiling itself is below the 25 USDT floor. */
  belowFloor: boolean;
  /** Every percentage rung before deduplication, for the explanation table. */
  ladder: Array<{ percent: number; rawMicros: number; quantizedMicros: number; kept: boolean }>;
};

/**
 * Build the candidate set for one route.
 *
 * Safe maximum = min of balance, depth, and hard policy caps. Analysis probes
 * are fractions of that maximum only — they never raise or lower the ceiling.
 * Quantization floors to the ledger precision (safe side of every cap).
 */
export function buildSmartCandidates(input: {
  /** Fee-inclusive usable quantity on the buy venue, in micros. */
  buyUsableMicros: number;
  /** Fee-inclusive deliverable quantity on the sell venue, in micros. */
  sellUsableMicros: number;
  buySourceId: string;
  sellSourceId: string;
  /** Slippage-bounded depth of the buy leg's ask ladder (full usable depth). */
  buyDepthMicros: number;
  /** Slippage-bounded depth of the sell leg's bid ladder (full usable depth). */
  sellDepthMicros: number;
  /** Further hard ceilings: capital plan share, order cap, venue exposure. */
  extraCapsMicros: number[];
  granularityMicros: number;
  minMicros?: number;
}): SmartCandidateSet {
  const minMicros = input.minMicros ?? MIN_EXECUTABLE_USDT_MICROS;
  const buyUsable = Math.max(0, Math.floor(input.buyUsableMicros));
  const sellUsable = Math.max(0, Math.floor(input.sellUsableMicros));

  const limitingUsableMicros = Math.min(buyUsable, sellUsable);
  const limitingSide: "buy" | "sell" = buyUsable <= sellUsable ? "buy" : "sell";
  const limitingSourceId = limitingSide === "buy" ? input.buySourceId : input.sellSourceId;

  // Full usable capacity (CAPITAL_CAP_PERCENT=100): capital-aware, not fixed ladder.
  const capitalCapMicros = Math.floor((limitingUsableMicros * CAPITAL_CAP_PERCENT) / 100);

  // Full slippage-bounded depth (DEPTH_CAP_PERCENT=100): multi-level VWAP may consume it.
  const buyDepthCap = Math.floor((Math.max(0, input.buyDepthMicros) * DEPTH_CAP_PERCENT) / 100);
  const sellDepthCap = Math.floor((Math.max(0, input.sellDepthMicros) * DEPTH_CAP_PERCENT) / 100);
  const depthCapMicros = Math.min(buyDepthCap, sellDepthCap);
  const depthCapSide: "buy" | "sell" = buyDepthCap <= sellDepthCap ? "buy" : "sell";

  const caps = [
    capitalCapMicros,
    depthCapMicros,
    buyUsable,
    sellUsable,
    buyDepthCap,
    sellDepthCap,
    ...input.extraCapsMicros.filter((c) => c >= 0)
  ];
  const ceilingMicros = caps.length ? Math.min(...caps) : 0;

  const quantize = (micros: number) =>
    Math.floor(micros / input.granularityMicros) * input.granularityMicros;

  const kept = new Set<number>();
  const ladder: SmartCandidateSet["ladder"] = [];

  const ceilingQuantized = quantize(ceilingMicros);

  // Analysis probes derived FROM the safe maximum — never independent fixed sizes.
  for (const frac of ANALYSIS_PROBE_FRACTIONS) {
    const percent = Math.round(frac * 100);
    const rawMicros = Math.floor(ceilingMicros * frac);
    const quantizedMicros = quantize(rawMicros);
    const keep = quantizedMicros >= minMicros && quantizedMicros <= ceilingQuantized;
    if (keep) kept.add(quantizedMicros);
    ladder.push({ percent, rawMicros, quantizedMicros, kept: keep });
  }

  // Always evaluate the full safe maximum when above floor.
  if (ceilingQuantized >= minMicros) kept.add(ceilingQuantized);

  return {
    quantities: [...kept].sort((a, b) => a - b),
    limitingUsableMicros,
    limitingSide,
    limitingSourceId,
    capitalCapMicros,
    depthCapMicros,
    depthCapSide,
    ceilingMicros,
    belowFloor: ceilingQuantized < minMicros,
    ladder
  };
}
