/**
 * Phase 6 persistence — paper sessions, virtual balances and the immutable
 * ledger.
 *
 * Simulated state only. Nothing in this file represents a real exchange
 * account, order, deposit, withdrawal or transfer.
 *
 * Conventions inherited from the Phase 2 repository: uuid ids are generated
 * in-process with randomUUID() (the migration runner strips database-side
 * defaults for PGlite), and every statement runs inside the shared
 * serialization wrapper.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { asDbError, getDbAsync } from "@/db/client";
import { runSerialized } from "@/db/repositories/shadowArbitrage";
import {
  shadowPaperBalances,
  shadowPaperCandidateState,
  shadowPaperCycleSummaries,
  shadowPaperLedger,
  shadowPaperSessions
} from "@/db/schema";

export type PaperSessionMode = "PROVISIONAL_EVALUATION" | "APPROVED_PLAN";
export type PaperSessionStatus = "NOT_STARTED" | "RUNNING" | "PAUSED" | "STOPPED";

export type PaperSessionRow = {
  id: string;
  observationId: string | null;
  name: string;
  mode: PaperSessionMode;
  status: PaperSessionStatus;
  totalCapitalToman: number;
  valuationPriceToman: number;
  openingAllocations: Array<{ sourceId: string; irtToman: number; usdtUnits: number }>;
  approvalFingerprint: string | null;
  createdBy: string;
  startedAt: string | null;
  pausedAt: string | null;
  stoppedAt: string | null;
  lastCycleAt: string | null;
  cyclesEvaluated: number;
  tradesExecuted: number;
  candidatesSkipped: number;
  note: string | null;
  createdAt: string;
};

export type PaperBalanceRow = {
  sourceId: string;
  irtToman: number;
  usdtMicros: number;
};

export type PaperLedgerRow = {
  id: string;
  eventType: string | null;
  reasonCodes: string[];
  sessionId: string;
  runId: string | null;
  lifecycleId: string;
  routeKey: string;
  outcome: "FILLED" | "SKIPPED";
  rejectionCode: string | null;
  rejectionReason: string | null;
  requiredRebalance: string | null;
  buySourceId: string;
  sellSourceId: string;
  sizeUsdt: number;
  buyVwapToman: number | null;
  sellVwapToman: number | null;
  buyNotionalToman: number | null;
  sellNotionalToman: number | null;
  buyFeeBps: number | null;
  sellFeeBps: number | null;
  buyFeeAsset: string | null;
  buyFeeDebitMode: string | null;
  buyFeeProvenance: string | null;
  sellFeeAsset: string | null;
  sellFeeDebitMode: string | null;
  sellFeeProvenance: string | null;
  feeTomanTotal: number | null;
  feeUsdtMicrosTotal: number | null;
  slippageBufferToman: number | null;
  grossSpreadToman: number | null;
  markPriceToman: number | null;
  cashPnlIrtToman: number | null;
  inventoryDeltaUsdtMicros: number | null;
  sellFeeValueToman: number | null;
  economicNetPnlToman: number | null;
  riskAdjustedPnlToman: number | null;
  balancesAfter: Array<{ sourceId: string; irtToman: number; usdtMicros: number }>;
  /**
   * SMART_CAPITAL_DEPTH decision evidence, from migration 0015. Null on any row
   * written before smart sizing — a null means "not recorded", never a value
   * invented to fill the gap.
   */
  sizingPolicy: string | null;
  sizingReason: string | null;
  limitingSide: string | null;
  limitingSourceId: string | null;
  limitingUsableUsdtMicros: number | null;
  capitalCapUsdtMicros: number | null;
  depthCapUsdtMicros: number | null;
  bindingConstraint: string | null;
  riskAdjustedReturnBps: number | null;
  selectedPercentOfUsable: number | null;
  inventoryImpactPoints: number | null;
  nextLargerSizeUsdt: number | null;
  nextLargerRejectionCode: string | null;
  nextLargerRejectionReason: string | null;
  nextLargerMarginalPnlToman: number | null;
  occurredAt: string;
};

function num(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * PGlite is a single WASM instance, so every statement must be serialized.
 * This shares the Phase 2 repository's reentrancy context on purpose: the paper
 * engine runs inside a collection cycle, and on PGlite that cycle already holds
 * the serialization queue. A private queue wrapper here would deadlock.
 */
const serial = runSerialized;

/**
 * Whether an error is a unique-constraint violation.
 *
 * Drivers wrap the original error, and the wrapper's message is only "Failed
 * query: ...", so the SQLSTATE has to be read from the cause chain rather than
 * pattern-matched on the top-level message.
 */
function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = error;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const rec = cur as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    if (rec.code === "23505") return true;
    if (typeof rec.constraint === "string" && rec.constraint.includes("idem")) return true;
    if (
      typeof rec.message === "string" &&
      /duplicate key|unique constraint|UNIQUE constraint/i.test(rec.message)
    ) {
      return true;
    }
    cur = rec.cause;
  }
  return false;
}

