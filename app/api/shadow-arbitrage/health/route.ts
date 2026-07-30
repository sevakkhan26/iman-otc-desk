import { NextResponse } from "next/server";
import { isSession } from "@/lib/requireApiAuth";
import { requireAdminSession } from "@/lib/requireAdmin";
import {
  getObservation,
  getWorkerHeartbeat,
  loadRunStats,
  loadSourceStats
} from "@/db/repositories/shadowArbitrage";
import { getActivePaperSession, loadPaperStats } from "@/db/repositories/shadowPaper";
import { SHADOW_BANNER, SHADOW_SOURCES } from "@/lib/shadowArbitrage/config";
import { SHADOW_NO_STORE } from "@/lib/shadowArbitrage/httpHeaders";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/shadow-arbitrage/health — admin-only collector health.
 *
 * Read-only. Reports heartbeat, last successful cycle, next expected cycle,
 * lease owner and error summary. Deliberately exposes no endpoint URLs, stack
 * traces or database details.
 */
export async function GET() {
  const session = await requireAdminSession();
  if (!isSession(session)) return session;

  const [observation, worker, runStats, sourceStats, paperSession] = await Promise.all([
    getObservation(),
    getWorkerHeartbeat(),
    loadRunStats(),
    loadSourceStats(),
    getActivePaperSession()
  ]);

  // Phase 6 status. Reported behind the same admin gate as everything else —
  // this adds a field, it does not add an unauthenticated surface.
  const paperStats = paperSession ? await loadPaperStats(paperSession.id) : null;
  const paper = {
    engine: "paper_only" as const,
    realOrders: false as const,
    sessionPresent: Boolean(paperSession),
    sessionId: paperSession?.id ?? null,
    status: paperSession?.status ?? "NONE",
    mode: paperSession?.mode ?? null,
    provisional: paperSession?.mode === "PROVISIONAL_EVALUATION",
    observationId: paperSession?.observationId ?? null,
    lastCycleAt: paperSession?.lastCycleAt ?? null,
    cyclesEvaluated: paperSession?.cyclesEvaluated ?? 0,
    tradesExecuted: paperStats?.filled ?? 0,
    candidatesSkipped: paperStats?.skipped ?? 0,
    cashPnlIrtToman: paperStats?.cashPnlIrtToman ?? 0,
    economicNetPnlToman: paperStats?.economicNetPnlToman ?? 0,
    riskAdjustedPnlToman: paperStats?.riskAdjustedPnlToman ?? 0,
    lastFillAt: paperStats?.lastFillAt ?? null
  };

  const pollIntervalMs = worker?.pollIntervalMs ?? observation?.pollIntervalMs ?? 30_000;
  const nextExpectedCycleAt = worker?.lastCycleAt
    ? new Date(Date.parse(worker.lastCycleAt) + pollIntervalMs).toISOString()
    : null;

  const sourcesWithErrors = sourceStats
    .filter((s) => s.errorSamples > 0)
    .map((s) => ({
      sourceId: s.sourceId,
      errorRatePercent: s.samples ? Math.round((s.errorSamples / s.samples) * 10_000) / 100 : 0,
      lastErrorAt: s.lastErrorAt,
      // Message only — never a stack trace or connection string.
      lastError: s.lastError ? s.lastError.slice(0, 200) : null
    }));

  const heartbeatAgeMs = worker?.lastHeartbeatAt
    ? Math.max(0, Date.now() - Date.parse(worker.lastHeartbeatAt))
    : null;

  const collectorRunning = Boolean(worker && !worker.stale && worker.leaseHeld);
  const status: "healthy" | "degraded" | "stopped" = !worker
    ? "stopped"
    : collectorRunning && observation?.status === "RUNNING"
      ? "healthy"
      : worker.stale
        ? "stopped"
        : "degraded";

  return new NextResponse(
    JSON.stringify({
      banner: SHADOW_BANNER,
      shadowMode: true,
      status,
      serverNow: new Date().toISOString(),
      paper,
      collector: {
        running: collectorRunning,
        workerId: worker?.workerId ?? null,
        state: worker?.status ?? "stopped",
        leaseHeld: worker?.leaseHeld ?? false,
        leaseExpiresAt: worker?.leaseExpiresAt ?? null,
        heartbeatAt: worker?.lastHeartbeatAt ?? null,
        heartbeatAgeMs,
        heartbeatStale: worker?.stale ?? true,
        pollIntervalMs,
        lastCycleAt: worker?.lastCycleAt ?? null,
        lastCycleStatus: worker?.lastCycleStatus ?? null,
        nextExpectedCycleAt
      },
      observation: observation
        ? {
            id: observation.id,
            status: observation.status,
            startedAt: observation.startedAt,
            elapsedMs: observation.elapsedMs,
            targetDurationMs: observation.targetDurationMs,
            progressPercent: observation.progressPercent,
            completedCycles: observation.completedCycles,
            successfulCycles: observation.successfulCycles,
            partialCycles: observation.partialCycles,
            failedCycles: observation.failedCycles,
            cycleCoveragePercent: observation.cycleCoveragePercent,
            lastSuccessAt: observation.lastSuccessAt
          }
        : null,
      runStats: {
        runCount: runStats.runCount,
        successfulRuns: runStats.successfulRuns,
        partialRuns: runStats.partialRuns,
        failedRuns: runStats.failedRuns,
        duplicateIdempotencyKeys: runStats.duplicateIdempotencyKeys
      },
      sources: {
        configured: SHADOW_SOURCES.length,
        reporting: sourceStats.length,
        withErrors: sourcesWithErrors
      }
    }),
    { status: 200, headers: SHADOW_NO_STORE }
  );
}
