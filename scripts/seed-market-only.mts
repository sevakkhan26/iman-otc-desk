#!/usr/bin/env npx tsx
/**
 * Seed a market and nothing else.
 *
 * The release reconciliation needs one thing from the world before it can size
 * a capital plan: a mark price, which in production the collector produces on
 * its first cycle. A preview instance has the collector switched off, so this
 * supplies that one input — normalized snapshots and a recorded cycle — and
 * deliberately supplies nothing else.
 *
 * That "nothing else" is the point. `preview-seed-shadow.mts` also plants demo
 * fee confirmations stamped with the current time, which outrank the approved
 * evidence's own confirmation date and would make a verification run measure
 * the demo data instead of the release. Production has no such seeder; this
 * script leaves the same gap production has, so the bootstrap is the only thing
 * that fills it.
 *
 * Every price below is invented. No credential, exchange call, order or
 * transfer is involved.
 */
import path from "node:path";

const url = process.env.DATABASE_URL ?? "";
if (!url.startsWith("pglite:")) throw new Error("this seeder only ever writes a throwaway PGlite database");
const dir = path.resolve(url.slice("pglite:".length));
if (dir.includes(`${path.sep}.data${path.sep}`) || dir.endsWith(`${path.sep}.data`)) {
  throw new Error(`refusing to write a project database: ${dir}`);
}

const { SHADOW_SOURCES } = await import("../src/lib/shadowArbitrage/config.ts");
const { snapshotFromResult } = await import("../src/lib/shadowArbitrage/adapters/base.ts");
const { certifyFromSnapshot } = await import("../src/lib/shadowArbitrage/certification.ts");
const {
  ensureObservationSession,
  beginCollectionRun,
  completeCollectionRun,
  claimWorkerLease,
  touchHeartbeat
} = await import("../src/db/repositories/shadowArbitrage.ts");
const { persistShadowCycle, saveCertifications } = await import("../src/lib/shadowArbitrage/store.ts");
const { closeDb } = await import("../src/db/client.ts");

const MARK = 100_000;
const nowIso = new Date().toISOString();

const snapshots = SHADOW_SOURCES.filter((c) => c.enabled).map((cfg) => {
  const quote = cfg.marketModel === "OTC_QUOTE";
  return snapshotFromResult(
    cfg,
    {
      kind: quote ? "OTC_QUOTE" : "BOOK",
      bids: quote ? [] : [{ priceToman: MARK - 50, amountUsdt: 400 }, { priceToman: MARK - 110, amountUsdt: 900 }],
      asks: quote ? [] : [{ priceToman: MARK + 50, amountUsdt: 400 }, { priceToman: MARK + 110, amountUsdt: 900 }],
      bestBidToman: MARK - 50,
      bestAskToman: MARK + 50,
      maxUsdt: quote ? 500 : null,
      sourceTimestamp: nowIso,
      priceUnit: "IRT",
      depthAvailable: !quote,
      directionVerified: true,
      endpoint: "seed://market-only",
      httpStatus: 200,
      latencyMs: 40,
      attempts: 1,
      rateLimited: false,
      normalizationNote: "دادهٔ ساختگی بازار — از هیچ صرافی دریافت نشده است"
    },
    nowIso
  );
});

const certBySource: Record<string, ReturnType<typeof certifyFromSnapshot>> = {};
for (const s of snapshots) certBySource[s.sourceId] = certifyFromSnapshot(s);

const session = await ensureObservationSession(30_000);
await claimWorkerLease({ workerId: "market-seed", ttlMs: 120_000, pollIntervalMs: 30_000 });
await touchHeartbeat({ workerId: "market-seed", ttlMs: 120_000, lastCycleAt: nowIso, lastCycleStatus: "success" });

const { runId } = await beginCollectionRun({
  sessionId: session.id,
  idempotencyKey: "market-only-seed",
  workerId: "market-seed",
  pollIntervalMs: 30_000,
  sourcesTotal: snapshots.length
});
await completeCollectionRun({
  runId,
  sessionId: session.id,
  status: "success",
  sourcesOk: snapshots.length,
  sourcesFailed: 0,
  sourcesTotal: snapshots.length,
  opportunityCount: 0,
  durationMs: 300,
  pollIntervalMs: 30_000,
  sources: snapshots,
  certBySource,
  opportunities: [],
  transitions: []
});
await saveCertifications(Object.values(certBySource));
await persistShadowCycle({ serverNow: nowIso, sources: snapshots, opportunities: [], blockedCounts: {} });

console.log(`[market-seed] ${snapshots.length} sources at an invented mark of ${MARK} toman`);
console.log("[market-seed] no fee, account, capital or session data was written");
await closeDb();