function toSession(r: typeof shadowPaperSessions.$inferSelect): PaperSessionRow {
  return {
    id: r.id,
    observationId: r.observationId,
    name: r.name,
    mode: r.mode === "APPROVED_PLAN" ? "APPROVED_PLAN" : "PROVISIONAL_EVALUATION",
    status: (["NOT_STARTED", "RUNNING", "PAUSED", "STOPPED"] as const).includes(
      r.status as PaperSessionStatus
    )
      ? (r.status as PaperSessionStatus)
      : "NOT_STARTED",
    totalCapitalToman: num(r.totalCapitalToman),
    valuationPriceToman: num(r.valuationPriceToman),
    openingAllocations: Array.isArray(r.openingAllocations) ? r.openingAllocations : [],
    approvalFingerprint: r.approvalFingerprint,
    createdBy: r.createdBy,
    startedAt: r.startedAt,
    pausedAt: r.pausedAt,
    stoppedAt: r.stoppedAt,
    lastCycleAt: r.lastCycleAt,
    cyclesEvaluated: r.cyclesEvaluated,
    tradesExecuted: r.tradesExecuted,
    candidatesSkipped: r.candidatesSkipped,
    note: r.note,
    createdAt: r.createdAt
  };
}

/**
 * The session the engine should act on: the newest one that is not stopped.
 * Returns null when no session exists — which is the state after a fresh
 * deployment, and why deployment never starts paper trading on its own.
 */
export async function getActivePaperSession(): Promise<PaperSessionRow | null> {
  try {
    const db = await getDbAsync();
    const rows = await serial(async () =>
      db
        .select()
        .from(shadowPaperSessions)
        .where(inArray(shadowPaperSessions.status, ["NOT_STARTED", "RUNNING", "PAUSED"]))
        .orderBy(desc(shadowPaperSessions.createdAt))
        .limit(1)
    );
    return rows[0] ? toSession(rows[0]) : null;
  } catch {
    return null;
  }
}

export async function listPaperSessions(limit = 20): Promise<PaperSessionRow[]> {
  try {
    const db = await getDbAsync();
    const rows = await serial(async () =>
      db
        .select()
        .from(shadowPaperSessions)
        .orderBy(desc(shadowPaperSessions.createdAt))
        .limit(Math.min(100, Math.max(1, limit)))
    );
    return rows.map(toSession);
  } catch {
    return [];
  }
}

export async function getPaperSession(id: string): Promise<PaperSessionRow | null> {
  try {
    const db = await getDbAsync();
    const rows = await serial(async () =>
      db.select().from(shadowPaperSessions).where(eq(shadowPaperSessions.id, id)).limit(1)
    );
    return rows[0] ? toSession(rows[0]) : null;
  } catch {
    return null;
  }
}

/**
 * Create a session and its opening virtual book in one go.
 * The session starts NOT_STARTED: an admin must start it explicitly.
 */
export async function createPaperSession(input: {
  observationId: string | null;
  name: string;
  mode: PaperSessionMode;
  totalCapitalToman: number;
  valuationPriceToman: number;
  openingAllocations: Array<{ sourceId: string; irtToman: number; usdtUnits: number }>;
  approvalFingerprint: string | null;
  createdBy: string;
  note?: string | null;
}): Promise<PaperSessionRow> {
  try {
    const db = await getDbAsync();
    const now = new Date().toISOString();
    const id = randomUUID();
    const row = {
      id,
      observationId: input.observationId,
      name: input.name,
      mode: input.mode,
      status: "NOT_STARTED" as const,
      totalCapitalToman: Math.round(input.totalCapitalToman),
      valuationPriceToman: Math.round(input.valuationPriceToman),
      openingAllocations: input.openingAllocations,
      approvalFingerprint: input.approvalFingerprint,
      createdBy: input.createdBy,
      startedAt: null,
      pausedAt: null,
      stoppedAt: null,
      lastCycleAt: null,
      cyclesEvaluated: 0,
      tradesExecuted: 0,
      candidatesSkipped: 0,
      note: input.note ?? null,
      createdAt: now,
      updatedAt: now
    };
    await serial(async () => {
      await db.insert(shadowPaperSessions).values(row);
      for (const a of input.openingAllocations) {
        await db.insert(shadowPaperBalances).values({
          id: `${id}|${a.sourceId}`,
          sessionId: id,
          sourceId: a.sourceId,
          irtToman: Math.max(0, Math.round(a.irtToman)),
          usdtMicros: Math.max(0, Math.round(a.usdtUnits * 1_000_000)),
          updatedAt: now
        });
      }
    });
    return toSession(row as typeof shadowPaperSessions.$inferSelect);
  } catch (error) {
    throw asDbError(error, "createPaperSession");
  }
}

