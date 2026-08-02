#!/usr/bin/env npx tsx
/**
 * Phase 8E-B — a disposable fixture that produces exactly ONE paper fill.
 *
 *   DATABASE_URL=pglite:<throwaway dir> npx tsx scripts/seed-paper-fill-fixture.mts
 *
 * WHY THIS EXISTS. Fourteen of the Paper acceptance assertions open the
 * calculation drawer of a filled trade. They can only run when a fill exists,
 * and a fill only exists when the market happens to offer a net-positive route —
 * which is not something a test may wait for, and absolutely not something it
 * may fabricate into the RC or production database.
 *
 * WHAT IT IS. Every order book below is INVENTED, chosen so that exactly one
 * route crosses far enough to survive fees, the slippage buffer and the risk
 * floor. The fill itself is not invented: it is produced by
 * `runPaperExecutionForCycle`, the same engine the collector calls, through the
 * same broker, sizer and ledger. The figures in the drawer are therefore the
 * engine's own arithmetic over fixture prices — a demonstration of the
 * calculation, never a market observation and never a live fill.
 *
 * SAFETY. It refuses to run against anything but a throwaway PGlite directory.
 * No credential, no exchange call, no order, no transfer.
 */
import path from "node:path";

const url = process.env.DATABASE_URL ?? "";
if (!url.startsWith("pglite:")) {
  throw new Error("this fixture only ever writes a throwaway PGlite database");
}
const dir = path.resolve(url.slice("pglite:".length));
if (dir.includes(`${path.sep}.data${path.sep}`) || dir.endsWith(`${path.sep}.data`)) {
  throw new Error(`refusing to write a project database: ${dir}`);
}

const { SHADOW_SOURCES } = await import("../src/lib/shadowArbitrage/config.ts");
const { snapshotFromResult } = await import("../src/lib/shadowArbitrage/adapters/base.ts");
const { certifyFromSnapshot } = await import("../src/lib/shadowArbitrage/certification.ts");
const { buildOpportunitiesDetailed } = await import("../src/lib/shadowArbitrage/calculate.ts");
const {
  ensureObservationSession,
  beginCollectionRun,
  completeCollectionRun,
  recordFeeConfirmation,
  recordAccountConfirmation,
  claimWorkerLease,
  touchHeartbeat
} = await import("../src/db/repositories/shadowArbitrage.ts");
const { recordFeeTierEvidence } = await import("../src/db/repositories/shadowFeeTier.ts");
const { recordRiskPolicy } = await import("../src/db/repositories/shadowLive.ts");
const { createPaperSession, setPaperSessionStatus } = await import(
  "../src/db/repositories/shadowPaper.ts"
);
const { runPaperExecutionForCycle } = await import("../src/lib/shadowArbitrage/paper/run.ts");
const { persistShadowCycle, saveCertifications } = await import(
  "../src/lib/shadowArbitrage/store.ts"
);
const { closeDb } = await import("../src/db/client.ts");

const now = new Date();
const nowIso = now.toISOString();
const MARK = 100_000;

/**
 * Invented books.
 *
 * Only `nobitex → wallex` crosses: buying at 99,900 and selling at 101,600 is
 * ~1.7%, comfortably clear of 25 + 30 bps of fees plus the slippage buffer.
 * Every other venue sits inside a band too narrow to survive costs, so the
 * engine has exactly one route to act on and the fixture is deterministic.
 */
const BOOKS: Record<string, { bid: number; ask: number } | null> = {
  nobitex: { bid: 99_820, ask: 99_900 },
  wallex: { bid: 101_600, ask: 101_700 },
  tabdeal: { bid: 100_180, ask: 100_260 },
  bitpin: { bid: 100_090, ask: 100_170 },
  ramzinex: { bid: 99_960, ask: 100_040 },
  abantether: { bid: 99_700, ask: 100_600 },
  tetherland: { bid: 99_750, ask: 100_540 },
  bit24: { bid: 99_640, ask: 100_710 },
  arzinja: { bid: 100_120, ask: 100_200 }
};

