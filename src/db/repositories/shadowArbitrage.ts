/**
 * Shadow Arbitrage Phase 2 persistence — dedicated relational tables.
 *
 * Notes that matter for correctness here:
 *  - uuid primary keys are generated in-process with randomUUID(). The
 *    migration runner strips `DEFAULT gen_random_uuid()` for PGlite, so relying
 *    on a database-side default fails locally. Every other repository in this
 *    project supplies ids the same way.
 *  - all reads and writes go through serial(), a reentrancy-aware wrapper over
 *    withPgliteSerial, because PGlite is a single WASM instance and concurrent
 *    queries from API routes would race.
 *  - nothing here touches OMPFinex.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { asDbError, getDbAsync, withAdvisoryLock, withPgliteSerial } from "@/db/client";

import {
  shadowCollectionRuns,
  shadowObservationSessions,
  shadowOpportunityEvents,
  shadowOpportunityLifecycles,
  shadowRouteMetrics,
  shadowSourceHealthEvents,
  shadowSourceSnapshots,
  shadowWorkerHeartbeat
} from "@/db/schema";
import type { NormalizedSourceSnapshot, ShadowOpportunity } from "@/lib/shadowArbitrage/types";
import type { SourceCertification } from "@/lib/shadowArbitrage/certification";
import type { LifecycleTransition } from "@/lib/shadowArbitrage/lifecycle";
import { isDeadLocalWorker } from "@/lib/shadowArbitrage/workerIdentity";
import {
  SHADOW_LEASE_MULTIPLIER,
  SHADOW_OBSERVATION_TARGET_MS,
  SHADOW_RETENTION_DAYS,
  clampPollInterval
} from "@/lib/shadowArbitrage/config";

const SHADOW_LOCK = 0x53_41_44_01; // "SAD\x01"
const RETENTION_MS = SHADOW_RETENTION_DAYS * 24 * 60 * 60_000;
const TARGET_MS = SHADOW_OBSERVATION_TARGET_MS;
const HEARTBEAT_ID = "primary";

export type ObservationStatus = "NOT_STARTED" | "RUNNING" | "PAUSED" | "DEGRADED" | "COMPLETED";

export type ObservationSnapshot = {
  id: string;
  status: ObservationStatus;
  startedAt: string | null;
  endedAt: string | null;
  pausedAt: string | null;
  pausedTotalMs: number;
  lastHeartbeatAt: string | null;
  lastSuccessAt: string | null;
  completedCycles: number;
  successfulCycles: number;
  failedCycles: number;
  partialCycles: number;
  pollIntervalMs: number;
  targetDurationMs: number;
  elapsedMs: number;
  remainingMs: number;
  progressPercent: number;
  /** recorded cycles ÷ cycles the interval implies for the elapsed window. */
  cycleCoveragePercent: number;
  expectedCycles: number;
  workerId: string | null;
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

/** postgres-js returns an array; PGlite returns { rows }. */
function rowsOf<T = Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const r = result as { rows?: T[] } | null;
  return r?.rows ?? [];
}