/** Lifecycle transitions. Only status and timestamps change; history is kept. */
export async function setPaperSessionStatus(
  id: string,
  status: PaperSessionStatus
): Promise<PaperSessionRow | null> {
  try {
    const db = await getDbAsync();
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { status, updatedAt: now };
    if (status === "RUNNING") patch.pausedAt = null;
    if (status === "PAUSED") patch.pausedAt = now;
    if (status === "STOPPED") patch.stoppedAt = now;

    await serial(async () => {
      const existing = await db
        .select({ startedAt: shadowPaperSessions.startedAt })
        .from(shadowPaperSessions)
        .where(eq(shadowPaperSessions.id, id))
        .limit(1);
      if (status === "RUNNING" && !existing[0]?.startedAt) patch.startedAt = now;
      await db.update(shadowPaperSessions).set(patch).where(eq(shadowPaperSessions.id, id));
    });
    return getPaperSession(id);
  } catch (error) {
    throw asDbError(error, "setPaperSessionStatus");
  }
}

export async function loadPaperBalances(sessionId: string): Promise<PaperBalanceRow[]> {
  try {
    const db = await getDbAsync();
    const rows = await serial(async () =>
      db.select().from(shadowPaperBalances).where(eq(shadowPaperBalances.sessionId, sessionId))
    );
    return rows
      .map((r) => ({
        sourceId: r.sourceId,
        irtToman: num(r.irtToman),
        usdtMicros: num(r.usdtMicros)
      }))
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  } catch {
    return [];
  }
}

/** Lifecycle ids this session already filled — the idempotency memory. */
export async function loadFilledLifecycleIds(sessionId: string): Promise<Set<string>> {
  try {
    const db = await getDbAsync();
    const rows = await serial(async () =>
      db
        .select({ lifecycleId: shadowPaperLedger.lifecycleId })
        .from(shadowPaperLedger)
        .where(and(eq(shadowPaperLedger.sessionId, sessionId), eq(shadowPaperLedger.outcome, "FILLED")))
    );
    return new Set(rows.map((r) => r.lifecycleId));
  } catch {
    return new Set();
  }
}

export type PaperFillRecord = {
  lifecycleId: string;
  routeKey: string;
  buySourceId: string;
  sellSourceId: string;
  sizeUsdt: number;
  buyVwapToman: number;
  sellVwapToman: number;
  buyNotionalToman: number;
  sellNotionalToman: number;
  buyFeeBps: number;
  sellFeeBps: number;
  buyFeeAsset: string;
  buyFeeDebitMode: string;
  buyFeeProvenance: string;
  sellFeeAsset: string;
  sellFeeDebitMode: string;
  sellFeeProvenance: string;
  feeTomanTotal: number;
  feeUsdtMicrosTotal: number;
  slippageBufferToman: number;
  grossSpreadToman: number;
  markPriceToman: number;
  cashPnlIrtToman: number;
  inventoryDeltaUsdtMicros: number;
  sellFeeValueToman: number;
  economicNetPnlToman: number;
  riskAdjustedPnlToman: number;
  balancesAfter: Array<{ sourceId: string; irtToman: number; usdtMicros: number }>;
  /**
   * SMART_CAPITAL_DEPTH decision evidence.
   *
   * Optional on the type so a caller that has no sizing context still writes a
   * valid fill — the columns are nullable and a null means "not recorded",
   * never a value that was invented to fill the gap.
   */
  sizing?: {
    policy: string;
    reason: string;
    limitingSide: string;
    limitingSourceId: string;
    limitingUsableUsdtMicros: number;
    capitalCapUsdtMicros: number;
    depthCapUsdtMicros: number;
    bindingConstraint: string | null;
    riskAdjustedReturnBps: number;
    selectedPercentOfUsable: number | null;
    inventoryImpactPoints: number | null;
    nextLargerSizeUsdt: number | null;
    nextLargerRejectionCode: string | null;
    nextLargerRejectionReason: string | null;
    nextLargerMarginalPnlToman: number | null;
  };
};

export type PaperSkipRecord = {
  lifecycleId: string;
  routeKey: string;
  buySourceId: string;
  sellSourceId: string;
  sizeUsdt: number;
  /** Deterministic primary cause — never a generic message. */
  rejectionCode: string;
  /** Every exact cause that applied, canonically ordered. */
  reasonCodes: string[];
  rejectionReason: string;
  requiredRebalance: string | null;
};

export type PaperCandidateStateRow = {
  lifecycleId: string;
  routeKey: string;
  buySourceId: string;
  sellSourceId: string;
  sizeUsdt: number;
  decisionKey: string;
  outcome: string;
  primaryReason: string | null;
  reasonCodes: string[];
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  closedAt: string | null;
};

