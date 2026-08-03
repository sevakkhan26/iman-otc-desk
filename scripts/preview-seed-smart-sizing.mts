#!/usr/bin/env npx tsx
/**
 * Seed a throwaway preview database for the SMART_CAPITAL_DEPTH screenshots.
 *
 * The screenshots have to show a sizing panel that has actually decided
 * something, which needs four things the default preview seeder does not
 * supply: a 10,000,000,000-toman session across nine venues, order books deep
 * enough that a tenth of them clears the 25 USDT floor, admin-confirmed fees on
 * every venue, and — critically — every required risk policy SET.
 *
 * EVERY NUMBER IN THIS FILE IS INVENTED. No exchange is contacted, no
 * credential exists, no real order, transfer or balance is involved, and the
 * risk-policy values below are this script's own choice for a demonstration —
 * they are not approvals and they are written only to a temporary database that
 * is deleted when the preview exits. The production system still has these
 * policies UNSET, which is why it still refuses to size anything.
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
const { buildOpportunitiesDetailed } = await import("../src/lib/shadowArbitrage/calculate.ts");
const {
  ensureObservationSession,
  beginCollectionRun,
  completeCollectionRun,
  claimWorkerLease,
  touchHeartbeat,
  recordFeeConfirmation
} = await import("../src/db/repositories/shadowArbitrage.ts");
const { recordFeeTierEvidence } = await import("../src/db/repositories/shadowFeeTier.ts");
const { recordRiskPolicy } = await import("../src/db/repositories/shadowLive.ts");
const { createPaperSession, setPaperSessionStatus } = await import(
  "../src/db/repositories/shadowPaper.ts"
);
const { persistShadowCycle, saveCertifications } = await import(
  "../src/lib/shadowArbitrage/store.ts"
);
const { runPaperExecutionForCycle } = await import("../src/lib/shadowArbitrage/paper/run.ts");
const { closeDb } = await import("../src/db/client.ts");

const MARK = 192_000;
const TOTAL = 10_000_000_000;
const now = new Date();
const nowIso = now.toISOString();

/**
 * Invented books. Nobitex is the cheapest place to buy, Wallex the richest bid.
 *
 * Sixty levels of 60 USDT with a 150-toman step on each side. Sixty is the
 * production cap on persisted levels (`MAX_PERSISTED_BOOK_LEVELS`), so this is
 * the deepest book the system can actually hold: 3,600 USDT, giving a depth cap
 * of 360. The CAPITAL cap — a tenth of the venue's ~2,890 USDT usable balance,
 * so about 289 — is therefore the tighter of the two, which is the case the
 * percentage ladder was designed for. The 150-toman step makes each extra USDT
 * dearer to buy and cheaper to sell, so the profit curve turns down before the
 * ceiling and the panel has a real "why not bigger" answer.
 */
const BOOKS: Record<string, { bid: number; ask: number } | null> = {
  nobitex: { bid: 191_900, ask: 192_000 },
  wallex: { bid: 194_000, ask: 194_100 },
  tabdeal: { bid: 192_800, ask: 192_900 },
  bitpin: { bid: 192_400, ask: 192_500 },
  ramzinex: { bid: 192_200, ask: 192_300 },
  abantether: { bid: 191_500, ask: 193_400 },
  tetherland: { bid: 191_600, ask: 193_200 },
  bit24: { bid: 191_400, ask: 193_600 },
  arzinja: { bid: 192_100, ask: 192_200 }
};