function utcDay(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * PGlite is a single WASM instance, so every query must be serialized. The
 * queue is not reentrant: a nested withPgliteSerial() call would wait for the
 * outer entry to finish and deadlock. This context marks "already serialized",
 * so nested repository calls run directly while independent callers still queue.
 */
const serialCtx = new AsyncLocalStorage<true>();

async function serial<T>(fn: () => Promise<T>): Promise<T> {
  if (serialCtx.getStore()) return fn();
  return withPgliteSerial(() => serialCtx.run(true, fn));
}

/**
 * Single-flight guard for a collection cycle.
 * On PostgreSQL this is a real advisory lock, so a second worker is refused.
 * On PGlite it degrades to the serialization queue (one process, one file).
 */
export async function withShadowLock<T>(fn: () => Promise<T>) {
  return withAdvisoryLock(SHADOW_LOCK, () => serialCtx.run(true, fn));
}

/* ── observation session ──────────────────────────────────────────────────── */

function toObs(row: typeof shadowObservationSessions.$inferSelect): ObservationSnapshot {
  const startedMs = row.startedAt ? Date.parse(row.startedAt) : null;
  const pausedTotal = num(row.pausedTotalMs);
  const pausedOpen =
    row.status === "PAUSED" && row.pausedAt ? Math.max(0, Date.now() - Date.parse(row.pausedAt)) : 0;
  const wall =
    startedMs !== null && Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0;
  const elapsedMs = Math.max(0, wall - pausedTotal - pausedOpen);
  const target = num(row.targetDurationMs) || TARGET_MS;
  const pollIntervalMs = clampPollInterval(row.pollIntervalMs);

  let status = row.status as ObservationStatus;
  if ((status === "RUNNING" || status === "DEGRADED") && elapsedMs >= target) status = "COMPLETED";

  const expectedCycles = pollIntervalMs > 0 ? Math.floor(elapsedMs / pollIntervalMs) + 1 : 0;
  const cycleCoveragePercent =
    expectedCycles > 0 ? Math.min(100, (row.completedCycles / expectedCycles) * 100) : 0;

  return {
    id: row.id,
    status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    pausedAt: row.pausedAt,
    pausedTotalMs: pausedTotal,
    lastHeartbeatAt: row.lastHeartbeatAt,
    lastSuccessAt: row.lastSuccessAt,
    completedCycles: row.completedCycles,
    successfulCycles: row.successfulCycles,
    failedCycles: row.failedCycles,
    partialCycles: row.partialCycles,
    pollIntervalMs,
    targetDurationMs: target,
    elapsedMs,
    remainingMs: Math.max(0, target - elapsedMs),
    progressPercent: Math.min(100, (elapsedMs / target) * 100),
    cycleCoveragePercent: Math.round(cycleCoveragePercent * 100) / 100,
    expectedCycles,
    workerId: row.workerId
  };
}

async function latestSessionRow() {
  const db = await getDbAsync();
  const rows = await serial(async () =>
    db
      .select()
      .from(shadowObservationSessions)
      .orderBy(desc(shadowObservationSessions.createdAt))
      .limit(1)
  );
  return rows[0] ?? null;
}

/**
 * Return the single active observation session, creating it once.
 * Restarting the app or the worker must never create a second session or reset
 * progress, so an existing row is always reused.
 */
export async function ensureObservationSession(
  pollIntervalMs: number
): Promise<ObservationSnapshot> {
  try {
    const db = await getDbAsync();
    const interval = clampPollInterval(pollIntervalMs);
    const existing = await latestSessionRow();

    if (existing) {
      // Only NOT_STARTED is promoted automatically; PAUSED stays paused.
      if (existing.status === "NOT_STARTED") {
        const now = new Date().toISOString();
        await serial(async () =>
          db
            .update(shadowObservationSessions)
            .set({ status: "RUNNING", startedAt: now, pollIntervalMs: interval, updatedAt: now })
            .where(eq(shadowObservationSessions.id, existing.id))
        );
        return toObs({ ...existing, status: "RUNNING", startedAt: now, pollIntervalMs: interval });
      }
      if (existing.pollIntervalMs !== interval) {
        const now = new Date().toISOString();
        await serial(async () =>
          db
            .update(shadowObservationSessions)
            .set({ pollIntervalMs: interval, updatedAt: now })
            .where(eq(shadowObservationSessions.id, existing.id))
        );
        return toObs({ ...existing, pollIntervalMs: interval });
      }
      return toObs(existing);
    }

    const now = new Date().toISOString();
    const inserted = await serial(async () =>
      db
        .insert(shadowObservationSessions)
        .values({
          id: randomUUID(),
          status: "RUNNING",
          startedAt: now,
          pollIntervalMs: interval,
          targetDurationMs: TARGET_MS,
          pausedTotalMs: 0,
          createdAt: now,
          updatedAt: now
        })
        .returning()
    );
    return toObs(inserted[0]!);
  } catch (error) {
    throw asDbError(error, "ensureObservationSession");
  }
}

export async function getObservation(): Promise<ObservationSnapshot | null> {
  try {
    const row = await latestSessionRow();
    return row ? toObs(row) : null;
  } catch {
    return null;
  }
}

/** Admin control: start / pause / resume / complete. Read-only wrt exchanges. */
export async function setObservationStatus(
  action: "start" | "pause" | "resume" | "complete",
  pollIntervalMs?: number
): Promise<ObservationSnapshot> {
  try {
    const db = await getDbAsync();
    const now = new Date().toISOString();
    const interval = clampPollInterval(pollIntervalMs ?? undefined);
    const row = await latestSessionRow();

    if (!row) {
      if (action === "pause" || action === "complete") {
        throw new Error("no observation session to update");
      }
      return ensureObservationSession(interval);
    }

    if (action === "pause") {
      if (row.status === "PAUSED") return toObs(row);
      await serial(async () =>
        db
          .update(shadowObservationSessions)
          .set({ status: "PAUSED", pausedAt: now, updatedAt: now })
          .where(eq(shadowObservationSessions.id, row.id))
      );
      return toObs({ ...row, status: "PAUSED", pausedAt: now });
    }

    if (action === "resume" || action === "start") {
      if (row.status !== "PAUSED" && row.status !== "NOT_STARTED") return toObs(row);
      const pausedAdd = row.pausedAt ? Math.max(0, Date.parse(now) - Date.parse(row.pausedAt)) : 0;
      const pausedTotal = num(row.pausedTotalMs) + pausedAdd;
      await serial(async () =>
        db
          .update(shadowObservationSessions)
          .set({
            status: "RUNNING",
            pausedAt: null,
            pausedTotalMs: pausedTotal,
            startedAt: row.startedAt ?? now,
            updatedAt: now
          })
          .where(eq(shadowObservationSessions.id, row.id))
      );
      return toObs({
        ...row,
        status: "RUNNING",
        pausedAt: null,
        pausedTotalMs: pausedTotal,
        startedAt: row.startedAt ?? now
      });
    }

    await serial(async () =>
      db
        .update(shadowObservationSessions)
        .set({ status: "COMPLETED", endedAt: now, updatedAt: now })
        .where(eq(shadowObservationSessions.id, row.id))
    );
    return toObs({ ...row, status: "COMPLETED", endedAt: now });
  } catch (error) {
    throw asDbError(error, "setObservationStatus");
  }
}

/* ── worker heartbeat + cooperative lease ─────────────────────────────────── */

export type WorkerHeartbeat = {
  workerId: string;
  status: string;
  lastHeartbeatAt: string;
  lastCycleAt: string | null;
  lastCycleStatus: string | null;
  pollIntervalMs: number;
  leaseExpiresAt: string | null;
  /** No heartbeat for longer than the lease window. */
  stale: boolean;
  /** Lease still held by some worker right now. */
  leaseHeld: boolean;
};

function leaseMs(pollIntervalMs: number): number {
  return Math.max(pollIntervalMs * SHADOW_LEASE_MULTIPLIER, 120_000);
}

/**
 * Claim the collector lease for this worker.
 * A second worker on the same database can only take over after the incumbent's
 * lease expires, which is what stops two workers recording the same cycle.
 */
export async function claimWorkerLease(input: {
  workerId: string;
  pollIntervalMs: number;
}): Promise<{ acquired: boolean; heldBy: string | null; expiresAt: string | null }> {
  try {
    const db = await getDbAsync();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const expiresIso = new Date(now + leaseMs(input.pollIntervalMs)).toISOString();

    return await serial(async () => {
      const rows = await db
        .select()
        .from(shadowWorkerHeartbeat)
        .where(eq(shadowWorkerHeartbeat.id, HEARTBEAT_ID))
        .limit(1);
      const row = rows[0];

      if (row) {
        const unexpired =
          row.leaseExpiresAt !== null &&
          Date.parse(row.leaseExpiresAt) > now &&
          row.workerId !== input.workerId;
        // A lease whose owning process is gone on this host is stale: the app
        // can be SIGTERM'd before an async release completes, and collection
        // must not sit idle until the lease times out.
        if (unexpired && !isDeadLocalWorker(row.workerId)) {
          return { acquired: false, heldBy: row.workerId, expiresAt: row.leaseExpiresAt };
        }
      }

      await db
        .insert(shadowWorkerHeartbeat)
        .values({
          id: HEARTBEAT_ID,
          workerId: input.workerId,
          status: "claimed",
          lastHeartbeatAt: nowIso,
          pollIntervalMs: clampPollInterval(input.pollIntervalMs),
          leaseExpiresAt: expiresIso,
          updatedAt: nowIso
        })
        .onConflictDoUpdate({
          target: shadowWorkerHeartbeat.id,
          set: {
            workerId: input.workerId,
            status: "claimed",
            lastHeartbeatAt: nowIso,
            pollIntervalMs: clampPollInterval(input.pollIntervalMs),
            leaseExpiresAt: expiresIso,
            updatedAt: nowIso
          }
        });
      return { acquired: true, heldBy: input.workerId, expiresAt: expiresIso };
    });
  } catch (error) {
    throw asDbError(error, "claimWorkerLease");
  }
}

/** Release the lease on graceful shutdown so a restart can take over at once. */
export async function releaseWorkerLease(workerId: string): Promise<void> {
  try {
    const db = await getDbAsync();
    const now = new Date().toISOString();
    await serial(async () =>
      db
        .update(shadowWorkerHeartbeat)
        .set({ status: "stopped", leaseExpiresAt: null, updatedAt: now })
        .where(and(eq(shadowWorkerHeartbeat.id, HEARTBEAT_ID), eq(shadowWorkerHeartbeat.workerId, workerId)))
    );
  } catch {
    /* non-fatal on shutdown */
  }
}

export async function touchHeartbeat(input: {
  workerId: string;
  status: string;
  pollIntervalMs: number;
  lastCycleStatus?: string;
  sessionId?: string;
  extendLease?: boolean;
}): Promise<void> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const interval = clampPollInterval(input.pollIntervalMs);
  try {
    const db = await getDbAsync();
    await serial(async () => {
      const lease = input.extendLease
        ? { leaseExpiresAt: new Date(now + leaseMs(interval)).toISOString() }
        : {};
      await db
        .insert(shadowWorkerHeartbeat)
        .values({
          id: HEARTBEAT_ID,
          workerId: input.workerId,
          status: input.status,
          lastHeartbeatAt: nowIso,
          lastCycleAt: input.lastCycleStatus ? nowIso : undefined,
          lastCycleStatus: input.lastCycleStatus ?? null,
          pollIntervalMs: interval,
          updatedAt: nowIso,
          ...lease
        })
        .onConflictDoUpdate({
          target: shadowWorkerHeartbeat.id,
          set: {
            workerId: input.workerId,
            status: input.status,
            lastHeartbeatAt: nowIso,
            ...(input.lastCycleStatus
              ? { lastCycleAt: nowIso, lastCycleStatus: input.lastCycleStatus }
              : {}),
            pollIntervalMs: interval,
            updatedAt: nowIso,
            ...lease
          }
        });

      if (input.sessionId) {
        await db
          .update(shadowObservationSessions)
          .set({ lastHeartbeatAt: nowIso, workerId: input.workerId, updatedAt: nowIso })
          .where(eq(shadowObservationSessions.id, input.sessionId));
      }
    });
  } catch (error) {
    throw asDbError(error, "touchHeartbeat");
  }
}

