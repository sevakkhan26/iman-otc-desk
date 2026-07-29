import { NextResponse } from "next/server";
import { isSession } from "@/lib/requireApiAuth";
import { requireAdminSession } from "@/lib/requireAdmin";
import {
  getObservation,
  getWorkerHeartbeat,
  loadRunStats,
  loadSourceStats,
  setObservationStatus
} from "@/db/repositories/shadowArbitrage";
import { listCertifications, type SourceCertification } from "@/lib/shadowArbitrage/certification";
import { loadCertificationsStored } from "@/lib/shadowArbitrage/store";
import {
  SHADOW_BANNER,
  SHADOW_COST_RECORDS,
  SHADOW_POLL_INTERVAL_MS,
  SHADOW_POLL_MAX_MS,
  SHADOW_POLL_MIN_MS,
  SHADOW_SOURCES
} from "@/lib/shadowArbitrage/config";
import { SHADOW_NO_STORE } from "@/lib/shadowArbitrage/httpHeaders";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";


/**
 * Observation + worker + source certification status.
 * Admin only (middleware plus requireAdminSession). Read-only: this endpoint
 * never contacts an exchange, it only reports what the collector persisted.
 */
export async function GET() {
  const session = await requireAdminSession();
  if (!isSession(session)) return session;

  const [observation, heartbeat, stored, runStats, sourceStats] = await Promise.all([
    getObservation(),
    getWorkerHeartbeat(),
    loadCertificationsStored(),
    loadRunStats(),
    loadSourceStats()
  ]);

  const certs: SourceCertification[] =
    Array.isArray(stored) && stored.length ? (stored as SourceCertification[]) : listCertifications();

  const health = SHADOW_SOURCES.map((cfg) => {
    const s = sourceStats.find((x) => x.sourceId === cfg.id);
    const samples = s?.samples ?? 0;
    const reachable = (s?.healthySamples ?? 0) + (s?.degradedSamples ?? 0);
    return {
      sourceId: cfg.id,
      sourceName: cfg.nameFa,
      samples,
      uptimePercent: samples ? Math.round((reachable / samples) * 10_000) / 100 : 0,
      errorRatePercent: samples
        ? Math.round(((s?.errorSamples ?? 0) / samples) * 10_000) / 100
        : 0,
      freshnessPercent: samples
        ? Math.round(((samples - (s?.staleSamples ?? 0)) / samples) * 10_000) / 100
        : 0,
      latencyP50Ms: s?.latencyP50Ms ?? null,
      latencyP95Ms: s?.latencyP95Ms ?? null,
      lastError: s?.lastError ?? null,
      lastErrorAt: s?.lastErrorAt ?? null,
      rateLimitNote: cfg.rateLimitNote
    };
  });

  const pollIntervalMs = heartbeat?.pollIntervalMs ?? observation?.pollIntervalMs ?? SHADOW_POLL_INTERVAL_MS;
  const nextExpected = heartbeat?.lastCycleAt
    ? new Date(Date.parse(heartbeat.lastCycleAt) + pollIntervalMs).toISOString()
    : null;

  return new NextResponse(
    JSON.stringify({
      banner: SHADOW_BANNER,
      shadowMode: true,
      serverNow: new Date().toISOString(),
      observation,
      runStats,
      worker: heartbeat
        ? { ...heartbeat, nextExpectedCycleAt: nextExpected, defaultPollIntervalMs: SHADOW_POLL_INTERVAL_MS }
        : {
            workerId: null,
            status: "stopped",
            lastHeartbeatAt: null,
            lastCycleAt: null,
            lastCycleStatus: null,
            pollIntervalMs: SHADOW_POLL_INTERVAL_MS,
            leaseExpiresAt: null,
            stale: true,
            leaseHeld: false,
            nextExpectedCycleAt: null,
            defaultPollIntervalMs: SHADOW_POLL_INTERVAL_MS
          },
      pollIntervalRange: { minMs: SHADOW_POLL_MIN_MS, maxMs: SHADOW_POLL_MAX_MS },
      certifications: certs,
      sourceHealth: health,
      costRecords: SHADOW_COST_RECORDS,
      workerCommand: "pnpm shadow:worker"
    }),
    { status: 200, headers: SHADOW_NO_STORE }
  );
}

/**
 * Admin control for the observation session: start / pause / resume / complete.
 * This only changes whether the collector records cycles — it places no orders
 * and touches no funds.
 */
export async function POST(request: Request) {
  const session = await requireAdminSession();
  if (!isSession(session)) return session;

  let action: unknown;
  let pollIntervalMs: unknown;
  try {
    const body = (await request.json()) as { action?: unknown; pollIntervalMs?: unknown };
    action = body.action;
    pollIntervalMs = body.pollIntervalMs;
  } catch {
    return new NextResponse(JSON.stringify({ error: "bad_request", message: "بدنهٔ JSON نامعتبر" }), {
      status: 400,
      headers: SHADOW_NO_STORE
    });
  }

  const allowed = ["start", "pause", "resume", "complete"] as const;
  if (typeof action !== "string" || !allowed.includes(action as (typeof allowed)[number])) {
    return new NextResponse(
      JSON.stringify({ error: "bad_request", message: `action باید یکی از ${allowed.join("، ")} باشد` }),
      { status: 400, headers: SHADOW_NO_STORE }
    );
  }

  try {
    const observation = await setObservationStatus(
      action as (typeof allowed)[number],
      typeof pollIntervalMs === "number" ? pollIntervalMs : undefined
    );
    return new NextResponse(
      JSON.stringify({ banner: SHADOW_BANNER, shadowMode: true, observation }),
      { status: 200, headers: SHADOW_NO_STORE }
    );
  } catch (error) {
    return new NextResponse(
      JSON.stringify({
        error: "unavailable",
        message: error instanceof Error ? error.message : "تغییر وضعیت مشاهده ممکن نشد"
      }),
      { status: 503, headers: SHADOW_NO_STORE }
    );
  }
}