export type PaperCycleSummaryRow = {
  id: string;
  occurredAt: string;
  candidatesEvaluated: number;
  filled: number;
  skipped: number;
  detailedEventsWritten: number;
  reasonCounts: Record<string, number>;
};

function decisionKeyOf(outcome: string, reasonCodes: string[]): string {
  return `${outcome}:${[...reasonCodes].sort().join(",")}`;
}

/**
 * Commit one cycle's decisions.
 *
 * Volume discipline (v4.9.1): a detailed, immutable ledger row is written ONLY
 * when something actually changed for a candidate — it is seen for the first
 * time, its decision key changes, it fills, or it disappears from the market.
 * An unchanged blocked candidate only bumps a counter on its state row, so a
 * steady state costs one compact summary per cycle instead of one row per
 * candidate per cycle.
 *
 * Fills and balance updates still happen inside a single transaction, and the
 * unique index on the idempotency key still refuses a second fill of the same
 * lifecycle.
 */
export async function commitPaperCycle(input: {
  sessionId: string;
  runId: string | null;
  occurredAt: string;
  fills: PaperFillRecord[];
  skips: PaperSkipRecord[];
}): Promise<{
  filled: number;
  skipped: number;
  duplicates: number;
  detailedEventsWritten: number;
  reasonCounts: Record<string, number>;
}> {
  const db = await getDbAsync();
  let filled = 0;
  let duplicates = 0;
  let detailedEventsWritten = 0;
  const reasonCounts: Record<string, number> = {};

  try {
    await serial(async () => {
      // Existing decision state for this session, keyed by lifecycle.
      const stateRows = await db
        .select()
        .from(shadowPaperCandidateState)
        .where(eq(shadowPaperCandidateState.sessionId, input.sessionId));
      const stateByLifecycle = new Map(stateRows.map((r) => [r.lifecycleId, r]));
      const seen = new Set<string>();

      const upsertState = async (
        rec: {
          lifecycleId: string;
          routeKey: string;
          buySourceId: string;
          sellSourceId: string;
          sizeUsdt: number;
        },
        outcome: string,
        primary: string | null,
        codes: string[]
      ): Promise<"NEW" | "CHANGED" | "UNCHANGED"> => {
        const key = decisionKeyOf(outcome, codes);
        const existing = stateByLifecycle.get(rec.lifecycleId);
        if (!existing) {
          await db.insert(shadowPaperCandidateState).values({
            id: `${input.sessionId}|${rec.lifecycleId}`,
            sessionId: input.sessionId,
            lifecycleId: rec.lifecycleId,
            routeKey: rec.routeKey,
            buySourceId: rec.buySourceId,
            sellSourceId: rec.sellSourceId,
            sizeUsdt: String(rec.sizeUsdt),
            decisionKey: key,
            outcome,
            primaryReason: primary,
            reasonCodes: codes,
            occurrences: 1,
            firstSeenAt: input.occurredAt,
            lastSeenAt: input.occurredAt,
            lastChangedAt: input.occurredAt,
            closedAt: null
          });
          return "NEW";
        }
        if (existing.decisionKey === key && !existing.closedAt) {
          // Nothing changed: only the observation counter moves.
          await db
            .update(shadowPaperCandidateState)
            .set({ occurrences: existing.occurrences + 1, lastSeenAt: input.occurredAt })
            .where(eq(shadowPaperCandidateState.id, `${input.sessionId}|${rec.lifecycleId}`));
          return "UNCHANGED";
        }
        await db
          .update(shadowPaperCandidateState)
          .set({
            decisionKey: key,
            outcome,
            primaryReason: primary,
            reasonCodes: codes,
            occurrences: existing.occurrences + 1,
            lastSeenAt: input.occurredAt,
            lastChangedAt: input.occurredAt,
            closedAt: null
          })
          .where(eq(shadowPaperCandidateState.id, `${input.sessionId}|${rec.lifecycleId}`));
        return "CHANGED";
      };

      for (const f of input.fills) {
        seen.add(f.lifecycleId);
        const key = `${input.sessionId}|${f.lifecycleId}`;
        try {
          await db.transaction(async (tx) => {
            await tx.insert(shadowPaperLedger).values({
              id: randomUUID(),
              sessionId: input.sessionId,
              runId: input.runId,
              idempotencyKey: key,
              lifecycleId: f.lifecycleId,
              routeKey: f.routeKey,
              outcome: "FILLED",
              eventType: "FILLED",
              reasonCodes: [],
              rejectionCode: null,
              rejectionReason: null,
              requiredRebalance: null,
              buySourceId: f.buySourceId,
              sellSourceId: f.sellSourceId,
              sizeUsdt: String(f.sizeUsdt),
              buyVwapToman: f.buyVwapToman,
              sellVwapToman: f.sellVwapToman,
              buyNotionalToman: f.buyNotionalToman,
              sellNotionalToman: f.sellNotionalToman,
              buyFeeBps: f.buyFeeBps,
              sellFeeBps: f.sellFeeBps,
              buyFeeAsset: f.buyFeeAsset,
              buyFeeDebitMode: f.buyFeeDebitMode,
              buyFeeProvenance: f.buyFeeProvenance,
              sellFeeAsset: f.sellFeeAsset,
              sellFeeDebitMode: f.sellFeeDebitMode,
              sellFeeProvenance: f.sellFeeProvenance,
              feeTomanTotal: f.feeTomanTotal,
              feeUsdtMicrosTotal: f.feeUsdtMicrosTotal,
              slippageBufferToman: f.slippageBufferToman,
              grossSpreadToman: f.grossSpreadToman,
              markPriceToman: f.markPriceToman,
              cashPnlIrtToman: f.cashPnlIrtToman,
              inventoryDeltaUsdtMicros: f.inventoryDeltaUsdtMicros,
              sellFeeValueToman: f.sellFeeValueToman,
              economicNetPnlToman: f.economicNetPnlToman,
              riskAdjustedPnlToman: f.riskAdjustedPnlToman,
              balancesAfter: f.balancesAfter,
              sizingPolicy: f.sizing?.policy ?? null,
              sizingReason: f.sizing?.reason ?? null,
              limitingSide: f.sizing?.limitingSide ?? null,
              limitingSourceId: f.sizing?.limitingSourceId ?? null,
              limitingUsableUsdtMicros: f.sizing?.limitingUsableUsdtMicros ?? null,
              capitalCapUsdtMicros: f.sizing?.capitalCapUsdtMicros ?? null,
              depthCapUsdtMicros: f.sizing?.depthCapUsdtMicros ?? null,
              bindingConstraint: f.sizing?.bindingConstraint ?? null,
              riskAdjustedReturnBps:
                f.sizing === undefined ? null : String(f.sizing.riskAdjustedReturnBps),
              selectedPercentOfUsable:
                f.sizing?.selectedPercentOfUsable === undefined ||
                f.sizing?.selectedPercentOfUsable === null
                  ? null
                  : String(f.sizing.selectedPercentOfUsable),
              inventoryImpactPoints:
                f.sizing?.inventoryImpactPoints === undefined ||
                f.sizing?.inventoryImpactPoints === null
                  ? null
                  : String(f.sizing.inventoryImpactPoints),
              nextLargerSizeUsdt:
                f.sizing?.nextLargerSizeUsdt === undefined || f.sizing?.nextLargerSizeUsdt === null
                  ? null
                  : String(f.sizing.nextLargerSizeUsdt),
              nextLargerRejectionCode: f.sizing?.nextLargerRejectionCode ?? null,
              nextLargerRejectionReason: f.sizing?.nextLargerRejectionReason ?? null,
              nextLargerMarginalPnlToman: f.sizing?.nextLargerMarginalPnlToman ?? null,
              occurredAt: input.occurredAt,
              createdAt: input.occurredAt
            });
            for (const b of f.balancesAfter) {
              // A negative balance must never reach the database.
              if (b.irtToman < 0 || b.usdtMicros < 0) {
                throw new Error(`refusing negative paper balance for ${b.sourceId}`);
              }
              await tx
                .update(shadowPaperBalances)
                .set({
                  irtToman: Math.round(b.irtToman),
                  usdtMicros: Math.round(b.usdtMicros),
                  updatedAt: input.occurredAt
                })
                .where(eq(shadowPaperBalances.id, `${input.sessionId}|${b.sourceId}`));
            }
          });
          filled += 1;
          detailedEventsWritten += 1;
        } catch (e) {
          // A duplicate simply means this lifecycle was already filled — that is
          // the idempotency guard working, not a failure. Anything else is real.
          if (isUniqueViolation(e)) {
            duplicates += 1;
          } else {
            throw e;
          }
        }
        await upsertState(f, "FILLED", null, []);
      }

      for (const k of input.skips) {
        seen.add(k.lifecycleId);
        const codes = k.reasonCodes?.length ? k.reasonCodes : [k.rejectionCode];
        reasonCounts[k.rejectionCode] = (reasonCounts[k.rejectionCode] ?? 0) + 1;

        const transition = await upsertState(k, "SKIPPED", k.rejectionCode, codes);
        // THE volume rule: an unchanged blocked candidate writes no detail row.
        if (transition === "UNCHANGED") continue;

        await db.insert(shadowPaperLedger).values({
          id: randomUUID(),
          sessionId: input.sessionId,
          runId: input.runId,
          // Skips carry no idempotency key: several transitions are legitimate.
          idempotencyKey: null,
          lifecycleId: k.lifecycleId,
          routeKey: k.routeKey,
          outcome: "SKIPPED",
          eventType: transition === "NEW" ? "FIRST_SEEN" : "CHANGED",
          reasonCodes: codes,
          rejectionCode: k.rejectionCode,
          rejectionReason: k.rejectionReason,
          requiredRebalance: k.requiredRebalance,
          buySourceId: k.buySourceId,
          sellSourceId: k.sellSourceId,
          sizeUsdt: String(k.sizeUsdt),
          balancesAfter: [],
          occurredAt: input.occurredAt,
          createdAt: input.occurredAt
        });
        detailedEventsWritten += 1;
      }

      // Candidates that vanished from the market: one CLOSED event each, once.
      for (const row of stateRows) {
        if (seen.has(row.lifecycleId) || row.closedAt) continue;
        await db
          .update(shadowPaperCandidateState)
          .set({ closedAt: input.occurredAt })
          .where(eq(shadowPaperCandidateState.id, row.id));
        await db.insert(shadowPaperLedger).values({
          id: randomUUID(),
          sessionId: input.sessionId,
          runId: input.runId,
          idempotencyKey: null,
          lifecycleId: row.lifecycleId,
          routeKey: row.routeKey,
          outcome: "SKIPPED",
          eventType: "CLOSED",
          reasonCodes: [],
          rejectionCode: null,
          rejectionReason: "فرصت از بازار خارج شد",
          requiredRebalance: null,
          buySourceId: row.buySourceId,
          sellSourceId: row.sellSourceId,
          sizeUsdt: String(row.sizeUsdt),
          balancesAfter: [],
          occurredAt: input.occurredAt,
          createdAt: input.occurredAt
        });
        detailedEventsWritten += 1;
      }

      // One compact summary per cycle, regardless of candidate count.
      await db.insert(shadowPaperCycleSummaries).values({
        id: randomUUID(),
        sessionId: input.sessionId,
        runId: input.runId,
        occurredAt: input.occurredAt,
        candidatesEvaluated: input.fills.length + input.skips.length,
        filled,
        skipped: input.skips.length,
        detailedEventsWritten,
        reasonCounts,
        createdAt: input.occurredAt
      });

      await db
        .update(shadowPaperSessions)
        .set({ lastCycleAt: input.occurredAt, updatedAt: input.occurredAt })
        .where(eq(shadowPaperSessions.id, input.sessionId));
    });
  } catch (error) {
    throw asDbError(error, "commitPaperCycle");
  }

  await bumpSessionCounters(input.sessionId, filled, input.skips.length);
  return { filled, skipped: input.skips.length, duplicates, detailedEventsWritten, reasonCounts };
}

