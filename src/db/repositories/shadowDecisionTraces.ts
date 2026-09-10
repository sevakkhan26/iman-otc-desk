/**
 * Append-only decision-cycle traces for the live monitor.
 * Read-heavy; writes are best-effort and must never throw into the paper path.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { asDbError, getDbAsync } from "@/db/client";
import { runSerialized } from "@/db/repositories/shadowArbitrage";
import { shadowPaperDecisionTraces, shadowPaperCycleSummaries } from "@/db/schema";

const serial = runSerialized;

export type DecisionCandidateTrace = {
  rank: number;
  lifecycleId: string;
  routeKey: string;
  buySourceId: string;
  sellSourceId: string;
  sizeUsdt: number;
  buyVwapToman: number | null;
  sellVwapToman: number | null;
  /** Delayed-book VWAP after simulated arrival (null when recheck not run). */
  delayedBuyVwapToman?: number | null;
  delayedSellVwapToman?: number | null;
  grossSpreadToman: number | null;
  economicNetPnlToman: number | null;
  riskAdjustedPnlToman: number | null;
  buyFeeBps: number | null;
  sellFeeBps: number | null;
  buyFeeProvenance?: string | null;
  sellFeeProvenance?: string | null;
  feeTomanTotal: number | null;
  slippageBufferToman: number | null;
  bindingConstraint: string | null;
  sizingReason: string | null;
  status:
    | "evaluating"
    | "rejected"
    | "valid"
    | "selected"
    | "traded"
    | "failed";
  statusFa: string;
  reasonFa: string | null;
  reasonCodes: string[];
  /** Exact terminal reason for non-fills; null on traded/selected-without-reject. */
  terminalReason?: string | null;
  selected: boolean;
  ledgerId: string | null;
  capitalCapUsdt: number | null;
  depthCapUsdt: number | null;
  sourceSkewMs?: number | null;
  appliedDelayMs?: number | null;
  delayedNetPnlToman?: number | null;
  funnelStages?: Array<Record<string, unknown>>;
  lifecycleEvidence?: Record<string, unknown> | null;
};

export type DecisionTraceRow = {
  id: string;
  sessionId: string;
  runId: string | null;
  occurredAt: string;
  venuesAvailable: number;
  routesEvaluated: number;
  sizesEvaluated: number;
  candidatesEvaluated: number;
  rejectedCount: number;
  validCount: number;
  selectedCount: number;
  filledCount: number;
  outcome: string;
  outcomeReasonFa: string | null;
  selectedLifecycleId: string | null;
  snapshotRef: string | null;
  releaseVersion: string | null;
  policyFingerprint: string | null;
  candidates: DecisionCandidateTrace[];
  traceComplete: boolean;
  createdAt: string;
  /** When false, UI must say candidate detail was not historically persisted. */
  source: "decision_trace" | "cycle_summary_only";
};

