#!/usr/bin/env npx tsx
/**
 * Prove migration 0015 on a database that predates it.
 *
 * A migration that has only ever run against a fresh database has not been
 * tested. `0015` adds thirteen columns to `shadow_paper_ledger`, and the case
 * that matters is an EXISTING table holding real fills: every one of those rows
 * must come back byte-identical, with the new columns null and nothing
 * rewritten.
 *
 * So this builds a genuine pre-0015 database (migrations 0001–0014 only, then
 * a session, balances and two ledger rows written through raw SQL against the
 * 0014 shape), CLONES that directory, and migrates the clone. It then reads
 * every old value back, re-runs the migration to prove idempotency, and writes
 * a new fill carrying the sizing evidence to prove the columns are usable.
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
const scratch = await mkdtemp(path.join(tmpdir(), "otc-mig0015-"));
const preDir = path.join(scratch, "pre0015");
const cloneDir = path.join(scratch, "clone");

const MIGRATION = "0015_shadow_smart_sizing.sql";

/** The thirteen columns 0015 introduces, in the order the file adds them. */
const NEW_COLUMNS = [
  "sizing_policy",
  "sizing_reason",
  "limiting_side",
  "limiting_source_id",
  "limiting_usable_usdt_micros",
  "capital_cap_usdt_micros",
  "depth_cap_usdt_micros",
  "binding_constraint",
  "risk_adjusted_return_bps",
  "selected_percent_of_usable",
  "inventory_impact_points",
  "next_larger_size_usdt",
  "next_larger_rejection_code",
  "next_larger_rejection_reason",
  "next_larger_marginal_pnl_toman"
];

/*
 * A working tree carrying only the migrations that existed before 0015. The
 * runner resolves `drizzle/` from `process.cwd()`, so pointing the cwd at this
 * directory is what pins the database to the earlier schema.
 */
const legacyRoot = path.join(scratch, "legacy-tree");
await mkdir(path.join(legacyRoot, "drizzle"), { recursive: true });
const allMigrations = (await readdir(path.join(repoRoot, "drizzle")))
  .filter((f) => f.endsWith(".sql"))
  .sort();
for (const f of allMigrations.filter((f) => f < "0015")) {
  await writeFile(
    path.join(legacyRoot, "drizzle", f),
    await readFile(path.join(repoRoot, "drizzle", f), "utf8")
  );
}

process.env.DATABASE_URL = `pglite:${preDir}`;
process.env.SHADOW_COLLECTOR_ENABLED = "false";

const { closeDb, execRaw, getDbAsync } = await import("../src/db/client.ts");
const { sql } = await import("drizzle-orm");

