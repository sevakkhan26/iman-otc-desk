/**
 * Persist session-scoped residual liquidity + append-only events.
 * All mutations run under runSerialized / caller transactions for PGlite safety.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { asDbError, getDbAsync } from "@/db/client";
import { runSerialized } from "@/db/repositories/shadowArbitrage";
import {
  shadowPaperResidualLiquidity,
  shadowPaperResidualLiquidityEvents
} from "@/db/schema";
import {
  type ResidualOutstanding,
  type ResidualConsumeLevel,
  type ResidualReleaseReason,
  type ResidualConsumeReason,
  type RefillAction,
  priceLevelKey,
  RESIDUAL_SYMBOL_DEFAULT,
  planRefillActions,
  ResidualLiquidityBook,
  type ResidualRefillModelConfig
} from "@/lib/shadowArbitrage/paper/residualLiquidity";
import type { NormalizedSourceSnapshot } from "@/lib/shadowArbitrage/types";

const serial = runSerialized;

export type ResidualRow = ResidualOutstanding & { id: string; state: string };

function toOutstanding(row: typeof shadowPaperResidualLiquidity.$inferSelect): ResidualRow {
  return {
    id: row.id,
    venueId: row.venueId,
    symbol: row.symbol,
    side: row.side as ResidualOutstanding["side"],
    priceLevelKey: row.priceLevelKey,
    priceToman: Number(row.priceToman),
    outstandingConsumedMicros: Number(row.outstandingConsumedMicros),
    lastRawDisplayedMicros:
      row.lastRawDisplayedMicros == null ? null : Number(row.lastRawDisplayedMicros),
    absentConsecutiveSnapshots: Number(row.absentConsecutiveSnapshots ?? 0),
    lastSeenSnapshotGeneration: row.lastSeenSnapshotGeneration,
    lastSeenBookHash: row.lastSeenBookHash,
    updatedAtMs: row.updatedAt ? Date.parse(row.updatedAt) : null,
    state: row.state
  };
}

export async function loadSessionResidualOutstanding(
  paperSessionId: string
): Promise<ResidualRow[]> {
  try {
    const db = await getDbAsync();
    return await serial(async () => {
      const rows = await db
        .select()
        .from(shadowPaperResidualLiquidity)
        .where(
          and(
            eq(shadowPaperResidualLiquidity.paperSessionId, paperSessionId),
            eq(shadowPaperResidualLiquidity.state, "ACTIVE")
          )
        );
      return rows
        .map(toOutstanding)
        .filter((r) => r.outstandingConsumedMicros > 0 || r.absentConsecutiveSnapshots > 0);
    });
  } catch (error) {
    throw asDbError(error, "loadSessionResidualOutstanding");
  }
}

export async function loadResidualBook(paperSessionId: string): Promise<ResidualLiquidityBook> {
  const rows = await loadSessionResidualOutstanding(paperSessionId);
  return new ResidualLiquidityBook(rows);
}

function isUniqueViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /unique|duplicate key|23505/i.test(msg);
}

export type PersistConsumeInput = {
  paperSessionId: string;
  levels: ResidualConsumeLevel[];
  reason: ResidualConsumeReason;
  fillLedgerId: string;
  lifecycleId: string;
  decisionTraceId: string | null;
  occurredAt: string;
  evidence?: Record<string, unknown>;
};

/**
 * Atomically consume levels for a fill. Idempotent per (fill, level, reason).
 * Intended to run inside the same DB transaction as the fill insert when possible;
 * when called standalone, uses its own transaction under serial.
 */