function levels(price: number, side: "bid" | "ask") {
  const step = side === "bid" ? -150 : 150;
  return Array.from({ length: 60 }, (_, i) => ({
    priceToman: price + step * i,
    amountUsdt: 60
  }));
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
      maxUsdt: isQuote ? 1_500 : null,
      sourceTimestamp: nowIso,
      priceUnit: "IRT",
      depthAvailable: Boolean(book) && !isQuote,
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

/** Confirmed taker fees, in basis points. Invented for the demonstration. */
const FEES: Record<string, number> = {
  nobitex: 25,
  wallex: 30,
  tabdeal: 30,
  bitpin: 35,
  ramzinex: 25,
  abantether: 30,
  tetherland: 45,
  bit24: 20,
  arzinja: 30
};

/*
 * Priced with the SAME confirmed fees the effective-fee resolver will hand the
 * paper engine. Building the opportunities on config fees and then settling on
 * evidenced ones is how a preview ends up showing two different numbers for the
 * same trade.
 */
const built = buildOpportunitiesDetailed(snapshots, [], nowIso, {
  certStatuses: Object.fromEntries(
    Object.entries(certBySource).map(([id, c]) => [id, c.status])
  ) as never,
  confirmedFeeBps: FEES
});

const observation = await ensureObservationSession(30_000);
await claimWorkerLease({ workerId: "preview-seed", ttlMs: 120_000, pollIntervalMs: 30_000 });
await touchHeartbeat({
  workerId: "preview-seed",
  ttlMs: 120_000,
  lastCycleAt: nowIso,
  lastCycleStatus: "success"
});

const { runId } = await beginCollectionRun({
  sessionId: observation.id,
  idempotencyKey: "smart-sizing-seed",
  workerId: "preview-seed",
  pollIntervalMs: 30_000,
  sourcesTotal: snapshots.length
});
await completeCollectionRun({
  runId,
  sessionId: observation.id,
  status: "success",
  sourcesOk: snapshots.length,
  sourcesFailed: 0,
  sourcesTotal: snapshots.length,
  opportunityCount: built.opportunities.length,
  durationMs: 1_800,
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

/* ── fee evidence: the confirmation AND the tier rate, which must agree ───── */
const PREVIEW_TIER = "پلهٔ پایه";
for (const cfg of SHADOW_SOURCES.filter((c) => c.enabled)) {
  const bps = FEES[cfg.id];
  if (bps === undefined) continue;
  await recordFeeConfirmation({
    sourceId: cfg.id,
    takerFeeBps: bps,
    feeTier: PREVIEW_TIER,
    sourceUrl: "https://example.invalid/preview-fee-schedule",
    confirmedBy: "preview-admin",
    note: "دادهٔ نمونهٔ پیش‌نمایش"
  });
  await recordFeeTierEvidence({
    sourceId: cfg.id,
    executionMode: cfg.marketModel === "OTC_QUOTE" ? "OTC_QUOTE" : "ORDER_BOOK",
    tierLabel: PREVIEW_TIER,
    makerFeeBps: bps,
    takerFeeBps: bps,
    provenance: "ADMIN_CONFIRMED_SCREENSHOT",
    evidenceKey: "preview-smart-sizing",
    confirmedBy: "preview-admin",
    confirmedAt: nowIso,
    validForDays: 30,
    sourceUrl: null,
    note: "دادهٔ نمونهٔ پیش‌نمایش"
  });
}

/* ── the risk policies, SET for the demonstration only ───────────────────────
 *
 * Production has these unset, and the engine refuses to size anything while
 * that is true. Setting them here is what makes the sizing panel show a
 * decision instead of a list of missing keys — it is not an approval, and it
 * lives only in this temporary database.
 */
const DEMO_POLICIES: Record<string, number> = {
  max_order_size_usdt: 2_000,
  max_daily_loss_toman: 500_000_000,
  max_venue_exposure_percent: 25,
  min_risk_adjusted_edge_percent: 0.05,
  max_quote_age_ms: 60_000,
  max_latency_ms: 5_000,
  max_slippage_bps: 600,
  max_consecutive_errors: 5,
  api_rate_limit_per_minute: 60,
  max_inventory_deviation_percent: 20,
  global_kill_switch: 0,
  per_venue_circuit_breaker_errors: 3
};
for (const [policyKey, value] of Object.entries(DEMO_POLICIES)) {
  await recordRiskPolicy({
    policyKey,
    value,
    setBy: "preview-admin",
    validForDays: null,
    note: "مقدار نمونهٔ پیش‌نمایش — تأیید مدیر نیست"
  });
}

/* ── the 10B session, half toman and half USDT on every venue ────────────── */
const venueIds = SHADOW_SOURCES.filter((c) => c.enabled).map((c) => c.id);
const perVenue = Math.floor(TOTAL / venueIds.length);
const openingAllocations = venueIds.map((sourceId, index) => {
  const share = perVenue + (index < TOTAL - perVenue * venueIds.length ? 1 : 0);
  const usdtSideToman = Math.floor(share / 2);
  const usdtMicros = Math.round((usdtSideToman / MARK) * 1_000_000);
  const usdtUnits = usdtMicros / 1_000_000;
  return { sourceId, irtToman: share - Math.round(usdtUnits * MARK), usdtUnits };
});

const paper = await createPaperSession({
  observationId: observation.id,
  name: "نشست نمونهٔ حجم هوشمند",
  mode: "PROVISIONAL_EVALUATION",
  totalCapitalToman: openingAllocations.reduce(
    (s, a) => s + a.irtToman + Math.round(a.usdtUnits * MARK),
    0
  ),
  valuationPriceToman: MARK,
  openingAllocations,
  approvalFingerprint: null,
  createdBy: "preview-admin",
  note: "دادهٔ نمونهٔ پیش‌نمایش"
});
await setPaperSessionStatus(paper.id, "RUNNING");

// One real engine cycle over the seeded market, through the production path.
const outcome = await runPaperExecutionForCycle({
  runId: null,
  occurredAt: nowIso,
  cycleStatus: "success",
  sources: snapshots,
  opportunities: built.opportunities
});

console.log(
  `[smart-sizing-seed] sources=${snapshots.length} opportunities=${built.opportunities.length} ` +
    `paper=${outcome.ran ? `filled ${outcome.filled ?? 0} / skipped ${outcome.skipped ?? 0}` : `not run (${outcome.reason})`}`
);
console.log(
  "[smart-sizing-seed] every figure above derives from invented order books and demonstration " +
    "risk values — no exchange, credential, order or transfer is involved"
);
await closeDb();
