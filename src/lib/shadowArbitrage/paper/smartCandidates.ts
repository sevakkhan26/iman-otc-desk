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
 * Execution quantities come from exact vertices (integer micros + book
 * breakpoints + hard caps). Percentage probes and fixed 5/10/20/25 are
 * analysis-only: they never determine or cap execution size.
 *
 * Pure module: no database, no network, no clock, no exchange client.
 */
import { orderedLevels, usdtToMicros, type BookSide } from "@/lib/shadowArbitrage/paper/liquidity";
import type { BookLevel } from "@/lib/shadowArbitrage/types";
import {
  buildAdaptiveExecutionPoints,
  quantizeMicros,
  SIZE_GRANULARITY_MICROS
} from "@/lib/shadowArbitrage/paper/adaptiveSizeSolver";

/** The name this sizing policy is recorded and displayed under. */
export const SMART_SIZING_POLICY = "MAX_RA_PNL" as const;
/** @deprecated Historical label only; it is not an active policy. */
export const DEPRECATED_CAPITAL_AWARE_MAX_SAFE = "CAPITAL_AWARE_MAX_SAFE" as const;

/**
 * Ledger accounting precision only (numeric(12,4) → 1e-4 USDT).
 * Not an executable trade floor — see venueExecutionLimits.
 */
export const LEDGER_SIZE_QUANTUM_MICROS = 100;

/**
 * @deprecated Do not use as a trade floor. Prefer resolveRouteExecutionFloor.
 * Kept as a re-export alias of ledger quantum for display/quantize helpers that
 * historically imported this name; sizing must pass the route min explicitly.
 */
export const MIN_EXECUTABLE_USDT_MICROS = LEDGER_SIZE_QUANTUM_MICROS;

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
 * 100% always means 100% of the final constrained safe maximum, never of total
 * session capital or unconstrained venue balance.
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
  /**
   * Exact execution vertices to evaluate, ascending. Analysis fractions are
   * excluded from this set.
   */
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
  /** Same ceiling before safe venue-step flooring. */
  preRoundCeilingMicros: number;
  /** True when the ceiling itself is below the ledger quantum floor. */
  belowFloor: boolean;
  /**
   * Analysis-only percentage rungs (display / profit curve labels).
   * Never the sole execution set.
   */
  ladder: Array<{ percent: number; rawMicros: number; quantizedMicros: number; kept: boolean }>;
  /** Adaptive solver metadata for the audit trail. */
  adaptive: {
    minMicros: number;
    ceilingMicros: number;
    executionPointCount: number;
    analysisPointCount: number;
  };
};

/**
 * Build the candidate set for one route.
 *
 * Safe maximum = min of balance, depth, and hard policy caps. Execution
 * quantities are exact book/cap endpoints. Inventory/capital crossings supplied
 * by the caller are hard-cap vertices; no midpoint grid is used as a solver.
 * Analysis probes remain labeled fractions of the ceiling only.
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
  /** Order-book levels whose cumulative endpoints form exact vertices. */
  buyLevels?: BookLevel[];
  sellLevels?: BookLevel[];
}): SmartCandidateSet {
  const minMicros = input.minMicros ?? MIN_EXECUTABLE_USDT_MICROS;
  const gran = input.granularityMicros > 0 ? input.granularityMicros : SIZE_GRANULARITY_MICROS;
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
  const rawCeiling = caps.length ? Math.min(...caps) : 0;
  const ceilingMicros = quantizeMicros(rawCeiling, gran);

  // Analysis-only ladder (display). Never the execution selector alone.
  const ladder: SmartCandidateSet["ladder"] = [];
  for (const frac of ANALYSIS_PROBE_FRACTIONS) {
    const percent = Math.round(frac * 100);
    const rawMicros = Math.floor(rawCeiling * frac);
    const quantizedMicros = quantizeMicros(rawMicros, gran);
    const keep = quantizedMicros >= minMicros && quantizedMicros <= ceilingMicros;
    ladder.push({ percent, rawMicros, quantizedMicros, kept: keep });
  }

  const adaptive = buildAdaptiveExecutionPoints({
    ceilingMicros: rawCeiling,
    minMicros,
    granularityMicros: gran,
    buyLevels: input.buyLevels ?? [],
    sellLevels: input.sellLevels ?? [],
    analysisFractions: ANALYSIS_PROBE_FRACTIONS
  });

  // Execution set = endpoints only. Analysis points never enter decisioning.
  const quantities = adaptive.allPoints;

  return {
    quantities,
    limitingUsableMicros,
    limitingSide,
    limitingSourceId,
    capitalCapMicros,
    depthCapMicros,
    depthCapSide,
    ceilingMicros,
    preRoundCeilingMicros: rawCeiling,
    belowFloor: ceilingMicros < minMicros,
    ladder,
    adaptive: {
      minMicros: adaptive.minMicros,
      ceilingMicros: adaptive.ceilingMicros,
      executionPointCount: adaptive.executionPoints.length,
      analysisPointCount: adaptive.analysisPoints.length
    }
  };
}
