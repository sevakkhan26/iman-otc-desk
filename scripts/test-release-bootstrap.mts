#!/usr/bin/env npx tsx
/**
 * Release 4.1.6.0 — the startup reconciliation, on a fresh database.
 *
 * The claim being tested is not "the importer works" — it is that a deployment
 * needs NO importer. So nothing here calls the reconciliation's helpers to set
 * data up: the test seeds only a market snapshot (which in production the
 * collector produces), then invokes the same entry point startup invokes, and
 * asserts the resulting state through the same repositories the APIs read.
 *
 * The second run is the point of the whole design: it must write nothing.
 *
 * Runs against a THROWAWAY PGlite directory in the OS temp dir, created and
 * removed per run, through the application's own migration runner. It never
 * opens `.data/`, never touches the RC, and never contacts production.
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

const dataDir = await mkdtemp(path.join(tmpdir(), "otc-release-"));
process.env.DATABASE_URL = `pglite:${path.join(dataDir, "pglite")}`;
process.env.SHADOW_COLLECTOR_ENABLED = "false";
process.env.SHADOW_RELEASE_BOOTSTRAP = "true";

const { closeDb } = await import("../src/db/client.ts");
const { runMigrations } = await import("../src/db/migrate.ts");
await runMigrations();

const {
  runReleaseBootstrap,
  buildAllocations,
  allocatedToman,
  RELEASE_CAPITAL_TOMAN,
  APPROVED_VENUES,
  CONFIRMED_AT
} = await import("../src/lib/shadowArbitrage/releaseBootstrap.ts");
const {
  loadLatestAccountConfirmations,
  loadLatestFeeConfirmations,
  loadCapitalPlans,
  ensureObservationSession,
  beginCollectionRun,
  completeCollectionRun
} = await import("../src/db/repositories/shadowArbitrage.ts");
const { listFeeTierEvidence } = await import("../src/db/repositories/shadowFeeTier.ts");
const {
  getActivePaperSession,
  listPaperSessions,
  createPaperSession,
  setPaperSessionStatus,
  loadPaperBalances
} = await import("../src/db/repositories/shadowPaper.ts");
const { buildAllReadiness } = await import("../src/lib/shadowArbitrage/accounts.ts");
const { loadEffectiveFees } = await import("../src/lib/shadowArbitrage/effectiveFees.ts");
const { PAPER_FEE_SETTLEMENT } = await import("../src/lib/shadowArbitrage/paper/broker.ts");
const { snapshotFromResult } = await import("../src/lib/shadowArbitrage/adapters/base.ts");
const { SHADOW_SOURCES } = await import("../src/lib/shadowArbitrage/config.ts");
const { SHADOW_COST_RECORDS } = await import("../src/lib/shadowArbitrage/config.ts");

/* ── the world before the release: a market, and an old 50M session ──────── */

const MARK = 100_000;
const nowIso = new Date().toISOString();
const snapshots = SHADOW_SOURCES.filter((c) => c.enabled).map((cfg) =>
  snapshotFromResult(
    cfg,
    {
      kind: cfg.marketModel === "OTC_QUOTE" ? "OTC_QUOTE" : "BOOK",
      bids: cfg.marketModel === "OTC_QUOTE" ? [] : [{ priceToman: MARK - 50, amountUsdt: 500 }],
      asks: cfg.marketModel === "OTC_QUOTE" ? [] : [{ priceToman: MARK + 50, amountUsdt: 500 }],
      bestBidToman: MARK - 50,
      bestAskToman: MARK + 50,
      maxUsdt: cfg.marketModel === "OTC_QUOTE" ? 500 : null,
      sourceTimestamp: nowIso,
      priceUnit: "IRT",
      depthAvailable: cfg.marketModel !== "OTC_QUOTE",
      directionVerified: true,
      endpoint: "test://fixture",
      httpStatus: 200,
      latencyMs: 10,
      attempts: 1,
      rateLimited: false,
      normalizationNote: "دادهٔ ساختگی آزمون"
    },
    nowIso
  )
);