/** Current decision state per candidate — the grouped view the UI reads. */
export async function loadCandidateStates(
  sessionId: string,
  options: { reason?: string; openOnly?: boolean; limit?: number } = {}
): Promise<PaperCandidateStateRow[]> {
  try {
    const db = await getDbAsync();
    const rows = await serial(async () => {
      const filters = [eq(shadowPaperCandidateState.sessionId, sessionId)];
      if (options.reason) filters.push(eq(shadowPaperCandidateState.primaryReason, options.reason));
      if (options.openOnly) filters.push(isNull(shadowPaperCandidateState.closedAt));
      return db
        .select()
        .from(shadowPaperCandidateState)
        .where(and(...filters))
        .orderBy(desc(shadowPaperCandidateState.lastSeenAt))
        .limit(Math.min(500, Math.max(1, options.limit ?? 200)));
    });
    return rows.map((r) => ({
      lifecycleId: r.lifecycleId,
      routeKey: r.routeKey,
      buySourceId: r.buySourceId,
      sellSourceId: r.sellSourceId,
      sizeUsdt: num(r.sizeUsdt),
      decisionKey: r.decisionKey,
      outcome: r.outcome,
      primaryReason: r.primaryReason,
      reasonCodes: Array.isArray(r.reasonCodes) ? r.reasonCodes : [],
      occurrences: r.occurrences,
      firstSeenAt: r.firstSeenAt,
      lastSeenAt: r.lastSeenAt,
      lastChangedAt: r.lastChangedAt,
      closedAt: r.closedAt
    }));
  } catch {
    return [];
  }
}