export function decisionTraceEnabled(): boolean {
  const raw = (process.env.SHADOW_DECISION_TRACE ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  // Default off in production; on for non-production local development.
  return process.env.NODE_ENV !== "production";
}

export async function appendDecisionTrace(input: {
  sessionId: string;
  runId: string | null;
  occurredAt: string;
  venuesAvailable: number;
  routesEvaluated: number;
  sizesEvaluated: number;
  candidates: DecisionCandidateTrace[];
  selectedLifecycleId: string | null;
  filledCount: number;
  outcome: string;
  outcomeReasonFa: string | null;
  snapshotRef: string | null;
  releaseVersion: string | null;
  policyFingerprint: string | null;
  traceComplete: boolean;
  /** Pre-allocated id so fills can durable-link before the trace row exists. */
  id?: string | null;
  experimentId?: string | null;
  observationId?: string | null;
  deploymentVersion?: string | null;
}): Promise<{ id: string } | { error: string }> {
  try {
    const db = await getDbAsync();
    const id = input.id?.trim() ? input.id : randomUUID();
    const rejected = input.candidates.filter((c) => c.status === "rejected").length;
    const valid = input.candidates.filter(
      (c) => c.status === "valid" || c.status === "selected" || c.status === "traded"
    ).length;
    const selected = input.candidates.filter((c) => c.selected).length;
    await serial(async () => {
      await db.insert(shadowPaperDecisionTraces).values({
        id,
        sessionId: input.sessionId,
        runId: input.runId,
        occurredAt: input.occurredAt,
        venuesAvailable: input.venuesAvailable,
        routesEvaluated: input.routesEvaluated,
        sizesEvaluated: input.sizesEvaluated,
        candidatesEvaluated: input.candidates.length,
        rejectedCount: rejected,
        validCount: valid,
        selectedCount: selected,
        filledCount: input.filledCount,
        outcome: input.outcome,
        outcomeReasonFa: input.outcomeReasonFa,
        selectedLifecycleId: input.selectedLifecycleId,
        snapshotRef: input.snapshotRef,
        releaseVersion: input.releaseVersion,
        policyFingerprint: input.policyFingerprint,
        candidates: input.candidates as unknown as Array<Record<string, unknown>>,
        traceComplete: input.traceComplete,
        experimentId: input.experimentId ?? null,
        observationId: input.observationId ?? null,
        deploymentVersion: input.deploymentVersion ?? input.releaseVersion ?? null,
        paperSessionId: input.sessionId,
        createdAt: input.occurredAt
      });
    });
    return { id };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function mapTrace(r: typeof shadowPaperDecisionTraces.$inferSelect): DecisionTraceRow {
  const raw = Array.isArray(r.candidates) ? r.candidates : [];
  return {
    id: r.id,
    sessionId: r.sessionId,
    runId: r.runId,
    occurredAt: String(r.occurredAt),
    venuesAvailable: r.venuesAvailable,
    routesEvaluated: r.routesEvaluated,
    sizesEvaluated: r.sizesEvaluated,
    candidatesEvaluated: r.candidatesEvaluated,
    rejectedCount: r.rejectedCount,
    validCount: r.validCount,
    selectedCount: r.selectedCount,
    filledCount: r.filledCount,
    outcome: r.outcome,
    outcomeReasonFa: r.outcomeReasonFa,
    selectedLifecycleId: r.selectedLifecycleId,
    snapshotRef: r.snapshotRef,
    releaseVersion: r.releaseVersion,
    policyFingerprint: r.policyFingerprint,
    candidates: raw as unknown as DecisionCandidateTrace[],
    traceComplete: Boolean(r.traceComplete),
    createdAt: String(r.createdAt),
    source: "decision_trace"
  };
}

/**
 * Cursor page: rows with occurred_at < cursor (or latest if no cursor), desc.
 */
export async function listDecisionTraces(input: {
  sessionId: string;
  limit?: number;
  /** ISO timestamp cursor (exclusive upper bound for next page). */
  cursor?: string | null;
}): Promise<{ rows: DecisionTraceRow[]; nextCursor: string | null }> {
  try {
    const db = await getDbAsync();
    const limit = Math.min(100, Math.max(1, input.limit ?? 30));
    const rows = await serial(async () => {
      const filters = [eq(shadowPaperDecisionTraces.sessionId, input.sessionId)];
      if (input.cursor) {
        filters.push(lt(shadowPaperDecisionTraces.occurredAt, input.cursor));
      }
      return db
        .select()
        .from(shadowPaperDecisionTraces)
        .where(and(...filters))
        .orderBy(desc(shadowPaperDecisionTraces.occurredAt))
        .limit(limit);
    });
    const mapped = rows.map(mapTrace);
    const nextCursor =
      mapped.length === limit ? mapped[mapped.length - 1]!.occurredAt : null;
    return { rows: mapped, nextCursor };
  } catch (error) {
    throw asDbError(error, "listDecisionTraces");
  }
}

/** Fallback: cycle summaries without candidate arrays (historical). */
export async function listCycleSummariesAsTraces(input: {
  sessionId: string;
  limit?: number;
  cursor?: string | null;
}): Promise<{ rows: DecisionTraceRow[]; nextCursor: string | null }> {
  try {
    const db = await getDbAsync();
    const limit = Math.min(100, Math.max(1, input.limit ?? 30));
    const rows = await serial(async () => {
      const filters = [eq(shadowPaperCycleSummaries.sessionId, input.sessionId)];
      if (input.cursor) {
        filters.push(lt(shadowPaperCycleSummaries.occurredAt, input.cursor));
      }
      return db
        .select()
        .from(shadowPaperCycleSummaries)
        .where(and(...filters))
        .orderBy(desc(shadowPaperCycleSummaries.occurredAt))
        .limit(limit);
    });
    const mapped: DecisionTraceRow[] = rows.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      runId: r.runId,
      occurredAt: String(r.occurredAt),
      venuesAvailable: 0,
      routesEvaluated: 0,
      sizesEvaluated: 0,
      candidatesEvaluated: r.candidatesEvaluated,
      rejectedCount: r.skipped,
      validCount: 0,
      selectedCount: r.filled > 0 ? 1 : 0,
      filledCount: r.filled,
      outcome: r.filled > 0 ? "filled" : "no_fill",
      outcomeReasonFa:
        r.filled > 0
          ? "حداقل یک پر کاغذی در این چرخه ثبت شد"
          : "جزئیات کاندید این چرخه در تاریخچه ثبت نشده است",
      selectedLifecycleId: null,
      snapshotRef: r.runId,
      releaseVersion: null,
      policyFingerprint: null,
      candidates: [],
      traceComplete: false,
      createdAt: String(r.createdAt),
      source: "cycle_summary_only"
    }));
    const nextCursor =
      mapped.length === limit ? mapped[mapped.length - 1]!.occurredAt : null;
    return { rows: mapped, nextCursor };
  } catch (error) {
    throw asDbError(error, "listCycleSummariesAsTraces");
  }
}

export async function countDecisionTraces(sessionId: string): Promise<number> {
  try {
    const db = await getDbAsync();
    const rows = await serial(async () =>
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(shadowPaperDecisionTraces)
        .where(eq(shadowPaperDecisionTraces.sessionId, sessionId))
    );
    return Number(rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

/** First occurred_at with a complete candidate trace (null if none). */
export async function firstCompleteTraceAt(sessionId: string): Promise<string | null> {
  try {
    const db = await getDbAsync();
    const rows = await serial(async () =>
      db
        .select({ occurredAt: shadowPaperDecisionTraces.occurredAt })
        .from(shadowPaperDecisionTraces)
        .where(
          and(
            eq(shadowPaperDecisionTraces.sessionId, sessionId),
            eq(shadowPaperDecisionTraces.traceComplete, true)
          )
        )
        .orderBy(shadowPaperDecisionTraces.occurredAt)
        .limit(1)
    );
    return rows[0] ? String(rows[0].occurredAt) : null;
  } catch {
    return null;
  }
}
