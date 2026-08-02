#!/usr/bin/env npx tsx
/**
 * Seed a THROWAWAY preview database so the Shadow screenshots show a populated
 * interface instead of nine empty states.
 *
 * What is real and what is not, stated plainly:
 *   * REAL — every code path. Snapshots go through the production normalizer
 *     (`snapshotFromResult`), certification through `certifyFromSnapshot`,
 *     opportunities through the production engine (`buildOpportunitiesDetailed`),
 *     persistence through the existing repositories, and the paper figures
 *     through the real paper engine (`runPaperExecutionForCycle`).
 *   * NOT REAL — the raw order books fed in at the top. No exchange is
 *     contacted; the prices below are invented inputs, so every number derived
 *     from them is a demonstration, not observed market data.
 *
 * This script refuses to run against anything but a temporary PGlite directory,
 * and it is never part of the application: nothing in `app/` or `src/` imports
 * it, and no production route can reach it.
 */
import { tmpdir } from "node:os";
import path from "node:path";

const url = process.env.DATABASE_URL ?? "";
if (!url.startsWith("pglite:")) {
  throw new Error("preview seed refuses to run: DATABASE_URL must be a pglite: directory");
}
const dir = path.resolve(url.slice("pglite:".length));
if (!dir.startsWith(path.resolve(tmpdir()))) {
  throw new Error(`preview seed refuses to run outside the OS temp dir: ${dir}`);
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
  claimWorkerLease,
  touchHeartbeat
} = await import("../src/db/repositories/shadowArbitrage.ts");
const { recordFeeTierEvidence } = await import("../src/db/repositories/shadowFeeTier.ts");
const { createPaperSession, setPaperSessionStatus } = await import(
  "../src/db/repositories/shadowPaper.ts"
);
const { runPaperExecutionForCycle } = await import("../src/lib/shadowArbitrage/paper/run.ts");
const { persistShadowCycle, saveCertifications } = await import(
  "../src/lib/shadowArbitrage/store.ts"
);

type Book = { bid: number; ask: number };

/** Invented books. Nobitex is the cheapest venue, Wallex the richest bid. */
const BOOKS: Record<string, Book | null> = {
  nobitex: { bid: 99_820, ask: 99_900 },
  wallex: { bid: 101_620, ask: 101_700 },
  tabdeal: { bid: 100_180, ask: 100_260 },
  bitpin: { bid: 100_090, ask: 100_170 },
  ramzinex: { bid: 99_960, ask: 100_040 },
  abantether: { bid: 99_700, ask: 100_600 },
  tetherland: { bid: 99_750, ask: 100_540 },
  bit24: { bid: 99_640, ask: 100_710 },
  // Reference venue: a headline price with no walkable book.
  arzinja: { bid: 100_200, ask: 100_200 }
};

/** Levels around a price so the production VWAP walk has something to walk. */
function levels(price: number, side: "bid" | "ask") {
  const step = side === "bid" ? -60 : 60;
  return [
    { priceToman: price, amountUsdt: 12 },
    { priceToman: price + step, amountUsdt: 30 },
    { priceToman: price + step * 2, amountUsdt: 120 }
  ];
}

const now = new Date();
const nowIso = now.toISOString();

const snapshots = SHADOW_SOURCES.filter((c) => c.enabled).map((cfg) => {
  const book = BOOKS[cfg.id] ?? null;
  const isReference = cfg.marketModel === "REFERENCE";
  const isQuote = cfg.marketModel === "OTC_QUOTE";
  // One venue is deliberately shown a stale timestamp so a degraded row exists.
  const sourceTimestamp =
    cfg.id === "ramzinex" ? new Date(now.getTime() - 240_000).toISOString() : nowIso;

  return snapshotFromResult(
    cfg,
    {
      kind: isReference ? "HEADLINE" : isQuote ? "OTC_QUOTE" : "BOOK",
      bids: book && !isReference && !isQuote ? levels(book.bid, "bid") : [],
      asks: book && !isReference && !isQuote ? levels(book.ask, "ask") : [],
      bestBidToman: book?.bid ?? null,
      bestAskToman: book?.ask ?? null,
      maxUsdt: isQuote ? 500 : null,
      sourceTimestamp,
      priceUnit: "IRT",
      depthAvailable: Boolean(book) && !isReference && !isQuote,
      directionVerified: true,
      endpoint: "preview://seeded",
      httpStatus: 200,
      latencyMs: 90 + (cfg.id.length % 7) * 35,
      attempts: 1,
      rateLimited: false,
      normalizationNote: "دادهٔ نمونهٔ پیش‌نمایش — از هیچ صرافی دریافت نشده است"
    },
    nowIso
  );
});

const certBySource: Record<string, ReturnType<typeof certifyFromSnapshot>> = {};
for (const s of snapshots) certBySource[s.sourceId] = certifyFromSnapshot(s);