/** Enough depth that a small size fills at one level and the VWAP is exact. */
function levels(price: number, side: "bid" | "ask") {
  const step = side === "bid" ? -60 : 60;
  return [
    { priceToman: price, amountUsdt: 40 },
    { priceToman: price + step, amountUsdt: 120 },
    { priceToman: price + step * 2, amountUsdt: 400 }
  ];
}

const snapshots = SHADOW_SOURCES.filter((c) => c.enabled).map((cfg) => {
  const book = BOOKS[cfg.id] ?? null;
  const isQuote = cfg.marketModel === "OTC_QUOTE";
  return snapshotFromResult(
    cfg,
    {
      kind: isQuote ? "OTC_QUOTE" : "BOOK",
      bids: book && !isQuote ? levels(book.bid, "bid") : [],
      asks: book && !isQuote ? levels(book.ask, "ask") : [],
      bestBidToman: book?.bid ?? null,
      bestAskToman: book?.ask ?? null,
      maxUsdt: isQuote ? 500 : null,
      sourceTimestamp: nowIso,
      priceUnit: "IRT",
      depthAvailable: Boolean(book) && !isQuote,
      directionVerified: true,
      endpoint: "fixture://invented",
      httpStatus: 200,
      latencyMs: 90,
      attempts: 1,
      rateLimited: false,
      normalizationNote: "دادهٔ ساختگی آزمون — از هیچ صرافی دریافت نشده است"
    },
    nowIso
  );
});

const certBySource: Record<string, ReturnType<typeof certifyFromSnapshot>> = {};
for (const s of snapshots) certBySource[s.sourceId] = certifyFromSnapshot(s);
const certStatuses = Object.fromEntries(
  Object.entries(certBySource).map(([id, c]) => [id, c.status])
) as Parameters<typeof buildOpportunitiesDetailed>[3] extends { certStatuses?: infer T }
  ? NonNullable<T>
  : never;

/* ── evidence: accounts, fees, tiers, and the risk policies sizing needs ──── */

const VENUE_FEES: Record<string, { mode: "ORDER_BOOK" | "OTC_QUOTE"; tier: string | null; maker: number; taker: number }> = {
  nobitex: { mode: "ORDER_BOOK", tier: "Base", maker: 25, taker: 25 },
  wallex: { mode: "ORDER_BOOK", tier: "Base Level 1", maker: 25, taker: 30 },
  tabdeal: { mode: "ORDER_BOOK", tier: "VIP1", maker: 24, taker: 28 },
  bitpin: { mode: "ORDER_BOOK", tier: "Base Level 1", maker: 30, taker: 35 },
  abantether: { mode: "OTC_QUOTE", tier: null, maker: 30, taker: 30 },
  ramzinex: { mode: "ORDER_BOOK", tier: "Base", maker: 20, taker: 25 },
  tetherland: { mode: "ORDER_BOOK", tier: "Bronze", maker: 45, taker: 45 },
  bit24: { mode: "ORDER_BOOK", tier: "VIP0", maker: 20, taker: 20 },
  arzinja: { mode: "ORDER_BOOK", tier: "Level 1", maker: 0, taker: 0 }
};

for (const cfg of SHADOW_SOURCES) {
  const fee = VENUE_FEES[cfg.id];
  if (!fee) continue;
  await recordAccountConfirmation({
    sourceId: cfg.id,
    kycComplete: true,
    accountState: "VERIFIED",
    executionEligible: true,
    ineligibleReason: null,
    provenance: "ADMIN_CONFIRMED_SCREENSHOT",
    validDays: 30,
    evidenceKey: "fixture-account",
    confirmedBy: "fixture-admin",
    confirmedAt: nowIso,
    note: "دادهٔ ساختگی آزمون"
  });
  await recordFeeConfirmation({
    sourceId: cfg.id,
    takerFeeBps: fee.taker,
    makerFeeBps: fee.maker,
    feeTier: fee.tier,
    provenance: "ADMIN_CONFIRMED_SCREENSHOT",
    validDays: 30,
    evidenceKey: "fixture-fee",
    confirmedBy: "fixture-admin",
    confirmedAt: nowIso,
    note: "دادهٔ ساختگی آزمون"
  });
  await recordFeeTierEvidence({
    sourceId: cfg.id,
    executionMode: fee.mode,
    tierLabel: fee.tier,
    makerFeeBps: fee.maker,
    takerFeeBps: fee.taker,
    provenance: "ADMIN_CONFIRMED_SCREENSHOT",
    evidenceKey: "fixture-tier",
    confirmedBy: "fixture-admin",
    confirmedAt: nowIso,
    validForDays: 30,
    sourceUrl: null,
    note: "دادهٔ ساختگی آزمون"
  });
}

