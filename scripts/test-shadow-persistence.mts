#!/usr/bin/env npx tsx
/**
 * Shadow Arbitrage persistence tests — real database, no exchange network.
 *
 * Runs against a throwaway PGlite instance and drives the repository directly
 * with synthetic snapshots, so idempotency, worker locking, restart continuity
 * and retention are tested without touching a venue.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (e) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e instanceof Error ? (e.stack ?? e.message) : e}`);
    failed += 1;
  }
}

const dir = await mkdtemp(path.join(tmpdir(), "otc-shadow-persist-"));
process.env.DATABASE_URL = `pglite:${path.join(dir, "pglite")}`;

const { closeDb } = await import("../src/db/client.ts");
const { runMigrations } = await import("../src/db/migrate.ts");
const repo = await import("../src/db/repositories/shadowArbitrage.ts");
const { buildOpportunitiesDetailed } = await import("../src/lib/shadowArbitrage/calculate.ts");
const { certifyFromSnapshot, resetCertifications } = await import(
  "../src/lib/shadowArbitrage/certification.ts"
);
const { bucketIdempotencyKey } = await import("../src/lib/shadowArbitrage/collector.ts");
const paperRepo = await import("../src/db/repositories/shadowPaper.ts");
const paperRun = await import("../src/lib/shadowArbitrage/paper/run.ts");
const liveRepo = await import("../src/db/repositories/shadowLive.ts");
const types = await import("../src/lib/shadowArbitrage/types.ts");
void types;

type Snap = Awaited<ReturnType<typeof repo.loadLatestSourceSnapshots>>[number];
void ({} as Snap);

import type {
  NormalizedSourceSnapshot,
  ShadowSourceId
} from "../src/lib/shadowArbitrage/types.ts";

function snap(
  id: string,
  buy: number,
  sell: number,
  over?: Partial<NormalizedSourceSnapshot>
): NormalizedSourceSnapshot {
  const now = new Date().toISOString();
  return {
    sourceId: id as ShadowSourceId,
    sourceName: id,
    marketModel: "ORDER_BOOK",
    accountStatus: "verified",
    eligibilityBase: "EXECUTABLE_NOW",
    bestBidToman: sell,
    bestAskToman: buy,
    userBuyPriceToman: buy,
    userSellPriceToman: sell,
    sizeExecutables: [5, 10, 20, 25].map((sizeUsdt) => ({
      sizeUsdt: sizeUsdt as 5 | 10 | 20 | 25,
      userBuyVwapToman: buy,
      userSellVwapToman: sell,
      buyFillable: true,
      sellFillable: true,
      buyFilledUsdt: sizeUsdt,
      sellFilledUsdt: sizeUsdt
    })),
    depthUsdtBid: 500,
    depthUsdtAsk: 500,
    maxExecutableUsdt: 500,
    marketFeeBps: 25,
    feeStatus: "provisional",
    feeLabel: "test",
    feeReferenceUrl: null,
    feeVerifiedAt: null,
    sourceTimestamp: now,
    receivedAt: now,
    ageMs: 0,
    health: "healthy",
    errorReason: null,
    degradedReason: null,
    stale: false,
    meta: {
      endpoint: "https://example.test",
      httpStatus: 200,
      latencyMs: 120,
      attempts: 1,
      rateLimited: false,
      timedOut: false,
      depthAvailable: true,
      directionVerified: true,
      priceUnit: "IRT",
      normalizationNote: null
    },
    sourceBlockedReasons: [],
    ...over
  };
}

/** Record one synthetic cycle the same way the collector does. */
async function recordCycle(opts?: {
  idempotencyKey?: string;
  sources?: NormalizedSourceSnapshot[];
  pollIntervalMs?: number;
  workerId?: string;
}): Promise<{ runId: string; duplicate: boolean; activeCount: number }> {
  const pollIntervalMs = opts?.pollIntervalMs ?? 15_000;
  const sources =
    opts?.sources ?? [snap("nobitex", 100_000, 99_500), snap("wallex", 101_000, 100_500)];
  const session = await repo.ensureObservationSession(pollIntervalMs);
  const { runId, duplicate } = await repo.beginCollectionRun({
    sessionId: session.id,
    idempotencyKey: opts?.idempotencyKey ?? `key-${Date.now()}-${Math.round(Math.random() * 1e9)}`,
    workerId: opts?.workerId ?? "test-worker",
    pollIntervalMs,
    sourcesTotal: sources.length
  });
  if (duplicate) return { runId, duplicate, activeCount: 0 };

  const nowIso = new Date().toISOString();
  const previous = await repo.loadLifecyclesForMerge();
  const built = buildOpportunitiesDetailed(sources, previous, nowIso);
  const certBySource = Object.fromEntries(
    sources.map((s) => [s.sourceId, certifyFromSnapshot(s)])
  );
  const failedCount = sources.filter((s) => s.health === "unavailable").length;

  await repo.completeCollectionRun({
    runId,
    sessionId: session.id,
    status: failedCount === 0 ? "success" : failedCount === sources.length ? "failed" : "partial",
    sourcesOk: sources.length - failedCount,
    sourcesFailed: failedCount,
    sourcesTotal: sources.length,
    opportunityCount: built.opportunities.filter((o) => o.isActive).length,
    durationMs: 12,
    pollIntervalMs,
    sources,
    certBySource,
    opportunities: built.opportunities,
    transitions: built.transitions,
    healthEvents: sources.map((s) => ({
      sourceId: s.sourceId,
      fromHealth: null,
      toHealth: s.health,
      fromCertStatus: null,
      toCertStatus: certBySource[s.sourceId]?.status ?? null,
      reason: s.errorReason,
      httpStatus: s.meta.httpStatus,
      latencyMs: s.meta.latencyMs
    }))
  });
  await repo.upsertRouteMetrics(built.drafts, nowIso);
  return {
    runId,
    duplicate,
    activeCount: built.opportunities.filter((o) => o.isActive).length
  };
}

console.log("\nShadow Arbitrage persistence tests (temp PGlite)\n");

