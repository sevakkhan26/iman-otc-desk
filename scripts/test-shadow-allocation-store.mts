#!/usr/bin/env npx tsx
/**
 * Phase 8C-5 — persistence tests for allocation proposals.
 *
 * Runs against a THROWAWAY PGlite directory in the OS temp dir, created and
 * removed per run. It never opens `.data/` and never touches the local RC
 * database — one PGlite directory, one process, always.
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

const dataDir = await mkdtemp(path.join(tmpdir(), "otc-alloc-test-"));
process.env.DATABASE_URL = `pglite:${path.join(dataDir, "pglite")}`;
process.env.SHADOW_COLLECTOR_ENABLED = "false";

const { execRaw, closeDb } = await import("../src/db/client.ts");
const { readdir, readFile } = await import("node:fs/promises");

// Apply every migration the same way the app does.
const dir = new URL("../drizzle/", import.meta.url);
for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
  const sql = await readFile(new URL(file, dir), "utf8");
  await execRaw(sql.replace(/CREATE INDEX CONCURRENTLY/g, "CREATE INDEX"));
}

const {
  applyProposal,
  fingerprint,
  getProposal,
  listDecisions,
  listProposals,
  recordProposal
} = await import("../src/db/repositories/shadowAllocation.ts");

const TEN_B = 10_000_000_000;
const PRICE = 194_396;
const NINE = [
  "abantether", "arzinja", "bit24", "bitpin", "exnovin",
  "nobitex", "ramzinex", "tabdeal", "wallex"
];

const FP = { books: "b1", fees: "f1", accounts: "a1", policy: "p1" };

/** Nine rows that conserve exactly, with the toman side absorbing rounding. */
function rows(total = TEN_B) {
  const per = Math.floor(total / NINE.length);
  const out = NINE.map((sourceId, i) => {
    const share = per + (i < total - per * NINE.length ? 1 : 0);
    return {
      sourceId,
      role: i % 2 ? "SELL_SIDE" : "BUY_SIDE",
      irtToman: share,
      usdtUnits: 0,
      valueToman: share,
      sharePercent: Math.round((share / total) * 10_000) / 100,
      buyCapacityUsdtMicros: 1_000_000_000,
      sellCapacityUsdtMicros: 900_000_000,
      buyLimiter: "irt_balance",
      sellLimiter: "usdt_balance",
      buyReason: "ok",
      sellReason: "ok",
      reasonFa: "آزمون"
    };
  });
  return out;
}

const base = () => ({
  totalCapitalToman: TEN_B,
  valuationPriceToman: PRICE,
  allocatedToman: TEN_B,
  residualToman: 0,
  rows: rows(),
  fingerprints: { ...FP },
  appliedPolicyCaps: {},
  unsetPolicyCaps: ["max_order_size_usdt"],
  observations: [],
  createdBy: "test"
});

/* ── conservation ────────────────────────────────────────────────────────── */

await test("a proposal that conserves exactly 10B is stored and reads back whole", async () => {
  const p = await recordProposal(base());
  assert.equal(p.totalCapitalToman, TEN_B);
  assert.equal(p.allocatedToman, TEN_B);
  assert.equal(p.residualToman, 0);
  assert.equal(p.rows.length, 9);
  assert.equal(p.rows.reduce((s, r) => s + r.valueToman, 0), TEN_B, "rows add to the total");
  assert.equal(p.status, "PROPOSED");

  const back = await getProposal(p.id);
  assert.ok(back);
  assert.equal(back?.allocatedToman, TEN_B);
  assert.equal(back?.rows.length, 9);
  assert.deepEqual(back?.unsetPolicyCaps, ["max_order_size_usdt"]);
});

await test("a proposal that does not conserve is refused before it reaches the table", async () => {
  const before = (await listProposals(100)).length;
  await assert.rejects(
    () => recordProposal({ ...base(), allocatedToman: TEN_B - 1, residualToman: -1 }),
    /does not conserve/
  );
  assert.equal((await listProposals(100)).length, before, "nothing was written");
});

/* ── UNSET is not zero ───────────────────────────────────────────────────── */

