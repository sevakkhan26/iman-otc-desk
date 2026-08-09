/**
 * Authoritative per-venue Paper execution limits (min notional / step / precision).
 *
 * Ledger quantum (0.0001 USDT) is accounting precision only — it is NOT an
 * executable minimum. Executable size must clear verified venue mins; if a
 * venue has no verified limit, sizing fails closed with `venue_min_unknown`.
 *
 * Limits are never guessed from books or exchange folklore. They enter only
 * through this registry (admin-confirmed / local seed evidence).
 */
import type { ShadowSourceId } from "@/lib/shadowArbitrage/types";

/** Accounting precision only — numeric(12,4) ledger quantum. Not a trade floor. */
export const LEDGER_SIZE_QUANTUM_MICROS = 100;

export type VenueExecutionLimit = {
  sourceId: string;
  /** Minimum executable notional in USDT micros. */
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

export type RouteExecutionFloor =
  | {
      ok: true;
      minMicros: number;
      stepMicros: number;
      buy: VenueExecutionLimit;
      sell: VenueExecutionLimit;
    }
  | {
      ok: false;
      missingSourceIds: string[];
    };

/**
 * Route executable floor = max(buy min, sell min), stepped to the coarser step.
 * Missing either venue → fail closed.
 */
export function resolveRouteExecutionFloor(
  buySourceId: string,
  sellSourceId: string,
  override?: Map<string, VenueExecutionLimit> | null
): RouteExecutionFloor {
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
    Math.max(buy.minNotionalUsdtMicros, sell.minNotionalUsdtMicros),
    stepMicros
  );
  return { ok: true, minMicros, stepMicros, buy, sell };
}

/**
 * LOCAL Paper fixture limits — admin-confirmed for simulation desks only.
 * minNotionalUsdt = 5 for all nine venues (below the obsolete 25 ladder).
 * Not live exchange API values; evidenceKey identifies the fixture provenance.
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

/** Register the local verified fixture (idempotent). */
export function seedLocalPaperExecutionLimits(input?: {
  /** Override min notional USDT for all venues (tests). */
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
      note: "LOCAL Paper fixture — verified min notional/step for simulation; not a live exchange scrape"
    });
    registered += 1;
  }
  return { registered };
}