export async function persistResidualConsumption(
  input: PersistConsumeInput,
  tx?: { insert: Function; select: Function; update: Function }
): Promise<{ events: number; duplicates: number }> {
  const run = async (db: {
    insert: Function;
    select: Function;
    update: Function;
    transaction?: Function;
  }) => {
    let events = 0;
    let duplicates = 0;
    for (const level of input.levels) {
      if (level.quantityMicros <= 0) continue;
      const plk = priceLevelKey(level.priceToman);
      const idempotencyKey = [
        "consume",
        input.paperSessionId,
        input.fillLedgerId,
        level.venueId,
        level.side,
        plk,
        input.reason
      ].join("|");

      // Idempotency first — never bump outstanding twice on retry.
      const priorEvent = await db
        .select({ id: shadowPaperResidualLiquidityEvents.id })
        .from(shadowPaperResidualLiquidityEvents)
        .where(eq(shadowPaperResidualLiquidityEvents.idempotencyKey, idempotencyKey))
        .limit(1);
      if (priorEvent[0]) {
        duplicates += 1;
        continue;
      }

      // Upsert residual row
      const existing = await db
        .select()
        .from(shadowPaperResidualLiquidity)
        .where(
          and(
            eq(shadowPaperResidualLiquidity.paperSessionId, input.paperSessionId),
            eq(shadowPaperResidualLiquidity.venueId, level.venueId),
            eq(shadowPaperResidualLiquidity.symbol, level.symbol),
            eq(shadowPaperResidualLiquidity.side, level.side),
            eq(shadowPaperResidualLiquidity.priceLevelKey, plk)
          )
        )
        .limit(1);

      let residualId: string;
      let prior: number;
      let outstandingAfter: number;

      if (existing[0]) {
        residualId = existing[0].id;
        prior = Number(existing[0].outstandingConsumedMicros);
        outstandingAfter = prior + level.quantityMicros;
        await db
          .update(shadowPaperResidualLiquidity)
          .set({
            outstandingConsumedMicros: outstandingAfter,
            lifetimeConsumedMicros:
              Number(existing[0].lifetimeConsumedMicros) + level.quantityMicros,
            lastRawDisplayedMicros:
              level.rawDisplayedMicros ?? existing[0].lastRawDisplayedMicros,
            absentConsecutiveSnapshots: 0,
            lastSeenSnapshotGeneration:
              level.immutableGeneration ?? existing[0].lastSeenSnapshotGeneration,
            lastSeenBookHash: level.immutableBookHash ?? existing[0].lastSeenBookHash,
            state: "ACTIVE",
            updatedAt: input.occurredAt
          })
          .where(eq(shadowPaperResidualLiquidity.id, residualId));
      } else {
        residualId = randomUUID();
        prior = 0;
        outstandingAfter = level.quantityMicros;
        await db.insert(shadowPaperResidualLiquidity).values({
          id: residualId,
          paperSessionId: input.paperSessionId,
          venueId: level.venueId,
          symbol: level.symbol,
          side: level.side,
          priceLevelKey: plk,
          priceToman: level.priceToman,
          outstandingConsumedMicros: outstandingAfter,
          lifetimeConsumedMicros: level.quantityMicros,
          lifetimeReleasedMicros: 0,
          lastRawDisplayedMicros: level.rawDisplayedMicros,
          absentConsecutiveSnapshots: 0,
          lastSeenSnapshotGeneration: level.immutableGeneration,
          lastSeenBookHash: level.immutableBookHash,
          state: "ACTIVE",
          updatedAt: input.occurredAt,
          createdAt: input.occurredAt
        });
      }

      const effectiveRemaining =
        level.rawDisplayedMicros == null
          ? null
          : Math.max(0, level.rawDisplayedMicros - outstandingAfter);

      try {
        await db.insert(shadowPaperResidualLiquidityEvents).values({
          id: randomUUID(),
          paperSessionId: input.paperSessionId,
          residualId,
          venueId: level.venueId,
          symbol: level.symbol,
          side: level.side,
          priceLevelKey: plk,
          priceToman: level.priceToman,
          eventKind: "consume",
          deltaMicros: level.quantityMicros,
          outstandingAfterMicros: outstandingAfter,
          reason: input.reason,
          idempotencyKey,
          fillLedgerId: input.fillLedgerId,
          lifecycleId: input.lifecycleId,
          decisionTraceId: input.decisionTraceId,
          rawSnapshotId: level.rawSnapshotId,
          arrivalSnapshotId: level.arrivalSnapshotId,
          immutableGeneration: level.immutableGeneration,
          immutableBookHash: level.immutableBookHash,
          rawDisplayedMicros: level.rawDisplayedMicros,
          priorOutstandingMicros: prior,
          actualConsumedMicros: level.quantityMicros,
          effectiveRemainingMicros: effectiveRemaining,
          evidence: input.evidence ?? {},
          occurredAt: input.occurredAt,
          createdAt: input.occurredAt
        });
        events += 1;
      } catch (e) {
        if (isUniqueViolation(e)) {
          duplicates += 1;
        } else {
          throw e;
        }
      }
    }
    return { events, duplicates };
  };

  try {
    if (tx) return await run(tx as never);
    const db = await getDbAsync();
    return await serial(async () =>
      db.transaction(async (inner) => run(inner as never))
    );
  } catch (error) {
    throw asDbError(error, "persistResidualConsumption");
  }
}