await test("migrations create the Phase 2 tables", async () => {
  const result = await runMigrations();
  assert.ok(result.applied.includes("0001_shadow_arbitrage.sql"));
  assert.ok(result.applied.includes("0002_shadow_arbitrage_phase2.sql"));
  // Re-running is a no-op, not a destructive rewrite.
  const again = await runMigrations();
  assert.deepEqual(again.applied, []);
  assert.ok(again.skipped.includes("0002_shadow_arbitrage_phase2.sql"));
});

await test("observation session is created once and reused", async () => {
  const first = await repo.ensureObservationSession(30_000);
  const second = await repo.ensureObservationSession(30_000);
  assert.equal(first.id, second.id, "must not create a second session");
  assert.equal(first.status, "RUNNING");
  assert.ok(first.startedAt);
  assert.equal(first.targetDurationMs, 14 * 24 * 60 * 60_000);
});

await test("collection run persists rows across all Phase 2 tables", async () => {
  resetCertifications();
  const { duplicate, activeCount } = await recordCycle();
  assert.equal(duplicate, false);
  assert.ok(activeCount > 0, "expected at least one material opportunity");

  const snapshots = await repo.countSnapshots();
  assert.ok(snapshots >= 2, `expected snapshots, got ${snapshots}`);
  const events = await repo.countLifecycleEvents();
  assert.ok(events > 0, "lifecycle transitions must be recorded");
  const latest = await repo.loadLatestSourceSnapshots();
  assert.equal(latest.length, 2);
  assert.ok(latest.every((s) => s.userBuy !== null && s.latencyMs !== null));
  const metrics = await repo.loadRouteMetrics();
  assert.ok(metrics.length > 0, "route aggregates must be written");
  assert.ok(metrics.every((m) => m.samples > 0));
});

await test("duplicate idempotency key does not create a second run", async () => {
  const key = bucketIdempotencyKey(1_700_000_000_000, 30_000);
  const before = (await repo.loadRunStats()).runCount;
  const a = await recordCycle({ idempotencyKey: key });
  const b = await recordCycle({ idempotencyKey: key });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true, "same bucket must be rejected as duplicate");
  assert.equal(b.runId, a.runId, "duplicate must resolve to the original run");
  const after = await repo.loadRunStats();
  assert.equal(after.runCount, before + 1, "only one run recorded");
  assert.equal(after.duplicateIdempotencyKeys, 0, "unique index holds");
});

await test("a persistent opportunity stays one lifecycle across cycles", async () => {
  const activeBefore = await repo.loadActiveOpportunitiesDb();
  const ids = new Set(activeBefore.map((o) => o.id));
  await recordCycle();
  await recordCycle();
  const activeAfter = await repo.loadActiveOpportunitiesDb();
  const routeCounts = new Map<string, number>();
  for (const o of activeAfter) routeCounts.set(o.routeKey, (routeCounts.get(o.routeKey) ?? 0) + 1);
  for (const [route, count] of routeCounts) {
    assert.equal(count, 1, `${route} must have exactly one active lifecycle row`);
  }
  const same = activeAfter.filter((o) => ids.has(o.id));
  assert.ok(same.length > 0, "existing lifecycles must be updated, not replaced");
  assert.ok(
    same.every((o) => (o.observationCount ?? 1) >= 2),
    "observation count must accumulate"
  );
});

await test("lifecycle close and reappearance are persisted", async () => {
  // No sources → all active routes close.
  const session = await repo.ensureObservationSession(15_000);
  const active = await repo.loadActiveOpportunitiesDb();
  assert.ok(active.length > 0);
  const closedRoute = active[0]!.routeKey;
  const closedId = active[0]!.id;

  const nowIso = new Date().toISOString();
  const previous = await repo.loadLifecyclesForMerge();
  const built = buildOpportunitiesDetailed([], previous, nowIso);
  const { runId } = await repo.beginCollectionRun({
    sessionId: session.id,
    idempotencyKey: `close-${Date.now()}`,
    workerId: "test-worker",
    pollIntervalMs: 15_000,
    sourcesTotal: 0
  });
  await repo.completeCollectionRun({
    runId,
    sessionId: session.id,
    status: "failed",
    sourcesOk: 0,
    sourcesFailed: 0,
    sourcesTotal: 0,
    opportunityCount: 0,
    durationMs: 5,
    pollIntervalMs: 15_000,
    sources: [],
    opportunities: built.opportunities,
    transitions: built.transitions
  });

  const stillActive = await repo.loadActiveOpportunitiesDb();
  assert.equal(
    stillActive.some((o) => o.id === closedId),
    false,
    "closed lifecycle must not remain active"
  );

  // Same route returns → new lifecycle id, old one retained as history.
  await recordCycle();
  const reopened = await repo.loadActiveOpportunitiesDb();
  const back = reopened.find((o) => o.routeKey === closedRoute);
  assert.ok(back, "route should reappear");
  assert.notEqual(back!.id, closedId, "reappearance must open a new lifecycle");
  const history = await repo.loadHistoryDb(2000);
  assert.ok(
    history.some((o) => o.id === closedId),
    "closed lifecycle must be kept as history"
  );
});

await test("observation counters and coverage survive a simulated restart", async () => {
  const before = await repo.getObservation();
  assert.ok(before);
  const cyclesBefore = before!.completedCycles;
  assert.ok(cyclesBefore > 0);

  // Close every handle, then re-open — the same process restarting the worker.
  await closeDb();
  const after = await repo.getObservation();
  assert.ok(after, "session must be readable after reconnect");
  assert.equal(after!.id, before!.id, "restart must not create a new session");
  assert.equal(after!.completedCycles, cyclesBefore, "counters must survive");
  assert.equal(after!.startedAt, before!.startedAt, "start time must survive");

  const survivingActive = await repo.loadActiveOpportunitiesDb();
  assert.ok(survivingActive.length > 0, "lifecycle data must survive a restart");

  // And a new cycle continues the same session rather than starting over.
  await recordCycle();
  const continued = await repo.getObservation();
  assert.equal(continued!.id, before!.id);
  assert.equal(continued!.completedCycles, cyclesBefore + 1);
});

