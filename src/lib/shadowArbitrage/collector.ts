/**
 * One collection cycle for Shadow Arbitrage Phase 2.
 *
 * The same code path serves the background worker and the rate-limited manual
 * refresh. It is read-only end to end: public GETs, then persistence. No auth,
 * no orders, no transfers. OMPFinex is not part of this module.
 */
import { createHash } from "node:crypto";
import { collectAllShadowSources } from "@/lib/shadowArbitrage/adapters";
import { buildOpportunitiesDetailed } from "@/lib/shadowArbitrage/calculate";
import {
  certifyFromSnapshot,
  getCertification,
  setCertification,
  type CertificationStatus,
  type SourceCertification
} from "@/lib/shadowArbitrage/certification";
import {
  SHADOW_BANNER,
  SHADOW_MANUAL_REFRESH_MIN_MS,
  SHADOW_POLL_INTERVAL_MS,
  SHADOW_SOURCES,
  SHADOW_TRADE_SIZES,
  clampPollInterval
} from "@/lib/shadowArbitrage/config";
import {
  beginCollectionRun,
  completeCollectionRun,
  ensureObservationSession,
  getObservation,
  loadLastSourceStates,
  loadLifecyclesForMerge,
  retentionCleanup,
  touchHeartbeat,
  upsertRouteMetrics,
  withShadowLock,
  type ObservationSnapshot
} from "@/db/repositories/shadowArbitrage";
import { persistShadowCycle, saveCertifications } from "@/lib/shadowArbitrage/store";
import type {
  NormalizedSourceSnapshot,
  ShadowMatrixResponse,
  ShadowSourceId
} from "@/lib/shadowArbitrage/types";

export type CycleResult = {
  acquired: boolean;
  duplicate?: boolean;
  skipped?: "paused" | "rate_limited";
  matrix?: ShadowMatrixResponse;
  observation?: ObservationSnapshot;
  status?: "success" | "partial" | "failed";
  runId?: string;
  error?: string;
  /** Cache payload flushed after the lock is released. */
  pendingCache?: {
    serverNow: string;
    sources: NormalizedSourceSnapshot[];
    opportunities: ShadowMatrixResponse["opportunities"];
    blockedCounts: Record<string, number>;
    certifications: SourceCertification[];
  };
};

/**
 * Cycles are bucketed by wall clock so two workers that wake in the same
 * interval produce the same key and the second one is rejected by the unique
 * index instead of recording a duplicate cycle.
 */
export function bucketIdempotencyKey(nowMs: number, intervalMs: number): string {
  const bucket = Math.floor(nowMs / intervalMs);
  return createHash("sha256").update(`shadow-cycle:${intervalMs}:${bucket}`).digest("hex").slice(0, 32);
}

/** In-process guards: single-flight and manual-refresh spacing. */
let inFlight: Promise<CycleResult> | null = null;
let lastManualRefreshAt = 0;

function certStatusMap(
  certs: Record<string, SourceCertification>
): Partial<Record<ShadowSourceId, CertificationStatus>> {
  const out: Partial<Record<ShadowSourceId, CertificationStatus>> = {};
  for (const [id, c] of Object.entries(certs)) {
    out[id as ShadowSourceId] = c.status;
  }
  return out;
}

function certifyAll(sources: NormalizedSourceSnapshot[]): Record<string, SourceCertification> {
  const out: Record<string, SourceCertification> = {};
  for (const s of sources) {
    const previous = getCertification(s.sourceId);
    const cert = certifyFromSnapshot(s, previous);
    setCertification(cert);
    out[s.sourceId] = cert;
  }
  return out;
}

