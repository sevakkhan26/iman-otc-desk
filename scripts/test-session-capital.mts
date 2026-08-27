#!/usr/bin/env npx tsx
/**
 * Step 1 — configurable Paper session capital (local only).
 * 100M and 10B: residual=0, one RUNNING, history preserved, idempotent retry.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SHADOW_SOURCES } from "../src/lib/shadowArbitrage/config.ts";
import {
  MAX_CAPITAL_TOMAN,
  MIN_CAPITAL_TOMAN,
  buildSessionCapitalPreview,
  parseWholeTomanCapital
} from "../src/lib/shadowArbitrage/paper/sessionCapital.ts";
import { portfolioValueToman } from "../src/lib/shadowArbitrage/paper/portfolio.ts";

let passed = 0;
let failed = 0;

const ELIGIBLE_VENUES = ["nobitex", "wallex"];
const OPENING_OBSERVATIONS = [
  {
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    occurrences: 1,
    riskAdjustedPnlToman: 100_000,
    capacityUsdtMicros: 1_000_000_000
  }
];

function liquidityAwarePreview(input: {
  totalCapitalToman: number;
  valuationPriceToman: number;
  venueIds: string[];
  activeSessionId: string | null;
}) {
  return buildSessionCapitalPreview({
    ...input,
    eligibleVenueIds: ELIGIBLE_VENUES,
    allocationObservations: OPENING_OBSERVATIONS
  });
}

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

await test("parseWholeTomanCapital accepts 100M and 10B, rejects bad values", () => {
  assert.equal(parseWholeTomanCapital(100_000_000).ok, true);
  assert.equal(parseWholeTomanCapital(10_000_000_000).ok, true);
  assert.equal(parseWholeTomanCapital("10,000,000,000").ok, true);
  assert.equal(parseWholeTomanCapital("100000000").ok, true);
  assert.equal(parseWholeTomanCapital(0).ok, false);
  assert.equal(parseWholeTomanCapital(-1).ok, false);
  assert.equal(parseWholeTomanCapital(1.5).ok, false);
  assert.equal(parseWholeTomanCapital("1.5").ok, false);
  assert.equal(parseWholeTomanCapital("").ok, false);
  assert.equal(parseWholeTomanCapital(null).ok, false);
  assert.equal(parseWholeTomanCapital(MIN_CAPITAL_TOMAN - 1).ok, false);
  assert.equal(parseWholeTomanCapital(MAX_CAPITAL_TOMAN + 1).ok, false);
});

await test("new-session preview preserves 10% reserve for 100M and 10B", () => {
  const venues = SHADOW_SOURCES.map((s) => s.id);
  const mark = 200_000;
  for (const cap of [100_000_000, 10_000_000_000] as const) {
    const p = liquidityAwarePreview({
      totalCapitalToman: cap,
      valuationPriceToman: mark,
      venueIds: venues,
      activeSessionId: null
    });
    assert.equal(p.residualToman, 0, `residual for ${cap}`);
    assert.equal(p.allocationValid, true);
    assert.equal(p.allocationSumToman + p.unallocatedReserveToman, cap);
    assert.equal(p.unallocatedReserveToman, Math.floor(cap * 0.1));
    assert.equal(portfolioValueToman(p.allocations, mark), p.allocationSumToman);
    assert.ok(p.previewToken.length >= 32);
    assert.equal(p.unit, "toman");
  }
});

const scratch = await mkdtemp(path.join(tmpdir(), "session-capital-"));
process.env.DATABASE_URL = `pglite:${scratch}`;
// Avoid production bootstrap side effects
process.env.SHADOW_RELEASE_BOOTSTRAP = "false";

const { runMigrations } = await import("../src/db/migrate.ts");
const { closeDb } = await import("../src/db/client.ts");
const {
  createPaperSession,
  getActivePaperSession,
  listActivePaperSessions,
  listPaperSessions,
  loadPaperBalances,
  replaceActivePaperSessionCapital,
  setPaperSessionStatus
} = await import("../src/db/repositories/shadowPaper.ts");
const { loadLatestCapitalPlan } = await import("../src/db/repositories/shadowArbitrage.ts");

await runMigrations();

const venues = SHADOW_SOURCES.map((s) => s.id);
const MARK = 200_000;

async function proveCapital(cap: number, label: string) {
  const prev = await getActivePaperSession();
  const prevId = prev?.id ?? null;
  const preview = liquidityAwarePreview({
    totalCapitalToman: cap,
    valuationPriceToman: MARK,
    venueIds: venues,
    activeSessionId: prevId
  });
  assert.equal(preview.residualToman, 0);

  const r1 = await replaceActivePaperSessionCapital({
    totalCapitalToman: preview.totalCapitalToman,
    valuationPriceToman: preview.valuationPriceToman,
    openingAllocations: preview.allocations,
    createdBy: "test-session-capital",
    previewToken: preview.previewToken,
    name: `test ${label}`
  });
  assert.equal(r1.reused, false);
  assert.equal(r1.newSession.status, "RUNNING");
  assert.equal(r1.newSession.totalCapitalToman, cap);
  assert.equal(r1.audit.newCapitalToman, cap);
  assert.equal(r1.audit.oldSessionId, prevId);
  assert.ok(r1.audit.actor);

  const actives = await listActivePaperSessions();
  assert.equal(actives.length, 1, "exactly one active");
  assert.equal(actives[0]!.id, r1.newSession.id);

  const bals = await loadPaperBalances(r1.newSession.id);
  assert.equal(bals.length, ELIGIBLE_VENUES.length);
  const balsTotal = bals.reduce(
    (s, b) => s + b.irtToman + Math.round((b.usdtMicros / 1e6) * MARK),
    0
  );
  assert.equal(balsTotal, preview.allocationSumToman, "balances exclude the global reserve");
  assert.equal(balsTotal + preview.unallocatedReserveToman, cap);

  // Idempotent second apply with same token
  const r2 = await replaceActivePaperSessionCapital({
    totalCapitalToman: preview.totalCapitalToman,
    valuationPriceToman: preview.valuationPriceToman,
    openingAllocations: preview.allocations,
    createdBy: "test-session-capital",
    previewToken: preview.previewToken
  });
  assert.equal(r2.reused, true);
  assert.equal(r2.newSession.id, r1.newSession.id);
  const actives2 = await listActivePaperSessions();
  assert.equal(actives2.length, 1);

  // History: old session still readable as STOPPED
  if (prevId) {
    const hist = await listPaperSessions(50);
    const old = hist.find((h) => h.id === prevId);
    assert.ok(old);
    assert.equal(old!.status, "STOPPED");
    assert.ok(old!.totalCapitalToman > 0);
  }

  const plan = await loadLatestCapitalPlan();
  assert.ok(plan);
  assert.equal(plan!.totalCapitalToman, cap);

  return r1.newSession.id;
}

await test("100M replace: exact capital, residual 0, one RUNNING, idempotent", async () => {
  // Seed a different capital first so replace has something to archive
  const seed = await createPaperSession({
    observationId: null,
    name: "seed before 100M",
    mode: "APPROVED_PLAN",
    totalCapitalToman: 50_000_000,
    valuationPriceToman: MARK,
    openingAllocations: liquidityAwarePreview({
      totalCapitalToman: 50_000_000,
      valuationPriceToman: MARK,
      venueIds: venues,
      activeSessionId: null
    }).allocations,
    approvalFingerprint: "seed",
    createdBy: "test"
  });
  await setPaperSessionStatus(seed.id, "RUNNING");
  await proveCapital(100_000_000, "100M");
});

await test("10B replace: exact capital, residual 0, one RUNNING, history kept", async () => {
  const before = await getActivePaperSession();
  assert.ok(before);
  const beforeId = before!.id;
  const beforeCap = before!.totalCapitalToman;
  await proveCapital(10_000_000_000, "10B");
  const hist = await listPaperSessions(50);
  const archived = hist.find((h) => h.id === beforeId);
  assert.ok(archived);
  assert.equal(archived!.status, "STOPPED");
  assert.equal(archived!.totalCapitalToman, beforeCap);
  const running = hist.filter((h) => h.status === "RUNNING");
  assert.equal(running.length, 1);
  assert.equal(running[0]!.totalCapitalToman, 10_000_000_000);
});

await closeDb();
await rm(scratch, { recursive: true, force: true });

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