export type PersistReleaseInput = {
  paperSessionId: string;
  action: RefillAction;
  occurredAt: string;
  idempotencySuffix: string;
};

export async function persistResidualRelease(
  input: PersistReleaseInput,
  tx?: { insert: Function; select: Function; update: Function }
): Promise<{ released: number; duplicate: boolean }> {
  const run = async (db: { insert: Function; select: Function; update: Function }) => {
    const a = input.action;
    const plk = a.priceLevelKey || priceLevelKey(a.priceToman);
    const idempotencyKey = [
      "release",
      input.paperSessionId,
      a.venueId,
      a.side,
      plk,
      a.reason,
      input.idempotencySuffix
    ].join("|");

    const priorEvent = await db
      .select({ id: shadowPaperResidualLiquidityEvents.id })
      .from(shadowPaperResidualLiquidityEvents)
      .where(eq(shadowPaperResidualLiquidityEvents.idempotencyKey, idempotencyKey))
      .limit(1);
    if (priorEvent[0]) {
      return { released: 0, duplicate: true };
    }

    const existing = await db
      .select()
      .from(shadowPaperResidualLiquidity)
      .where(
        and(
          eq(shadowPaperResidualLiquidity.paperSessionId, input.paperSessionId),
          eq(shadowPaperResidualLiquidity.venueId, a.venueId),
          eq(shadowPaperResidualLiquidity.symbol, a.symbol),
          eq(shadowPaperResidualLiquidity.side, a.side),
          eq(shadowPaperResidualLiquidity.priceLevelKey, plk)
        )
      )
      .limit(1);

    if (!existing[0]) {
      if (a.evidence?.bumpOnly && a.releaseMicros === 0) {
        // Create row to track absence counter only.
        const id = randomUUID();
        await db.insert(shadowPaperResidualLiquidity).values({
          id,
          paperSessionId: input.paperSessionId,
          venueId: a.venueId,
          symbol: a.symbol,
          side: a.side,
          priceLevelKey: plk,
          priceToman: a.priceToman,
          outstandingConsumedMicros: 0,
          lifetimeConsumedMicros: 0,
          lifetimeReleasedMicros: 0,
          lastRawDisplayedMicros: null,
          absentConsecutiveSnapshots: Number(a.evidence.absentConsecutiveSnapshots ?? 1),
          lastSeenSnapshotGeneration: null,
          lastSeenBookHash: null,
          state: "ACTIVE",
          updatedAt: input.occurredAt,
          createdAt: input.occurredAt
        });
        return { released: 0, duplicate: false };
      }
      return { released: 0, duplicate: false };
    }

    const row = existing[0];
    const prior = Number(row.outstandingConsumedMicros);

    // Bump-only absence tracking (no release yet).
    if (a.evidence?.bumpOnly && a.releaseMicros === 0) {
      await db
        .update(shadowPaperResidualLiquidity)
        .set({
          absentConsecutiveSnapshots: Number(a.evidence.absentConsecutiveSnapshots ?? 0),
          updatedAt: input.occurredAt
        })
        .where(eq(shadowPaperResidualLiquidity.id, row.id));
      return { released: 0, duplicate: false };
    }

    const release = Math.min(prior, Math.max(0, Math.round(a.releaseMicros)));
    if (release <= 0 && a.reason !== "level_absent_n_snapshots") {
      return { released: 0, duplicate: false };
    }
    const outstandingAfter = Math.max(0, prior - release);

    try {
      await db.insert(shadowPaperResidualLiquidityEvents).values({
        id: randomUUID(),
        paperSessionId: input.paperSessionId,
        residualId: row.id,
        venueId: a.venueId,
        symbol: a.symbol,
        side: a.side,
        priceLevelKey: plk,
        priceToman: a.priceToman,
        eventKind: "release",
        deltaMicros: -release,
        outstandingAfterMicros: outstandingAfter,
        reason: a.reason,
        idempotencyKey,
        fillLedgerId: null,
        lifecycleId: null,
        decisionTraceId: null,
        rawSnapshotId: null,
        arrivalSnapshotId: null,
        immutableGeneration: null,
        immutableBookHash: null,
        rawDisplayedMicros: null,
        priorOutstandingMicros: prior,
        actualConsumedMicros: null,
        effectiveRemainingMicros: null,
        evidence: a.evidence,
        occurredAt: input.occurredAt,
        createdAt: input.occurredAt
      });
    } catch (e) {
      if (isUniqueViolation(e)) return { released: 0, duplicate: true };
      throw e;
    }

    await db
      .update(shadowPaperResidualLiquidity)
      .set({
        outstandingConsumedMicros: outstandingAfter,
        lifetimeReleasedMicros: Number(row.lifetimeReleasedMicros) + release,
        absentConsecutiveSnapshots:
          a.reason === "level_absent_n_snapshots" ? 0 : row.absentConsecutiveSnapshots,
        state: outstandingAfter === 0 && a.reason === "level_absent_n_snapshots" ? "CLEARED" : "ACTIVE",
        updatedAt: input.occurredAt
      })
      .where(eq(shadowPaperResidualLiquidity.id, row.id));

    return { released: release, duplicate: false };
  };

  try {
    if (tx) return await run(tx as never);
    const db = await getDbAsync();
    return await serial(async () =>
      db.transaction(async (inner) => run(inner as never))
    );
  } catch (error) {
    throw asDbError(error, "persistResidualRelease");
  }
}