const observation = await ensureObservationSession(30_000);
const { runId } = await beginCollectionRun({
  sessionId: observation.id,
  idempotencyKey: "release-test-cycle",
  workerId: "test",
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
  opportunityCount: 0,
  durationMs: 100,
  pollIntervalMs: 30_000,
  sources: snapshots,
  certBySource: {},
  opportunities: [],
  transitions: []
});

/** The session production is still showing: fifty million, with its history. */
const oldSession = await createPaperSession({
  observationId: observation.id,
  name: "نشست قدیمی ۵۰ میلیونی",
  mode: "PROVISIONAL_EVALUATION",
  totalCapitalToman: 50_000_000,
  valuationPriceToman: MARK,
  openingAllocations: [
    { sourceId: "nobitex", irtToman: 25_000_000, usdtUnits: 250 }
  ],
  approvalFingerprint: null,
  createdBy: "test",
  note: "تاریخچه — نباید بازنویسی شود"
});
await setPaperSessionStatus(oldSession.id, "RUNNING");
const oldBalancesBefore = await loadPaperBalances(oldSession.id);

/* ── the first start ─────────────────────────────────────────────────────── */

const first = await runReleaseBootstrap();

await test("startup creates one account and one fee confirmation per venue", async () => {
  assert.equal(first.ran, true, `bootstrap ran (${first.reason ?? ""})`);
  assert.equal(first.accountConfirmations, 9);
  assert.equal(first.feeConfirmations, 9);
  const accounts = await loadLatestAccountConfirmations();
  const fees = await loadLatestFeeConfirmations();
  assert.equal(Object.keys(accounts).length, 9, "nine account confirmations");
  assert.equal(Object.keys(fees).length, 9, "nine fee confirmations");
});

await test("the accounts surface reports KYC 9/9 and eligibility 9/9", async () => {
  const eff = await loadEffectiveFees(Date.now());
  const accounts = await loadLatestAccountConfirmations();
  const readiness = buildAllReadiness(
    eff.overrides,
    Date.now(),
    Object.values(accounts),
    eff.blocks
  );
  assert.equal(readiness.length, 9);
  assert.equal(readiness.filter((r) => r.kycComplete).length, 9, "KYC 9/9");
  assert.equal(readiness.filter((r) => r.executionEligible).length, 9, "eligible 9/9");
  for (const id of ["tetherland", "arzinja"]) {
    const v = readiness.find((r) => r.sourceId === id)!;
    assert.equal(v.executionEligible, true, `${id} is eligible`);
    assert.equal(v.ineligibleReason, null, `${id} carries no permanent ineligible reason`);
    assert.notEqual(v.accountState, "REFERENCE_ONLY", `${id} is not reference-only`);
  }
});

await test("every taker, maker, tier and settlement value matches the approval", async () => {
  const eff = await loadEffectiveFees(Date.now());
  for (const want of APPROVED_VENUES) {
    const f = eff.byVenue[want.sourceId];
    assert.ok(f, `${want.sourceId} resolved`);
    assert.equal(f.ok, true, `${want.sourceId} has an applied fee`);
    assert.equal(f.takerFeeBps, want.takerBps, `${want.sourceId} taker`);
    assert.equal(f.makerFeeBps, want.makerBps, `${want.sourceId} maker`);
    assert.equal(f.evidenceTierLabel, want.tier, `${want.sourceId} tier`);
    assert.equal(f.provenance, "ADMIN_CONFIRMED_SCREENSHOT", `${want.sourceId} provenance`);

    const settle = PAPER_FEE_SETTLEMENT[want.sourceId as keyof typeof PAPER_FEE_SETTLEMENT];
    assert.equal(settle.buy.feeAsset, "IRT", `${want.sourceId} buy fee is toman`);
    assert.equal(settle.buy.debitMode, "ADD_TO_DEBIT", `${want.sourceId} buy debit`);
    assert.equal(settle.sell.feeAsset, "USDT", `${want.sourceId} sell fee is USDT`);
    assert.equal(settle.sell.debitMode, "ADD_TO_DEBIT", `${want.sourceId} sell debit`);
  }
  const tiers = await listFeeTierEvidence();
  assert.equal(tiers.filter((t) => t.evidenceKey.startsWith("release-")).length, 9);
  for (const t of tiers) {
    assert.equal(Date.parse(t.confirmedAt), Date.parse(CONFIRMED_AT), "the approver's timestamp");
    /*
     * The STORED evidence carries no URL. `effectiveFees` falls back to the
     * venue's published fee page from config for display only — that link is
     * compiled in and documented, not something this release invented.
     */
    assert.equal(t.sourceUrl, null, `${t.sourceId} stored evidence invents no URL`);
  }
  const storedFees = await loadLatestFeeConfirmations();
  for (const want of APPROVED_VENUES) {
    const row = storedFees[want.sourceId];
    assert.equal(row.sourceUrl, null, `${want.sourceId} fee confirmation stores a null URL`);
    assert.equal(row.takerFeeBps, want.takerBps, `${want.sourceId} stored taker`);
    assert.equal(row.makerFeeBps, want.makerBps, `${want.sourceId} stored maker`);
    assert.equal(row.feeTier, want.tier, `${want.sourceId} stored tier`);
  }
});

