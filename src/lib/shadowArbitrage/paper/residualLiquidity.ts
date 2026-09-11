/**
 * Session-scoped simulated residual liquidity (Paper only).
 *
 * effective_qty = max(0, raw_displayed - active_session_consumption)
 *
 * A new snapshot generation alone MUST NOT reset consumption. Carry by
 * venue/symbol/side/price. Clear/reduce only via the documented refill model
 * in REFILL-MODEL.md (level_absent_n_snapshots | conservative_quantity_delta |
 * optional paper_ttl_decay labeled as Paper simulation assumption).
 *
 * Pure module: no DB, no network, no clock (callers supply nowMs / generation).
 */
import type { BookLevel, NormalizedSourceSnapshot } from "@/lib/shadowArbitrage/types";
import { USDT_MICROS, usdtToMicros, microsToUsdt, type BookSide } from "@/lib/shadowArbitrage/paper/liquidity";

export const RESIDUAL_SYMBOL_DEFAULT = "USDTIRT";

/** Default: level must be absent for this many consecutive fresh snapshots. */
export const DEFAULT_ABSENT_SNAPSHOTS_TO_RELEASE = 3;

/**
 * Optional Paper-simulation TTL (ms). Null/0 = disabled.
 * Labeled clearly as simulation assumption, not market fact.
 */
export const DEFAULT_PAPER_TTL_DECAY_MS: number | null = null;

export type ResidualSide = "bid" | "ask";

export type ResidualLevelKeyParts = {
  paperSessionId: string;
  venueId: string;
  symbol?: string;
  side: ResidualSide;
  priceToman: number;
};

export type ResidualOutstanding = {
  venueId: string;
  symbol: string;
  side: ResidualSide;
  priceLevelKey: string;
  priceToman: number;
  outstandingConsumedMicros: number;
  lastRawDisplayedMicros: number | null;
  absentConsecutiveSnapshots: number;
  lastSeenSnapshotGeneration: string | null;
  lastSeenBookHash: string | null;
  updatedAtMs: number | null;
};

export type ResidualConsumeLevel = {
  venueId: string;
  symbol: string;
  side: ResidualSide;
  priceToman: number;
  quantityMicros: number;
  rawDisplayedMicros: number | null;
  immutableGeneration: string | null;
  immutableBookHash: string | null;
  rawSnapshotId: string | null;
  arrivalSnapshotId: string | null;
};

export type ResidualReleaseReason =
  | "level_absent_n_snapshots"
  | "conservative_quantity_delta"
  | "paper_ttl_decay"
  | "session_stopped"
  | "explicit_test_reset";

export type ResidualConsumeReason =
  | "fill_consume"
  | "leg_partial_consume"
  | "leg_risk_first_leg_consume";

export type ResidualRefillModelConfig = {
  absentSnapshotsToRelease: number;
  /** When true, raw qty increase releases min(delta, outstanding). */
  conservativeQuantityDelta: boolean;
  /** Paper simulation TTL; null disables. Not a market fact. */
  paperTtlDecayMs: number | null;
};

export const DEFAULT_REFILL_MODEL: ResidualRefillModelConfig = {
  absentSnapshotsToRelease: DEFAULT_ABSENT_SNAPSHOTS_TO_RELEASE,
  conservativeQuantityDelta: true,
  paperTtlDecayMs: DEFAULT_PAPER_TTL_DECAY_MS
};

/** Deterministic price-level identity — quantized integer toman. */
export function priceLevelKey(priceToman: number): string {
  const p = Math.round(priceToman);
  return `p${p}`;
}

export function residualLevelKey(parts: ResidualLevelKeyParts): string {
  const symbol = parts.symbol ?? RESIDUAL_SYMBOL_DEFAULT;
  return [
    parts.paperSessionId,
    parts.venueId,
    symbol,
    parts.side,
    priceLevelKey(parts.priceToman)
  ].join("|");
}

export function bookSideToResidual(side: BookSide): ResidualSide {
  // buy walks asks; sell walks bids
  return side === "buy" ? "ask" : "bid";
}

export function effectiveQtyMicros(
  rawDisplayedMicros: number,
  activeSessionConsumptionMicros: number
): number {
  return Math.max(0, Math.round(rawDisplayedMicros) - Math.max(0, Math.round(activeSessionConsumptionMicros)));
}

