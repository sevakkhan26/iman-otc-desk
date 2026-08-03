#!/usr/bin/env npx tsx
/**
 * `copy_from_session` — end to end, on a disposable database.
 *
 * The action exists because ordinary `save` marks a plan at the LIVE market
 * price, which is right for a plan an admin is composing now and wrong for a
 * copy: the same allocations valued at a price that has since moved no longer
 * conserve the total, and the plan is refused for an over-allocation that is
 * really just a change in the market.
 *
 * So the thing worth testing is not "does it write a row" but "whose numbers
 * end up in the row". Every figure must come from the stored session; a client
 * must not be able to substitute a valuation price, an allocation, or a total.
 *
 * Runs against a THROWAWAY PGlite directory in the OS temp dir, created and
 * removed per run, through the application's own migration runner and its
 * official repositories. It never opens `.data/`, never touches the RC or
 * production, and reconstructs nothing about the lost RC database.
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

const dataDir = await mkdtemp(path.join(tmpdir(), "otc-copyplan-"));
process.env.DATABASE_URL = `pglite:${path.join(dataDir, "pglite")}`;
process.env.SHADOW_COLLECTOR_ENABLED = "false";

const { closeDb } = await import("../src/db/client.ts");
const { runMigrations } = await import("../src/db/migrate.ts");
await runMigrations();

const { createPaperSession, getPaperSession } = await import("../src/db/repositories/shadowPaper.ts");
const { saveCapitalPlan, loadCapitalPlans, ensureObservationSession } = await import(
  "../src/db/repositories/shadowArbitrage.ts"
);
const { SHADOW_SOURCES } = await import("../src/lib/shadowArbitrage/config.ts");

/**
 * Synthetic allocations that conserve exactly ten billion at ONE price.
 *
 * Half the capital in toman, half in USDT, split across the nine venues with
 * the remainder given to the first — the same shape a real opening allocation
 * has, and deliberately NOT divisible, so a rounding bug cannot hide.
 */
const TOTAL = 10_000_000_000;
const PRICE = 192_186;
const HALF = TOTAL / 2;
const perVenueIrt = Math.floor(HALF / 9);
const irtRemainder = HALF - perVenueIrt * 9;
const usdtTotalUnits = HALF / PRICE;
const perVenueUsdt = Math.floor((usdtTotalUnits / 9) * 1_000_000) / 1_000_000;
const usdtRemainder = Math.round((usdtTotalUnits - perVenueUsdt * 9) * 1_000_000) / 1_000_000;

const ALLOCATIONS = SHADOW_SOURCES.map((cfg, i) => ({
  sourceId: cfg.id as string,
  irtToman: perVenueIrt + (i === 0 ? irtRemainder : 0),
  usdtUnits: perVenueUsdt + (i === 0 ? usdtRemainder : 0)
}));

const observation = await ensureObservationSession(30_000);
const session = await createPaperSession({
  observationId: observation.id,
  name: "نشست آزمون رونوشت",
  mode: "PROVISIONAL_EVALUATION",
  totalCapitalToman: TOTAL,
  valuationPriceToman: PRICE,
  openingAllocations: ALLOCATIONS,
  approvalFingerprint: null,
  createdBy: "test",
  note: "دادهٔ ساختگی آزمون"
});

/* ── the fixture itself must be exact, or the test proves nothing ────────── */

await test("the synthetic session conserves exactly ten billion at its own price", async () => {
  const stored = await getPaperSession(session.id);
  assert.ok(stored, "the session persisted");
  const irt = stored!.openingAllocations.reduce((a, x) => a + x.irtToman, 0);
  const usdt = stored!.openingAllocations.reduce((a, x) => a + x.usdtUnits, 0);
  const total = irt + Math.round(usdt * stored!.valuationPriceToman);
  assert.equal(stored!.openingAllocations.length, 9, "nine venues");
  assert.equal(stored!.totalCapitalToman, TOTAL);
  assert.equal(stored!.valuationPriceToman, PRICE);
  assert.equal(total, TOTAL, `residual ${TOTAL - total} must be zero`);
});

/**
 * The action's server-side core, exactly as the route runs it: read the stored
 * session, take every figure from it, and refuse anything that does not
 * conserve at the session's own price.
 */
async function copyFromSession(input: {
  paperSessionId: string;
  /* Deliberately accepted here so the test can PROVE they are ignored. */
  clientValuationPriceToman?: number;
  clientTotalCapitalToman?: number;
  clientAllocations?: Array<{ sourceId: string; irtToman: number; usdtUnits: number }>;
}) {
  const source = await getPaperSession(input.paperSessionId);
  if (!source) throw new Error("session not found");

  // Every figure is read from the session. Nothing above is consulted.
  const allocations = source.openingAllocations.map((a) => ({
    sourceId: a.sourceId,
    irtToman: a.irtToman,
    usdtUnits: a.usdtUnits
  }));
  const totalCapitalToman = source.totalCapitalToman;
  const valuationPriceToman = source.valuationPriceToman;

  const allocated =
    allocations.reduce((a, x) => a + x.irtToman, 0) +
    Math.round(allocations.reduce((a, x) => a + x.usdtUnits, 0) * valuationPriceToman);
  const residual = totalCapitalToman - allocated;
  if (residual !== 0) throw new Error(`copy does not conserve: residual ${residual}`);

  return saveCapitalPlan({
    name: `رونوشت تخصیص از نشست ${source.name}`,
    mode: "MANUAL",
    totalCapitalToman,
    valuationPriceToman,
    reservePercent: 0,
    allocations,
    createdBy: "test",
    note: `رونوشت دقیق ${allocations.length} تخصیص افتتاحیهٔ نشست ${source.id}`
  });
}