await test("the persisted capital plan is exactly ten billion with zero residual", async () => {
  const plans = await loadCapitalPlans(20);
  const plan = plans[0];
  assert.equal(plan.totalCapitalToman, RELEASE_CAPITAL_TOMAN, "exactly 10,000,000,000");
  assert.equal(plan.allocations.length, 9, "nine venue allocations");
  assert.equal(plan.reservePercent, 0, "no held-back reserve");
  const allocated = allocatedToman(plan.allocations, plan.valuationPriceToman);
  assert.equal(RELEASE_CAPITAL_TOMAN - allocated, 0, "conservation residual is exactly zero");
  const ids = new Set(plan.allocations.map((a) => a.sourceId));
  assert.equal(ids.size, 9, "all nine venues present, none repeated");
});

await test("the active paper session is the ten-billion one, and it is the only one", async () => {
  const active = await getActivePaperSession();
  assert.ok(active, "an active session exists");
  assert.equal(active!.totalCapitalToman, RELEASE_CAPITAL_TOMAN, "initial capital is ten billion");
  assert.equal(active!.status, "RUNNING");
  assert.equal(active!.openingAllocations.length, 9, "nine venue balances");
  assert.equal(active!.id, first.sessionId, "and it is the one the bootstrap created");

  const all = await listPaperSessions(20);
  const stillActive = all.filter((s) => ["NOT_STARTED", "RUNNING", "PAUSED"].includes(s.status));
  assert.equal(stillActive.length, 1, `exactly one active session, found ${stillActive.length}`);
});

await test("the old fifty-million session survives as history, unrewritten", async () => {
  const all = await listPaperSessions(20);
  const old = all.find((s) => s.id === oldSession.id);
  assert.ok(old, "the old session still exists");
  assert.equal(old!.totalCapitalToman, 50_000_000, "its capital was not rewritten");
  assert.equal(old!.status, "STOPPED", "closed through the audited transition");
  assert.equal(
    old!.openingAllocations.length,
    1,
    "its opening allocations are untouched"
  );
  const after = await loadPaperBalances(oldSession.id);
  assert.equal(after.length, oldBalancesBefore.length, "its balances are untouched");
});

await test("transfer and rebalance cost stay UNKNOWN — nothing was invented", () => {
  const rebalance = SHADOW_COST_RECORDS.find((c) => c.key === "rebalance_cost")!;
  assert.notEqual(rebalance.status, "official", "rebalance cost is not presented as verified");
  assert.equal(rebalance.reference, null, "and no source was invented for it");
});

/* ── the second start: the whole point ───────────────────────────────────── */