/**
 * Reduce one book side by outstanding consumption at matching prices.
 * Returns a new array; never mutates input.
 */
export function applyConsumptionToLevels(
  levels: BookLevel[] | null | undefined,
  side: ResidualSide,
  outstanding: ReadonlyMap<string, number>,
  venueId: string,
  symbol: string = RESIDUAL_SYMBOL_DEFAULT
): BookLevel[] | null {
  if (!levels) return levels ?? null;
  return levels.map((lvl) => {
    const key = `${venueId}|${symbol}|${side}|${priceLevelKey(lvl.priceToman)}`;
    const consumed = outstanding.get(key) ?? 0;
    if (consumed <= 0) return { ...lvl };
    const rawMicros = usdtToMicros(lvl.amountUsdt);
    const eff = effectiveQtyMicros(rawMicros, consumed);
    return { priceToman: lvl.priceToman, amountUsdt: microsToUsdt(eff) };
  });
}

export function outstandingMapKey(
  venueId: string,
  side: ResidualSide,
  priceToman: number,
  symbol: string = RESIDUAL_SYMBOL_DEFAULT
): string {
  return `${venueId}|${symbol}|${side}|${priceLevelKey(priceToman)}`;
}

/** Immutable book generation: prefer fabric sequence, else run/received composite. */
export function snapshotGeneration(snap: NormalizedSourceSnapshot, runId?: string | null): string {
  const seq = snap.marketData?.sequence;
  if (seq != null && Number.isFinite(seq)) {
    return `${snap.sourceId}:seq:${seq}`;
  }
  const recv = snap.marketData?.receiveTimestamp ?? snap.receivedAt;
  const run = runId ?? "norun";
  return `${snap.sourceId}:recv:${recv}:run:${run}`;
}