export async function getWorkerHeartbeat(): Promise<WorkerHeartbeat | null> {
  try {
    const db = await getDbAsync();
    const rows = await serial(async () =>
      db
        .select()
        .from(shadowWorkerHeartbeat)
        .where(eq(shadowWorkerHeartbeat.id, HEARTBEAT_ID))
        .limit(1)
    );
    const r = rows[0];
    if (!r) return null;
    const interval = clampPollInterval(r.pollIntervalMs);
    const age = Date.now() - Date.parse(r.lastHeartbeatAt);
    return {
      workerId: r.workerId,
      status: r.status,
      lastHeartbeatAt: r.lastHeartbeatAt,
      lastCycleAt: r.lastCycleAt,
      lastCycleStatus: r.lastCycleStatus,
      pollIntervalMs: interval,
      leaseExpiresAt: r.leaseExpiresAt,
      stale: !Number.isFinite(age) || age > leaseMs(interval),
      leaseHeld: r.leaseExpiresAt !== null && Date.parse(r.leaseExpiresAt) > Date.now()
    };
  } catch {
    return null;
  }
}

/* ── collection runs ──────────────────────────────────────────────────────── */

export async function beginCollectionRun(input: {
  sessionId: string;
  idempotencyKey: string;
  workerId: string;
  pollIntervalMs?: number;
  sourcesTotal?: number;
}): Promise<{ runId: string; duplicate: boolean }> {
  try {
    const db = await getDbAsync();
    const now = new Date().toISOString();
    return await serial(async () => {
      const existing = await db
        .select({ id: shadowCollectionRuns.id })
        .from(shadowCollectionRuns)
        .where(eq(shadowCollectionRuns.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (existing[0]) return { runId: existing[0].id, duplicate: true };

      const runId = randomUUID();
      // The unique index on idempotency_key is the real guard: a racing worker
      // that passed the check above will conflict here and be told it is a dup.
      const inserted = await db
        .insert(shadowCollectionRuns)
        .values({
          id: runId,
          sessionId: input.sessionId,
          idempotencyKey: input.idempotencyKey,
          startedAt: now,
          status: "running",
          workerId: input.workerId,
          sourcesTotal: input.sourcesTotal ?? 0,
          pollIntervalMs: input.pollIntervalMs ?? null,
          createdAt: now
        })
        .onConflictDoNothing({ target: shadowCollectionRuns.idempotencyKey })
        .returning();

      if (!inserted[0]) {
        const winner = await db
          .select({ id: shadowCollectionRuns.id })
          .from(shadowCollectionRuns)
          .where(eq(shadowCollectionRuns.idempotencyKey, input.idempotencyKey))
          .limit(1);
        return { runId: winner[0]?.id ?? runId, duplicate: true };
      }
      return { runId: inserted[0].id, duplicate: false };
    });
  } catch (error) {
    throw asDbError(error, "beginCollectionRun");
  }
}

export async function completeCollectionRun(input: {
  runId: string;
  sessionId: string;
  status: "success" | "partial" | "failed";
  sourcesOk: number;
  sourcesFailed: number;
  sourcesTotal: number;
  opportunityCount: number;
  durationMs: number;
  pollIntervalMs: number;
  errorMessage?: string | null;
  sources: NormalizedSourceSnapshot[];
  certBySource?: Record<string, SourceCertification>;
  opportunities: ShadowOpportunity[];
  transitions?: LifecycleTransition[];
  healthEvents?: Array<{
    sourceId: string;
    fromHealth: string | null;
    toHealth: string;
    fromCertStatus: string | null;
    toCertStatus: string | null;
    reason: string | null;
    httpStatus: number | null;
    latencyMs: number | null;
  }>;
}): Promise<void> {
  const now = new Date().toISOString();
  try {
    const db = await getDbAsync();
    await serial(async () => {
      const coverage =
        input.sourcesTotal > 0
          ? Math.round((input.sourcesOk / input.sourcesTotal) * 10_000) / 100
          : 0;

      await db
        .update(shadowCollectionRuns)
        .set({
          finishedAt: now,
          status: input.status,
          sourcesOk: input.sourcesOk,
          sourcesFailed: input.sourcesFailed,
          sourcesTotal: input.sourcesTotal,
          coveragePercent: String(coverage),
          opportunityCount: input.opportunityCount,
          durationMs: input.durationMs,
          pollIntervalMs: input.pollIntervalMs,
          errorMessage: input.errorMessage ?? null
        })
        .where(eq(shadowCollectionRuns.id, input.runId));

      // One snapshot row per source per cycle — the regular time series.
      if (input.sources.length) {
        await db.insert(shadowSourceSnapshots).values(
          input.sources.map((s) => {
            const cert = input.certBySource?.[s.sourceId];
            return {
              id: randomUUID(),
              runId: input.runId,
              sourceId: s.sourceId,
              receivedAt: s.receivedAt,
              sourceTimestamp: s.sourceTimestamp,
              health: s.health,
              marketModel: s.marketModel,
              certStatus: cert?.status ?? null,
              userBuyToman: s.userBuyPriceToman != null ? String(s.userBuyPriceToman) : null,
              userSellToman: s.userSellPriceToman != null ? String(s.userSellPriceToman) : null,
              latencyMs: s.meta?.latencyMs ?? null,
              httpStatus: s.meta?.httpStatus ?? null,
              depthAvailable: s.meta?.depthAvailable ?? null,
              maxExecutableUsdt:
                s.maxExecutableUsdt != null ? String(s.maxExecutableUsdt) : null,
              feeStatus: s.feeStatus,
              stale: Boolean(s.stale),
              payload: {
                sizeExecutables: s.sizeExecutables,
                feeStatus: s.feeStatus,
                feeBps: s.marketFeeBps,
                feeLabel: s.feeLabel,
                accountStatus: s.accountStatus,
                eligibilityBase: s.eligibilityBase,
                marketModel: s.marketModel,
                sourceName: s.sourceName,
                depthUsdtBid: s.depthUsdtBid,
                depthUsdtAsk: s.depthUsdtAsk,
                meta: s.meta ?? null,
                sourceBlockedReasons: s.sourceBlockedReasons ?? [],
                degradedReason: s.degradedReason,
                diagnostics: s.diagnostics ?? null
              },
              errorReason: s.errorReason,
              createdAt: now
            };
          })
        );
      }

      // Health transitions only — not one row per cycle.
      if (input.healthEvents?.length) {
        await db.insert(shadowSourceHealthEvents).values(
          input.healthEvents.map((e) => ({
            id: randomUUID(),
            sourceId: e.sourceId,
            runId: input.runId,
            occurredAt: now,
            fromHealth: e.fromHealth,
            toHealth: e.toHealth,
            fromCertStatus: e.fromCertStatus,
            toCertStatus: e.toCertStatus,
            reason: e.reason,
            httpStatus: e.httpStatus,
            latencyMs: e.latencyMs,
            createdAt: now
          }))
        );
      }

      // Lifecycles: upsert by id so a persistent opportunity stays one row.
      for (const o of input.opportunities) {
        const payload = {
          buyFeeToman: o.buyFeeToman,
          sellFeeToman: o.sellFeeToman,
          buyFeeBps: o.buyFeeBps,
          sellFeeBps: o.sellFeeBps,
          totalFeePercent: o.totalFeePercent,
          slippageBufferToman: o.slippageBufferToman,
          rebalanceCostToman: o.rebalanceCostToman,
          buySourceName: o.buySourceName,
          sellSourceName: o.sellSourceName
        };
        const values = {
          id: o.id,
          routeKey: o.routeKey,
          buySourceId: o.buySourceId,
          sellSourceId: o.sellSourceId,
          sizeUsdt: String(o.sizeUsdt),
          eligibility: o.eligibility,
          isActive: o.isActive,
          firstSeenAt: o.firstSeenAt,
          lastSeenAt: o.lastSeenAt,
          endedAt: o.endedAt,
          buyVwapToman: String(Math.round(o.buyVwapToman)),
          sellVwapToman: String(Math.round(o.sellVwapToman)),
          rawSpreadPercent: String(o.rawSpreadPercent),
          netEdgePercent: String(o.netEdgePercent),
          netProfitToman: String(Math.round(o.netProfitToman)),
          maxNetEdgePercent: String(o.maxNetEdgePercent),
          maxNetProfitToman: String(Math.round(o.maxNetProfitToman)),
          maxRawSpreadPercent: String(o.maxRawSpreadPercent ?? o.rawSpreadPercent),
          feeUnknown: Boolean(o.feeUnknown),
          observationCount: o.observationCount ?? 1,
          blockedReasons: o.blockedReasons,
          payload,
          updatedAt: now
        };
        await db
          .insert(shadowOpportunityLifecycles)
          .values(values)
          .onConflictDoUpdate({
            target: shadowOpportunityLifecycles.id,
            set: {
              eligibility: values.eligibility,
              isActive: values.isActive,
              lastSeenAt: values.lastSeenAt,
              endedAt: values.endedAt,
              buyVwapToman: values.buyVwapToman,
              sellVwapToman: values.sellVwapToman,
              rawSpreadPercent: values.rawSpreadPercent,
              netEdgePercent: values.netEdgePercent,
              netProfitToman: values.netProfitToman,
              maxNetEdgePercent: values.maxNetEdgePercent,
              maxNetProfitToman: values.maxNetProfitToman,
              maxRawSpreadPercent: values.maxRawSpreadPercent,
              feeUnknown: values.feeUnknown,
              observationCount: values.observationCount,
              blockedReasons: values.blockedReasons,
              payload,
              updatedAt: now
            }
          });
      }

      // Transition records — status changes, not periodic duplicates.
      if (input.transitions?.length) {
        await db.insert(shadowOpportunityEvents).values(
          input.transitions.map((t) => ({
            id: randomUUID(),
            lifecycleId: t.lifecycleId,
            routeKey: t.routeKey,
            occurredAt: t.occurredAt,
            eventType: t.eventType,
            fromEligibility: t.fromEligibility,
            toEligibility: t.toEligibility,
            netEdgePercent: t.netEdgePercent != null ? String(t.netEdgePercent) : null,
            netProfitToman: t.netProfitToman != null ? String(Math.round(t.netProfitToman)) : null,
            rawSpreadPercent: t.rawSpreadPercent != null ? String(t.rawSpreadPercent) : null,
            blockedReasons: t.blockedReasons,
            createdAt: now
          }))
        );
      }

      // Session counters.
      const session = await db
        .select()
        .from(shadowObservationSessions)
        .where(eq(shadowObservationSessions.id, input.sessionId))
        .limit(1);
      const s = session[0];
      if (s) {
        const completed = s.completedCycles + 1;
        const successful = s.successfulCycles + (input.status === "success" ? 1 : 0);
        const failed = s.failedCycles + (input.status === "failed" ? 1 : 0);
        const partial = s.partialCycles + (input.status === "partial" ? 1 : 0);

        let status = s.status;
        if (status === "RUNNING" || status === "DEGRADED") {
          // Degraded when the unhealthy majority persists, healthy again otherwise.
          status = failed + partial > successful ? "DEGRADED" : "RUNNING";
        }
        const startedMs = s.startedAt ? Date.parse(s.startedAt) : Date.now();
        const elapsed = Math.max(0, Date.now() - startedMs - num(s.pausedTotalMs));
        if (status !== "PAUSED" && elapsed >= (num(s.targetDurationMs) || TARGET_MS)) {
          status = "COMPLETED";
        }

        await db
          .update(shadowObservationSessions)
          .set({
            completedCycles: completed,
            successfulCycles: successful,
            failedCycles: failed,
            partialCycles: partial,
            status,
            lastSuccessAt: input.status !== "failed" ? now : s.lastSuccessAt,
            lastHeartbeatAt: now,
            endedAt: status === "COMPLETED" ? now : s.endedAt,
            updatedAt: now
          })
          .where(eq(shadowObservationSessions.id, input.sessionId));
      }
    });
  } catch (error) {
    throw asDbError(error, "completeCollectionRun");
  }
}

/* ── route aggregates ─────────────────────────────────────────────────────── */

/**
 * Fold this cycle's drafts into per-route/per-day aggregates.
 * This is what keeps 14-day analytics cheap without storing one row per pair
 * per cycle.
 */
export async function upsertRouteMetrics(
  drafts: ShadowOpportunity[],
  nowIso: string
): Promise<void> {
  if (!drafts.length) return;
  const bucket = utcDay(nowIso);
  try {
    const db = await getDbAsync();
    const byId = new Map<string, ShadowOpportunity[]>();
    for (const d of drafts) {
      const id = `${d.routeKey}|${bucket}`;
      const list = byId.get(id);
      if (list) list.push(d);
      else byId.set(id, [d]);
    }

    await serial(async () => {
      const ids = [...byId.keys()];
      const existing = ids.length
        ? await db.select().from(shadowRouteMetrics).where(inArray(shadowRouteMetrics.id, ids))
        : [];
      const existingById = new Map(existing.map((r) => [r.id, r]));

      for (const [id, group] of byId) {
        const first = group[0]!;
        const prev = existingById.get(id);
        const blocked: Record<string, number> = { ...((prev?.blockedCounts ?? {}) as Record<string, number>) };
        let positiveRaw = prev?.positiveRawSamples ?? 0;
        let positiveNet = prev?.positiveNetSamples ?? 0;
        let sumRaw = num(prev?.sumRawSpreadPercent);
        let sumNet = num(prev?.sumNetEdgePercent);
        let maxRaw = numOrNull(prev?.maxRawSpreadPercent);
        let maxNet = numOrNull(prev?.maxNetEdgePercent);
        let maxProfit = numOrNull(prev?.maxNetProfitToman);
        let feeUnknown = prev?.feeUnknown ?? false;

        for (const d of group) {
          sumRaw += d.rawSpreadPercent;
          sumNet += d.netEdgePercent;
          if (d.rawSpreadPercent > 0) positiveRaw += 1;
          if (!d.feeUnknown && d.netProfitToman > 0 && d.eligibility !== "BLOCKED") positiveNet += 1;
          maxRaw = maxRaw === null ? d.rawSpreadPercent : Math.max(maxRaw, d.rawSpreadPercent);
          maxNet = maxNet === null ? d.netEdgePercent : Math.max(maxNet, d.netEdgePercent);
          maxProfit =
            maxProfit === null ? d.netProfitToman : Math.max(maxProfit, d.netProfitToman);
          if (d.feeUnknown) feeUnknown = true;
          for (const r of d.blockedReasons) blocked[r] = (blocked[r] ?? 0) + 1;
        }

        const samples = (prev?.samples ?? 0) + group.length;
        const values = {
          id,
          routeKey: first.routeKey,
          buySourceId: first.buySourceId,
          sellSourceId: first.sellSourceId,
          sizeUsdt: String(first.sizeUsdt),
          bucketDate: bucket,
          samples,
          positiveRawSamples: positiveRaw,
          positiveNetSamples: positiveNet,
          sumRawSpreadPercent: String(Math.round(sumRaw * 1e8) / 1e8),
          maxRawSpreadPercent: maxRaw !== null ? String(maxRaw) : null,
          sumNetEdgePercent: String(Math.round(sumNet * 1e8) / 1e8),
          maxNetEdgePercent: maxNet !== null ? String(maxNet) : null,
          maxNetProfitToman: maxProfit !== null ? String(Math.round(maxProfit)) : null,
          feeUnknown,
          blockedCounts: blocked,
          firstSeenAt: prev?.firstSeenAt ?? nowIso,
          lastSeenAt: nowIso,
          updatedAt: nowIso
        };

        await db
          .insert(shadowRouteMetrics)
          .values(values)
          .onConflictDoUpdate({
            target: shadowRouteMetrics.id,
            set: {
              samples: values.samples,
              positiveRawSamples: values.positiveRawSamples,
              positiveNetSamples: values.positiveNetSamples,
              sumRawSpreadPercent: values.sumRawSpreadPercent,
              maxRawSpreadPercent: values.maxRawSpreadPercent,
              sumNetEdgePercent: values.sumNetEdgePercent,
              maxNetEdgePercent: values.maxNetEdgePercent,
              maxNetProfitToman: values.maxNetProfitToman,
              feeUnknown: values.feeUnknown,
              blockedCounts: values.blockedCounts,
              lastSeenAt: values.lastSeenAt,
              updatedAt: values.updatedAt
            }
          });
      }
    });
  } catch (error) {
    throw asDbError(error, "upsertRouteMetrics");
  }
}

export type RouteMetricRow = {
  routeKey: string;
  buySourceId: string;
  sellSourceId: string;
  sizeUsdt: number;
  samples: number;
  positiveRawSamples: number;
  positiveNetSamples: number;
  avgRawSpreadPercent: number | null;
  maxRawSpreadPercent: number | null;
  avgNetEdgePercent: number | null;
  maxNetEdgePercent: number | null;
  maxNetProfitToman: number | null;
  feeUnknown: boolean;
  blockedCounts: Record<string, number>;
  firstSeenAt: string;
  lastSeenAt: string;
};

export async function loadRouteMetrics(windowMs = RETENTION_MS): Promise<RouteMetricRow[]> {
  try {
    const db = await getDbAsync();
    const cutDay = utcDay(new Date(Date.now() - windowMs).toISOString());
    const rows = await serial(async () =>
      db.select().from(shadowRouteMetrics).where(gte(shadowRouteMetrics.bucketDate, cutDay))
    );

    // Fold day buckets into one row per route.
    const byRoute = new Map<string, RouteMetricRow>();
    for (const r of rows) {
      const cur = byRoute.get(r.routeKey);
      const samples = r.samples;
      const sumRaw = num(r.sumRawSpreadPercent);
      const sumNet = num(r.sumNetEdgePercent);
      if (!cur) {
        byRoute.set(r.routeKey, {
          routeKey: r.routeKey,
          buySourceId: r.buySourceId,
          sellSourceId: r.sellSourceId,
          sizeUsdt: num(r.sizeUsdt),
          samples,
          positiveRawSamples: r.positiveRawSamples,
          positiveNetSamples: r.positiveNetSamples,
          avgRawSpreadPercent: samples ? sumRaw / samples : null,
          maxRawSpreadPercent: numOrNull(r.maxRawSpreadPercent),
          avgNetEdgePercent: samples ? sumNet / samples : null,
          maxNetEdgePercent: numOrNull(r.maxNetEdgePercent),
          maxNetProfitToman: numOrNull(r.maxNetProfitToman),
          feeUnknown: r.feeUnknown,
          blockedCounts: (r.blockedCounts ?? {}) as Record<string, number>,
          firstSeenAt: r.firstSeenAt,
          lastSeenAt: r.lastSeenAt
        });
        continue;
      }
      const totalSamples = cur.samples + samples;
      const curSumRaw = (cur.avgRawSpreadPercent ?? 0) * cur.samples + sumRaw;
      const curSumNet = (cur.avgNetEdgePercent ?? 0) * cur.samples + sumNet;
      cur.samples = totalSamples;
      cur.positiveRawSamples += r.positiveRawSamples;
      cur.positiveNetSamples += r.positiveNetSamples;
      cur.avgRawSpreadPercent = totalSamples ? curSumRaw / totalSamples : null;
      cur.avgNetEdgePercent = totalSamples ? curSumNet / totalSamples : null;
      const mr = numOrNull(r.maxRawSpreadPercent);
      if (mr !== null) cur.maxRawSpreadPercent = Math.max(cur.maxRawSpreadPercent ?? mr, mr);
      const mn = numOrNull(r.maxNetEdgePercent);
      if (mn !== null) cur.maxNetEdgePercent = Math.max(cur.maxNetEdgePercent ?? mn, mn);
      const mp = numOrNull(r.maxNetProfitToman);
      if (mp !== null) cur.maxNetProfitToman = Math.max(cur.maxNetProfitToman ?? mp, mp);
      cur.feeUnknown = cur.feeUnknown || r.feeUnknown;
      for (const [k, v] of Object.entries((r.blockedCounts ?? {}) as Record<string, number>)) {
        cur.blockedCounts[k] = (cur.blockedCounts[k] ?? 0) + v;
      }
      if (r.firstSeenAt < cur.firstSeenAt) cur.firstSeenAt = r.firstSeenAt;
      if (r.lastSeenAt > cur.lastSeenAt) cur.lastSeenAt = r.lastSeenAt;
    }
    return [...byRoute.values()];
  } catch {
    return [];
  }
}

/* ── lifecycle reads ──────────────────────────────────────────────────────── */

function rowToOpp(row: typeof shadowOpportunityLifecycles.$inferSelect): ShadowOpportunity {
  const p = (row.payload ?? {}) as Record<string, unknown>;
  const size = num(row.sizeUsdt);
  const buyVwap = num(row.buyVwapToman);
  const sellVwap = num(row.sellVwapToman);
  return {
    id: row.id,
    routeKey: row.routeKey,
    buySourceId: row.buySourceId as ShadowOpportunity["buySourceId"],
    sellSourceId: row.sellSourceId as ShadowOpportunity["sellSourceId"],
    buySourceName: String(p.buySourceName ?? row.buySourceId),
    sellSourceName: String(p.sellSourceName ?? row.sellSourceId),
    sizeUsdt: size as ShadowOpportunity["sizeUsdt"],
    buyVwapToman: buyVwap,
    sellVwapToman: sellVwap,
    rawSpreadPercent: num(row.rawSpreadPercent),
    buyFeeToman: num(p.buyFeeToman as number),
    sellFeeToman: num(p.sellFeeToman as number),
    buyFeeBps: num(p.buyFeeBps as number),
    sellFeeBps: num(p.sellFeeBps as number),
    totalFeePercent: num(p.totalFeePercent as number),
    slippageBufferToman: num(p.slippageBufferToman as number),
    rebalanceCostToman: num(p.rebalanceCostToman as number),
    netProfitToman: num(row.netProfitToman),
    netEdgePercent: num(row.netEdgePercent),
    buyCostToman: Math.round(buyVwap * size),
    sellProceedsToman: Math.round(sellVwap * size),
    eligibility: row.eligibility as ShadowOpportunity["eligibility"],
    blockedReasons: (row.blockedReasons ?? []) as ShadowOpportunity["blockedReasons"],
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    endedAt: row.endedAt,
    durationMs: Math.max(0, Date.parse(row.lastSeenAt) - Date.parse(row.firstSeenAt)),
    maxNetEdgePercent: num(row.maxNetEdgePercent),
    maxNetProfitToman: num(row.maxNetProfitToman),
    maxRawSpreadPercent: num(row.maxRawSpreadPercent ?? row.rawSpreadPercent),
    feeUnknown: row.feeUnknown,
    observationCount: row.observationCount,
    isActive: row.isActive,
    buyAgeMs: 0,
    sellAgeMs: 0
  };
}

export async function loadActiveOpportunitiesDb(): Promise<ShadowOpportunity[]> {
  try {
    const db = await getDbAsync();
    const rows = await serial(async () =>
      db
        .select()
        .from(shadowOpportunityLifecycles)
        .where(eq(shadowOpportunityLifecycles.isActive, true))
        .orderBy(desc(shadowOpportunityLifecycles.lastSeenAt))
        .limit(2000)
    );
    return rows.map(rowToOpp);
  } catch {
    return [];
  }
}

/**
 * Active lifecycles plus recently closed ones, so a route that comes back is
 * recorded as "reappeared" rather than silently opening as if it were new.
 */
export async function loadLifecyclesForMerge(recentClosedMs = 3_600_000): Promise<ShadowOpportunity[]> {
  try {
    const db = await getDbAsync();
    const cut = new Date(Date.now() - recentClosedMs).toISOString();
    const rows = await serial(async () =>
      db
        .select()
        .from(shadowOpportunityLifecycles)
        .where(
          sql`${shadowOpportunityLifecycles.isActive} = true OR ${shadowOpportunityLifecycles.lastSeenAt} >= ${cut}`
        )
        .orderBy(desc(shadowOpportunityLifecycles.lastSeenAt))
        .limit(4000)
    );
    return rows.map(rowToOpp);
  } catch {
    return [];
  }
}

export async function loadHistoryDb(limit = 500): Promise<ShadowOpportunity[]> {
  try {
    const db = await getDbAsync();
    const cut = new Date(Date.now() - RETENTION_MS).toISOString();
    const rows = await serial(async () =>
      db
        .select()
        .from(shadowOpportunityLifecycles)
        .where(gte(shadowOpportunityLifecycles.lastSeenAt, cut))
        .orderBy(desc(shadowOpportunityLifecycles.lastSeenAt))
        .limit(limit)
    );
    return rows.map(rowToOpp);
  } catch {
    return [];
  }
}

export async function loadLatestSourceSnapshots(): Promise<
  Array<{
    sourceId: string;
    receivedAt: string;
    health: string;
    payload: Record<string, unknown>;
    errorReason: string | null;
    userBuy: number | null;
    userSell: number | null;
    certStatus: string | null;
    latencyMs: number | null;
    maxExecutableUsdt: number | null;
    stale: boolean;
  }>
> {
  try {
    const db = await getDbAsync();
    return await serial(async () => {
      const runs = await db
        .select({ id: shadowCollectionRuns.id })
        .from(shadowCollectionRuns)
        .where(sql`${shadowCollectionRuns.status} IN ('success','partial','failed')`)
        .orderBy(desc(shadowCollectionRuns.startedAt))
        .limit(1);
      if (!runs[0]) return [];
      const snaps = await db
        .select()
        .from(shadowSourceSnapshots)
        .where(eq(shadowSourceSnapshots.runId, runs[0].id));
      return snaps.map((s) => ({
        sourceId: s.sourceId,
        receivedAt: s.receivedAt,
        health: s.health,
        payload: (s.payload ?? {}) as Record<string, unknown>,
        errorReason: s.errorReason,
        userBuy: numOrNull(s.userBuyToman),
        userSell: numOrNull(s.userSellToman),
        certStatus: s.certStatus,
        latencyMs: s.latencyMs,
        maxExecutableUsdt: numOrNull(s.maxExecutableUsdt),
        stale: Boolean(s.stale)
      }));
    });
  } catch {
    return [];
  }
}

/** Last health/cert state per source, used to emit transitions only on change. */
export async function loadLastSourceStates(): Promise<
  Record<string, { health: string; certStatus: string | null }>
> {
  try {
    const db = await getDbAsync();
    const result = await serial(async () =>
      db.execute(sql`
        SELECT DISTINCT ON (source_id) source_id, health, cert_status
        FROM shadow_source_snapshots
        ORDER BY source_id, received_at DESC
      `)
    );
    const out: Record<string, { health: string; certStatus: string | null }> = {};
    for (const row of rowsOf<{ source_id: string; health: string; cert_status: string | null }>(
      result
    )) {
      out[row.source_id] = { health: row.health, certStatus: row.cert_status };
    }
    return out;
  } catch {
    return {};
  }
}

/* ── run / coverage stats ─────────────────────────────────────────────────── */

export async function countRecentRuns(limitMs = 24 * 60 * 60_000): Promise<number> {
  try {
    const db = await getDbAsync();
    const since = new Date(Date.now() - limitMs).toISOString();
    const rows = await serial(async () =>
      db
        .select({ c: sql<number>`count(*)` })
        .from(shadowCollectionRuns)
        .where(gte(shadowCollectionRuns.startedAt, since))
    );
    return num(rows[0]?.c);
  } catch {
    return 0;
  }
}

export type RunWindowStats = {
  runCount: number;
  successfulRuns: number;
  partialRuns: number;
  failedRuns: number;
  firstRunAt: string | null;
  lastRunAt: string | null;
  duplicateIdempotencyKeys: number;
};

export async function loadRunStats(windowMs = RETENTION_MS): Promise<RunWindowStats> {
  const empty: RunWindowStats = {
    runCount: 0,
    successfulRuns: 0,
    partialRuns: 0,
    failedRuns: 0,
    firstRunAt: null,
    lastRunAt: null,
    duplicateIdempotencyKeys: 0
  };
  try {
    const db = await getDbAsync();
    const since = new Date(Date.now() - windowMs).toISOString();
    const result = await serial(async () =>
      db.execute(sql`
        SELECT
          count(*)::int AS run_count,
          count(*) FILTER (WHERE status = 'success')::int AS successful,
          count(*) FILTER (WHERE status = 'partial')::int AS partial,
          count(*) FILTER (WHERE status = 'failed')::int AS failed,
          min(started_at) AS first_at,
          max(started_at) AS last_at,
          (count(*) - count(DISTINCT idempotency_key))::int AS dup_keys
        FROM shadow_collection_runs
        WHERE started_at >= ${since}
      `)
    );
    const row = rowsOf<{
      run_count: number;
      successful: number;
      partial: number;
      failed: number;
      first_at: string | null;
      last_at: string | null;
      dup_keys: number;
    }>(result)[0];
    if (!row) return empty;
    return {
      runCount: num(row.run_count),
      successfulRuns: num(row.successful),
      partialRuns: num(row.partial),
      failedRuns: num(row.failed),
      firstRunAt: row.first_at ? new Date(row.first_at).toISOString() : null,
      lastRunAt: row.last_at ? new Date(row.last_at).toISOString() : null,
      duplicateIdempotencyKeys: num(row.dup_keys)
    };
  } catch {
    return empty;
  }
}

export type SourceWindowStats = {
  sourceId: string;
  samples: number;
  healthySamples: number;
  degradedSamples: number;
  errorSamples: number;
  staleSamples: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  lastErrorAt: string | null;
  lastError: string | null;
};

/** Uptime, error rate, freshness and latency percentiles straight from SQL. */
export async function loadSourceStats(windowMs = RETENTION_MS): Promise<SourceWindowStats[]> {
  try {
    const db = await getDbAsync();
    const since = new Date(Date.now() - windowMs).toISOString();
    const result = await serial(async () =>
      db.execute(sql`
        SELECT
          source_id,
          count(*)::int AS samples,
          count(*) FILTER (WHERE health = 'healthy')::int AS healthy,
          count(*) FILTER (WHERE health = 'degraded')::int AS degraded,
          count(*) FILTER (WHERE health = 'unavailable')::int AS unavailable,
          count(*) FILTER (WHERE stale)::int AS stale_samples,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
          max(received_at) FILTER (WHERE error_reason IS NOT NULL) AS last_error_at
        FROM shadow_source_snapshots
        WHERE received_at >= ${since}
        GROUP BY source_id
      `)
    );

    const stats = rowsOf<{
      source_id: string;
      samples: number;
      healthy: number;
      degraded: number;
      unavailable: number;
      stale_samples: number;
      p50: number | string | null;
      p95: number | string | null;
      last_error_at: string | null;
    }>(result);

    const lastErrors = await serial(async () =>
      db.execute(sql`
        SELECT DISTINCT ON (source_id) source_id, error_reason
        FROM shadow_source_snapshots
        WHERE received_at >= ${since} AND error_reason IS NOT NULL
        ORDER BY source_id, received_at DESC
      `)
    );
    const errById = new Map(
      rowsOf<{ source_id: string; error_reason: string | null }>(lastErrors).map((r) => [
        r.source_id,
        r.error_reason
      ])
    );

    return stats.map((r) => ({
      sourceId: r.source_id,
      samples: num(r.samples),
      healthySamples: num(r.healthy),
      degradedSamples: num(r.degraded),
      errorSamples: num(r.unavailable),
      staleSamples: num(r.stale_samples),
      latencyP50Ms: r.p50 != null ? Math.round(num(r.p50)) : null,
      latencyP95Ms: r.p95 != null ? Math.round(num(r.p95)) : null,
      lastErrorAt: r.last_error_at ? new Date(r.last_error_at).toISOString() : null,
      lastError: errById.get(r.source_id) ?? null
    }));
  } catch {
    return [];
  }
}

export async function countSnapshots(windowMs = RETENTION_MS): Promise<number> {
  try {
    const db = await getDbAsync();
    const since = new Date(Date.now() - windowMs).toISOString();
    const rows = await serial(async () =>
      db
        .select({ c: sql<number>`count(*)` })
        .from(shadowSourceSnapshots)
        .where(gte(shadowSourceSnapshots.receivedAt, since))
    );
    return num(rows[0]?.c);
  } catch {
    return 0;
  }
}

export async function countLifecycleEvents(windowMs = RETENTION_MS): Promise<number> {
  try {
    const db = await getDbAsync();
    const since = new Date(Date.now() - windowMs).toISOString();
    const rows = await serial(async () =>
      db
        .select({ c: sql<number>`count(*)` })
        .from(shadowOpportunityEvents)
        .where(gte(shadowOpportunityEvents.occurredAt, since))
    );
    return num(rows[0]?.c);
  } catch {
    return 0;
  }
}

/* ── retention ────────────────────────────────────────────────────────────── */

/**
 * Drop data older than the 14-day retention window.
 * Runs are deleted first so snapshots cascade; lifecycles are only removed once
 * they are closed and stale, so an in-flight opportunity is never truncated.
 */
export async function retentionCleanup(): Promise<{
  runs: number;
  lifecycles: number;
  healthEvents: number;
  opportunityEvents: number;
  routeMetrics: number;
}> {
  const cut = new Date(Date.now() - RETENTION_MS).toISOString();
  const cutDay = utcDay(cut);
  const result = { runs: 0, lifecycles: 0, healthEvents: 0, opportunityEvents: 0, routeMetrics: 0 };
  try {
    const db = await getDbAsync();
    await serial(async () => {
      const runs = await db
        .delete(shadowCollectionRuns)
        .where(sql`${shadowCollectionRuns.startedAt} < ${cut}`)
        .returning();
      result.runs = runs.length;

      const lifecycles = await db
        .delete(shadowOpportunityLifecycles)
        .where(
          and(
            eq(shadowOpportunityLifecycles.isActive, false),
            sql`${shadowOpportunityLifecycles.lastSeenAt} < ${cut}`
          )
        )
        .returning();
      result.lifecycles = lifecycles.length;

      const health = await db
        .delete(shadowSourceHealthEvents)
        .where(sql`${shadowSourceHealthEvents.occurredAt} < ${cut}`)
        .returning();
      result.healthEvents = health.length;

      const events = await db
        .delete(shadowOpportunityEvents)
        .where(sql`${shadowOpportunityEvents.occurredAt} < ${cut}`)
        .returning();
      result.opportunityEvents = events.length;

      const metrics = await db
        .delete(shadowRouteMetrics)
        .where(sql`${shadowRouteMetrics.bucketDate} < ${cutDay}`)
        .returning();
      result.routeMetrics = metrics.length;
    });
    return result;
  } catch {
    return result;
  }
}
