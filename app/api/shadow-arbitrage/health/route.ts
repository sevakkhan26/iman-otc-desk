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
import { getActiveExperiment } from "@/db/repositories/shadowExperiments";
import { SHADOW_BANNER, SHADOW_SOURCES } from "@/lib/shadowArbitrage/config";
import { SHADOW_NO_STORE } from "@/lib/shadowArbitrage/httpHeaders";
import { classifyInfraHealth } from "@/lib/shadowArbitrage/paper/economicLiveness";
import { buildThreeWayHealthSplit } from "@/lib/shadowArbitrage/paper/dataHealth";

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

  const [observation, worker, runStats, sourceStats, paperSession, activeExperiment] =
    await Promise.all([
      getObservation(),
      getWorkerHeartbeat(),
      loadRunStats(),
      loadSourceStats(),
      getActivePaperSession(),
      getActiveExperiment().catch(() => null)
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

  // INFRA vs MARKET DATA vs ECONOMIC LIVENESS — never conflate.
  const infraHealth = classifyInfraHealth(status);
  const expCfg = (activeExperiment?.config ?? null) as Record<string, unknown> | null;
  const liv = (expCfg?.economicLiveness ?? null) as Record<string, unknown> | null;
  const supervisorEconomic = (expCfg?.economicLivenessSupervisor ?? null) as
    | Record<string, unknown>
    | null;
  const marketDataFromSources = sourceStats.length
    ? sourceStats.every((s) => (s as { health?: string }).health === "healthy")
      ? "healthy"
      : sourceStats.some((s) => (s as { health?: string }).health === "unavailable")
        ? "degraded"
        : "degraded"
    : ((supervisorEconomic?.marketDataHealth as string | undefined) ?? "unknown");
  const economicLivenessStatus =
    (supervisorEconomic?.economicLivenessStatus as string | undefined) ??
    (liv?.validityState === "ECONOMICS_INVALID"
      ? "ECONOMICS_INVALID"
      : liv?.validityState === "ECONOMICS_DEGRADED"
        ? "ECONOMICS_DEGRADED"
        : liv?.validityState === "WARNING"
          ? "WARNING"
          : liv
            ? "HEALTHY"
            : "unknown");
  const healthSplit = buildThreeWayHealthSplit({
    infraHealth,
    marketDataHealth: marketDataFromSources as
      | "healthy"
      | "degraded"
      | "unavailable"
      | "unknown",
    economicLiveness: economicLivenessStatus as
      | "HEALTHY"
      | "WARNING"
      | "CRITICAL"
      | "ECONOMICS_DEGRADED"
      | "ECONOMICS_INVALID"
      | "NO_EXECUTABLE_OPPORTUNITIES"
      | "unknown"
  });
  const economicLiveness = {
    ...healthSplit,
    last_fill_at:
      (supervisorEconomic?.last_fill_at as string | null | undefined) ??
      paper.lastFillAt ??
      (liv?.lastFillAt as string | null | undefined) ??
      null,
    hours_since_fill:
      (supervisorEconomic?.hours_since_fill as number | null | undefined) ??
      (liv?.hoursSinceFill as number | null | undefined) ??
      null,
    rolling_funnel_counts: supervisorEconomic?.rolling_funnel_counts ?? liv?.lastFunnel ?? null,
    reject_distribution: supervisorEconomic?.reject_distribution ?? null,
    fee_blockers: supervisorEconomic?.fee_blockers ?? null,
    first_degraded_at:
      (supervisorEconomic?.first_degraded_at as string | null | undefined) ??
      (liv?.firstDegradedAt as string | null | undefined) ??
      null,
    validityState:
      (supervisorEconomic?.validityState as string | undefined) ??
      (liv?.validityState as string | undefined) ??
      null,
    alerts: supervisorEconomic?.alerts ?? [],
    terminal_output_authoritative: false as const,
    supervisorPayload: supervisorEconomic
  };

  return new NextResponse(
    JSON.stringify({
      banner: SHADOW_BANNER,
      shadowMode: true,
      status,
      /** Explicit: Docker/collector infra status — not economic liveness. */
      infraHealth,
      healthSplit,
      economicLiveness,
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