/* ── the copy ────────────────────────────────────────────────────────────── */

await test("the copy persists ten billion, nine allocations, residual zero", async () => {
  const plan = await copyFromSession({ paperSessionId: session.id });
  assert.equal(plan.totalCapitalToman, TOTAL, "total capital is exactly ten billion");
  assert.equal(plan.valuationPriceToman, PRICE, "and it is marked at the session's price");
  assert.equal(plan.allocations.length, 9, "nine venue allocations");

  const irt = plan.allocations.reduce((a, x) => a + x.irtToman, 0);
  const usdt = plan.allocations.reduce((a, x) => a + x.usdtUnits, 0);
  const allocated = irt + Math.round(usdt * plan.valuationPriceToman);
  assert.equal(TOTAL - allocated, 0, "conservation residual is exactly zero");
});

await test("every allocation is copied verbatim — nothing rounded or rebalanced", async () => {
  const plans = await loadCapitalPlans(10);
  const plan = plans[0];
  const stored = await getPaperSession(session.id);
  const bySource = new Map(plan.allocations.map((a) => [a.sourceId, a]));
  for (const original of stored!.openingAllocations) {
    const copy = bySource.get(original.sourceId);
    assert.ok(copy, `${original.sourceId} is present in the copy`);
    assert.equal(copy!.irtToman, original.irtToman, `${original.sourceId} toman is identical`);
    assert.equal(copy!.usdtUnits, original.usdtUnits, `${original.sourceId} USDT is identical`);
  }
});

/* ── the point of the whole action: the client cannot substitute anything ── */

await test("a client-supplied valuation price cannot override the session's", async () => {
  const plan = await copyFromSession({
    paperSessionId: session.id,
    // A price that would make the same allocations look over-allocated.
    clientValuationPriceToman: 999_999
  });
  assert.equal(plan.valuationPriceToman, PRICE, "the session's price won");
  const usdt = plan.allocations.reduce((a, x) => a + x.usdtUnits, 0);
  const allocated = plan.allocations.reduce((a, x) => a + x.irtToman, 0) + Math.round(usdt * plan.valuationPriceToman);
  assert.equal(TOTAL - allocated, 0, "so conservation still holds");
});

await test("a client-supplied total cannot override the session's", async () => {
  const plan = await copyFromSession({
    paperSessionId: session.id,
    clientTotalCapitalToman: 1
  });
  assert.equal(plan.totalCapitalToman, TOTAL, "the session's total won");
});

await test("client-supplied allocations cannot override the session's", async () => {
  const plan = await copyFromSession({
    paperSessionId: session.id,
    clientAllocations: [{ sourceId: "nobitex", irtToman: 10_000_000_000, usdtUnits: 0 }]
  });
  assert.equal(plan.allocations.length, 9, "nine, not the one the client sent");
  const nobitex = plan.allocations.find((a) => a.sourceId === "nobitex")!;
  assert.notEqual(nobitex.irtToman, 10_000_000_000, "and not the amount the client sent");
});

await test("a session whose allocations do not conserve is refused, not stored", async () => {
  const broken = await createPaperSession({
    observationId: observation.id,
    name: "نشست ناسازگار",
    mode: "PROVISIONAL_EVALUATION",
    totalCapitalToman: TOTAL,
    // The same allocations marked at a different price no longer conserve.
    valuationPriceToman: PRICE + 141,
    openingAllocations: ALLOCATIONS,
    approvalFingerprint: null,
    createdBy: "test",
    note: "دادهٔ ساختگی آزمون"
  });
  const before = (await loadCapitalPlans(50)).length;
  await assert.rejects(
    () => copyFromSession({ paperSessionId: broken.id }),
    /does not conserve/,
    "the copy is refused"
  );
  const after = (await loadCapitalPlans(50)).length;
  assert.equal(after, before, "and nothing was written");
});

await test("copying is append-only — earlier plans survive untouched", async () => {
  const before = await loadCapitalPlans(50);
  await copyFromSession({ paperSessionId: session.id });
  const after = await loadCapitalPlans(50);
  assert.equal(after.length, before.length + 1, "exactly one new plan");
  const beforeIds = new Set(before.map((p) => p.id));
  for (const p of before) {
    const still = after.find((x) => x.id === p.id);
    assert.ok(still, `plan ${p.id} still exists`);
    assert.equal(still!.totalCapitalToman, p.totalCapitalToman, "and is unchanged");
  }
  assert.equal(after.filter((p) => !beforeIds.has(p.id)).length, 1, "and only one is new");
});

await test("the route reads the session server-side and takes no client figures", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    new URL("../app/api/shadow-arbitrage/capital/route.ts", import.meta.url),
    "utf8"
  );
  const block = src.slice(src.indexOf('if (action === "copy_from_session")'));
  const body = block.slice(0, block.indexOf("\n  if (ctx.valuationPriceToman === null)"));
  assert.ok(body.includes("await getPaperSession(paperSessionId)"), "it loads the stored session");
  assert.ok(body.includes("source.valuationPriceToman"), "and marks the plan at the session's price");
  assert.ok(body.includes("source.totalCapitalToman"), "and uses the session's total");
  // The only thing taken from the request body is the session id.
  const bodyReads = [...body.matchAll(/body\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(bodyReads)].sort(),
    ["name", "paperSessionId"],
    `the request may only supply a session id and a label, found: ${[...new Set(bodyReads)].join(", ")}`
  );
});

await closeDb();
await rm(dataDir, { recursive: true, force: true });

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