/** Stable hash over sorted price/qty levels (not order-identity of resting orders). */
export function bookHash(
  bids: BookLevel[] | null | undefined,
  asks: BookLevel[] | null | undefined
): string {
  const fmt = (levels: BookLevel[] | null | undefined, tag: string) => {
    if (!levels?.length) return `${tag}:empty`;
    return (
      tag +
      ":" +
      [...levels]
        .map((l) => `${Math.round(l.priceToman)}@${Math.round(l.amountUsdt * USDT_MICROS)}`)
        .sort()
        .join(",")
    );
  };
  // FNV-1a 32-bit over the canonical string
  const s = `${fmt(bids, "b")}|${fmt(asks, "a")}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `bh${(h >>> 0).toString(16).padStart(8, "0")}`;
}

export function applyResidualToSnapshot(
  snap: NormalizedSourceSnapshot,
  outstanding: ReadonlyMap<string, number>,
  symbol: string = RESIDUAL_SYMBOL_DEFAULT
): NormalizedSourceSnapshot {
  const venueId = snap.sourceId;
  return {
    ...snap,
    bookBids: applyConsumptionToLevels(snap.bookBids, "bid", outstanding, venueId, symbol),
    bookAsks: applyConsumptionToLevels(snap.bookAsks, "ask", outstanding, venueId, symbol)
  };
}

export function applyResidualToSnapshots(
  sources: NormalizedSourceSnapshot[],
  outstanding: ReadonlyMap<string, number>,
  symbol: string = RESIDUAL_SYMBOL_DEFAULT
): NormalizedSourceSnapshot[] {
  return sources.map((s) => applyResidualToSnapshot(s, outstanding, symbol));
}

/** In-memory session residual book for same-cycle + cross-cycle accounting. */
export class ResidualLiquidityBook {
  private outstanding = new Map<string, number>();
  private meta = new Map<string, ResidualOutstanding>();

  constructor(seed: ResidualOutstanding[] = []) {
    for (const row of seed) {
      const k = outstandingMapKey(row.venueId, row.side, row.priceToman, row.symbol);
      this.outstanding.set(k, Math.max(0, Math.round(row.outstandingConsumedMicros)));
      this.meta.set(k, { ...row });
    }
  }

  getOutstandingMicros(venueId: string, side: ResidualSide, priceToman: number, symbol = RESIDUAL_SYMBOL_DEFAULT): number {
    return this.outstanding.get(outstandingMapKey(venueId, side, priceToman, symbol)) ?? 0;
  }

  asMap(): ReadonlyMap<string, number> {
    return this.outstanding;
  }

  snapshot(): ResidualOutstanding[] {
    return [...this.meta.values()].map((r) => ({ ...r }));
  }

  /**
   * Consume qty at a price level. Returns actual consumed (may clip if needed).
   * Does not release. Idempotency is the caller's responsibility at persist time.
   */
  consume(input: {
    venueId: string;
    side: ResidualSide;
    priceToman: number;
    quantityMicros: number;
    symbol?: string;
    rawDisplayedMicros?: number | null;
    generation?: string | null;
    bookHash?: string | null;
    nowMs?: number;
  }): { prior: number; consumed: number; outstandingAfter: number; effectiveRemaining: number } {
    const symbol = input.symbol ?? RESIDUAL_SYMBOL_DEFAULT;
    const qty = Math.max(0, Math.round(input.quantityMicros));
    const k = outstandingMapKey(input.venueId, input.side, input.priceToman, symbol);
    const prior = this.outstanding.get(k) ?? 0;
    const outstandingAfter = prior + qty;
    this.outstanding.set(k, outstandingAfter);
    const raw = input.rawDisplayedMicros ?? this.meta.get(k)?.lastRawDisplayedMicros ?? null;
    const prev = this.meta.get(k);
    this.meta.set(k, {
      venueId: input.venueId,
      symbol,
      side: input.side,
      priceLevelKey: priceLevelKey(input.priceToman),
      priceToman: Math.round(input.priceToman),
      outstandingConsumedMicros: outstandingAfter,
      lastRawDisplayedMicros: raw,
      absentConsecutiveSnapshots: 0,
      lastSeenSnapshotGeneration: input.generation ?? prev?.lastSeenSnapshotGeneration ?? null,
      lastSeenBookHash: input.bookHash ?? prev?.lastSeenBookHash ?? null,
      updatedAtMs: input.nowMs ?? prev?.updatedAtMs ?? null
    });
    const effectiveRemaining =
      raw == null ? Math.max(0, 0 - outstandingAfter) : effectiveQtyMicros(raw, outstandingAfter);
    return { prior, consumed: qty, outstandingAfter, effectiveRemaining };
  }

  /**
   * Release up to `quantityMicros` of outstanding. Never goes negative.
   * Returns actual released (0 if already zero — caller must still avoid double-release via idempotency).
   */
  release(input: {
    venueId: string;
    side: ResidualSide;
    priceToman: number;
    quantityMicros: number;
    symbol?: string;
    nowMs?: number;
  }): { prior: number; released: number; outstandingAfter: number } {
    const symbol = input.symbol ?? RESIDUAL_SYMBOL_DEFAULT;
    const want = Math.max(0, Math.round(input.quantityMicros));
    const k = outstandingMapKey(input.venueId, input.side, input.priceToman, symbol);
    const prior = this.outstanding.get(k) ?? 0;
    const released = Math.min(prior, want);
    const outstandingAfter = prior - released;
    this.outstanding.set(k, outstandingAfter);
    const prev = this.meta.get(k);
    if (prev) {
      this.meta.set(k, {
        ...prev,
        outstandingConsumedMicros: outstandingAfter,
        updatedAtMs: input.nowMs ?? prev.updatedAtMs
      });
    }
    return { prior, released, outstandingAfter };
  }
}

export type RefillAction = {
  venueId: string;
  symbol: string;
  side: ResidualSide;
  priceToman: number;
  priceLevelKey: string;
  releaseMicros: number;
  reason: ResidualReleaseReason;
  evidence: Record<string, unknown>;
};

/**
 * Reconcile outstanding vs a fresh snapshot set.
 * NEVER clears solely because generation changed.
 */
export function planRefillActions(input: {
  outstanding: ResidualOutstanding[];
  sources: NormalizedSourceSnapshot[];
  runId?: string | null;
  nowMs: number;
  config?: Partial<ResidualRefillModelConfig>;
}): RefillAction[] {
  const cfg: ResidualRefillModelConfig = { ...DEFAULT_REFILL_MODEL, ...input.config };
  const actions: RefillAction[] = [];

  // Build observed raw qty per level from current sources.
  const observed = new Map<string, { rawMicros: number; generation: string; hash: string; venueId: string; side: ResidualSide; priceToman: number; symbol: string }>();
  for (const snap of input.sources) {
    const generation = snapshotGeneration(snap, input.runId);
    const hash = bookHash(snap.bookBids, snap.bookAsks);
    const ingest = (levels: BookLevel[] | null | undefined, side: ResidualSide) => {
      if (!levels) return;
      for (const lvl of levels) {
        if (!Number.isFinite(lvl.priceToman) || !Number.isFinite(lvl.amountUsdt)) continue;
        const symbol = RESIDUAL_SYMBOL_DEFAULT;
        const k = outstandingMapKey(snap.sourceId, side, lvl.priceToman, symbol);
        const rawMicros = usdtToMicros(lvl.amountUsdt);
        const prev = observed.get(k);
        // Same price may appear once; if duplicate, take max displayed (conservative).
        const merged = prev ? Math.max(prev.rawMicros, rawMicros) : rawMicros;
        observed.set(k, {
          rawMicros: merged,
          generation,
          hash,
          venueId: snap.sourceId,
          side,
          priceToman: Math.round(lvl.priceToman),
          symbol
        });
      }
    };
    ingest(snap.bookBids, "bid");
    ingest(snap.bookAsks, "ask");
  }

  for (const row of input.outstanding) {
    if (row.outstandingConsumedMicros <= 0) continue;
    const k = outstandingMapKey(row.venueId, row.side, row.priceToman, row.symbol);
    const obs = observed.get(k);

    // Optional Paper TTL decay (simulation assumption).
    if (
      cfg.paperTtlDecayMs != null &&
      cfg.paperTtlDecayMs > 0 &&
      row.updatedAtMs != null &&
      input.nowMs - row.updatedAtMs >= cfg.paperTtlDecayMs
    ) {
      actions.push({
        venueId: row.venueId,
        symbol: row.symbol,
        side: row.side,
        priceToman: row.priceToman,
        priceLevelKey: row.priceLevelKey,
        releaseMicros: row.outstandingConsumedMicros,
        reason: "paper_ttl_decay",
        evidence: {
          paperSimulationAssumption: true,
          ttlMs: cfg.paperTtlDecayMs,
          updatedAtMs: row.updatedAtMs,
          nowMs: input.nowMs,
          note: "Paper TTL decay is a simulation assumption, not market fact"
        }
      });
      continue;
    }

    if (!obs) {
      const absent = (row.absentConsecutiveSnapshots ?? 0) + 1;
      if (absent >= cfg.absentSnapshotsToRelease) {
        actions.push({
          venueId: row.venueId,
          symbol: row.symbol,
          side: row.side,
          priceToman: row.priceToman,
          priceLevelKey: row.priceLevelKey,
          releaseMicros: row.outstandingConsumedMicros,
          reason: "level_absent_n_snapshots",
          evidence: {
            absentConsecutiveSnapshots: absent,
            threshold: cfg.absentSnapshotsToRelease,
            priorGeneration: row.lastSeenSnapshotGeneration
          }
        });
      }
      // If below threshold, caller should bump absent counter without releasing.
      else {
        actions.push({
          venueId: row.venueId,
          symbol: row.symbol,
          side: row.side,
          priceToman: row.priceToman,
          priceLevelKey: row.priceLevelKey,
          releaseMicros: 0,
          reason: "level_absent_n_snapshots",
          evidence: {
            absentConsecutiveSnapshots: absent,
            threshold: cfg.absentSnapshotsToRelease,
            bumpOnly: true
          }
        });
      }
      continue;
    }

    // Level present: generation change alone does NOT release.
    if (cfg.conservativeQuantityDelta) {
      const priorRaw = row.lastRawDisplayedMicros;
      if (priorRaw != null && obs.rawMicros > priorRaw) {
        const delta = obs.rawMicros - priorRaw;
        const releaseMicros = Math.min(delta, row.outstandingConsumedMicros);
        if (releaseMicros > 0) {
          actions.push({
            venueId: row.venueId,
            symbol: row.symbol,
            side: row.side,
            priceToman: row.priceToman,
            priceLevelKey: row.priceLevelKey,
            releaseMicros,
            reason: "conservative_quantity_delta",
            evidence: {
              priorRawDisplayedMicros: priorRaw,
              newRawDisplayedMicros: obs.rawMicros,
              deltaMicros: delta,
              generationChanged: obs.generation !== row.lastSeenSnapshotGeneration,
              note: "Only the displayed qty increase is treated as possible replenishment; identity of resting orders is not assumed"
            }
          });
        }
      }
    }
  }

  return actions;
}

/**
 * Derive per-level consume records from a walk on the RAW (pre-consumption) or
 * effective book. Prefer walking the book that backed the fill at the ACTUAL
 * executed quantity for that leg.
 */
export function consumeLevelsFromWalk(input: {
  venueId: string;
  side: BookSide;
  /** Levels that backed the fill (prefer EFFECTIVE / residual-reduced). */
  levels: BookLevel[] | null | undefined;
  quantityMicros: number;
  generation?: string | null;
  bookHash?: string | null;
  rawSnapshotId?: string | null;
  arrivalSnapshotId?: string | null;
  symbol?: string;
  /**
   * Optional RAW displayed book at the same venue/side. When provided,
   * rawDisplayedMicros is taken from the raw level at each walked price
   * (not from the effective amount). Walk order/qty still follow `levels`.
   */
  rawLevels?: BookLevel[] | null | undefined;
}): ResidualConsumeLevel[] {
  const symbol = input.symbol ?? RESIDUAL_SYMBOL_DEFAULT;
  const residualSide = bookSideToResidual(input.side);
  if (!input.levels?.length || input.quantityMicros <= 0) return [];
  const rawByPrice = new Map<number, number>();
  if (input.rawLevels?.length) {
    for (const rl of input.rawLevels) {
      if (!Number.isFinite(rl.priceToman) || !Number.isFinite(rl.amountUsdt)) continue;
      const p = Math.round(rl.priceToman);
      const m = usdtToMicros(rl.amountUsdt);
      rawByPrice.set(p, Math.max(rawByPrice.get(p) ?? 0, m));
    }
  }
  // Inline walk to avoid circular import issues at module init; mirror walkBook.
  const ordered =
    input.side === "buy"
      ? [...input.levels].sort((a, b) => a.priceToman - b.priceToman)
      : [...input.levels].sort((a, b) => b.priceToman - a.priceToman);
  let remaining = Math.round(input.quantityMicros);
  const out: ResidualConsumeLevel[] = [];
  for (const level of ordered) {
    if (remaining <= 0) break;
    const levelMicros = usdtToMicros(level.amountUsdt);
    if (levelMicros <= 0) continue;
    const take = Math.min(remaining, levelMicros);
    const price = Math.round(level.priceToman);
    const rawDisplayedMicros = rawByPrice.has(price) ? rawByPrice.get(price)! : levelMicros;
    out.push({
      venueId: input.venueId,
      symbol,
      side: residualSide,
      priceToman: price,
      quantityMicros: take,
      rawDisplayedMicros,
      immutableGeneration: input.generation ?? null,
      immutableBookHash: input.bookHash ?? null,
      rawSnapshotId: input.rawSnapshotId ?? null,
      arrivalSnapshotId: input.arrivalSnapshotId ?? null
    });
    remaining -= take;
  }
  return out;
}

/** Terminal reasons for residual / raw depth exhaustion (exact; never sizing_blocked). */
export const PAPER_RESIDUAL_LIQUIDITY_EXHAUSTED = "paper_residual_liquidity_exhausted" as const;
export const RAW_EXCHANGE_DEPTH_INSUFFICIENT = "raw_exchange_depth_insufficient" as const;

export function classifyDepthExhaustion(input: {
  rawFilledMicros: number;
  effectiveFilledMicros: number;
  requestedMicros: number;
}): typeof PAPER_RESIDUAL_LIQUIDITY_EXHAUSTED | typeof RAW_EXCHANGE_DEPTH_INSUFFICIENT | null {
  if (input.effectiveFilledMicros >= input.requestedMicros && input.requestedMicros > 0) {
    return null;
  }
  if (input.rawFilledMicros >= input.requestedMicros && input.effectiveFilledMicros < input.requestedMicros) {
    return PAPER_RESIDUAL_LIQUIDITY_EXHAUSTED;
  }
  if (input.rawFilledMicros < input.requestedMicros) {
    return RAW_EXCHANGE_DEPTH_INSUFFICIENT;
  }
  return PAPER_RESIDUAL_LIQUIDITY_EXHAUSTED;
}