/** Read rows back, whichever shape the driver returns them in. */
async function query<T>(text: string): Promise<T[]> {
  const db = await getDbAsync();
  const r = await db.execute(sql.raw(text));
  return (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as T[];
}
const { runMigrations, migrationStatus } = await import("../src/db/migrate.ts");

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";

/** Two fills, exactly as an installation that predates 0015 would hold them. */
const LEGACY_FILLS = [
  {
    id: "33333333-3333-4333-8333-333333333333",
    lifecycleId: "lc-legacy-a",
    routeKey: "nobitex->wallex@25",
    sizeUsdt: "25.0000",
    riskAdjustedPnlToman: 41_250
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    lifecycleId: "lc-legacy-b",
    routeKey: "bitpin->tabdeal@20",
    sizeUsdt: "20.0000",
    riskAdjustedPnlToman: 18_900
  }
];

/* ── build the pre-0015 database ─────────────────────────────────────────── */
process.chdir(legacyRoot);
await runMigrations();

const preStatus = await migrationStatus();
await execRaw(
  `INSERT INTO shadow_paper_sessions
     (id, name, status, mode, total_capital_toman, valuation_price_toman, opening_allocations,
      created_by, created_at)
   VALUES ('${SESSION_ID}', 'pre-0015', 'RUNNING', 'PAPER', 10000000000, 192000, '[]'::jsonb,
           'migration-test', now())`
);
for (const f of LEGACY_FILLS) {
  await execRaw(
    `INSERT INTO shadow_paper_ledger
       (id, session_id, run_id, idempotency_key, lifecycle_id, route_key, outcome, event_type,
        buy_source_id, sell_source_id, size_usdt, risk_adjusted_pnl_toman, occurred_at, created_at)
     VALUES ('${f.id}', '${SESSION_ID}', '${RUN_ID}', '${SESSION_ID}|${f.lifecycleId}',
             '${f.lifecycleId}', '${f.routeKey}', 'FILLED', 'FILLED',
             'nobitex', 'wallex', ${f.sizeUsdt}, ${f.riskAdjustedPnlToman}, now(), now())`
  );
}
await closeDb();
process.chdir(repoRoot);

await test("the fixture really predates 0015", async () => {
  assert.equal(
    preStatus.applied.includes(MIGRATION),
    false,
    "the pre-migration database must not already carry 0015"
  );
  assert.ok(preStatus.applied.length >= 14, "every earlier migration was applied");
});

/* ── clone, then migrate the clone ───────────────────────────────────────── */
await cp(preDir, cloneDir, { recursive: true });
process.env.DATABASE_URL = `pglite:${cloneDir}`;

await test("the migration file is purely additive", async () => {
  const text = await readFile(path.join(repoRoot, "drizzle", MIGRATION), "utf8");
  const statements = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("--"));

  for (const line of statements) {
    assert.ok(
      /^ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS /i.test(line),
      `only additive column adds are allowed, found: ${line}`
    );
    // A NOT NULL or a DEFAULT would rewrite every existing row.
    assert.equal(/NOT NULL/i.test(line), false, `a NOT NULL rewrites rows: ${line}`);
    assert.equal(/DEFAULT/i.test(line), false, `a DEFAULT rewrites rows: ${line}`);
  }
  // Comments are prose, not SQL — the scan below must not trip on the word
  // "renamed" in a sentence explaining that nothing is renamed.
  const executable = statements.join("\n").toUpperCase();
  for (const forbidden of ["DROP ", "DELETE ", "TRUNCATE", "UPDATE ", "ALTER COLUMN", "RENAME"]) {
    assert.equal(
      executable.includes(forbidden),
      false,
      `${MIGRATION} must not contain ${forbidden}`
    );
  }
  // Every column the schema declares is actually created by the file.
  for (const column of NEW_COLUMNS) {
    assert.ok(text.includes(`ADD COLUMN IF NOT EXISTS ${column} `), `${column} is missing`);
  }
});

let afterStatus: Awaited<ReturnType<typeof migrationStatus>>;

await test("migrating a database with existing fills applies 0015 and nothing else", async () => {
  await runMigrations();
  afterStatus = await migrationStatus();
  assert.ok(afterStatus.applied.includes(MIGRATION), "0015 is applied");
  assert.equal(afterStatus.pending.length, 0, "nothing is left pending");
  assert.deepEqual(
    afterStatus.applied.filter((m) => !preStatus.applied.includes(m)),
    [MIGRATION],
    "exactly one new migration ran"
  );
});