await test("worker lease blocks a second worker until it expires", async () => {
  const first = await repo.claimWorkerLease({ workerId: "worker-A", pollIntervalMs: 30_000 });
  assert.equal(first.acquired, true);
  const second = await repo.claimWorkerLease({ workerId: "worker-B", pollIntervalMs: 30_000 });
  assert.equal(second.acquired, false, "a second worker must be refused");
  assert.equal(second.heldBy, "worker-A");

  // The holder can always renew its own lease.
  const renew = await repo.claimWorkerLease({ workerId: "worker-A", pollIntervalMs: 30_000 });
  assert.equal(renew.acquired, true);

  // After a graceful release the lease is free again.
  await repo.releaseWorkerLease("worker-A");
  const third = await repo.claimWorkerLease({ workerId: "worker-B", pollIntervalMs: 30_000 });
  assert.equal(third.acquired, true, "released lease must be claimable");

  const hb = await repo.getWorkerHeartbeat();
  assert.equal(hb?.workerId, "worker-B");
  assert.equal(hb?.leaseHeld, true);
  assert.equal(hb?.stale, false);

  // Leave the lease free for the following tests.
  await repo.releaseWorkerLease("worker-B");
  assert.equal((await repo.getWorkerHeartbeat())?.leaseHeld, false);
});

await test("a lease left by a dead local process is reclaimed at once", async () => {
  const { makeWorkerId } = await import("../src/lib/shadowArbitrage/workerIdentity.ts");
  // A worker id for a pid that cannot exist: the app can be SIGTERM'd before it
  // releases the lease, and collection must not stall until the lease expires.
  const ghost = makeWorkerId("inproc", 2_147_483_1);
  const held = await repo.claimWorkerLease({ workerId: ghost, pollIntervalMs: 300_000 });
  assert.equal(held.acquired, true);

  const successor = makeWorkerId("inproc");
  const takeover = await repo.claimWorkerLease({ workerId: successor, pollIntervalMs: 30_000 });
  assert.equal(takeover.acquired, true, "must reclaim a lease owned by a dead local pid");
  assert.equal(takeover.heldBy, successor);

  // A live holder is still respected.
  const other = await repo.claimWorkerLease({ workerId: "worker-live", pollIntervalMs: 30_000 });
  assert.equal(other.acquired, false, "a live holder must not be displaced");
  await repo.releaseWorkerLease(successor);
});

await test("overlapping cycles are prevented by the shadow lock", async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const body = async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((r) => setTimeout(r, 40));
    concurrent -= 1;
    return true;
  };
  const results = await Promise.all([
    repo.withShadowLock(body),
    repo.withShadowLock(body),
    repo.withShadowLock(body)
  ]);
  assert.equal(maxConcurrent, 1, "cycle bodies must never overlap");
  assert.ok(results.every((r) => r.acquired));
});

await test("pause / resume changes status without losing progress", async () => {
  const before = await repo.getObservation();
  const paused = await repo.setObservationStatus("pause");
  assert.equal(paused.status, "PAUSED");
  assert.ok(paused.pausedAt);
  assert.equal(paused.completedCycles, before!.completedCycles);

  // ensureObservationSession must not silently resume a paused session.
  const stillPaused = await repo.ensureObservationSession(15_000);
  assert.equal(stillPaused.status, "PAUSED");

  await new Promise((r) => setTimeout(r, 30));
  const resumed = await repo.setObservationStatus("resume");
  assert.equal(resumed.status, "RUNNING");
  assert.equal(resumed.pausedAt, null);
  assert.ok(resumed.pausedTotalMs > 0, "paused time must be accounted for");
  assert.equal(resumed.completedCycles, before!.completedCycles);
});

await test("partial source failure is recorded without losing the cycle", async () => {
  const sources = [
    snap("nobitex", 0, 0, {
      health: "unavailable",
      errorReason: "HTTP 503",
      userBuyPriceToman: null,
      userSellPriceToman: null,
      sourceBlockedReasons: ["source_unhealthy", "market_data_missing"]
    }),
    snap("wallex", 100_000, 99_500),
    snap("tabdeal", 101_000, 100_500)
  ];
  const before = await repo.loadRunStats();
  const { duplicate, activeCount } = await recordCycle({ sources });
  assert.equal(duplicate, false);
  assert.ok(activeCount > 0, "healthy pair still produced opportunities");
  const after = await repo.loadRunStats();
  assert.equal(after.partialRuns, before.partialRuns + 1, "cycle recorded as partial");

  const stats = await repo.loadSourceStats();
  const dead = stats.find((s) => s.sourceId === "nobitex")!;
  assert.ok(dead.errorSamples > 0, "error samples must be counted");
  assert.ok(dead.lastError?.includes("503"));
});

await test("retention cleanup removes only data past the window", async () => {
  const activeBefore = (await repo.loadActiveOpportunitiesDb()).length;
  const runsBefore = (await repo.loadRunStats()).runCount;
  const removed = await repo.retentionCleanup();
  assert.equal(removed.runs, 0, "nothing inside the 14-day window may be deleted");
  assert.equal(removed.lifecycles, 0);
  const runsAfter = (await repo.loadRunStats()).runCount;
  assert.equal(runsAfter, runsBefore, "recent runs survive");
  assert.equal((await repo.loadActiveOpportunitiesDb()).length, activeBefore);

  // Age one run past the window and confirm it (and its snapshots) go away.
  const { getDbAsync } = await import("../src/db/client.ts");
  const { sql } = await import("drizzle-orm");
  const db = await getDbAsync();
  const old = new Date(Date.now() - 20 * 24 * 60 * 60_000).toISOString();
  await db.execute(
    sql`UPDATE shadow_collection_runs SET started_at = ${old} WHERE id = (SELECT id FROM shadow_collection_runs ORDER BY started_at ASC LIMIT 1)`
  );
  const snapsBefore = await repo.countSnapshots();
  const second = await repo.retentionCleanup();
  assert.equal(second.runs, 1, "the aged run must be deleted");
  const snapsAfter = await repo.countSnapshots();
  assert.ok(snapsAfter <= snapsBefore, "its snapshots cascade away");
  assert.ok((await repo.loadActiveOpportunitiesDb()).length > 0, "active lifecycles untouched");
});