/** Grouped block reasons with counts — computed from state, not from raw rows. */
export async function loadReasonBreakdown(
  sessionId: string
): Promise<Array<{ code: string; candidates: number; observations: number }>> {
  try {
    const db = await getDbAsync();
    const rows = await serial(async () =>
      db
        .select({
          code: shadowPaperCandidateState.primaryReason,
          candidates: sql<number>`count(*)`,
          observations: sql<number>`sum(${shadowPaperCandidateState.occurrences})`
        })
        .from(shadowPaperCandidateState)
        .where(
          and(
            eq(shadowPaperCandidateState.sessionId, sessionId),
            eq(shadowPaperCandidateState.outcome, "SKIPPED")
          )
        )
        .groupBy(shadowPaperCandidateState.primaryReason)
    );
    return rows
      .filter((r) => r.code)
      .map((r) => ({
        code: String(r.code),
        candidates: num(r.candidates),
        observations: num(r.observations)
      }))
      .sort((a, b) => b.observations - a.observations || a.code.localeCompare(b.code));
  } catch {
    return [];
  }
}

export async function loadCycleSummaries(
  sessionId: string,
  limit = 100
): Promise<PaperCycleSummaryRow[]> {
  try {
    const db = await getDbAsync();
    const rows = await serial(async () =>
      db
        .select()
        .from(shadowPaperCycleSummaries)
        .where(eq(shadowPaperCycleSummaries.sessionId, sessionId))
        .orderBy(desc(shadowPaperCycleSummaries.occurredAt))
        .limit(Math.min(500, Math.max(1, limit)))
    );
    return rows.map((r) => ({
      id: r.id,
      occurredAt: r.occurredAt,
      candidatesEvaluated: r.candidatesEvaluated,
      filled: r.filled,
      skipped: r.skipped,
      detailedEventsWritten: r.detailedEventsWritten,
      reasonCounts: (r.reasonCounts ?? {}) as Record<string, number>
    }));
  } catch {
    return [];
  }
}

