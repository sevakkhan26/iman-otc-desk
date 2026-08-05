/**
 * Four-day Paper experiment persistence.
 *
 * Append-oriented: status transitions are explicit; endsAt is never updated
 * after insert; history of prior runs is never deleted.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { asDbError, getDbAsync } from "@/db/client";
import { runSerialized } from "@/db/repositories/shadowArbitrage";
import { shadowPaperExperiments, shadowPaperSessions } from "@/db/schema";

const serial = runSerialized;

export type ExperimentStatus = "PENDING" | "ACTIVE" | "COMPLETED" | "SUPERSEDED";

export type PaperExperimentRow = {
  id: string;
  runKey: string;
  status: ExperimentStatus;
  policySetKey: string;
  policyFingerprint: string;
  releaseVersion: string;
  startedAt: string;
  endsAt: string;
  completedAt: string | null;
  sessionId: string | null;
  initialCapitalToman: number;
  targetUtilizationPercent: number;
  maxUtilizationPercent: number;
  minReservePercent: number;
  maxRouteCapitalPercent: number;
  maxVenueExposurePercent: number;
  derivedMaxOrderUsdt: number | null;
  derivedMaxOrderReferencePrice: number | null;
  derivedMaxOrderAt: string | null;
  config: Record<string, unknown>;
  summary: Record<string, unknown> | null;
  peakUtilizationPercent: number | null;
  utilizationStats: { sum: number; n: number };
  createdAt: string;
  updatedAt: string;
};

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toRow(r: typeof shadowPaperExperiments.$inferSelect): PaperExperimentRow {
  const stats = (r.utilizationStats ?? { sum: 0, n: 0 }) as { sum: number; n: number };
  return {
    id: r.id,
    runKey: r.runKey,
    status: r.status as ExperimentStatus,
    policySetKey: r.policySetKey,
    policyFingerprint: r.policyFingerprint,
    releaseVersion: r.releaseVersion,
    startedAt: String(r.startedAt),
    endsAt: String(r.endsAt),
    completedAt: r.completedAt ? String(r.completedAt) : null,
    sessionId: r.sessionId,
    initialCapitalToman: num(r.initialCapitalToman),
    targetUtilizationPercent: num(r.targetUtilizationPercent),
    maxUtilizationPercent: num(r.maxUtilizationPercent),
    minReservePercent: num(r.minReservePercent),
    maxRouteCapitalPercent: num(r.maxRouteCapitalPercent),
    maxVenueExposurePercent: num(r.maxVenueExposurePercent),
    derivedMaxOrderUsdt: r.derivedMaxOrderUsdt == null ? null : num(r.derivedMaxOrderUsdt),
    derivedMaxOrderReferencePrice: r.derivedMaxOrderReferencePrice,
    derivedMaxOrderAt: r.derivedMaxOrderAt ? String(r.derivedMaxOrderAt) : null,
    config: (r.config ?? {}) as Record<string, unknown>,
    summary: (r.summary as Record<string, unknown> | null) ?? null,
    peakUtilizationPercent:
      r.peakUtilizationPercent == null ? null : num(r.peakUtilizationPercent),
    utilizationStats: { sum: num(stats.sum), n: num(stats.n) },
    createdAt: String(r.createdAt),
    updatedAt: String(r.updatedAt)
  };
}

export async function getActiveExperiment(): Promise<PaperExperimentRow | null> {
  try {
    const db = await getDbAsync();
    const rows = await serial(async () =>
      db
        .select()
        .from(shadowPaperExperiments)
        .where(eq(shadowPaperExperiments.status, "ACTIVE"))
        .limit(1)
    );
    return rows[0] ? toRow(rows[0]) : null;
  } catch (error) {
    throw asDbError(error, "getActiveExperiment");
  }
}

export async function getExperimentByRunKey(runKey: string): Promise<PaperExperimentRow | null> {
  try {
    const db = await getDbAsync();
    const rows = await serial(async () =>
      db
        .select()
        .from(shadowPaperExperiments)
        .where(eq(shadowPaperExperiments.runKey, runKey))
        .limit(1)
    );
    return rows[0] ? toRow(rows[0]) : null;
  } catch (error) {
    throw asDbError(error, "getExperimentByRunKey");
  }
}

export async function listExperiments(limit = 20): Promise<PaperExperimentRow[]> {
  try {
    const db = await getDbAsync();
    const rows = await serial(async () =>
      db
        .select()
        .from(shadowPaperExperiments)
        .orderBy(desc(shadowPaperExperiments.startedAt))
        .limit(Math.min(100, Math.max(1, limit)))
    );
    return rows.map(toRow);
  } catch (error) {
    throw asDbError(error, "listExperiments");
  }
}

export async function createActiveExperiment(input: {
  runKey: string;
  policySetKey: string;
  policyFingerprint: string;
  releaseVersion: string;
  startedAt: string;
  endsAt: string;
  sessionId: string;
  initialCapitalToman: number;
  targetUtilizationPercent: number;
  maxUtilizationPercent: number;
  minReservePercent: number;
  maxRouteCapitalPercent: number;
  maxVenueExposurePercent: number;
  derivedMaxOrderUsdt: number;
  derivedMaxOrderReferencePrice: number;
  config: Record<string, unknown>;
}): Promise<PaperExperimentRow> {
  try {
    const db = await getDbAsync();
    const now = input.startedAt;
    const id = randomUUID();
    await serial(async () =>
      db.transaction(async (tx) => {
        // Supersede any prior ACTIVE (should be none due to unique index).
        await tx
          .update(shadowPaperExperiments)
          .set({ status: "SUPERSEDED", updatedAt: now })
          .where(eq(shadowPaperExperiments.status, "ACTIVE"));

        await tx.insert(shadowPaperExperiments).values({
          id,
          runKey: input.runKey,
          status: "ACTIVE",
          policySetKey: input.policySetKey,
          policyFingerprint: input.policyFingerprint,
          releaseVersion: input.releaseVersion,
          startedAt: input.startedAt,
          endsAt: input.endsAt,
          completedAt: null,
          sessionId: input.sessionId,
          initialCapitalToman: Math.round(input.initialCapitalToman),
          targetUtilizationPercent: String(input.targetUtilizationPercent),
          maxUtilizationPercent: String(input.maxUtilizationPercent),
          minReservePercent: String(input.minReservePercent),
          maxRouteCapitalPercent: String(input.maxRouteCapitalPercent),
          maxVenueExposurePercent: String(input.maxVenueExposurePercent),
          derivedMaxOrderUsdt: String(input.derivedMaxOrderUsdt),
          derivedMaxOrderReferencePrice: Math.round(input.derivedMaxOrderReferencePrice),
          derivedMaxOrderAt: now,
          config: input.config,
          summary: null,
          peakUtilizationPercent: null,
          utilizationStats: { sum: 0, n: 0 },
          createdAt: now,
          updatedAt: now
        });

        await tx
          .update(shadowPaperSessions)
          .set({ experimentRunId: id, updatedAt: now })
          .where(eq(shadowPaperSessions.id, input.sessionId));
      })
    );
    const row = await getExperimentByRunKey(input.runKey);
    if (!row) throw new Error("experiment insert did not persist");
    return row;
  } catch (error) {
    throw asDbError(error, "createActiveExperiment");
  }
}

export async function completeExperiment(
  id: string,
  summary: Record<string, unknown>
): Promise<PaperExperimentRow | null> {
  try {
    const db = await getDbAsync();
    const now = new Date().toISOString();
    await serial(async () => {
      await db
        .update(shadowPaperExperiments)
        .set({
          status: "COMPLETED",
          completedAt: now,
          summary,
          updatedAt: now
        })
        .where(and(eq(shadowPaperExperiments.id, id), eq(shadowPaperExperiments.status, "ACTIVE")));
    });
    const rows = await serial(async () =>
      db.select().from(shadowPaperExperiments).where(eq(shadowPaperExperiments.id, id)).limit(1)
    );
    return rows[0] ? toRow(rows[0]) : null;
  } catch (error) {
    throw asDbError(error, "completeExperiment");
  }
}

/** Record a utilization sample; never moves endsAt. */
export async function recordUtilizationSample(
  id: string,
  utilizationPercent: number
): Promise<void> {
  try {
    const db = await getDbAsync();
    const now = new Date().toISOString();
    await serial(async () => {
      const rows = await db
        .select()
        .from(shadowPaperExperiments)
        .where(eq(shadowPaperExperiments.id, id))
        .limit(1);
      const cur = rows[0];
      if (!cur || cur.status !== "ACTIVE") return;
      const stats = (cur.utilizationStats ?? { sum: 0, n: 0 }) as { sum: number; n: number };
      const next = { sum: num(stats.sum) + utilizationPercent, n: num(stats.n) + 1 };
      const peak = Math.max(num(cur.peakUtilizationPercent), utilizationPercent);
      await db
        .update(shadowPaperExperiments)
        .set({
          utilizationStats: next,
          peakUtilizationPercent: String(peak),
          updatedAt: now
        })
        .where(eq(shadowPaperExperiments.id, id));
    });
  } catch (error) {
    throw asDbError(error, "recordUtilizationSample");
  }
}

export function experimentIsOpen(exp: PaperExperimentRow, nowMs: number): boolean {
  if (exp.status !== "ACTIVE") return false;
  return nowMs < Date.parse(exp.endsAt);
}

export function formatTehranWithSeconds(isoUtc: string): string {
  const d = new Date(isoUtc);
  if (!Number.isFinite(d.getTime())) return isoUtc;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(d);
}
