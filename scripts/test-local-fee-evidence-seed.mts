#!/usr/bin/env npx tsx
/**
 * Local fee evidence seed — pure throwaway PGlite, never .data/ or production.
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

const dataDir = await mkdtemp(path.join(tmpdir(), "otc-local-fee-"));
process.env.DATABASE_URL = `pglite:${path.join(dataDir, "pglite")}`;
process.env.SHADOW_COLLECTOR_ENABLED = "false";
process.env.SHADOW_RELEASE_BOOTSTRAP = "false";

const { closeDb } = await import("../src/db/client.ts");
const { runMigrations } = await import("../src/db/migrate.ts");
await runMigrations();

const { seedLocalFeeEvidence } = await import(
  "../src/lib/shadowArbitrage/localFeeEvidenceSeed.ts"
);
const {
  APPROVED_VENUES,
  RELEASE_KEY,
  CONFIRMED_AT
} = await import("../src/lib/shadowArbitrage/releaseBootstrap.ts");
const {
  loadLatestFeeConfirmations,
  loadLatestAccountConfirmations,
  recordFeeConfirmation,
  recordAccountConfirmation
} = await import("../src/db/repositories/shadowArbitrage.ts");
const { listFeeTierEvidence, recordFeeTierEvidence } = await import(
  "../src/db/repositories/shadowFeeTier.ts"
);
const { loadEffectiveFees } = await import("../src/lib/shadowArbitrage/effectiveFees.ts");
const {
  getActivePaperSession,
  createPaperSession,
  setPaperSessionStatus,
  loadPaperBalances
} = await import("../src/db/repositories/shadowPaper.ts");
const { defaultAllocation } = await import("../src/lib/shadowArbitrage/paper/portfolio.ts");
const { SHADOW_SOURCES } = await import("../src/lib/shadowArbitrage/config.ts");

await test("first seed writes all nine venues from releaseBootstrap", async () => {
  const r = await seedLocalFeeEvidence();
  assert.equal(r.evidenceSource, "releaseBootstrap.APPROVED_VENUES");
  assert.equal(r.evidenceKey, RELEASE_KEY);
  assert.equal(r.confirmedAt, CONFIRMED_AT);
  assert.equal(r.venues.length, 9);
  assert.equal(r.written, 9);
  assert.equal(r.alreadyPresent, 0);
  assert.equal(r.skippedNewer, 0);

  const fees = await loadLatestFeeConfirmations();
  const accounts = await loadLatestAccountConfirmations();
  for (const v of APPROVED_VENUES) {
    assert.ok(fees[v.sourceId], v.sourceId);
    assert.equal(fees[v.sourceId]!.takerFeeBps, v.takerBps);
    assert.equal(fees[v.sourceId]!.makerFeeBps, v.makerBps);
    assert.equal(fees[v.sourceId]!.feeTier, v.tier);
    assert.equal(fees[v.sourceId]!.evidenceKey, RELEASE_KEY);
    assert.equal(accounts[v.sourceId]!.executionEligible, true);
    assert.equal(accounts[v.sourceId]!.evidenceKey, RELEASE_KEY);
  }
  const tiers = await listFeeTierEvidence();
  assert.ok(tiers.length >= 9);
});

await test("second seed is a pure no-op (no duplicates)", async () => {
  const beforeTiers = (await listFeeTierEvidence()).length;
  const beforeFees = Object.keys(await loadLatestFeeConfirmations()).length;
  const r = await seedLocalFeeEvidence();
  assert.equal(r.written, 0);
  assert.equal(r.alreadyPresent, 9);
  assert.equal((await listFeeTierEvidence()).length, beforeTiers);
  assert.equal(Object.keys(await loadLatestFeeConfirmations()).length, beforeFees);
});

await test("effective fees apply 9/9 with no fee_unknown", async () => {
  const fees = await loadEffectiveFees(Date.now());
  assert.equal(fees.venues.length, 9);
  for (const v of fees.venues) {
    assert.equal(v.ok, true, `${v.sourceId} miss=${v.miss}`);
    assert.ok(v.takerFeeBps !== null, v.sourceId);
  }
  assert.equal(fees.blocks.length, 0);
});

await test("newer admin evidence is not overwritten", async () => {
  const newerAt = "2026-08-05T12:00:00.000Z";
  await recordFeeConfirmation({
    sourceId: "nobitex",
    takerFeeBps: 99,
    makerFeeBps: 99,
    feeTier: "AdminNew",
    provenance: "ADMIN_CONFIRMED",
    validDays: 30,
    evidenceKey: "admin-newer-local-test",
    confirmedBy: "admin-test",
    confirmedAt: newerAt
  });
  await recordFeeTierEvidence({
    sourceId: "nobitex",
    executionMode: "ORDER_BOOK",
    tierLabel: "AdminNew",
    makerFeeBps: 99,
    takerFeeBps: 99,
    provenance: "ADMIN_CONFIRMED",
    evidenceKey: "admin-newer-local-test",
    confirmedBy: "admin-test",
    confirmedAt: newerAt,
    validForDays: 30
  });
  await recordAccountConfirmation({
    sourceId: "nobitex",
    kycComplete: true,
    accountState: "VERIFIED",
    executionEligible: true,
    provenance: "ADMIN_CONFIRMED",
    validDays: 30,
    evidenceKey: "admin-newer-local-test",
    confirmedBy: "admin-test",
    confirmedAt: newerAt
  });

  const r = await seedLocalFeeEvidence();
  const nobitex = r.venues.find((v) => v.sourceId === "nobitex");
  assert.equal(nobitex?.action, "skipped_newer_admin");
  const fees = await loadLatestFeeConfirmations();
  assert.equal(fees.nobitex!.takerFeeBps, 99);
  assert.equal(fees.nobitex!.evidenceKey, "admin-newer-local-test");
});

await test("seed does not create or stop paper sessions", async () => {
  const alloc = defaultAllocation(
    100_000_000,
    SHADOW_SOURCES.map((s) => s.id),
    200_000
  );
  const s = await createPaperSession({
    observationId: null,
    name: "preserve-test",
    mode: "APPROVED_PLAN",
    totalCapitalToman: 100_000_000,
    valuationPriceToman: 200_000,
    openingAllocations: alloc,
    approvalFingerprint: null,
    createdBy: "test",
    note: null
  });
  await setPaperSessionStatus(s.id, "RUNNING");
  const balsBefore = await loadPaperBalances(s.id);

  await seedLocalFeeEvidence();

  const active = await getActivePaperSession();
  assert.equal(active?.id, s.id);
  assert.equal(active?.status, "RUNNING");
  const balsAfter = await loadPaperBalances(s.id);
  assert.deepEqual(
    balsAfter.map((b) => ({ id: b.sourceId, i: b.irtToman, u: b.usdtMicros })),
    balsBefore.map((b) => ({ id: b.sourceId, i: b.irtToman, u: b.usdtMicros }))
  );
});

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
await closeDb();
await rm(dataDir, { recursive: true, force: true });
if (failed) process.exit(1);