await test("a second start writes no evidence, no plan and no session", async () => {
  const plansBefore = (await loadCapitalPlans(50)).length;
  const sessionsBefore = (await listPaperSessions(50)).length;
  const tiersBefore = (await listFeeTierEvidence()).length;
  const activeBefore = await getActivePaperSession();

  const second = await runReleaseBootstrap();
  assert.equal(second.ran, false, "the second run did not apply");
  assert.equal(second.reason, "already-applied", "and said why");
  assert.equal(second.capitalPlansCreated, 0);
  assert.equal(second.paperSessionsCreated, 0);
  assert.equal(second.accountConfirmations, 0);
  assert.equal(second.feeConfirmations, 0);

  assert.equal((await loadCapitalPlans(50)).length, plansBefore, "no extra plan");
  assert.equal((await listPaperSessions(50)).length, sessionsBefore, "no extra session");
  assert.equal((await listFeeTierEvidence()).length, tiersBefore, "no duplicate evidence");
  const activeAfter = await getActivePaperSession();
  assert.equal(activeAfter!.id, activeBefore!.id, "the same session is still active");
});

await test("a third start is equally quiet — the guard is not a one-shot fluke", async () => {
  const before = (await listPaperSessions(50)).length;
  const third = await runReleaseBootstrap();
  assert.equal(third.ran, false);
  assert.equal((await listPaperSessions(50)).length, before);
});

/* ── restart persistence ─────────────────────────────────────────────────── */

await test("the state survives a database reopen", async () => {
  await closeDb();
  const active = await getActivePaperSession();
  assert.equal(active!.totalCapitalToman, RELEASE_CAPITAL_TOMAN, "still ten billion after restart");
  const plans = await loadCapitalPlans(20);
  assert.equal(plans[0].totalCapitalToman, RELEASE_CAPITAL_TOMAN);
  const eff = await loadEffectiveFees(Date.now());
  assert.equal(eff.venues.filter((v) => v.ok).length, 9, "nine applied fees after restart");

  const again = await runReleaseBootstrap();
  assert.equal(again.ran, false, "and the marker still holds after a reopen");
});

/* ── the allocation arithmetic itself ────────────────────────────────────── */

await test("largest-remainder allocation conserves at a range of awkward prices", () => {
  const ids = SHADOW_SOURCES.map((c) => c.id as string);
  for (const price of [100_000, 192_186, 192_327, 99_991, 123_457]) {
    const allocations = buildAllocations(RELEASE_CAPITAL_TOMAN, price, ids);
    assert.equal(allocations.length, 9, `nine at ${price}`);
    const total = allocatedToman(allocations, price);
    assert.equal(RELEASE_CAPITAL_TOMAN - total, 0, `residual zero at price ${price}`);
    // Deterministic: the same inputs give the same split every time.
    const again = buildAllocations(RELEASE_CAPITAL_TOMAN, price, ids);
    assert.deepEqual(again, allocations, `deterministic at ${price}`);
    // Roughly half the value on each side, as approved.
    const irt = allocations.reduce((a, x) => a + x.irtToman, 0);
    assert.ok(
      Math.abs(irt - RELEASE_CAPITAL_TOMAN / 2) <= 9,
      `toman half is within rounding at ${price}: ${irt}`
    );
  }
});

await test("no credential, order or transfer path exists in the bootstrap", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    new URL("../src/lib/shadowArbitrage/releaseBootstrap.ts", import.meta.url),
    "utf8"
  );
  /*
   * Strip comments first. The file's own header says it adds no deposit or
   * withdrawal path, and a raw scan matches that prose instead of the code.
   */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["apiKey", "api_key", "secret", "withdraw", "deposit", "privateKey", "Authorization"]) {
    assert.equal(code.includes(forbidden), false, `no ${forbidden} in the bootstrap`);
  }
  assert.equal(/\bfetch\s*\(/.test(code), false, "it makes no network call");
  // Destructive SQL must never appear in the release migration either.
  const migration = readFileSync(
    new URL("../drizzle/0014_shadow_release_bootstrap.sql", import.meta.url),
    "utf8"
  ).replace(/^--.*$/gm, "");
  for (const forbidden of ["DROP ", "DELETE ", "TRUNCATE", "ALTER "]) {
    assert.equal(migration.includes(forbidden), false, `no ${forbidden.trim()} in the migration`);
  }
});

await closeDb();
await rm(dataDir, { recursive: true, force: true });

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
