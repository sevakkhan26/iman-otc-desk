#!/usr/bin/env npx tsx
/**
 * Phase 8E-B — fee-tier and execution-mode evidence tests.
 *
 * Runs against a THROWAWAY PGlite directory in the OS temp dir, created and
 * removed per run, through the application's own migration runner. It never
 * opens `.data/` and never touches the local RC database.
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

const dataDir = await mkdtemp(path.join(tmpdir(), "otc-tier-test-"));
process.env.DATABASE_URL = `pglite:${path.join(dataDir, "pglite")}`;
process.env.SHADOW_COLLECTOR_ENABLED = "false";

const { closeDb } = await import("../src/db/client.ts");
const { runMigrations } = await import("../src/db/migrate.ts");
await runMigrations();

const {
  recordFeeTierEvidence,
  listFeeTierEvidence,
  selectEffectiveFee,
  EXECUTABLE_MODES,
  EXECUTION_MODES
} = await import("../src/db/repositories/shadowFeeTier.ts");

const NOW = Date.parse("2026-08-10T00:00:00.000Z");
const base = (over: Record<string, unknown> = {}) => ({
  sourceId: "nobitex",
  executionMode: "ORDER_BOOK" as const,
  tierLabel: "Base",
  makerFeeBps: 25,
  takerFeeBps: 25,
  provenance: "ADMIN_CONFIRMED_SCREENSHOT",
  evidenceKey: "k1",
  confirmedBy: "test",
  confirmedAt: "2026-08-01T00:00:00.000Z",
  validForDays: 30,
  sourceUrl: null,
  note: null,
  ...over
});

/* ── migration and storage ───────────────────────────────────────────────── */

await test("the migration is additive and creates the evidence table", async () => {
  const { readFileSync } = await import("node:fs");
  const raw = readFileSync(
    new URL("../drizzle/0012_shadow_fee_tier_evidence.sql", import.meta.url),
    "utf8"
  );
  /*
   * Strip `--` comments first: the migration's own prose explains that it never
   * updates, drops or truncates, and scanning the prose would flag the very
   * sentence that promises the opposite.
   */
  const sql = raw
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .toUpperCase();
  for (const banned of ["DROP TABLE", "ALTER TABLE", "DELETE FROM", "TRUNCATE", "UPDATE "]) {
    assert.equal(sql.includes(banned), false, `migration must not ${banned}`);
  }
  assert.ok(sql.includes("CREATE TABLE IF NOT EXISTS SHADOW_FEE_TIER_EVIDENCE"));
  // The table exists and is empty in a fresh database.
  assert.deepEqual(await listFeeTierEvidence(), []);
});

await test("the repository never updates or deletes evidence", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    new URL("../src/db/repositories/shadowFeeTier.ts", import.meta.url),
    "utf8"
  );
  assert.equal(/\.delete\(/.test(src), false, "evidence is never deleted");
  assert.equal(/\.update\(/.test(src), false, "evidence is never updated");
  for (const banned of ["apiKey", "apiSecret", "privateKey", "placeOrder", "withdraw", "fetch("]) {
    assert.equal(src.includes(banned), false, `must not contain ${banned}`);
  }
});

/* ── idempotency ─────────────────────────────────────────────────────────── */

await test("importing the same confirmation twice writes one row", async () => {
  const a = await recordFeeTierEvidence(base());
  const b = await recordFeeTierEvidence(base());
  assert.equal(a.id, b.id, "the second call returned the first row");
  assert.equal((await listFeeTierEvidence("nobitex")).length, 1);

  // A genuinely new confirmation appends beside it rather than replacing it.
  const c = await recordFeeTierEvidence(
    base({ evidenceKey: "k2", takerFeeBps: 26, confirmedAt: "2026-08-02T00:00:00.000Z" })
  );
  assert.notEqual(c.id, a.id);
  assert.equal((await listFeeTierEvidence("nobitex")).length, 2, "history is kept");
});

