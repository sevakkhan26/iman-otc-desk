/**
 * Paper execution floors and (optional) verified venue mins.
 *
 * Ledger quantum (0.0001 USDT) is accounting precision only — not a trade floor.
 *
 * Paper simulation always applies the admin-approved global Paper minimum
 * (`paper_policy_min` = 5 USDT). It is NOT an official exchange limit.
 *
 * Effective Paper floor = max(paper_policy_min, verified venue minimum).
 * Missing verified venue mins do NOT block Paper; they are recorded so future
 * LIVE execution can fail closed until mins are confirmed.
 *
 * Verified venue limits are never guessed — they enter only through this
 * registry (admin-confirmed evidence).
 */
import type { ShadowSourceId } from "@/lib/shadowArbitrage/types";

/** Accounting precision only — numeric(12,4) ledger quantum. Not a trade floor. */
export const LEDGER_SIZE_QUANTUM_MICROS = 100;

/**
 * Admin-approved global Paper minimum (USDT). Simulation never sizes below this.
 * Label: `paper_policy_min` — not a venue/exchange min.
 */
export const PAPER_POLICY_MIN_USDT = 5;
export const PAPER_POLICY_MIN_USDT_MICROS = PAPER_POLICY_MIN_USDT * 1_000_000;

/** Stable key for audits / API / UI. */
export const PAPER_POLICY_MIN_KEY = "paper_policy_min" as const;

export type VenueExecutionLimit = {
  sourceId: string;
  /** Minimum executable notional in USDT micros (verified). */
  minNotionalUsdtMicros: number;
  /** Quantity step in USDT micros (must be ≥ ledger quantum after quantize). */
  quantityStepUsdtMicros: number;
  provenance: string;
  evidenceKey: string;
  confirmedAt: string;
  note: string | null;
};

const registry = new Map<string, VenueExecutionLimit>();

export function clearVenueExecutionLimitsRegistry(): void {
  registry.clear();
}

export function getVenueExecutionLimit(sourceId: string): VenueExecutionLimit | null {
  return registry.get(sourceId) ?? null;
}