await test("UNSET policy caps are recorded as names, never as a zero value", async () => {
  const p = await recordProposal({
    ...base(),
    appliedPolicyCaps: { max_slippage_bps: 25 },
    unsetPolicyCaps: ["max_order_size_usdt", "max_venue_exposure_percent"]
  });
  assert.deepEqual(p.appliedPolicyCaps, { max_slippage_bps: 25 });
  assert.deepEqual(p.unsetPolicyCaps, ["max_order_size_usdt", "max_venue_exposure_percent"]);
  // An unset cap must not appear among the applied ones with a value of 0.
  assert.equal("max_order_size_usdt" in p.appliedPolicyCaps, false);
  assert.notEqual(p.appliedPolicyCaps.max_order_size_usdt, 0);
});

/* ── append-only ─────────────────────────────────────────────────────────── */

await test("proposals are append-only: a second proposal never replaces the first", async () => {
  const a = await recordProposal(base());
  const b = await recordProposal(base());
  assert.notEqual(a.id, b.id);
  const all = await listProposals(100);
  assert.ok(all.find((p) => p.id === a.id), "the first still exists");
  assert.ok(all.find((p) => p.id === b.id));
});

await test("the repository issues no UPDATE, DELETE or DROP against its own tables", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    new URL("../src/db/repositories/shadowAllocation.ts", import.meta.url),
    "utf8"
  );
  for (const table of ["shadowAllocationProposals", "shadowAllocationDecisions"]) {
    assert.equal(
      new RegExp(`delete\\([^)]*${table}`).test(src),
      false,
      `${table} must never be deleted from`
    );
    assert.equal(
      new RegExp(`update\\(${table}\\)`).test(src),
      false,
      `${table} must never be updated`
    );
  }
  assert.equal(/DROP\s+TABLE/i.test(src), false);
  // The migration is additive only.
  const mig = readFileSync(
    new URL("../drizzle/0011_shadow_allocation_proposals.sql", import.meta.url),
    "utf8"
  );
  for (const banned of ["DROP TABLE", "ALTER TABLE", "DELETE FROM", "TRUNCATE"]) {
    assert.equal(mig.toUpperCase().includes(banned), false, `migration must not ${banned}`);
  }
  assert.ok(mig.includes("CREATE TABLE IF NOT EXISTS"));
});

/* ── apply: idempotency, staleness, concurrency ──────────────────────────── */

const SESSION = "11111111-2222-3333-4444-555555555555";

await test("applying writes the balances once and is idempotent on replay", async () => {
  const p = await recordProposal(base());
  const key = `apply-${p.id}`;

  const first = await applyProposal({
    proposalId: p.id,
    sessionId: SESSION,
    idempotencyKey: key,
    currentFingerprints: { ...FP },
    decidedBy: "test"
  });
  assert.equal(first.ok, true);
  assert.equal(first.decision, "APPLIED");
  assert.equal(first.idempotentReplay, false);

  const replay = await applyProposal({
    proposalId: p.id,
    sessionId: SESSION,
    idempotencyKey: key,
    currentFingerprints: { ...FP },
    decidedBy: "test"
  });
  assert.equal(replay.decision, "APPLIED");
  assert.equal(replay.idempotentReplay, true, "the replay did nothing");
  assert.equal(replay.decidedAt, first.decidedAt, "it returned the FIRST outcome");

  // Exactly one decision row exists for that key.
  const decisions = await listDecisions(p.id, 100);
  assert.equal(decisions.filter((d) => d.idempotencyKey === key).length, 1);
});

await test("a stale proposal is refused, and the refusal is itself audited", async () => {
  const p = await recordProposal(base());
  const out = await applyProposal({
    proposalId: p.id,
    sessionId: SESSION,
    idempotencyKey: `stale-${p.id}`,
    // The books moved since the proposal was built.
    currentFingerprints: { ...FP, books: "b2" },
    decidedBy: "test"
  });
  assert.equal(out.ok, false);
  assert.equal(out.decision, "REJECTED_STALE");
  assert.ok(out.detailFa.includes("دفتر سفارش"), "it names what moved");

  const decisions = await listDecisions(p.id, 100);
  assert.ok(
    decisions.some((d) => d.decision === "REJECTED_STALE"),
    "a refusal is part of the audit trail, not an absence from it"
  );

  // Each of the four inputs independently makes a proposal stale.
  for (const [k, fa] of [
    ["fees", "کارمزد"],
    ["accounts", "شواهد حساب"],
    ["policy", "سیاست"]
  ] as Array<[keyof typeof FP, string]>) {
    const q = await recordProposal(base());
    const r = await applyProposal({
      proposalId: q.id,
      sessionId: SESSION,
      idempotencyKey: `stale-${k}-${q.id}`,
      currentFingerprints: { ...FP, [k]: "changed" },
      decidedBy: "test"
    });
    assert.equal(r.decision, "REJECTED_STALE", `${k} must invalidate a proposal`);
    assert.ok(r.detailFa.includes(fa));
  }
});

