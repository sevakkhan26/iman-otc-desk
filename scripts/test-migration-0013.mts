#!/usr/bin/env npx tsx
/**
 * Phase 8E-B — prove migration 0013 on a database that predates it.
 *
 * A migration that only ever runs against a fresh database has not been tested:
 * on a fresh database `0013` adds a column to a table created moments earlier
 * and empty. The real case is an EXISTING table with rows in it, where
 * `ADD COLUMN seq bigserial` has to backfill every one of them.
 *
 * So this builds a genuine pre-0013 database (migrations 0001–0012 only, then
 * nine evidence rows written through raw SQL against the 0012 shape), CLONES
 * that directory, and migrates the clone. Then it reads back, shuts down
 * cleanly, restarts, verifies again, and re-runs the migration to prove it is
 * idempotent.
 *
 * Everything happens in the OS temp directory. It never opens `.data/`, never
 * touches the local RC database, and deletes nothing outside its own scratch.
 */
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

const repoRoot = process.cwd();
const scratch = await mkdtemp(path.join(tmpdir(), "otc-mig0013-"));
const preDir = path.join(scratch, "pre0013");
const cloneDir = path.join(scratch, "clone");

/*
 * A working tree that carries only the migrations that existed before 0013.
 * The runner resolves `drizzle/` from `process.cwd()`, so pointing the cwd at
 * this directory is what pins the database to the earlier schema.
 */
const legacyRoot = path.join(scratch, "legacy-tree");
await mkdir(path.join(legacyRoot, "drizzle"), { recursive: true });
const allMigrations = (await readdir(path.join(repoRoot, "drizzle")))
  .filter((f) => f.endsWith(".sql"))
  .sort();
const beforeSeq = allMigrations.filter((f) => f < "0013");
for (const f of beforeSeq) {
  await writeFile(
    path.join(legacyRoot, "drizzle", f),
    await readFile(path.join(repoRoot, "drizzle", f), "utf8")
  );
}

process.env.DATABASE_URL = `pglite:${preDir}`;
process.env.SHADOW_COLLECTOR_ENABLED = "false";

const { closeDb, execRaw, getDbAsync } = await import("../src/db/client.ts");
const { runMigrations, migrationStatus } = await import("../src/db/migrate.ts");
const { listFeeTierEvidence, selectEffectiveFee } = await import(
  "../src/db/repositories/shadowFeeTier.ts"
);

/** The nine rows, as an installation that predates 0013 would hold them. */
const ROWS = [
  ["nobitex", "ORDER_BOOK", "Base", 25, 25],
  ["wallex", "ORDER_BOOK", "Base Level 1", 25, 30],
  ["tabdeal", "ORDER_BOOK", "VIP1", 24, 28],
  ["bitpin", "ORDER_BOOK", "Base Level 1", 30, 35],
  ["abantether", "OTC_QUOTE", null, 30, 30],
  ["ramzinex", "ORDER_BOOK", "Base", 20, 25],
  ["bit24", "ORDER_BOOK", "VIP0", 20, 20],
  ["tetherland", "ORDER_BOOK", "Bronze", 45, 45],
  ["arzinja", "ORDER_BOOK", "Level 1", 0, 0]
] as const;

/*
 * One shared confirmation instant across all nine, exactly as a bulk import
 * produces — the case that made the pre-0013 ordering ambiguous.
 */
const CONFIRMED_AT = "2026-08-02T00:00:00.000Z";
const EXPIRES_AT = "2026-09-01T00:00:00.000Z";
const NOW = Date.parse("2026-08-10T00:00:00.000Z");

/* ── 1. build the pre-0013 database ──────────────────────────────────────── */