async function bumpSessionCounters(sessionId: string, filled: number, skipped: number) {
  try {
    const db = await getDbAsync();
    await serial(async () => {
      const rows = await db
        .select({
          cyclesEvaluated: shadowPaperSessions.cyclesEvaluated,
          tradesExecuted: shadowPaperSessions.tradesExecuted,
          candidatesSkipped: shadowPaperSessions.candidatesSkipped
        })
        .from(shadowPaperSessions)
        .where(eq(shadowPaperSessions.id, sessionId))
        .limit(1);
      const cur = rows[0];
      if (!cur) return;
      await db
        .update(shadowPaperSessions)
        .set({
          cyclesEvaluated: cur.cyclesEvaluated + 1,
          tradesExecuted: cur.tradesExecuted + filled,
          candidatesSkipped: cur.candidatesSkipped + skipped
        })
        .where(eq(shadowPaperSessions.id, sessionId));
    });
  } catch {
    // Counters are reporting only; the ledger is the source of truth.
  }
}

export async function loadPaperLedger(
  sessionId: string,
  options: { outcome?: "FILLED" | "SKIPPED"; limit?: number } = {}
): Promise<PaperLedgerRow[]> {
  try {
    const db = await getDbAsync();
    const limit = Math.min(500, Math.max(1, options.limit ?? 200));
    const rows = await serial(async () => {
      const where = options.outcome
        ? and(eq(shadowPaperLedger.sessionId, sessionId), eq(shadowPaperLedger.outcome, options.outcome))
        : eq(shadowPaperLedger.sessionId, sessionId);
      return db
        .select()
        .from(shadowPaperLedger)
        .where(where)
        .orderBy(desc(shadowPaperLedger.occurredAt))
        .limit(limit);
    });
    return rows.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      reasonCodes: Array.isArray(r.reasonCodes) ? r.reasonCodes : [],
      sessionId: r.sessionId,
      runId: r.runId,
      lifecycleId: r.lifecycleId,
      routeKey: r.routeKey,
      outcome: r.outcome === "FILLED" ? "FILLED" : "SKIPPED",
      rejectionCode: r.rejectionCode,
      rejectionReason: r.rejectionReason,
      requiredRebalance: r.requiredRebalance,
      buySourceId: r.buySourceId,
      sellSourceId: r.sellSourceId,
      sizeUsdt: num(r.sizeUsdt),
      buyVwapToman: numOrNull(r.buyVwapToman),
      sellVwapToman: numOrNull(r.sellVwapToman),
      buyNotionalToman: numOrNull(r.buyNotionalToman),
      sellNotionalToman: numOrNull(r.sellNotionalToman),
      buyFeeBps: numOrNull(r.buyFeeBps),
      sellFeeBps: numOrNull(r.sellFeeBps),
      buyFeeAsset: r.buyFeeAsset,
      buyFeeDebitMode: r.buyFeeDebitMode,
      buyFeeProvenance: r.buyFeeProvenance,
      sellFeeAsset: r.sellFeeAsset,
      sellFeeDebitMode: r.sellFeeDebitMode,
      sellFeeProvenance: r.sellFeeProvenance,
      feeTomanTotal: numOrNull(r.feeTomanTotal),
      feeUsdtMicrosTotal: numOrNull(r.feeUsdtMicrosTotal),
      sizingPolicy: r.sizingPolicy,
      sizingReason: r.sizingReason,
      limitingSide: r.limitingSide,
      limitingSourceId: r.limitingSourceId,
      limitingUsableUsdtMicros: numOrNull(r.limitingUsableUsdtMicros),
      capitalCapUsdtMicros: numOrNull(r.capitalCapUsdtMicros),
      depthCapUsdtMicros: numOrNull(r.depthCapUsdtMicros),
      bindingConstraint: r.bindingConstraint,
      riskAdjustedReturnBps: numOrNull(r.riskAdjustedReturnBps),
      selectedPercentOfUsable: numOrNull(r.selectedPercentOfUsable),
      inventoryImpactPoints: numOrNull(r.inventoryImpactPoints),
      nextLargerSizeUsdt: numOrNull(r.nextLargerSizeUsdt),
      nextLargerRejectionCode: r.nextLargerRejectionCode,
      nextLargerRejectionReason: r.nextLargerRejectionReason,
      nextLargerMarginalPnlToman: numOrNull(r.nextLargerMarginalPnlToman),
      slippageBufferToman: numOrNull(r.slippageBufferToman),
      grossSpreadToman: numOrNull(r.grossSpreadToman),
      markPriceToman: numOrNull(r.markPriceToman),
      cashPnlIrtToman: numOrNull(r.cashPnlIrtToman),
      inventoryDeltaUsdtMicros: numOrNull(r.inventoryDeltaUsdtMicros),
      sellFeeValueToman: numOrNull(r.sellFeeValueToman),
      economicNetPnlToman: numOrNull(r.economicNetPnlToman),
      riskAdjustedPnlToman: numOrNull(r.riskAdjustedPnlToman),
      balancesAfter: Array.isArray(r.balancesAfter) ? r.balancesAfter : [],
      occurredAt: r.occurredAt
    }));
  } catch {
    return [];
  }
}