/**
 * Apply refill model against current sources; persist releases / absence bumps.
 * Generation change alone never clears outstanding.
 */
export async function reconcileSessionResidualWithSnapshots(input: {
  paperSessionId: string;
  sources: NormalizedSourceSnapshot[];
  runId?: string | null;
  nowMs: number;
  occurredAt: string;
  config?: Partial<ResidualRefillModelConfig>;
}): Promise<{ actions: number; releasedMicros: number }> {
  const outstanding = await loadSessionResidualOutstanding(input.paperSessionId);
  const actions = planRefillActions({
    outstanding,
    sources: input.sources,
    runId: input.runId,
    nowMs: input.nowMs,
    config: input.config
  });

  // Also refresh last_raw / generation for levels that are present (no release).
  try {
    const db = await getDbAsync();
    await serial(async () => {
      await db.transaction(async (tx) => {
        for (const snap of input.sources) {
          const gen = `${snap.sourceId}:recv:${snap.marketData?.receiveTimestamp ?? snap.receivedAt}:run:${input.runId ?? "norun"}`;
          for (const [levels, side] of [
            [snap.bookBids, "bid"],
            [snap.bookAsks, "ask"]
          ] as const) {
            if (!levels) continue;
            for (const lvl of levels) {
              const plk = priceLevelKey(lvl.priceToman);
              const rows = await tx
                .select()
                .from(shadowPaperResidualLiquidity)
                .where(
                  and(
                    eq(shadowPaperResidualLiquidity.paperSessionId, input.paperSessionId),
                    eq(shadowPaperResidualLiquidity.venueId, snap.sourceId),
                    eq(shadowPaperResidualLiquidity.side, side),
                    eq(shadowPaperResidualLiquidity.priceLevelKey, plk)
                  )
                )
                .limit(1);
              if (!rows[0]) continue;
              await tx
                .update(shadowPaperResidualLiquidity)
                .set({
                  lastRawDisplayedMicros: Math.round(lvl.amountUsdt * 1_000_000),
                  absentConsecutiveSnapshots: 0,
                  lastSeenSnapshotGeneration: gen,
                  updatedAt: input.occurredAt
                })
                .where(eq(shadowPaperResidualLiquidity.id, rows[0].id));
            }
          }
        }
      });
    });
  } catch (error) {
    throw asDbError(error, "reconcileSessionResidual.refresh");
  }

  let releasedMicros = 0;
  let n = 0;
  const suffix = `cycle:${input.runId ?? "none"}:${input.occurredAt}`;
  for (const action of actions) {
    const r = await persistResidualRelease({
      paperSessionId: input.paperSessionId,
      action,
      occurredAt: input.occurredAt,
      idempotencySuffix: suffix
    });
    releasedMicros += r.released;
    n += 1;
  }
  return { actions: n, releasedMicros };
}
