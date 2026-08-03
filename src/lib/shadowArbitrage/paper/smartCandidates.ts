/**
 * `SMART_CAPITAL_DEPTH` — candidate generation for paper sizing.
 *
 * The fixed 5/10/20/25 USDT ladder answers "can this book fill a probe?", which
 * is a data-quality question. It cannot answer "how much should this desk
 * trade?", because it knows nothing about the desk: the same four numbers come
 * back whether the session holds ten million toman or ten billion. On a 10B
 * session a 25 USDT fill is not conservative, it is noise — it proves the
 * plumbing works and nothing about whether the capital is being used.
 *
 * So candidates are generated from what the desk can actually commit, and then
 * cut down by what the market can actually absorb:
 *
 *   1. LIMITING USABLE BALANCE — the smaller of the two sides after fees and
 *      after any capacity already reserved by another candidate this cycle.
 *      Both sides matter: toman that cannot be matched by USDT on the other
 *      venue buys nothing an arbitrage can sell.
 *   2. PERCENTAGE LADDER — 1, 2, 4, 6, 8 and 10 percent of that balance. Six
 *      points, geometric at the bottom where the profit curve bends and linear
 *      at the top where it flattens. They are quantities to EVALUATE, not a
 *      preference ordering: the winner is chosen on measured profit.
 *   3. CAPITAL CAP — 10% of the limiting balance. No single fill may commit
 *      more than a tenth of the side that binds it, whatever the book offers.
 *   4. DEPTH CAP — 10% of the executable depth on EACH leg, where "executable"
 *      means the levels reachable without exceeding the administrator's own
 *      slippage ceiling. Depth beyond that ceiling exists but is not depth this
 *      desk is allowed to take.
 *   5. FLOOR — 25 USDT. Below it the trade is not worth the two legs, and the
 *      answer is "do not trade", never "trade a smaller amount".
 *
 * Every number above is a stated policy, not a tuned constant: no score, no
 * model, no learned weights, and nothing that changes between two runs on the
 * same inputs.
 *
 * Pure module: no database, no network, no clock, no exchange client.
 */
import { orderedLevels, usdtToMicros, type BookSide } from "@/lib/shadowArbitrage/paper/liquidity";
import type { BookLevel } from "@/lib/shadowArbitrage/types";

/** The name this sizing policy is recorded and displayed under. */
export const SMART_SIZING_POLICY = "SMART_CAPITAL_DEPTH" as const;

/** Nothing smaller than this trades. Not a floor to round to — a refusal. */
export const MIN_EXECUTABLE_USDT_MICROS = 25_000_000;

/** Percentages of the limiting usable side balance that get evaluated. */
export const CANDIDATE_PERCENTS = [1, 2, 4, 6, 8, 10] as const;

/** Hard ceiling as a percentage of the limiting usable side balance. */
export const CAPITAL_CAP_PERCENT = 10;

/** Hard ceiling as a percentage of each leg's slippage-bounded depth. */
export const DEPTH_CAP_PERCENT = 10;

/**
 * The fixed probe ladder, kept ONLY as a comparison baseline.
 *
 * It is never executable. It exists so an operator can see, side by side, what
 * the old fixed sizing would have produced on the same evidence — which is the
 * only honest way to argue that the smart size is better rather than merely
 * different.
 */
export const BASELINE_FIXED_SIZES_USDT = [5, 10, 20, 25] as const;
export const BASELINE_POLICY = "FIXED_PROBE_LADDER" as const;

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
 * Quantization floors to the ledger's own storable precision. Flooring rather
 * than rounding keeps every candidate on the safe side of every cap: a rung
 * rounded UP could exceed the cap it was derived from by a fraction of a USDT,
 * and a size the caps do not permit is not a candidate at all.
 */
export function buildSmartCandidates(input: {
  /** Fee-inclusive usable quantity on the buy venue, in micros. */
  buyUsableMicros: number;
  /** Fee-inclusive deliverable quantity on the sell venue, in micros. */
  sellUsableMicros: number;
  buySourceId: string;
  sellSourceId: string;
  /** Slippage-bounded depth of the buy leg's ask ladder. */
  buyDepthMicros: number;
  /** Slippage-bounded depth of the sell leg's bid ladder. */
  sellDepthMicros: number;
  /** Further hard ceilings: the capital plan share, the risk policies. */
  extraCapsMicros: number[];
  granularityMicros: number;
  minMicros?: number;
}): SmartCandidateSet {
  const minMicros = input.minMicros ?? MIN_EXECUTABLE_USDT_MICROS;
  const buyUsable = Math.max(0, Math.floor(input.buyUsableMicros));
  const sellUsable = Math.max(0, Math.floor(input.sellUsableMicros));

  const limitingUsableMicros = Math.min(buyUsable, sellUsable);
  // Ties resolve to the buy side deterministically; both are equal, so the
  // choice cannot change a number — only the label the UI prints.
  const limitingSide: "buy" | "sell" = buyUsable <= sellUsable ? "buy" : "sell";
  const limitingSourceId = limitingSide === "buy" ? input.buySourceId : input.sellSourceId;

  const capitalCapMicros = Math.floor((limitingUsableMicros * CAPITAL_CAP_PERCENT) / 100);

  const buyDepthCap = Math.floor((Math.max(0, input.buyDepthMicros) * DEPTH_CAP_PERCENT) / 100);
  const sellDepthCap = Math.floor((Math.max(0, input.sellDepthMicros) * DEPTH_CAP_PERCENT) / 100);
  const depthCapMicros = Math.min(buyDepthCap, sellDepthCap);
  const depthCapSide: "buy" | "sell" = buyDepthCap <= sellDepthCap ? "buy" : "sell";

  const caps = [capitalCapMicros, depthCapMicros, ...input.extraCapsMicros.filter((c) => c >= 0)];
  const ceilingMicros = caps.length ? Math.min(...caps) : 0;

  const quantize = (micros: number) =>
    Math.floor(micros / input.granularityMicros) * input.granularityMicros;

  const kept = new Set<number>();
  const ladder: SmartCandidateSet["ladder"] = [];

  for (const percent of CANDIDATE_PERCENTS) {
    const rawMicros = Math.floor((limitingUsableMicros * percent) / 100);
    const quantizedMicros = quantize(rawMicros);
    /*
     * A rung above the ceiling is DROPPED, not clipped down to it. Clipping
     * would report several different percentages as though they had all
     * produced the ceiling quantity, which reads like agreement between
     * independent measurements when it is really one cap repeated.
     */
    const keep = quantizedMicros >= minMicros && quantizedMicros <= ceilingMicros;
    if (keep) kept.add(quantizedMicros);
    ladder.push({ percent, rawMicros, quantizedMicros, kept: keep });
  }

  /*
   * The ceiling itself is always evaluated when it clears the floor. A cap that
   * lands between two rungs is a real quantity the desk could trade, and
   * leaving it out would mean the largest evaluated size is arbitrarily below
   * what every constraint actually permits.
   */
  const ceilingQuantized = quantize(ceilingMicros);
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