await test("run and source stats expose coverage inputs", async () => {
  const stats = await repo.loadRunStats();
  assert.ok(stats.runCount > 0);
  assert.ok(stats.firstRunAt && stats.lastRunAt);
  const sources = await repo.loadSourceStats();
  assert.ok(sources.length > 0);
  for (const s of sources) {
    assert.ok(s.samples > 0);
    assert.ok(s.latencyP50Ms === null || s.latencyP50Ms >= 0);
  }
  const obs = await repo.getObservation();
  assert.ok(obs!.cycleCoveragePercent >= 0 && obs!.cycleCoveragePercent <= 100);
  assert.ok(obs!.expectedCycles >= 1);
});


await test("restart during a live lease: B waits, then takes over after expiry", async () => {
  // Reproduces the production outage: container A held the lease, was recreated
  // without releasing it, and the new process exited instead of waiting — so
  // nothing claimed the lease once it expired.
  const { acquireLeaseWithRetry } = await import("../src/lib/shadowArbitrage/runner.ts");
  const { makeWorkerId } = await import("../src/lib/shadowArbitrage/workerIdentity.ts");

  // Lease = max(pollInterval*3, floor). Use a 1s interval + 4s floor so the
  // expiry path runs in seconds instead of two minutes.
  process.env.SHADOW_LEASE_MIN_MS = "4000";
  try {
    const sessionBefore = await repo.ensureObservationSession(15_000);

    // A is on a DIFFERENT host, so the dead-pid reclaim cannot short-circuit
    // this — exactly like a recreated container with a new hostname.
    const workerA = "shadow-web-otherhostabc-4321-ms7test";
    const a = await repo.claimWorkerLease({ workerId: workerA, pollIntervalMs: 1_000 });
    assert.equal(a.acquired, true, "A must hold the lease");

    // A disappears WITHOUT releasing. B starts while the lease is still valid.
    const workerB = makeWorkerId("web");
    const immediate = await repo.claimWorkerLease({ workerId: workerB, pollIntervalMs: 1_000 });
    assert.equal(immediate.acquired, false, "B must not steal a live lease");

    const started = Date.now();
    const result = await acquireLeaseWithRetry({
      workerId: workerB,
      pollIntervalMs: 1_000,
      shouldStop: () => false,
      minDelayMs: 250,
      maxDelayMs: 1_000,
      maxWaitMs: 30_000
    });
    assert.equal(result.acquired, true, "B must take over once the lease expires");
    assert.ok(result.waitedMs >= 1_000, "B must have waited rather than exited immediately");
    assert.ok(Date.now() - started < 30_000, "takeover must happen promptly after expiry");

    // Exactly one collector: the heartbeat now names B, and A cannot come back.
    const hb = await repo.getWorkerHeartbeat();
    assert.equal(hb?.workerId, workerB);
    assert.equal(hb?.leaseHeld, true);
    const aAgain = await repo.claimWorkerLease({ workerId: workerA, pollIntervalMs: 1_000 });
    assert.equal(aAgain.acquired, false, "the displaced worker must not reclaim a live lease");

    // The observation session is untouched by the handover.
    const sessionAfter = await repo.getObservation();
    assert.equal(sessionAfter?.id, sessionBefore.id, "observation.id must survive the restart");

    // A graceful release frees it immediately for the next process.
    await repo.releaseWorkerLease(workerB);
    assert.equal((await repo.getWorkerHeartbeat())?.leaseHeld, false);
  } finally {
    delete process.env.SHADOW_LEASE_MIN_MS;
  }
});

await test("capital plans persist append-only and preserve virtual balances", async () => {
  const before = await repo.loadCapitalPlans();

  const saved = await repo.saveCapitalPlan({
    name: "طرح آزمایشی",
    mode: "MANUAL",
    totalCapitalToman: 50_000_000,
    valuationPriceToman: 100_000,
    reservePercent: 0,
    allocations: [
      { sourceId: "nobitex", irtToman: 10_000_000, usdtUnits: 50 },
      { sourceId: "wallex", irtToman: 5_000_000, usdtUnits: 100 }
    ],
    createdBy: "admin",
    note: "شبیه‌سازی"
  });
  assert.ok(saved.id, "saved plan must have an id");
  assert.equal(saved.totalCapitalToman, 50_000_000);
  assert.equal(saved.allocations.length, 2);

  const latest = await repo.loadLatestCapitalPlan();
  assert.equal(latest?.id, saved.id, "latest plan is the most recent save");
  assert.equal(latest?.allocations[0]?.usdtUnits, 50, "virtual USDT balance round-trips");

  // Append-only: a second save adds a row and never mutates the first.
  const second = await repo.saveCapitalPlan({
    name: "طرح دوم",
    mode: "OPTIMIZED",
    totalCapitalToman: 60_000_000,
    valuationPriceToman: 100_000,
    reservePercent: 20,
    allocations: [{ sourceId: "tabdeal", irtToman: 1_000_000, usdtUnits: 0 }],
    createdBy: "admin",
    note: null
  });
  const after = await repo.loadCapitalPlans();
  assert.equal(after.length, before.length + 2, "both saves are retained");
  const original = after.find((p) => p.id === saved.id);
  assert.equal(original?.totalCapitalToman, 50_000_000, "the earlier plan is unchanged");
  assert.equal(after[0]?.id, second.id, "history is newest first");
  assert.equal(after[0]?.mode, "OPTIMIZED");
  assert.equal(after[0]?.reservePercent, 20);
});

await test("capital approvals persist append-only and pin plan + readiness", async () => {
  const first = await repo.saveCapitalApproval({
    planId: null,
    planFingerprint: "plan-aaa",
    readinessFingerprint: "ready-aaa",
    approvedBy: "admin",
    note: "تأیید اول"
  });
  assert.ok(first.id);
  let latest = await repo.loadLatestCapitalApproval();
  assert.equal(latest?.planFingerprint, "plan-aaa");
  assert.equal(latest?.readinessFingerprint, "ready-aaa");

  // A later approval supersedes it without mutating the earlier row.
  const second = await repo.saveCapitalApproval({
    planId: null,
    planFingerprint: "plan-bbb",
    readinessFingerprint: "ready-bbb",
    approvedBy: "admin",
    note: null
  });
  latest = await repo.loadLatestCapitalApproval();
  assert.equal(latest?.id, second.id);
  assert.equal(latest?.planFingerprint, "plan-bbb");
  assert.notEqual(second.id, first.id, "approvals are appended, never updated");
});