async function runCycleLocked(input: {
  workerId: string;
  pollIntervalMs: number;
  force: boolean;
  ignorePause: boolean;
  /** Only the real collector owns the heartbeat; API refreshes must not. */
  ownsHeartbeat: boolean;
}): Promise<CycleResult> {
  const { workerId, pollIntervalMs, force } = input;

  const session = await ensureObservationSession(pollIntervalMs);
  if (session.status === "PAUSED" && !input.ignorePause) {
    if (input.ownsHeartbeat) {
      await touchHeartbeat({ workerId, status: "paused", pollIntervalMs, sessionId: session.id });
    }
    return { acquired: true, skipped: "paused", observation: session };
  }

  if (input.ownsHeartbeat) {
    await touchHeartbeat({
      workerId,
      status: "collecting",
      pollIntervalMs,
      sessionId: session.id,
      extendLease: true
    });
  }

  const nowMs = Date.now();
  const idempotencyKey = force
    ? createHash("sha256").update(`force:${nowMs}:${workerId}`).digest("hex").slice(0, 32)
    : bucketIdempotencyKey(nowMs, pollIntervalMs);

  const { runId, duplicate } = await beginCollectionRun({
    sessionId: session.id,
    idempotencyKey,
    workerId,
    pollIntervalMs,
    sourcesTotal: SHADOW_SOURCES.length
  });

  if (duplicate) {
    if (input.ownsHeartbeat) {
      await touchHeartbeat({
        workerId,
        status: "idle",
        pollIntervalMs,
        lastCycleStatus: "duplicate",
        sessionId: session.id
      });
    }
    return { acquired: true, duplicate: true, runId, observation: session };
  }

  const t0 = Date.now();
  let sources: NormalizedSourceSnapshot[] = [];
  let cycleError: string | null = null;

  try {
    // Per-source failures are isolated inside collectAllShadowSources.
    sources = await collectAllShadowSources();
  } catch (e) {
    cycleError = e instanceof Error ? e.message : String(e);
    sources = [];
  }

  const serverNow = new Date().toISOString();
  const serverNowMs = Date.parse(serverNow);
  const aged = sources.map((s) => ({
    ...s,
    ageMs: s.sourceTimestamp
      ? s.ageMs
      : Math.max(0, serverNowMs - Date.parse(s.receivedAt))
  }));

  const certBySource = certifyAll(aged);
  const previousStates = await loadLastSourceStates();

  const healthEvents = aged
    .filter((s) => {
      const prev = previousStates[s.sourceId];
      const cert = certBySource[s.sourceId];
      if (!prev) return true; // first observation is itself a transition
      return prev.health !== s.health || prev.certStatus !== (cert?.status ?? null);
    })
    .map((s) => {
      const prev = previousStates[s.sourceId];
      const cert = certBySource[s.sourceId];
      return {
        sourceId: s.sourceId,
        fromHealth: prev?.health ?? null,
        toHealth: s.health,
        fromCertStatus: prev?.certStatus ?? null,
        toCertStatus: cert?.status ?? null,
        reason: s.errorReason ?? s.degradedReason ?? cert?.statusReason ?? null,
        httpStatus: s.meta?.httpStatus ?? null,
        latencyMs: s.meta?.latencyMs ?? null
      };
    });

  const previousLifecycles = await loadLifecyclesForMerge();
  const built = buildOpportunitiesDetailed(aged, previousLifecycles, serverNow, {
    certStatuses: certStatusMap(certBySource)
  });

  const ok = aged.filter((s) => s.health === "healthy" || s.health === "degraded").length;
  const failed = aged.filter((s) => s.health === "unavailable").length;
  const total = aged.length || SHADOW_SOURCES.length;
  const status: "success" | "partial" | "failed" =
    cycleError || aged.length === 0 || failed === total
      ? "failed"
      : failed > 0
        ? "partial"
        : "success";

  const activeOpportunities = built.opportunities.filter((o) => o.isActive);

  await completeCollectionRun({
    runId,
    sessionId: session.id,
    status,
    sourcesOk: ok,
    sourcesFailed: failed,
    sourcesTotal: total,
    opportunityCount: activeOpportunities.length,
    durationMs: Date.now() - t0,
    pollIntervalMs,
    errorMessage: cycleError,
    sources: aged,
    certBySource,
    opportunities: built.opportunities,
    transitions: built.transitions,
    healthEvents
  });

  // Compact aggregates cover every evaluated pair without a row per pair.
  await upsertRouteMetrics(built.drafts, serverNow);

  if (input.ownsHeartbeat) {
    await touchHeartbeat({
      workerId,
      status: "idle",
      pollIntervalMs,
      lastCycleStatus: status,
      sessionId: session.id,
      extendLease: true
    });
  }

  const matrix: ShadowMatrixResponse = {
    serverNow,
    shadowMode: true,
    banner: SHADOW_BANNER,
    sizes: SHADOW_TRADE_SIZES,
    sources: aged,
    opportunities: activeOpportunities,
    generatedAt: serverNow,
    pollIntervalMs
  };

  return {
    acquired: true,
    duplicate: false,
    matrix,
    status,
    runId,
    observation: (await getObservation()) ?? session,
    // Written after the lock is released: the key/value cache helpers use the
    // PGlite serialization queue directly, which would deadlock nested inside it.
    pendingCache: {
      serverNow,
      sources: aged,
      opportunities: activeOpportunities,
      blockedCounts: built.blockedCounts,
      certifications: Object.values(certBySource)
    }
  };
}