await test("every pre-existing fill survives byte-identical, with the new columns null", async () => {
  const rows = await query<Record<string, unknown>>(
    `SELECT id, lifecycle_id, route_key, outcome, size_usdt, risk_adjusted_pnl_toman,
            ${NEW_COLUMNS.join(", ")}
       FROM shadow_paper_ledger ORDER BY lifecycle_id`
  );

  assert.equal(rows.length, LEGACY_FILLS.length, "no row was added or lost");
  for (let i = 0; i < LEGACY_FILLS.length; i += 1) {
    const expected = LEGACY_FILLS[i];
    const row = rows[i];
    assert.equal(row.id, expected.id);
    assert.equal(row.lifecycle_id, expected.lifecycleId);
    assert.equal(row.route_key, expected.routeKey);
    assert.equal(row.outcome, "FILLED");
    assert.equal(String(row.size_usdt), expected.sizeUsdt);
    assert.equal(Number(row.risk_adjusted_pnl_toman), expected.riskAdjustedPnlToman);
    // A null means "not recorded", which is the truth for a pre-0015 fill.
    for (const column of NEW_COLUMNS) {
      assert.equal(row[column], null, `${column} must be null on a legacy row`);
    }
  }
});

await test("the migration is idempotent across a re-run and a restart", async () => {
  await runMigrations();
  const twice = await migrationStatus();
  assert.deepEqual(twice.applied, afterStatus.applied, "a second run changes nothing");

  await closeDb();
  // A fresh process would reopen the same directory and find the same state.
  const reopened = await migrationStatus();
  assert.ok(reopened.applied.includes(MIGRATION));
  const rows = await query<{ n: number }>("SELECT count(*)::int AS n FROM shadow_paper_ledger");
  assert.equal(Number(rows[0].n), LEGACY_FILLS.length, "the rows are still there after a restart");
});

await test("a new fill can carry the sizing evidence the columns exist for", async () => {
  await execRaw(
    `INSERT INTO shadow_paper_ledger
       (id, session_id, lifecycle_id, route_key, outcome, event_type,
        buy_source_id, sell_source_id, size_usdt, risk_adjusted_pnl_toman,
        sizing_policy, sizing_reason, limiting_side, limiting_source_id,
        limiting_usable_usdt_micros, capital_cap_usdt_micros, depth_cap_usdt_micros,
        binding_constraint, risk_adjusted_return_bps, selected_percent_of_usable,
        inventory_impact_points, next_larger_size_usdt, next_larger_rejection_code,
        next_larger_rejection_reason, next_larger_marginal_pnl_toman,
        occurred_at, created_at)
     VALUES ('55555555-5555-4555-8555-555555555555', '${SESSION_ID}', 'lc-smart', 'nobitex->wallex',
             'FILLED', 'FILLED', 'nobitex', 'wallex', 231.0000, 52340,
             'SMART_CAPITAL_DEPTH', 'بیشترین سود تعدیل‌شده', 'sell', 'wallex',
             2882000000, 288200000, 500000000, 'capital_cap', 92.50, 8.00,
             1.2345, 288.2000, 'negative_marginal_profitability', 'کاهش سود', -1200,
             now(), now())`
  );

  const rows = await query<Record<string, unknown>>(
    `SELECT sizing_policy, limiting_side, capital_cap_usdt_micros, risk_adjusted_return_bps,
            inventory_impact_points, next_larger_rejection_code, next_larger_marginal_pnl_toman
       FROM shadow_paper_ledger WHERE lifecycle_id = 'lc-smart'`
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].sizing_policy, "SMART_CAPITAL_DEPTH");
  assert.equal(rows[0].limiting_side, "sell");
  assert.equal(Number(rows[0].capital_cap_usdt_micros), 288_200_000);
  assert.equal(Number(rows[0].risk_adjusted_return_bps), 92.5);
  assert.equal(Number(rows[0].inventory_impact_points), 1.2345);
  assert.equal(rows[0].next_larger_rejection_code, "negative_marginal_profitability");
  assert.equal(Number(rows[0].next_larger_marginal_pnl_toman), -1_200);

  // And the legacy rows are STILL untouched by the new write.
  const legacy = await query<Record<string, unknown>>(
    "SELECT sizing_policy FROM shadow_paper_ledger WHERE lifecycle_id = 'lc-legacy-a'"
  );
  assert.equal(legacy[0].sizing_policy, null);
});

await closeDb();
await rm(scratch, { recursive: true, force: true });

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
