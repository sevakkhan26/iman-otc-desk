/**
 * Deterministic adaptive size solver for paper execution.
 *
 * Finds the largest valid USDT size in [minExecutable, hardCeiling] using:
 *  - integer micros + ledger granularity
 *  - order-book cumulative breakpoints (both legs)
 *  - densified midpoints so inventory-tight routes still find a smaller valid size
 *
 * Percentage probes and fixed 5/10/20/25 are NOT used as the execution selector.
 * Pure: no I/O, no clock, no network.
 */
import { orderedLevels, usdtToMicros, type BookSide } from "@/lib/shadowArbitrage/paper/liquidity";
import type { BookLevel } from "@/lib/shadowArbitrage/types";
import { MIN_EXECUTABLE_USDT_MICROS } from "@/lib/shadowArbitrage/paper/smartCandidates";

export const SIZE_GRANULARITY_MICROS = 100;

export function quantizeMicros(micros: number, gran: number = SIZE_GRANULARITY_MICROS): number {
  if (micros <= 0) return 0;
  return Math.floor(micros / gran) * gran;
}

/** Cumulative fillable USDT micros at each successive book level (price-ordered). */
export function cumulativeBookBreakpoints(
  levels: BookLevel[],
  side: BookSide,
  ceilingMicros: number,
  gran: number
): number[] {
  const ordered = orderedLevels(levels, side);
  const out: number[] = [];
  let cum = 0;
  for (const level of ordered) {
    cum += usdtToMicros(level.amountUsdt);
    const q = quantizeMicros(Math.min(cum, ceilingMicros), gran);
    if (q > 0) out.push(q);
    if (cum >= ceilingMicros) break;
  }
  return out;
}

/**
 * Densify a sorted unique list of breakpoints so large gaps get midpoints.
 * Stops when every adjacent gap is ≤ maxGapMicros (or min steps reached).
 */
export function densifyBreakpoints(
  points: number[],
  minMicros: number,
  ceilingMicros: number,
  gran: number,
  maxGapMicros: number = 50_000_000 // 50 USDT
): number[] {
  const set = new Set<number>();
  const add = (n: number) => {
    const q = quantizeMicros(n, gran);
    if (q >= minMicros && q <= ceilingMicros) set.add(q);
  };
  add(minMicros);
  add(ceilingMicros);
  for (const p of points) add(p);

  let sorted = [...set].sort((a, b) => a - b);
  // Recursive midpoint fill (bounded iterations).
  for (let iter = 0; iter < 12; iter += 1) {
    let grew = false;
    const next = new Set(sorted);
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const a = sorted[i]!;
      const b = sorted[i + 1]!;
      if (b - a > maxGapMicros) {
        const mid = quantizeMicros(Math.floor((a + b) / 2), gran);
        if (mid > a && mid < b && !next.has(mid)) {
          next.add(mid);
          grew = true;
        }
      }
    }
    sorted = [...next].sort((a, b) => a - b);
    if (!grew) break;
  }
  return sorted;
}

/**
 * Build the execution candidate set for the adaptive solver.
 * Analysis-only fractions may be appended for UI but do not define the ceiling.
 */
export function buildAdaptiveExecutionPoints(input: {
  ceilingMicros: number;
  minMicros?: number;
  granularityMicros?: number;
  buyLevels: BookLevel[];
  sellLevels: BookLevel[];
  /** Optional analysis fractions of ceiling (display only, still evaluated). */
  analysisFractions?: readonly number[];
}): {
  minMicros: number;
  ceilingMicros: number;
  executionPoints: number[];
  analysisPoints: number[];
  allPoints: number[];
} {
  const gran = input.granularityMicros ?? SIZE_GRANULARITY_MICROS;
  const minMicros = input.minMicros ?? MIN_EXECUTABLE_USDT_MICROS;
  const ceiling = quantizeMicros(Math.max(0, input.ceilingMicros), gran);

  if (ceiling < minMicros) {
    return {
      minMicros,
      ceilingMicros: ceiling,
      executionPoints: [],
      analysisPoints: [],
      allPoints: []
    };
  }

  const buyBp = cumulativeBookBreakpoints(input.buyLevels, "buy", ceiling, gran);
  const sellBp = cumulativeBookBreakpoints(input.sellLevels, "sell", ceiling, gran);
  const densified = densifyBreakpoints(
    [...buyBp, ...sellBp],
    minMicros,
    ceiling,
    gran,
    Math.max(gran * 100, Math.floor(ceiling / 32))
  );

  const analysisPoints: number[] = [];
  for (const f of input.analysisFractions ?? [0.1, 0.25, 0.5, 0.75, 1.0]) {
    const q = quantizeMicros(Math.floor(ceiling * f), gran);
    if (q >= minMicros && q <= ceiling) analysisPoints.push(q);
  }

  const executionPoints = densified;
  const all = new Set([...executionPoints, ...analysisPoints, ceiling, minMicros]);
  const allPoints = [...all].filter((q) => q >= minMicros && q <= ceiling).sort((a, b) => a - b);

  return {
    minMicros,
    ceilingMicros: ceiling,
    executionPoints,
    analysisPoints: [...new Set(analysisPoints)].sort((a, b) => a - b),
    allPoints
  };
}

/**
 * Given evaluated points with eligibility, pick the largest valid size.
 * Pure selection — evaluation is the caller's job.
 */
export function selectLargestValid(
  evaluated: Array<{ sizeUsdtMicros: number; eligible: boolean }>
): number | null {
  let best: number | null = null;
  for (const e of evaluated) {
    if (!e.eligible) continue;
    if (best === null || e.sizeUsdtMicros > best) best = e.sizeUsdtMicros;
  }
  return best;
}