const certStatuses = Object.fromEntries(
  Object.entries(certBySource).map(([id, c]) => [id, c.status])
) as Record<string, "LIVE_VERIFIED" | "LIVE_DEGRADED" | "REFERENCE_ONLY" | "UNSUPPORTED" | "PENDING_PROBE">;

const built = buildOpportunitiesDetailed(snapshots, [], nowIso, { certStatuses });

const session = await ensureObservationSession(30_000);
await claimWorkerLease({ workerId: "preview-seed", ttlMs: 120_000, pollIntervalMs: 30_000 });
await touchHeartbeat({
  workerId: "preview-seed",
  ttlMs: 120_000,
  lastCycleAt: nowIso,
  lastCycleStatus: "success"
});

// Two cycles so durations and observation counts are not all "brand new".
for (const [index, offsetMs] of [60_000, 0].entries()) {
  const at = new Date(now.getTime() - offsetMs).toISOString();
  const { runId } = await beginCollectionRun({
    sessionId: session.id,
    idempotencyKey: `preview-seed-${index}`,
    workerId: "preview-seed",
    pollIntervalMs: 30_000,
    sourcesTotal: snapshots.length
  });
  await completeCollectionRun({
    runId,
    sessionId: session.id,
    status: "success",
    sourcesOk: snapshots.filter((s) => s.health !== "unavailable").length,
    sourcesFailed: snapshots.filter((s) => s.health === "unavailable").length,
    sourcesTotal: snapshots.length,
    opportunityCount: built.opportunities.length,
    durationMs: 1_800,
    pollIntervalMs: 30_000,
    sources: snapshots,
    certBySource,
    opportunities: built.opportunities,
    transitions: built.transitions
  });
  void at;
}

// The UI reads these two caches for certification status and the live matrix.
await saveCertifications(Object.values(certBySource));
await persistShadowCycle({
  serverNow: nowIso,
  sources: snapshots,
  opportunities: built.opportunities,
  blockedCounts: built.blockedCounts
});

/*
 * Fee evidence for the venues the desk holds accounts on, so the fee columns
 * show a real provenance chain rather than "unknown" everywhere.
 *
 * BOTH halves are required, and they must agree. The confirmation records which
 * tier the account is on; the tier evidence records the rate confirmed FOR that
 * tier and that execution mode. Effective-fee selection matches the two and
 * fails closed when they disagree — so seeding only the confirmation would give
 * a preview where every venue is fee-unknown and every panel is empty.
 */
const PREVIEW_TIER = "پلهٔ پایه";
for (const [sourceId, bps] of [
  ["nobitex", 25],
  ["wallex", 35],
  ["tabdeal", 30]
] as const) {
  await recordFeeConfirmation({
    sourceId,
    takerFeeBps: bps,
    feeTier: PREVIEW_TIER,
    sourceUrl: "https://example.invalid/preview-fee-schedule",
    confirmedBy: "preview-admin",
    note: "دادهٔ نمونهٔ پیش‌نمایش"
  });
  await recordFeeTierEvidence({
    sourceId,
    // These three are order-book venues in the preview's own market model.
    executionMode: "ORDER_BOOK",
    tierLabel: PREVIEW_TIER,
    makerFeeBps: bps,
    takerFeeBps: bps,
    provenance: "ADMIN_CONFIRMED_SCREENSHOT",
    evidenceKey: "preview-seed",
    confirmedBy: "preview-admin",
    confirmedAt: nowIso,
    validForDays: 30,
    sourceUrl: null,
    note: "دادهٔ نمونهٔ پیش‌نمایش"
  });
}

// A running paper session, then one real engine cycle over the seeded market so
// the PnL columns carry the engine's own recorded figures.
const paper = await createPaperSession({
  observationId: session.id,
  name: "نشست پیش‌نمایش",
  mode: "PROVISIONAL_EVALUATION",
  totalCapitalToman: 50_000_000,
  valuationPriceToman: 100_000,
  openingAllocations: [
    { sourceId: "nobitex", irtToman: 12_000_000, usdtUnits: 60 },
    { sourceId: "wallex", irtToman: 10_000_000, usdtUnits: 70 },
    { sourceId: "tabdeal", irtToman: 8_000_000, usdtUnits: 50 }
  ],
  approvalFingerprint: null,
  createdBy: "preview-admin",
  note: "دادهٔ نمونهٔ پیش‌نمایش"
});
await setPaperSessionStatus(paper.id, "RUNNING");

const outcome = await runPaperExecutionForCycle({
  runId: null,
  occurredAt: nowIso,
  cycleStatus: "success",
  sources: snapshots,
  opportunities: built.opportunities
});

console.log(
  `[preview-seed] sources=${snapshots.length} opportunities=${built.opportunities.length} ` +
    `paper=${outcome.ran ? `filled ${outcome.filled ?? 0} / skipped ${outcome.skipped ?? 0}` : `not run (${outcome.reason})`}`
);
console.log("[preview-seed] every figure above derives from invented order books — demo data only");