/** Aggregates for the dashboard and the health endpoint. */
export async function loadPaperStats(sessionId: string): Promise<{
  filled: number;
  skipped: number;
  cashPnlIrtToman: number;
  inventoryDeltaUsdtMicros: number;
  sellFeeValueToman: number;
  economicNetPnlToman: number;
  riskAdjustedPnlToman: number;
  feeTomanTotal: number;
  feeUsdtMicrosTotal: number;
  blockReasons: Array<{ code: string; reasonFa: string; count: number }>;
  lastFillAt: string | null;
}> {
  const empty = {
    filled: 0,
    skipped: 0,
    cashPnlIrtToman: 0,
    inventoryDeltaUsdtMicros: 0,
    sellFeeValueToman: 0,
    economicNetPnlToman: 0,
    riskAdjustedPnlToman: 0,
    feeTomanTotal: 0,
    feeUsdtMicrosTotal: 0,
    blockReasons: [] as Array<{ code: string; reasonFa: string; count: number }>,
    lastFillAt: null as string | null
  };
  try {
    const rows = await loadPaperLedger(sessionId, { limit: 500 });
    const fills = rows.filter((r) => r.outcome === "FILLED");
    const skips = rows.filter((r) => r.outcome === "SKIPPED");
    const byReason = new Map<string, { reasonFa: string; count: number }>();
    for (const s of skips) {
      const code = s.rejectionCode ?? "unknown";
      const cur = byReason.get(code);
      if (cur) cur.count += 1;
      else byReason.set(code, { reasonFa: s.rejectionReason ?? code, count: 1 });
    }
    return {
      filled: fills.length,
      skipped: skips.length,
      cashPnlIrtToman: fills.reduce((s, f) => s + (f.cashPnlIrtToman ?? 0), 0),
      inventoryDeltaUsdtMicros: fills.reduce((s, f) => s + (f.inventoryDeltaUsdtMicros ?? 0), 0),
      sellFeeValueToman: fills.reduce((s, f) => s + (f.sellFeeValueToman ?? 0), 0),
      economicNetPnlToman: fills.reduce((s, f) => s + (f.economicNetPnlToman ?? 0), 0),
      riskAdjustedPnlToman: fills.reduce((s, f) => s + (f.riskAdjustedPnlToman ?? 0), 0),
      feeTomanTotal: fills.reduce((s, f) => s + (f.feeTomanTotal ?? 0), 0),
      feeUsdtMicrosTotal: fills.reduce((s, f) => s + (f.feeUsdtMicrosTotal ?? 0), 0),
      blockReasons: [...byReason.entries()]
        .map(([code, v]) => ({ code, reasonFa: v.reasonFa, count: v.count }))
        .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
      lastFillAt: fills[0]?.occurredAt ?? null
    };
  } catch {
    return empty;
  }
}