await test("expiry is derived from the approver's own validity period", async () => {
  const r = await recordFeeTierEvidence(
    base({ sourceId: "wallex", evidenceKey: "w1", validForDays: 30 })
  );
  // The driver may hand back an ISO string or a Postgres timestamp; compare the
  // instant, not the spelling.
  assert.equal(Date.parse(r.expiresAt as string), Date.parse("2026-08-31T00:00:00.000Z"));
  // No stated validity means no expiry, never an assumed one.
  const forever = await recordFeeTierEvidence(
    base({ sourceId: "wallex", evidenceKey: "w2", validForDays: null })
  );
  assert.equal(forever.expiresAt, null);
});

await test("a null tier and a null URL are stored as null, never invented", async () => {
  const r = await recordFeeTierEvidence(
    base({ sourceId: "abantether", executionMode: "OTC_QUOTE", evidenceKey: "a1", tierLabel: null })
  );
  assert.equal(r.tierLabel, null);
  assert.equal(r.sourceUrl, null);
  const back = (await listFeeTierEvidence("abantether"))[0];
  assert.equal(back.tierLabel, null, "null survives the round trip");
});

/* ── effective fee selection ─────────────────────────────────────────────── */

const records = () => listFeeTierEvidence();

await test("the effective fee matches venue, mode and tier together", async () => {
  const all = await records();
  const hit = selectEffectiveFee({
    records: all,
    sourceId: "nobitex",
    executionMode: "ORDER_BOOK",
    currentTierLabel: "Base",
    nowMs: NOW
  });
  assert.equal(hit.ok, true);
  if (!hit.ok) return;
  // The NEWEST matching confirmation wins.
  assert.equal(hit.takerFeeBps, 26);
  assert.equal(hit.tierLabel, "Base");
  assert.equal(hit.executable, true);
});

await test("a tier change invalidates the fee until it is reconfirmed", async () => {
  const all = await records();
  const moved = selectEffectiveFee({
    records: all,
    sourceId: "nobitex",
    executionMode: "ORDER_BOOK",
    currentTierLabel: "VIP2",
    nowMs: NOW
  });
  assert.equal(moved.ok, false);
  if (moved.ok) return;
  assert.equal(moved.miss, "tier_mismatch");
  assert.ok(moved.detailFa.includes("VIP2"), "it names the tier now in force");
  assert.ok(moved.detailFa.includes("Base"), "and the tier the evidence was for");

  // Confirming the new tier restores it — nothing was inherited in between.
  await recordFeeTierEvidence(
    base({
      evidenceKey: "k3",
      tierLabel: "VIP2",
      makerFeeBps: 15,
      takerFeeBps: 18,
      confirmedAt: "2026-08-03T00:00:00.000Z"
    })
  );
  const after = selectEffectiveFee({
    records: await records(),
    sourceId: "nobitex",
    executionMode: "ORDER_BOOK",
    currentTierLabel: "VIP2",
    nowMs: NOW
  });
  assert.equal(after.ok, true);
  if (!after.ok) return;
  assert.equal(after.takerFeeBps, 18);
  // The old tier's evidence is still on file.
  assert.ok((await records()).some((r) => r.tierLabel === "Base"), "history is preserved");
});

await test("expired evidence fails closed instead of being used", async () => {
  // A venue whose only record carries a real expiry.
  await recordFeeTierEvidence(
    base({ sourceId: "tabdeal", evidenceKey: "t1", tierLabel: "VIP1", validForDays: 30 })
  );
  const all = await records();

  const inDate = selectEffectiveFee({
    records: all,
    sourceId: "tabdeal",
    executionMode: "ORDER_BOOK",
    currentTierLabel: "VIP1",
    nowMs: NOW
  });
  assert.equal(inDate.ok, true, "inside its validity it is usable");

  const late = selectEffectiveFee({
    records: all,
    sourceId: "tabdeal",
    executionMode: "ORDER_BOOK",
    currentTierLabel: "VIP1",
    nowMs: Date.parse("2027-01-01T00:00:00.000Z")
  });
  assert.equal(late.ok, false, "past its expiry it is not");
  if (late.ok) return;
  assert.equal(late.miss, "expired");
  assert.ok(late.record, "the expired record is still shown, not hidden");

  /*
   * And a record whose approver stated NO validity never expires — that is the
   * approver's decision, not an assumed one.
   */
  const noExpiry = selectEffectiveFee({
    records: all,
    sourceId: "wallex",
    executionMode: "ORDER_BOOK",
    currentTierLabel: "Base",
    nowMs: Date.parse("2030-01-01T00:00:00.000Z")
  });
  assert.equal(noExpiry.ok, true);
  if (noExpiry.ok) assert.equal(noExpiry.record.expiresAt, null);
});