/* ── Phase 6 — paper execution persistence ────────────────────────────────── */

const PAPER_OPENING = [
  { sourceId: "nobitex", irtToman: 20_000_000, usdtUnits: 100 },
  { sourceId: "wallex", irtToman: 20_000_000, usdtUnits: 100 }
];

function paperFill(
  lifecycleId: string,
  netPnl = 43_750,
  balancesAfter: Array<{ sourceId: string; irtToman: number; usdtMicros: number }> = [
    { sourceId: "nobitex", irtToman: 20_000_000 - 2_506_250, usdtMicros: 125_000_000 },
    { sourceId: "wallex", irtToman: 20_000_000 + 2_550_000, usdtMicros: 74_912_500 }
  ]
) {
  return {
    lifecycleId,
    routeKey: "nobitex->wallex@25",
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    sizeUsdt: 25,
    buyVwapToman: 100_000,
    sellVwapToman: 102_000,
    buyNotionalToman: 2_500_000,
    sellNotionalToman: 2_550_000,
    buyFeeBps: 25,
    sellFeeBps: 35,
    // Confirmed mixed settlement: IRT on the buy side, USDT on the sell side.
    buyFeeAsset: "IRT",
    buyFeeDebitMode: "ADD_TO_DEBIT",
    buyFeeProvenance: "ADMIN_CONFIRMED",
    sellFeeAsset: "USDT",
    sellFeeDebitMode: "ADD_TO_DEBIT",
    sellFeeProvenance: "ADMIN_CONFIRMED",
    feeTomanTotal: 6_250,
    feeUsdtMicrosTotal: 87_500,
    slippageBufferToman: 1_000,
    grossSpreadToman: 50_000,
    markPriceToman: 100_000,
    cashPnlIrtToman: netPnl,
    // 0.0875 USDT valued at the 100,000-toman same-cycle mark price.
    sellFeeValueToman: 8_750,
    economicNetPnlToman: netPnl - 8_750,
    riskAdjustedPnlToman: netPnl - 8_750 - 1_000,
    inventoryDeltaUsdtMicros: -87_500,
    balancesAfter
  };
}

let paperSessionId = "";

await test("paper session is never started by creation alone", async () => {
  const before = await paperRepo.getActivePaperSession();
  assert.equal(before, null, "a fresh database has no paper session");

  const created = await paperRepo.createPaperSession({
    observationId: null,
    name: "نشست تست",
    mode: "PROVISIONAL_EVALUATION",
    totalCapitalToman: 50_000_000,
    valuationPriceToman: 100_000,
    openingAllocations: PAPER_OPENING,
    approvalFingerprint: null,
    createdBy: "admin",
    note: null
  });
  paperSessionId = created.id;
  assert.equal(created.status, "NOT_STARTED", "creation must not start execution");
  assert.equal(created.startedAt, null);

  const balances = await paperRepo.loadPaperBalances(created.id);
  assert.equal(balances.length, 2);
  assert.equal(balances.find((b) => b.sourceId === "nobitex")?.usdtMicros, 100_000_000);
});

await test("paper engine does not run for a session that was never started", async () => {
  const outcome = await paperRun.runPaperExecutionForCycle({
    runId: null,
    occurredAt: new Date().toISOString(),
    cycleStatus: "success",
    sources: [],
    opportunities: []
  });
  assert.equal(outcome.ran, false);
  assert.equal(outcome.reason, "not_running");
  const ledger = await paperRepo.loadPaperLedger(paperSessionId);
  assert.equal(ledger.length, 0, "nothing is written while the session is not running");
});

await test("paper session start, pause and resume are explicit admin transitions", async () => {
  const started = await paperRepo.setPaperSessionStatus(paperSessionId, "RUNNING");
  assert.equal(started?.status, "RUNNING");
  assert.ok(started?.startedAt, "startedAt is stamped once");
  const firstStart = started?.startedAt;

  const paused = await paperRepo.setPaperSessionStatus(paperSessionId, "PAUSED");
  assert.equal(paused?.status, "PAUSED");
  assert.ok(paused?.pausedAt);

  const resumed = await paperRepo.setPaperSessionStatus(paperSessionId, "RUNNING");
  assert.equal(resumed?.status, "RUNNING");
  assert.equal(resumed?.pausedAt, null, "resuming clears the pause marker");
  assert.equal(resumed?.startedAt, firstStart, "the original start time is preserved");
});

await test("paper fill commits both legs and the balance change together", async () => {
  const result = await paperRepo.commitPaperCycle({
    sessionId: paperSessionId,
    runId: null,
    occurredAt: new Date().toISOString(),
    fills: [paperFill("lc-1")],
    skips: [
      {
        lifecycleId: "lc-skip",
        routeKey: "wallex->nobitex@5",
        buySourceId: "wallex",
        sellSourceId: "nobitex",
        sizeUsdt: 5,
        rejectionCode: "insufficient_usdt",
        reasonCodes: ["insufficient_usdt"],
        rejectionReason: "موجودی تتری صرافی فروش کافی نیست",
        requiredRebalance: "انتقال شبیه‌سازی‌شدهٔ ۵ تتر لازم است."
      }
    ]
  });
  assert.equal(result.filled, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.duplicates, 0);

  const balances = await paperRepo.loadPaperBalances(paperSessionId);
  assert.equal(balances.find((b) => b.sourceId === "nobitex")?.irtToman, 17_493_750);
  // Sell debited quantity plus the USDT fee: 100 − 25.0875 = 74.9125 USDT.
  assert.equal(balances.find((b) => b.sourceId === "wallex")?.usdtMicros, 74_912_500);

  const stats = await paperRepo.loadPaperStats(paperSessionId);
  assert.equal(stats.filled, 1);
  assert.equal(stats.skipped, 1);
  // Cash PnL is the gross spread minus the buy-side IRT fee only; the economic
  // result is smaller because the USDT fee is valued and subtracted.
  assert.equal(stats.cashPnlIrtToman, 43_750);
  assert.equal(stats.sellFeeValueToman, 8_750);
  assert.equal(stats.economicNetPnlToman, 35_000);
  assert.equal(stats.riskAdjustedPnlToman, 34_000);
  assert.equal(stats.inventoryDeltaUsdtMicros, -87_500);
  assert.equal(stats.feeTomanTotal, 6_250);
  assert.equal(stats.feeUsdtMicrosTotal, 87_500);
  assert.ok(stats.blockReasons.some((r) => r.code === "insufficient_usdt"));

  // The skip is recorded with its rebalance requirement, not silently dropped.
  const skipped = await paperRepo.loadPaperLedger(paperSessionId, { outcome: "SKIPPED" });
  assert.equal(skipped.length, 1);
  assert.ok(skipped[0].requiredRebalance?.includes("انتقال"));
});