/*
 * The five policies dynamic sizing refuses to proceed without. These are
 * fixture thresholds for a fixture database — they are not a recommendation and
 * they never reach the RC.
 */
for (const [policyKey, value] of [
  ["max_order_size_usdt", 25],
  ["max_venue_exposure_percent", 40],
  ["min_risk_adjusted_edge_percent", 0.2],
  ["max_quote_age_ms", 60_000],
  ["max_slippage_bps", 50]
] as const) {
  await recordRiskPolicy({
    policyKey,
    value,
    setBy: "fixture-admin",
    validForDays: 30,
    note: "دادهٔ ساختگی آزمون"
  });
}

/* ── one recorded cycle over the invented market ─────────────────────────── */

const accountEvidence = Object.fromEntries(
  SHADOW_SOURCES.map((c) => [c.id, { executionEligible: true, kycComplete: true }])
);
const built = buildOpportunitiesDetailed(snapshots, [], nowIso, {
  certStatuses,
  accountEvidence
});

const session = await ensureObservationSession(30_000);
await claimWorkerLease({ workerId: "fixture", ttlMs: 120_000, pollIntervalMs: 30_000 });
await touchHeartbeat({
  workerId: "fixture",
  ttlMs: 120_000,
  lastCycleAt: nowIso,
  lastCycleStatus: "success"
});

const { runId } = await beginCollectionRun({
  sessionId: session.id,
  idempotencyKey: "fixture-cycle",
  workerId: "fixture",
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
  opportunityCount: built.opportunities.length,
  durationMs: 1_200,
  pollIntervalMs: 30_000,
  sources: snapshots,
  certBySource,
  opportunities: built.opportunities,
  transitions: built.transitions
});
await saveCertifications(Object.values(certBySource));
await persistShadowCycle({
  serverNow: nowIso,
  sources: snapshots,
  opportunities: built.opportunities,
  blockedCounts: built.blockedCounts
});

/* ── the session, then ONE real engine cycle ─────────────────────────────── */

const paper = await createPaperSession({
  observationId: session.id,
  name: "نشست آزمون کشوی محاسبه",
  mode: "PROVISIONAL_EVALUATION",
  totalCapitalToman: 50_000_000,
  valuationPriceToman: MARK,
  openingAllocations: SHADOW_SOURCES.map((c) => ({
    sourceId: c.id,
    irtToman: 3_000_000,
    usdtUnits: 20
  })),
  approvalFingerprint: null,
  createdBy: "fixture-admin",
  note: "دادهٔ ساختگی آزمون"
});
await setPaperSessionStatus(paper.id, "RUNNING");

const outcome = await runPaperExecutionForCycle({
  runId,
  occurredAt: nowIso,
  cycleStatus: "success",
  sources: snapshots,
  opportunities: built.opportunities
});

console.log(
  `[fixture] sources=${snapshots.length} opportunities=${built.opportunities.length} ` +
    `paper=${outcome.ran ? `filled ${outcome.filled ?? 0} / skipped ${outcome.skipped ?? 0}` : `not run (${outcome.reason})`}`
);
console.log("[fixture] every price above is invented; the fill is the real engine's own arithmetic");
console.log("[fixture] no credential, exchange call, order or transfer was involved");

if (!outcome.ran || !outcome.filled) {
  throw new Error(
    `the fixture produced no fill (${outcome.reason ?? "no reason"}) — the drawer tests would be vacuous`
  );
}

await closeDb();