/* ── Arzinja mode isolation ──────────────────────────────────────────────── */

await test("Arzinja 0/0 applies to the order book and to nothing else", async () => {
  await recordFeeTierEvidence(
    base({
      sourceId: "arzinja",
      evidenceKey: "arz1",
      tierLabel: "Level 1",
      makerFeeBps: 0,
      takerFeeBps: 0
    })
  );
  const all = await records();

  const book = selectEffectiveFee({
    records: all,
    sourceId: "arzinja",
    executionMode: "ORDER_BOOK",
    currentTierLabel: "Level 1",
    nowMs: NOW
  });
  assert.equal(book.ok, true);
  if (!book.ok) return;
  assert.equal(book.makerFeeBps, 0);
  assert.equal(book.takerFeeBps, 0);

  /*
   * The whole point: Easy Trade and Convert have no evidence, so they fail
   * closed. Zero must never leak from the order book into another mode.
   */
  for (const mode of ["EASY_TRADE", "CONVERT"] as const) {
    const other = selectEffectiveFee({
      records: all,
      sourceId: "arzinja",
      executionMode: mode,
      currentTierLabel: "Level 1",
      nowMs: NOW
    });
    assert.equal(other.ok, false, `${mode} must not inherit the order-book rate`);
    if (other.ok) continue;
    assert.equal(other.miss, "no_evidence_for_mode");
    assert.equal(other.record, null, "there is no record to point at");
  }
});

await test("reference modes are never executable, even with evidence", async () => {
  await recordFeeTierEvidence(
    base({
      sourceId: "arzinja",
      executionMode: "CONVERT",
      evidenceKey: "arz-convert",
      tierLabel: "Level 1",
      makerFeeBps: 100,
      takerFeeBps: 120
    })
  );
  const conv = selectEffectiveFee({
    records: await records(),
    sourceId: "arzinja",
    executionMode: "CONVERT",
    currentTierLabel: "Level 1",
    nowMs: NOW
  });
  assert.equal(conv.ok, true, "the rate is visible as reference metadata");
  if (!conv.ok) return;
  assert.equal(conv.takerFeeBps, 120);
  assert.equal(conv.executable, false, "but it may never price an executable trade");
  assert.deepEqual([...EXECUTABLE_MODES].sort(), ["ORDER_BOOK", "OTC_QUOTE"]);
  assert.equal(EXECUTION_MODES.length, 4);
});

/* ── no defaults ─────────────────────────────────────────────────────────── */

await test("nothing falls back to another tier, mode or a venue default", async () => {
  const all = await records();
  // A venue with no evidence at all yields nothing, not a house rate.
  const none = selectEffectiveFee({
    records: all,
    sourceId: "bitpin",
    executionMode: "ORDER_BOOK",
    currentTierLabel: "Base Level 1",
    nowMs: NOW
  });
  assert.equal(none.ok, false);
  if (!none.ok) assert.equal(none.miss, "no_evidence_for_mode");

  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    new URL("../src/db/repositories/shadowFeeTier.ts", import.meta.url),
    "utf8"
  );
  // No literal bps anywhere in the selection path.
  assert.equal(/FeeBps\s*[:=]\s*\d/.test(src), false, "no default fee value exists");
  assert.equal(/\?\?\s*\d+/.test(src), false, "no numeric fallback exists");
});

/* ── restart persistence ─────────────────────────────────────────────────── */

await test("evidence survives a database reopen", async () => {
  const beforeCount = (await records()).length;
  await closeDb();
  const after = await records();
  assert.equal(after.length, beforeCount, "every row survived");
  assert.ok(after.some((r) => r.sourceId === "arzinja" && r.executionMode === "ORDER_BOOK"));
});

await closeDb();
await rm(dataDir, { recursive: true, force: true });

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