await test("a pre-0013 database migrates to 0012 and has no seq column", async () => {
  process.chdir(legacyRoot);
  const applied = await runMigrations();
  process.chdir(repoRoot);

  assert.ok(applied.applied.includes("0012_shadow_fee_tier_evidence.sql"), "0012 ran");
  assert.equal(
    applied.applied.some((f) => f.startsWith("0013")),
    false,
    "0013 did not — this database predates it"
  );

  const db = await getDbAsync();
  const { sql } = await import("drizzle-orm");
  const cols = await db.execute(
    sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'shadow_fee_tier_evidence'`
  );
  const rows = (Array.isArray(cols) ? cols : ((cols as { rows?: unknown[] }).rows ?? [])) as Array<{
    column_name: string;
  }>;
  const names = rows.map((r) => r.column_name);
  assert.ok(names.includes("evidence_key"), "the 0012 table is there");
  assert.equal(names.includes("seq"), false, "and it genuinely has no seq column yet");
});

await test("nine evidence rows are written in the 0012 shape", async () => {
  for (const [sourceId, mode, tier, maker, taker] of ROWS) {
    const { randomUUID } = await import("node:crypto");
    await execRaw(`
      INSERT INTO shadow_fee_tier_evidence
        (id, source_id, execution_mode, tier_label, maker_fee_bps, taker_fee_bps,
         provenance, evidence_key, confirmed_by, confirmed_at, valid_for_days,
         expires_at, source_url, note)
      VALUES ('${randomUUID()}', '${sourceId}', '${mode}',
        ${tier === null ? "NULL" : `'${tier}'`}, ${maker}, ${taker},
        'ADMIN_CONFIRMED_SCREENSHOT', 'pre-0013-import', 'test',
        '${CONFIRMED_AT}', 30, '${EXPIRES_AT}', NULL, NULL);
    `);
  }
  const db = await getDbAsync();
  const { sql } = await import("drizzle-orm");
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM shadow_fee_tier_evidence`);
  const rows = (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Array<{
    n: number;
  }>;
  assert.equal(Number(rows[0].n), 9);
  await closeDb();
});

/* ── 2. clone it, then migrate the clone ─────────────────────────────────── */

await test("the pre-0013 database clones cleanly", async () => {
  await cp(preDir, cloneDir, { recursive: true });
  const names = await readdir(cloneDir);
  assert.ok(names.includes("PG_VERSION"), "the clone is a real data directory");
  // A clone taken after a clean shutdown carries no live lock.
  assert.equal(names.includes("postmaster.pid"), false, "and no stale lock file");
});

await test("0013 applies to the clone and backfills every existing row", async () => {
  process.env.DATABASE_URL = `pglite:${cloneDir}`;
  const applied = await runMigrations();
  assert.deepEqual(
    applied.applied.filter((f) => f.startsWith("0013")),
    ["0013_shadow_fee_tier_seq.sql"],
    "exactly the one new migration ran"
  );
  assert.ok(
    applied.skipped.includes("0012_shadow_fee_tier_evidence.sql"),
    "and the earlier ones were recognised as already applied"
  );

  const records = await listFeeTierEvidence();
  assert.equal(records.length, 9, "no row was lost");
  const seqs = records.map((r) => r.seq);
  assert.equal(new Set(seqs).size, 9, "every pre-existing row got its own sequence");
  assert.ok(
    seqs.every((n) => Number.isFinite(n) && n > 0),
    `every sequence is a real number: ${JSON.stringify(seqs)}`
  );
});

await test("the migration is additive — nothing was rewritten or dropped", async () => {
  const records = await listFeeTierEvidence();
  for (const [sourceId, mode, tier, maker, taker] of ROWS) {
    const r = records.find((x) => x.sourceId === sourceId);
    assert.ok(r, `${sourceId} survived`);
    assert.equal(r!.executionMode, mode);
    assert.equal(r!.tierLabel, tier);
    assert.equal(r!.makerFeeBps, maker);
    assert.equal(r!.takerFeeBps, taker);
    assert.equal(r!.evidenceKey, "pre-0013-import");
    assert.equal(Date.parse(r!.confirmedAt), Date.parse(CONFIRMED_AT));
  }
  // The migration file itself may not carry a destructive statement.
  const sqlText = await readFile(
    path.join(repoRoot, "drizzle", "0013_shadow_fee_tier_seq.sql"),
    "utf8"
  );
  const body = sqlText.replace(/^--.*$/gm, "");
  for (const forbidden of ["DROP ", "DELETE ", "TRUNCATE", "UPDATE ", "ALTER COLUMN"]) {
    assert.equal(body.includes(forbidden), false, `no ${forbidden.trim()} in the migration`);
  }
  assert.ok(body.includes("ADD COLUMN IF NOT EXISTS"), "it only adds");
});

await test("effective-fee selection reads back correctly on the migrated clone", async () => {
  const records = await listFeeTierEvidence();
  for (const [sourceId, mode, tier, , taker] of ROWS) {
    const pick = selectEffectiveFee({
      records,
      sourceId,
      executionMode: mode,
      currentTierLabel: tier,
      nowMs: NOW
    });
    assert.equal(pick.ok, true, `${sourceId} resolves`);
    if (pick.ok) assert.equal(pick.takerFeeBps, taker, `${sourceId} taker`);
  }
});

/* ── 3. clean shutdown, restart, verify again ────────────────────────────── */

let seqBeforeRestart: number[] = [];

await test("a clean shutdown and restart preserves every row and its sequence", async () => {
  seqBeforeRestart = (await listFeeTierEvidence())
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
    .map((r) => r.seq);

  await closeDb();
  const names = await readdir(cloneDir);
  assert.equal(names.includes("postmaster.pid"), false, "the shutdown released its lock");

  // Reopening is a real restart: closeDb cleared the cached connection.
  const after = (await listFeeTierEvidence())
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
    .map((r) => r.seq);
  assert.equal(after.length, 9, "nine rows after restart");
  assert.deepEqual(after, seqBeforeRestart, "and the same sequences, in the same order");
});

await test("the resolved fee is identical before and after the restart", async () => {
  const records = await listFeeTierEvidence();
  const arz = selectEffectiveFee({
    records,
    sourceId: "arzinja",
    executionMode: "ORDER_BOOK",
    currentTierLabel: "Level 1",
    nowMs: NOW
  });
  assert.equal(arz.ok, true);
  if (arz.ok) {
    assert.equal(arz.takerFeeBps, 0);
    assert.equal(arz.makerFeeBps, 0);
  }
  // And the zero is still confined to the order book.
  for (const mode of ["EASY_TRADE", "CONVERT"] as const) {
    const other = selectEffectiveFee({
      records,
      sourceId: "arzinja",
      executionMode: mode,
      currentTierLabel: "Level 1",
      nowMs: NOW
    });
    assert.equal(other.ok, false);
    if (!other.ok) assert.equal(other.miss, "no_evidence_for_mode");
  }
});

/* ── 4. re-running the migration changes nothing ─────────────────────────── */

await test("re-running the migration is a no-op", async () => {
  const before = await listFeeTierEvidence();
  const again = await runMigrations();
  assert.deepEqual(again.applied, [], "nothing was applied a second time");
  assert.ok(again.skipped.includes("0013_shadow_fee_tier_seq.sql"), "0013 was recognised");

  const after = await listFeeTierEvidence();
  assert.equal(after.length, before.length, "the row count did not move");
  assert.deepEqual(
    after.map((r) => `${r.sourceId}:${r.seq}`).sort(),
    before.map((r) => `${r.sourceId}:${r.seq}`).sort(),
    "and neither did a single sequence"
  );

  const status = await migrationStatus();
  assert.deepEqual(status.pending, [], "no migration is left pending");
  assert.ok(status.applied.includes("0013_shadow_fee_tier_seq.sql"));
});

await closeDb();
/*
 * Only this run's own scratch directory is removed. No database outside it —
 * including every preserved damaged directory — is touched.
 */
await rm(scratch, { recursive: true, force: true });

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