/**
 * Run one collection cycle behind the database advisory lock and an in-process
 * single-flight guard, so overlapping cycles cannot happen from either
 * direction (two workers, or a worker plus a manual refresh).
 */
export async function runCollectionCycle(input?: {
  workerId?: string;
  pollIntervalMs?: number;
  force?: boolean;
  /** Manual refresh: enforce minimum spacing between user-triggered cycles. */
  manual?: boolean;
  /** Retention sweep is cheap but not needed on every cycle. */
  runRetention?: boolean;
  ignorePause?: boolean;
  /** True only for the background collector loop. */
  ownsHeartbeat?: boolean;
}): Promise<CycleResult> {
  const workerId = input?.workerId ?? `manual-${process.pid}`;
  const pollIntervalMs = clampPollInterval(input?.pollIntervalMs ?? SHADOW_POLL_INTERVAL_MS);

  if (input?.manual) {
    const since = Date.now() - lastManualRefreshAt;
    if (since < SHADOW_MANUAL_REFRESH_MIN_MS) {
      return { acquired: false, skipped: "rate_limited" };
    }
  }

  if (inFlight) {
    // Single-flight: a concurrent caller waits for the running cycle.
    return inFlight;
  }

  const task = (async (): Promise<CycleResult> => {
    try {
      if (input?.manual) lastManualRefreshAt = Date.now();
      const locked = await withShadowLock(async () =>
        runCycleLocked({
          workerId,
          pollIntervalMs,
          force: Boolean(input?.force),
          ignorePause: Boolean(input?.ignorePause),
          ownsHeartbeat: Boolean(input?.ownsHeartbeat)
        })
      );
      if (!locked.acquired) {
        return { acquired: false, error: "collection lock held by another worker" };
      }
      const result = locked.result ?? { acquired: true };

      // Flush the UI caches now that the serialization queue is free again.
      if (result.pendingCache) {
        const cache = result.pendingCache;
        try {
          await persistShadowCycle({
            serverNow: cache.serverNow,
            sources: cache.sources,
            opportunities: cache.opportunities,
            blockedCounts: cache.blockedCounts
          });
          await saveCertifications(cache.certifications);
        } catch (e) {
          // A cold cache is recoverable — the tables already hold the cycle.
          console.error(
            "[shadow-collector] cache write failed",
            e instanceof Error ? e.message : e
          );
        }
      }

      if (input?.runRetention !== false) {
        await retentionCleanup();
      }
      return result;
    } finally {
      inFlight = null;
    }
  })();

  inFlight = task;
  return task;
}

/** Test seam — clears in-process single-flight and refresh throttle state. */
export function resetCollectorGuards(): void {
  inFlight = null;
  lastManualRefreshAt = 0;
}