export function listVenueExecutionLimits(): VenueExecutionLimit[] {
  return [...registry.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}

/**
 * Register or replace one venue's verified limit (same evidenceKey is idempotent).
 * Does not invent values — caller must supply verified numbers.
 */
export function registerVenueExecutionLimit(limit: VenueExecutionLimit): VenueExecutionLimit {
  if (!(limit.minNotionalUsdtMicros > 0) || !(limit.quantityStepUsdtMicros > 0)) {
    throw new Error(`invalid execution limit for ${limit.sourceId}`);
  }
  const existing = registry.get(limit.sourceId);
  if (existing && existing.evidenceKey === limit.evidenceKey) {
    return existing;
  }
  const step = Math.max(limit.quantityStepUsdtMicros, LEDGER_SIZE_QUANTUM_MICROS);
  const min = Math.max(limit.minNotionalUsdtMicros, step);
  const normalized: VenueExecutionLimit = {
    ...limit,
    quantityStepUsdtMicros: step,
    minNotionalUsdtMicros: quantizeUpToStep(min, step)
  };
  registry.set(limit.sourceId, normalized);
  return normalized;
}

export function quantizeUpToStep(micros: number, stepMicros: number): number {
  if (micros <= 0) return 0;
  const step = Math.max(stepMicros, LEDGER_SIZE_QUANTUM_MICROS);
  return Math.ceil(micros / step) * step;
}

export function quantizeDownToStep(micros: number, stepMicros: number): number {
  if (micros <= 0) return 0;
  const step = Math.max(stepMicros, LEDGER_SIZE_QUANTUM_MICROS);
  return Math.floor(micros / step) * step;
}

export type PaperFloorBinding = typeof PAPER_POLICY_MIN_KEY | "venue_min";

/**
 * Paper route floor — always ok for simulation.
 * Effective min = max(paper_policy_min, verified venue min when both legs known).
 * Unknown venue mins are advisory for LIVE only.
 */
export type PaperRouteFloor = {
  /** Always true for Paper — unknown venues do not block simulation. */
  ok: true;
  /** max(paper_policy_min, verified venue floor) after step quantize. */
  minMicros: number;
  stepMicros: number;
  paperPolicyMinMicros: number;
  /** Route venue floor when both legs verified; null if either unknown. */
  verifiedVenueMinMicros: number | null;
  /** Which floor bound the effective min. */
  binding: PaperFloorBinding;
  buy: VenueExecutionLimit | null;
  sell: VenueExecutionLimit | null;
  /**
   * Venues without verified mins. Does NOT block Paper.
   * Future LIVE execution must fail closed while this is non-empty.
   */
  unknownSourceIds: string[];
  /** True when LIVE must not execute until mins are confirmed. */
  liveBlockedByUnknownVenueMin: boolean;
};

/**
 * Resolve the Paper executable floor for a route.
 * Never invents venue mins; never blocks Paper on missing venue mins.
 */
export function resolvePaperRouteFloor(
  buySourceId: string,
  sellSourceId: string,
  override?: Map<string, VenueExecutionLimit> | null
): PaperRouteFloor {
  const buy = override?.get(buySourceId) ?? getVenueExecutionLimit(buySourceId);
  const sell = override?.get(sellSourceId) ?? getVenueExecutionLimit(sellSourceId);
  const unknownSourceIds: string[] = [];
  if (!buy) unknownSourceIds.push(buySourceId);
  if (!sell) unknownSourceIds.push(sellSourceId);

  const paperPolicyMinMicros = PAPER_POLICY_MIN_USDT_MICROS;
  let verifiedVenueMinMicros: number | null = null;
  let stepMicros = LEDGER_SIZE_QUANTUM_MICROS;

  if (buy && sell) {
    stepMicros = Math.max(buy.quantityStepUsdtMicros, sell.quantityStepUsdtMicros);
    verifiedVenueMinMicros = quantizeUpToStep(
      Math.max(buy.minNotionalUsdtMicros, sell.minNotionalUsdtMicros),
      stepMicros
    );
  } else if (buy) {
    stepMicros = Math.max(buy.quantityStepUsdtMicros, LEDGER_SIZE_QUANTUM_MICROS);
  } else if (sell) {
    stepMicros = Math.max(sell.quantityStepUsdtMicros, LEDGER_SIZE_QUANTUM_MICROS);
  }

  const rawMin = Math.max(paperPolicyMinMicros, verifiedVenueMinMicros ?? 0);
  const minMicros = quantizeUpToStep(rawMin, stepMicros);
  const binding: PaperFloorBinding =
    verifiedVenueMinMicros != null && verifiedVenueMinMicros > paperPolicyMinMicros
      ? "venue_min"
      : PAPER_POLICY_MIN_KEY;

  return {
    ok: true,
    minMicros,
    stepMicros,
    paperPolicyMinMicros,
    verifiedVenueMinMicros,
    binding,
    buy,
    sell,
    unknownSourceIds,
    liveBlockedByUnknownVenueMin: unknownSourceIds.length > 0
  };
}

/**
 * LIVE path only: both legs must have verified mins.
 * Paper must not call this for sizing decisions.
 */
export type LiveVenueMinCheck =
  | { ok: true; minMicros: number; stepMicros: number; buy: VenueExecutionLimit; sell: VenueExecutionLimit }
  | { ok: false; missingSourceIds: string[] };

export function resolveLiveVenueMinFloor(
  buySourceId: string,
  sellSourceId: string,
  override?: Map<string, VenueExecutionLimit> | null
): LiveVenueMinCheck {
  const buy = override?.get(buySourceId) ?? getVenueExecutionLimit(buySourceId);
  const sell = override?.get(sellSourceId) ?? getVenueExecutionLimit(sellSourceId);
  const missing: string[] = [];
  if (!buy) missing.push(buySourceId);
  if (!sell) missing.push(sellSourceId);
  if (missing.length || !buy || !sell) {
    return { ok: false, missingSourceIds: missing };
  }
  const stepMicros = Math.max(buy.quantityStepUsdtMicros, sell.quantityStepUsdtMicros);
  const minMicros = quantizeUpToStep(
    Math.max(buy.minNotionalUsdtMicros, sell.minNotionalUsdtMicros, PAPER_POLICY_MIN_USDT_MICROS),
    stepMicros
  );
  return { ok: true, minMicros, stepMicros, buy, sell };
}

/**
 * @deprecated Prefer resolvePaperRouteFloor for Paper, resolveLiveVenueMinFloor for LIVE.
 * Kept as an alias of the LIVE check so older call sites fail closed on missing mins.
 */
export function resolveRouteExecutionFloor(
  buySourceId: string,
  sellSourceId: string,
  override?: Map<string, VenueExecutionLimit> | null
): LiveVenueMinCheck {
  return resolveLiveVenueMinFloor(buySourceId, sellSourceId, override);
}

/**
 * Optional LOCAL fixture for true verified venue mins (tests / demos).
 * Not the Paper policy min — that is always PAPER_POLICY_MIN_USDT.
 * Default fixture values are deliberately ABOVE paper_policy_min when used
 * to exercise max(5, venue) — pass minNotionalUsdt to control.
 */
export const LOCAL_PAPER_EXECUTION_LIMITS_FIXTURE: Array<{
  sourceId: ShadowSourceId;
  minNotionalUsdt: number;
  quantityStepUsdt: number;
}> = (
  [
    "nobitex",
    "wallex",
    "tabdeal",
    "bitpin",
    "abantether",
    "ramzinex",
    "tetherland",
    "bit24",
    "arzinja"
  ] as ShadowSourceId[]
).map((sourceId) => ({
  sourceId,
  minNotionalUsdt: 5,
  quantityStepUsdt: 0.01
}));

export const LOCAL_EXECUTION_LIMITS_EVIDENCE_KEY = "local-paper-execution-limits-v1" as const;
export const LOCAL_EXECUTION_LIMITS_CONFIRMED_AT = "2026-08-09T00:00:00.000Z";

/** Register optional verified venue mins (idempotent). Not required for Paper. */
export function seedLocalPaperExecutionLimits(input?: {
  minNotionalUsdt?: number;
  quantityStepUsdt?: number;
}): { registered: number } {
  const minU = input?.minNotionalUsdt ?? 5;
  const stepU = input?.quantityStepUsdt ?? 0.01;
  let registered = 0;
  for (const row of LOCAL_PAPER_EXECUTION_LIMITS_FIXTURE) {
    registerVenueExecutionLimit({
      sourceId: row.sourceId,
      minNotionalUsdtMicros: Math.round(minU * 1_000_000),
      quantityStepUsdtMicros: Math.round(stepU * 1_000_000),
      provenance: "ADMIN_CONFIRMED_LOCAL_FIXTURE",
      evidenceKey: LOCAL_EXECUTION_LIMITS_EVIDENCE_KEY,
      confirmedAt: LOCAL_EXECUTION_LIMITS_CONFIRMED_AT,
      note: "Optional verified venue min fixture for tests — not paper_policy_min"
    });
    registered += 1;
  }
  return { registered };
}