await test("paper ledger refuses a duplicate fill of the same lifecycle", async () => {
  const balancesBefore = await paperRepo.loadPaperBalances(paperSessionId);
  const again = await paperRepo.commitPaperCycle({
    sessionId: paperSessionId,
    runId: null,
    occurredAt: new Date().toISOString(),
    fills: [paperFill("lc-1")],
    skips: []
  });
  assert.equal(again.filled, 0, "the second fill is refused");
  assert.equal(again.duplicates, 1);

  const balancesAfter = await paperRepo.loadPaperBalances(paperSessionId);
  assert.deepEqual(balancesAfter, balancesBefore, "a refused duplicate changes no balance");

  const fills = await paperRepo.loadPaperLedger(paperSessionId, { outcome: "FILLED" });
  assert.equal(fills.length, 1, "the ledger still holds exactly one fill");

  const filledIds = await paperRepo.loadFilledLifecycleIds(paperSessionId);
  assert.ok(filledIds.has("lc-1"));
});

await test("paper ledgers reconcile independently across the session", async () => {
  const balances = await paperRepo.loadPaperBalances(paperSessionId);
  const fills = await paperRepo.loadPaperLedger(paperSessionId, { outcome: "FILLED" });

  const openingIrt = PAPER_OPENING.reduce((s, a) => s + a.irtToman, 0);
  const openingUsdtMicros = PAPER_OPENING.reduce((s, a) => s + a.usdtUnits * 1_000_000, 0);
  const irtNow = balances.reduce((s, b) => s + b.irtToman, 0);
  const usdtNow = balances.reduce((s, b) => s + b.usdtMicros, 0);

  // The IRT ledger moves by CASH PnL, not by economic PnL — the USDT fee never
  // touched the toman book, which is exactly why economic PnL must be reported
  // separately rather than inferred from the balances.
  const expectedIrtDelta = fills.reduce((s, f) => s + (f.cashPnlIrtToman ?? 0), 0);
  const expectedUsdtDelta = fills.reduce((s, f) => s + (f.inventoryDeltaUsdtMicros ?? 0), 0);

  assert.equal(irtNow - openingIrt, expectedIrtDelta, "the IRT ledger reconciles on its own");
  assert.equal(usdtNow - openingUsdtMicros, expectedUsdtDelta, "the USDT ledger reconciles on its own");

  // The fee assets are recorded per side, not as one currency.
  for (const f of fills) {
    assert.equal(f.buyFeeAsset, "IRT");
    assert.equal(f.sellFeeAsset, "USDT");
    assert.equal(f.buyFeeProvenance, "ADMIN_CONFIRMED");
    assert.equal(f.sellFeeProvenance, "ADMIN_CONFIRMED");
    // Economic PnL is always strictly below cash PnL when a USDT fee was paid.
    assert.ok((f.economicNetPnlToman ?? 0) < (f.cashPnlIrtToman ?? 0));
    assert.equal(
      (f.cashPnlIrtToman ?? 0) - (f.sellFeeValueToman ?? 0),
      f.economicNetPnlToman ?? 0
    );
  }
});

await test("paper session continues after a restart with no duplicate fills", async () => {
  // A restart keeps no in-process state: everything is re-read from the database.
  const resumedSession = await paperRepo.getActivePaperSession();
  assert.equal(resumedSession?.id, paperSessionId, "the same session is picked back up");
  assert.equal(resumedSession?.status, "RUNNING");

  const balancesBefore = await paperRepo.loadPaperBalances(paperSessionId);
  const filledBefore = await paperRepo.loadFilledLifecycleIds(paperSessionId);
  assert.ok(filledBefore.has("lc-1"), "the filled-lifecycle memory survives the restart");

  // The already-filled lifecycle must not refill; a new one may.
  const after = await paperRepo.commitPaperCycle({
    sessionId: paperSessionId,
    runId: null,
    occurredAt: new Date().toISOString(),
    fills: [
      paperFill("lc-1"),
      // A second round trip moves the book further, so the change is observable.
      paperFill("lc-2", 20_000, [
        { sourceId: "nobitex", irtToman: 15_000_000, usdtMicros: 150_000_000 },
        { sourceId: "wallex", irtToman: 25_000_000, usdtMicros: 50_000_000 }
      ])
    ],
    skips: []
  });
  assert.equal(after.duplicates, 1, "the pre-restart fill is still refused");
  assert.equal(after.filled, 1, "only the new lifecycle fills");

  const fills = await paperRepo.loadPaperLedger(paperSessionId, { outcome: "FILLED" });
  assert.equal(fills.length, 2);
  const balancesAfter = await paperRepo.loadPaperBalances(paperSessionId);
  assert.notDeepEqual(balancesAfter, balancesBefore);

  // Balances never went negative at any point.
  for (const b of balancesAfter) {
    assert.ok(b.irtToman >= 0 && b.usdtMicros >= 0, `${b.sourceId} must never go negative`);
  }
});

