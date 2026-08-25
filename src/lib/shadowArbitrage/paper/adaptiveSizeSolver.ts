/**
 * Deterministic adaptive size solver for paper execution.
 *
 * Builds the exact endpoint set in [minExecutable, hardCeiling] using:
 *  - integer micros + ledger granularity
 *  - order-book cumulative breakpoints (both legs)
 *
 * Midpoints and percentage probes are NOT execution candidates. Between book
 * vertices canonical RA is affine, so an optimum is at an endpoint.
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
 * @deprecated Analysis/display helper only. Execution candidate construction
 * never calls this midpoint sampler.
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
 * Build the execution vertex set. Analysis fractions are returned separately
 * for display only and are never appended to `executionPoints`/`allPoints`.
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
  const vertices = new Set<number>();
  const addVertex = (raw: number) => {
    const q = quantizeMicros(raw, gran);
    if (q >= minMicros && q <= ceiling) vertices.add(q);
  };
  addVertex(minMicros);
  addVertex(ceiling);
  for (const point of buyBp) addVertex(point);
  for (const point of sellBp) addVertex(point);

  const analysisPoints: number[] = [];
  for (const f of input.analysisFractions ?? [0.1, 0.25, 0.5, 0.75, 1.0]) {
    const q = quantizeMicros(Math.floor(ceiling * f), gran);
    if (q >= minMicros && q <= ceiling) analysisPoints.push(q);
  }

  const executionPoints = [...vertices].sort((a, b) => a - b);
  const allPoints = executionPoints;

  return {
    minMicros,
    ceilingMicros: ceiling,
    executionPoints,
    analysisPoints: [...new Set(analysisPoints)].sort((a, b) => a - b),
    allPoints
  };
}

/**
 * @deprecated Historical comparison helper. Never use for execution.
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

/** Canonical objective selector; execution callers must use this, not largest-q. */
export function selectMaxRiskAdjustedPnl<T extends {
  sizeUsdtMicros: number;
  eligible: boolean;
  riskAdjustedPnlToman: number;
  capitalEfficiencyBps: number;
  inventoryImpactPoints: number;
  capitalLockedToman: number;
}>(evaluated: T[]): T | null {
  const eligible = evaluated.filter((e) => e.eligible);
  if (!eligible.length) return null;
  return [...eligible].sort(
    (a, b) =>
      b.riskAdjustedPnlToman - a.riskAdjustedPnlToman ||
      b.capitalEfficiencyBps - a.capitalEfficiencyBps ||
      a.inventoryImpactPoints - b.inventoryImpactPoints ||
      a.capitalLockedToman - b.capitalLockedToman ||
      a.sizeUsdtMicros - b.sizeUsdtMicros
  )[0]!;
}