await test("concurrent applies of one proposal produce exactly one APPLIED row", async () => {
  const p = await recordProposal(base());
  const key = `race-${p.id}`;
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      applyProposal({
        proposalId: p.id,
        sessionId: SESSION,
        idempotencyKey: key,
        currentFingerprints: { ...FP },
        decidedBy: "test"
      })
    )
  );
  const ok = results.filter((r) => r.status === "fulfilled");
  assert.ok(ok.length >= 1, "at least one call resolved");

  const decisions = await listDecisions(p.id, 100);
  const applied = decisions.filter((d) => d.idempotencyKey === key);
  assert.equal(applied.length, 1, "the unique key admitted exactly one decision row");
});

await test("a failed apply leaves no partial decision behind", async () => {
  const before = (await listDecisions(undefined, 200)).length;
  await assert.rejects(
    () =>
      applyProposal({
        proposalId: "00000000-0000-0000-0000-000000000000",
        sessionId: SESSION,
        idempotencyKey: `missing-${Date.now()}`,
        currentFingerprints: { ...FP },
        decidedBy: "test"
      }),
    /proposal not found/
  );
  assert.equal((await listDecisions(undefined, 200)).length, before, "nothing was appended");
});

/* ── fingerprints ────────────────────────────────────────────────────────── */

await test("fingerprints are stable under key order and change with content", () => {
  const a = fingerprint({ x: 1, y: [1, 2], z: { b: 2, a: 1 } });
  const b = fingerprint({ z: { a: 1, b: 2 }, y: [1, 2], x: 1 });
  assert.equal(a, b, "key order must not change the digest");
  assert.notEqual(a, fingerprint({ x: 1, y: [2, 1], z: { a: 1, b: 2 } }), "array order matters");
  assert.notEqual(a, fingerprint({ x: 2, y: [1, 2], z: { a: 1, b: 2 } }));
});

/* ── restart persistence ─────────────────────────────────────────────────── */

await test("proposals and decisions survive a database reopen", async () => {
  const p = await recordProposal(base());
  await applyProposal({
    proposalId: p.id,
    sessionId: SESSION,
    idempotencyKey: `restart-${p.id}`,
    currentFingerprints: { ...FP },
    decidedBy: "test"
  });

  await closeDb();

  const back = await getProposal(p.id);
  assert.ok(back, "the proposal survived the reopen");
  assert.equal(back?.allocatedToman, TEN_B);
  const decisions = await listDecisions(p.id, 100);
  assert.ok(decisions.some((d) => d.decision === "APPLIED"));

  // And the key is still spent: a replay after restart re-applies nothing.
  const replay = await applyProposal({
    proposalId: p.id,
    sessionId: SESSION,
    idempotencyKey: `restart-${p.id}`,
    currentFingerprints: { ...FP },
    decidedBy: "test"
  });
  assert.equal(replay.idempotentReplay, true);
});

/* ── safety ──────────────────────────────────────────────────────────────── */

await test("the allocation surface adds no order, credential or transfer path", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    new URL("../src/db/repositories/shadowAllocation.ts", import.meta.url),
    "utf8"
  );
  for (const banned of [
    "apiKey", "apiSecret", "privateKey", "placeOrder", "cancelOrder",
    "withdraw", "deposit", "transferFunds", "fetch("
  ]) {
    assert.equal(src.includes(banned), false, `must not contain ${banned}`);
  }
  const capability = readFileSync(
    new URL("../src/lib/shadowArbitrage/live/capability.ts", import.meta.url),
    "utf8"
  );
  assert.ok(capability.includes("export const LIVE_EXECUTION_IMPLEMENTED = false as const"));
});

await closeDb();
await rm(dataDir, { recursive: true, force: true });

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