await test("paper balances can never be driven negative through the ledger", async () => {
  const before = await paperRepo.loadPaperBalances(paperSessionId);
  let threw = false;
  try {
    await paperRepo.commitPaperCycle({
      sessionId: paperSessionId,
      runId: null,
      occurredAt: new Date().toISOString(),
      fills: [
        {
          ...paperFill("lc-negative"),
          balancesAfter: [{ sourceId: "nobitex", irtToman: -1, usdtMicros: 0 }]
        }
      ],
      skips: []
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, true, "a negative balance must be rejected at the database boundary");
  const after = await paperRepo.loadPaperBalances(paperSessionId);
  assert.deepEqual(after, before, "the rejected write left the book untouched");
  const fills = await paperRepo.loadPaperLedger(paperSessionId, { outcome: "FILLED" });
  assert.equal(fills.length, 2, "no phantom fill was recorded");
});

await test("a paper execution failure cannot stop the collector", async () => {
  // The isolated wrapper swallows anything the engine throws.
  const outcome = await paperRun.runPaperExecutionIsolated({
    runId: null,
    occurredAt: "not-a-timestamp",
    cycleStatus: "success",
    // A malformed opportunity list is enough to make the engine throw.
    sources: null as never,
    opportunities: null as never
  });
  assert.equal(outcome.ran, false);
  assert.equal(outcome.reason, "error");
  assert.ok(outcome.error, "the failure is reported, not rethrown");

  // The collector's own state is untouched and the next cycle still records.
  const observation = await repo.getObservation();
  assert.ok(observation, "the observation session survives a paper failure");
  const stats = await paperRepo.loadPaperStats(paperSessionId);
  assert.equal(stats.filled, 2, "no fill was invented by the failure path");
});

await test("a paused paper session stops executing without losing its book", async () => {
  await paperRepo.setPaperSessionStatus(paperSessionId, "PAUSED");
  const balancesBefore = await paperRepo.loadPaperBalances(paperSessionId);

  const outcome = await paperRun.runPaperExecutionForCycle({
    runId: null,
    occurredAt: new Date().toISOString(),
    cycleStatus: "success",
    sources: [],
    opportunities: []
  });
  assert.equal(outcome.ran, false);
  assert.equal(outcome.reason, "not_running");

  const balancesAfter = await paperRepo.loadPaperBalances(paperSessionId);
  assert.deepEqual(balancesAfter, balancesBefore);

  // Resuming keeps the same session and the same ledger.
  const resumed = await paperRepo.setPaperSessionStatus(paperSessionId, "RUNNING");
  assert.equal(resumed?.id, paperSessionId);
  const fills = await paperRepo.loadPaperLedger(paperSessionId, { outcome: "FILLED" });
  assert.equal(fills.length, 2);
});

await test("v4.9.1 100 identical cycles write one detail per candidate plus 100 summaries", async () => {
  // A dedicated session so the counts are unambiguous.
  const session = await paperRepo.createPaperSession({
    observationId: null,
    name: "حجم رویداد",
    mode: "PROVISIONAL_EVALUATION",
    totalCapitalToman: 50_000_000,
    valuationPriceToman: 100_000,
    openingAllocations: PAPER_OPENING,
    approvalFingerprint: null,
    createdBy: "admin",
    note: null
  });
  await paperRepo.setPaperSessionStatus(session.id, "RUNNING");

  // 12 blocked candidates whose situation never changes — the production shape.
  const CANDIDATES = 12;
  const skips = Array.from({ length: CANDIDATES }, (_, i) => ({
    lifecycleId: `vol-${i}`,
    routeKey: `nobitex->wallex@${5 + (i % 4) * 5}`,
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    sizeUsdt: 5 + (i % 4) * 5,
    rejectionCode: i % 2 === 0 ? "fee_unknown" : "insufficient_depth",
    reasonCodes: i % 2 === 0 ? ["fee_unknown"] : ["insufficient_depth"],
    rejectionReason: i % 2 === 0 ? "کارمزد تأییدنشده" : "عمق دفتر ناکافی",
    requiredRebalance: null
  }));

  const CYCLES = 100;
  let totalDetailed = 0;
  for (let c = 0; c < CYCLES; c += 1) {
    const res = await paperRepo.commitPaperCycle({
      sessionId: session.id,
      runId: null,
      occurredAt: new Date(Date.UTC(2026, 6, 30, 0, 0, c)).toISOString(),
      fills: [],
      skips
    });
    totalDetailed += res.detailedEventsWritten;
    if (c === 0) {
      assert.equal(res.detailedEventsWritten, CANDIDATES, "the first cycle records every candidate");
    } else {
      assert.equal(res.detailedEventsWritten, 0, `cycle ${c} must write no detail rows`);
    }
  }

  // Exactly one detailed transition per candidate, for all 100 cycles.
  assert.equal(totalDetailed, CANDIDATES);
  const ledger = await paperRepo.loadPaperLedger(session.id, { limit: 500 });
  assert.equal(ledger.length, CANDIDATES, "no duplicate detail rows accumulated");
  assert.equal(
    ledger.every((r) => r.eventType === "FIRST_SEEN"),
    true
  );

  // ...and exactly one compact summary per cycle.
  const summaries = await paperRepo.loadCycleSummaries(session.id, 500);
  assert.equal(summaries.length, CYCLES);
  assert.equal(summaries[0].candidatesEvaluated, CANDIDATES);
  assert.equal(summaries[0].skipped, CANDIDATES);
  assert.equal(summaries[0].detailedEventsWritten, 0, "a steady cycle writes only its summary");
  assert.equal(summaries[0].reasonCounts.fee_unknown, CANDIDATES / 2);
  assert.equal(summaries[0].reasonCounts.insufficient_depth, CANDIDATES / 2);

  // Per-candidate observation counts still show the full history.
  const states = await paperRepo.loadCandidateStates(session.id, { limit: 500 });
  assert.equal(states.length, CANDIDATES);
  assert.equal(states.every((st) => st.occurrences === CYCLES), true);

  // Grouped reasons are exact, never generic.
  const groups = await paperRepo.loadReasonBreakdown(session.id);
  assert.deepEqual(
    groups.map((g) => g.code).sort(),
    ["fee_unknown", "insufficient_depth"]
  );
  for (const g of groups) {
    assert.equal(g.candidates, CANDIDATES / 2);
    assert.equal(g.observations, (CANDIDATES / 2) * CYCLES);
  }

  // Volume proof: the old design would have written 1,200 rows here.
  assert.ok(ledger.length + summaries.length < CANDIDATES * CYCLES / 5);
});

await test("v4.9.1 a changed reason writes exactly one new transition", async () => {
  const session = await paperRepo.createPaperSession({
    observationId: null,
    name: "تغییر دلیل",
    mode: "PROVISIONAL_EVALUATION",
    totalCapitalToman: 50_000_000,
    valuationPriceToman: 100_000,
    openingAllocations: PAPER_OPENING,
    approvalFingerprint: null,
    createdBy: "admin",
    note: null
  });
  await paperRepo.setPaperSessionStatus(session.id, "RUNNING");

  const skip = (code: string) => [
    {
      lifecycleId: "chg-1",
      routeKey: "nobitex->wallex@25",
      buySourceId: "nobitex",
      sellSourceId: "wallex",
      sizeUsdt: 25,
      rejectionCode: code,
      reasonCodes: [code],
      rejectionReason: code,
      requiredRebalance: null
    }
  ];

  for (let i = 0; i < 5; i += 1) {
    await paperRepo.commitPaperCycle({
      sessionId: session.id,
      runId: null,
      occurredAt: new Date(Date.UTC(2026, 6, 30, 1, 0, i)).toISOString(),
      fills: [],
      skips: skip("fee_unknown")
    });
  }
  assert.equal((await paperRepo.loadPaperLedger(session.id)).length, 1);

  // The cause changes: exactly one CHANGED row is added.
  const changed = await paperRepo.commitPaperCycle({
    sessionId: session.id,
    runId: null,
    occurredAt: new Date(Date.UTC(2026, 6, 30, 1, 0, 5)).toISOString(),
    fills: [],
    skips: skip("insufficient_depth")
  });
  assert.equal(changed.detailedEventsWritten, 1);
  const afterChange = await paperRepo.loadPaperLedger(session.id);
  assert.equal(afterChange.length, 2);
  assert.equal(afterChange[0].eventType, "CHANGED");
  assert.equal(afterChange[0].rejectionCode, "insufficient_depth");

  // The candidate leaving the market records one CLOSED event, once.
  const closedCycle = await paperRepo.commitPaperCycle({
    sessionId: session.id,
    runId: null,
    occurredAt: new Date(Date.UTC(2026, 6, 30, 1, 0, 6)).toISOString(),
    fills: [],
    skips: []
  });
  assert.equal(closedCycle.detailedEventsWritten, 1);
  const afterClose = await paperRepo.loadPaperLedger(session.id);
  assert.equal(afterClose[0].eventType, "CLOSED");

  // A further empty cycle adds nothing but its summary.
  const quiet = await paperRepo.commitPaperCycle({
    sessionId: session.id,
    runId: null,
    occurredAt: new Date(Date.UTC(2026, 6, 30, 1, 0, 7)).toISOString(),
    fills: [],
    skips: []
  });
  assert.equal(quiet.detailedEventsWritten, 0);
  assert.equal((await paperRepo.loadPaperLedger(session.id)).length, 3);
});

await test("7A readiness attestations, policies and reviews are append-only", async () => {
  // Nothing exists until a human records it — no seeded defaults.
  assert.deepEqual(await liveRepo.loadRiskPolicyValues(), []);
  assert.deepEqual(await liveRepo.loadAttestations(), []);
  assert.deepEqual(await liveRepo.loadReadinessReviews(), []);

  await liveRepo.recordRiskPolicy({
    policyKey: "max_order_size_usdt",
    value: 25,
    setBy: "admin",
    note: "سقف اولیه"
  });
  await liveRepo.recordRiskPolicy({
    policyKey: "max_order_size_usdt",
    value: 50,
    setBy: "admin",
    validForDays: 30,
    note: "افزایش سقف"
  });

  // Latest wins for evaluation, but both rows survive for audit.
  const latest = await liveRepo.loadRiskPolicyValues();
  assert.equal(latest.length, 1);
  assert.equal(latest[0].value, 50);
  assert.equal(latest[0].provenance, "ADMIN_APPROVED", "the only provenance that exists");
  assert.equal(latest[0].validForDays, 30, "the approver's own validity period round-trips");
  const history = await liveRepo.loadRiskPolicyHistory("max_order_size_usdt");
  assert.equal(history.length, 2, "the earlier value is preserved");
  assert.equal(history[1].value, 25);
  assert.equal(history[1].validForDays, null, "a policy set without an expiry keeps null");

  await liveRepo.recordAttestation({
    kind: "key_permissions",
    confirmedBy: "admin",
    claims: {
      trading_only_keys: true,
      withdrawal_permission_disabled: true,
      ip_whitelist_confirmed: true
    },
    note: null
  });
  const attestations = await liveRepo.loadAttestations();
  assert.equal(attestations.length, 1);
  assert.equal(attestations[0].claims.withdrawal_permission_disabled, true);
  // The attestation stores a STATEMENT, never a credential.
  assert.equal(JSON.stringify(attestations[0]).toLowerCase().includes("apikey"), false);

  await liveRepo.recordReadinessReview({
    reviewedBy: "admin",
    gateState: "DISARMED",
    effectiveState: "DISARMED",
    passedCount: 3,
    blockedCount: 8,
    blockers: [{ gate: "risk_policies", blocker: "پیکربندی‌نشده" }],
    note: null
  });
  const reviews = await liveRepo.loadReadinessReviews();
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].effectiveState, "DISARMED", "a review never arms anything");
  assert.equal(reviews[0].blockedCount, 8);
});

await test("7A readiness storage does not disturb the observation or paper session", async () => {
  const observation = await repo.getObservation();
  const paperSession = await paperRepo.getActivePaperSession();
  const balancesBefore = paperSession ? await paperRepo.loadPaperBalances(paperSession.id) : [];

  await liveRepo.recordRiskPolicy({
    policyKey: "max_daily_loss_toman",
    value: 1_000_000,
    setBy: "admin",
    note: null
  });

  const observationAfter = await repo.getObservation();
  assert.equal(observationAfter?.id, observation?.id, "observation.id must be untouched");
  const sessionAfter = await paperRepo.getActivePaperSession();
  assert.equal(sessionAfter?.id, paperSession?.id, "the paper session is untouched");
  assert.equal(sessionAfter?.status, paperSession?.status, "its status is untouched");
  if (paperSession) {
    assert.deepEqual(
      await paperRepo.loadPaperBalances(paperSession.id),
      balancesBefore,
      "virtual balances are untouched"
    );
  }
});

await closeDb().catch(() => undefined);
await rm(dir, { recursive: true, force: true });

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
