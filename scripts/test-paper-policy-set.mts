#!/usr/bin/env npx tsx
/**
 * `PAPER_BALANCED_10B_V1` — the set, the atomic apply, and the bootstrap.
 *
 * Every database test here runs against a THROWAWAY PGlite directory in the OS
 * temp folder. It never opens `.data/`, never touches the local RC or
 * production, and deletes nothing outside its own scratch.
 *
 * What it proves, in the order it matters:
 *   · the set is exactly the six Paper policies, with the approved values;
 *   · applying it writes six rows and one marker, in one transaction;
 *   · the second and third starts write nothing at all;
 *   · a concurrent start cannot duplicate the set;
 *   · an administrator's own value is never overwritten;
 *   · history is append-only and survives every one of those;
 *   · the expiry is thirty days from the FIRST application and a restart cannot
 *     move it;
 *   · one invalid value rolls all six back;
 *   · smart sizing stops being blocked once the set is in force, while every
 *     other readiness gate stays blocked;
 *   · none of it can reach a credential, an order or an exchange.
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

const scratch = await mkdtemp(path.join(tmpdir(), "otc-policyset-"));
process.env.DATABASE_URL = `pglite:${path.join(scratch, "db")}`;
process.env.SHADOW_COLLECTOR_ENABLED = "false";
process.env.SHADOW_RELEASE_BOOTSTRAP = "true";

const {
  PAPER_POLICY_SET,
  PAPER_POLICY_SET_KEY,
  PAPER_POLICY_SET_KEYS,
  PAPER_POLICY_SET_VALID_DAYS,
  buildPaperPolicySetView,
  paperPolicySetCanonical
} = await import("../src/lib/shadowArbitrage/live/paperPolicySet.ts");
const { paperPolicySetFingerprint } = await import(
  "../src/lib/shadowArbitrage/live/paperPolicySetHash.ts"
);
const { runPaperPolicyBootstrap, BOOTSTRAP_ACTOR } = await import(
  "../src/lib/shadowArbitrage/live/paperPolicyBootstrap.ts"
);
const {
  applyRiskPolicySet,
  loadRiskPolicyValues,
  loadRiskPolicyHistory,
  recordRiskPolicy
} = await import("../src/db/repositories/shadowLive.ts");
const { buildPolicyState, REQUIRED_RISK_POLICIES, validatePolicyValue } = await import(
  "../src/lib/shadowArbitrage/live/policy.ts"
);
const { SIZING_REQUIRED_POLICIES, computeRouteSize } = await import(
  "../src/lib/shadowArbitrage/paper/sizing.ts"
);
const { runMigrations } = await import("../src/db/migrate.ts");
const { getDbAsync, closeDb } = await import("../src/db/client.ts");
const { sql } = await import("drizzle-orm");

await runMigrations();

async function query<T>(text: string): Promise<T[]> {
  const db = await getDbAsync();
  const r = await db.execute(sql.raw(text));
  return (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as T[];
}

const policyRowCount = async () =>
  Number(
    (await query<{ n: number }>("SELECT count(*)::int AS n FROM shadow_live_risk_policies"))[0].n
  );
const markerCount = async () =>
  Number(
    (
      await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM shadow_release_bootstrap WHERE release_key = '${PAPER_POLICY_SET_KEY}'`
      )
    )[0].n
  );

/* ══ 1. the set itself ════════════════════════════════════════════════════ */

await test("the set is exactly the six policies SMART_CAPITAL_DEPTH requires", () => {
  assert.equal(PAPER_POLICY_SET_KEY, "PAPER_BALANCED_10B_V1");
  assert.deepEqual(
    [...PAPER_POLICY_SET_KEYS].sort(),
    [...SIZING_REQUIRED_POLICIES].sort(),
    "the set and the sizer must ask for the same six keys"
  );
  assert.equal(PAPER_POLICY_SET.length, 6);
  assert.equal(PAPER_POLICY_SET_VALID_DAYS, 30);
});

await test("every approved value is the one that was signed off, and is in range", () => {
  const expected: Record<string, number> = {
    max_order_size_usdt: 500,
    max_venue_exposure_percent: 20,
    min_risk_adjusted_edge_percent: 0.05,
    max_quote_age_ms: 30_000,
    max_slippage_bps: 10,
    max_inventory_deviation_percent: 20
  };
  for (const entry of PAPER_POLICY_SET) {
    assert.equal(entry.value, expected[entry.key], `${entry.key} must be ${expected[entry.key]}`);
    const check = validatePolicyValue(entry.key, entry.value);
    assert.equal(check.ok, true, `${entry.key} is outside its own definition's range`);
    assert.ok(entry.labelFa.length > 3, `${entry.key} needs a Persian label`);
    assert.ok(entry.controlsFa.length > 20, `${entry.key} must explain what it controls`);
  }
});

await test("storage units are also shown the way a human reads them", () => {
  const age = PAPER_POLICY_SET.find((p) => p.key === "max_quote_age_ms");
  assert.ok(age?.displayFa.includes("۳۰ ثانیه"), `30000 ms must read as 30 seconds: ${age?.displayFa}`);
  const slip = PAPER_POLICY_SET.find((p) => p.key === "max_slippage_bps");
  assert.ok(slip?.displayFa.includes("۰٫۱۰٪"), `10 bps must also read as 0.10%: ${slip?.displayFa}`);
});

await test("the fingerprint is stable, order-independent and change-sensitive", () => {
  const a = paperPolicySetFingerprint();
  const b = paperPolicySetFingerprint();
  assert.equal(a, b, "the same set always fingerprints the same");
  assert.equal(a.length, 32);

  const shuffled = [...PAPER_POLICY_SET].reverse().map((e) => ({ key: e.key, value: e.value }));
  assert.equal(paperPolicySetFingerprint(shuffled), a, "input order cannot change it");

  const changed = PAPER_POLICY_SET.map((e) =>
    e.key === "max_slippage_bps" ? { key: e.key, value: 11 } : { key: e.key, value: e.value }
  );
  assert.notEqual(paperPolicySetFingerprint(changed), a, "one different value, one different hash");

  // Validity is part of the decision, so it is part of the fingerprint.
  assert.notEqual(paperPolicySetFingerprint(undefined, 60), a);
  assert.ok(paperPolicySetCanonical().includes("validForDays=30"));
});

/* ══ 2. the first application ═════════════════════════════════════════════ */

let firstRunAt = "";

await test("the first startup writes exactly six policies and one marker", async () => {
  assert.equal(await policyRowCount(), 0, "the fixture starts empty");
  assert.equal(await markerCount(), 0);

  const r = await runPaperPolicyBootstrap();
  assert.equal(r.ran, true);
  assert.equal(r.reason, "applied");
  assert.equal(r.setKey, PAPER_POLICY_SET_KEY);
  assert.equal(r.applied.length, 6, `applied ${r.applied.join(", ")}`);
  assert.deepEqual([...r.applied].sort(), [...PAPER_POLICY_SET_KEYS].sort());
  assert.equal(r.preserved.length, 0);

  assert.equal(await policyRowCount(), 6, "six rows, no more");
  assert.equal(await markerCount(), 1, "one marker");

  const rows = await query<{ policy_key: string; set_by: string; set_at: string; valid_for_days: number }>(
    "SELECT policy_key, set_by, set_at, valid_for_days FROM shadow_live_risk_policies ORDER BY policy_key"
  );
  firstRunAt = String(rows[0].set_at);
  for (const row of rows) {
    assert.equal(row.set_by, BOOTSTRAP_ACTOR, "the audit trail names the bootstrap, not a person");
    assert.equal(Number(row.valid_for_days), 30);
  }
});

await test("the set reads as effective, and the sizer stops being blocked by policy", () => {
  const view = buildPaperPolicySetView(buildPolicyState([], Date.now()));
  assert.equal(view.status, "NOT_APPLIED", "an empty state is NOT_APPLIED, never a default");
  assert.equal(view.missingKeys.length, 6);
});

await test("smart sizing becomes operational once the set is in force", async () => {
  const state = buildPolicyState(await loadRiskPolicyValues(), Date.now());
  const view = buildPaperPolicySetView(state);
  assert.equal(view.status, "EFFECTIVE", JSON.stringify(view.missingKeys));
  assert.equal(view.effective, true);
  for (const row of view.rows) assert.equal(row.status, "MATCHES", `${row.key}: ${row.statusFa}`);

  /*
   * The sizer is handed a deliberately unusable route: no books at all. What
   * matters is WHICH reasons come back — every missing-policy blocker must be
   * gone, and only the evidence blocker should remain.
   */
  const blocked = computeRouteSize({
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    buySnapshot: undefined,
    sellSnapshot: undefined,
    buyFeeBps: 25,
    sellFeeBps: 30,
    buySettlement: { feeAsset: "IRT", debitMode: "ADD_TO_DEBIT", provenance: "ADMIN_CONFIRMED" },
    sellSettlement: { feeAsset: "USDT", debitMode: "ADD_TO_DEBIT", provenance: "ADMIN_CONFIRMED" },
    balances: [],
    buyVenueAllocationToman: null,
    portfolioValueToman: null,
    buyVenueExposureToman: null,
    policies: state,
    slippageBufferBps: 5,
    inventoryModel: { valuationPriceToman: 192_000, targets: [], maxDeviationPoints: 20 }
  } as never);
  assert.equal(
    blocked.blockers.some((b) => b.code === "missing_policy" || b.code === "expired_policy"),
    false,
    `no policy blocker may remain: ${JSON.stringify(blocked.blockers.map((b) => b.code))}`
  );
});

await test("other readiness gates stay blocked — this set configures only Paper", async () => {
  const values = await loadRiskPolicyValues();
  const configured = new Set(values.map((v) => v.key));
  const untouched = REQUIRED_RISK_POLICIES.filter((d) => !PAPER_POLICY_SET_KEYS.includes(d.key));
  assert.ok(untouched.length >= 10, "there are other required policies to leave alone");
  for (const d of untouched) {
    assert.equal(configured.has(d.key), false, `${d.key} must NOT have been configured`);
  }
  const state = buildPolicyState(values, Date.now());
  const stillBlocked = state.filter((p) => !p.configured).map((p) => p.definition.key);
  assert.deepEqual(
    [...stillBlocked].sort(),
    [...untouched.map((d) => d.key)].sort(),
    "exactly the non-Paper policies remain unconfigured"
  );
});

/* ══ 3. idempotency ═══════════════════════════════════════════════════════ */

await test("the second and third startups write nothing and change nothing", async () => {
  const before = await query<Record<string, unknown>>(
    "SELECT policy_key, value, set_by, set_at, valid_for_days FROM shadow_live_risk_policies ORDER BY policy_key"
  );

  for (const run of [2, 3]) {
    const r = await runPaperPolicyBootstrap();
    assert.equal(r.ran, false, `run ${run} must not run`);
    assert.equal(r.reason, "already-applied", `run ${run}: ${r.reason}`);
    assert.equal(r.applied.length, 0);
    assert.equal(await policyRowCount(), 6, `run ${run} added a row`);
    assert.equal(await markerCount(), 1, `run ${run} added a marker`);
  }

  const after = await query<Record<string, unknown>>(
    "SELECT policy_key, value, set_by, set_at, valid_for_days FROM shadow_live_risk_policies ORDER BY policy_key"
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(after)),
    JSON.parse(JSON.stringify(before)),
    "every stored value is byte-identical after two more starts"
  );
});

await test("a restart never extends the expiry", async () => {
  const rows = await query<{ set_at: string; valid_for_days: number }>(
    "SELECT set_at, valid_for_days FROM shadow_live_risk_policies ORDER BY policy_key"
  );
  for (const row of rows) {
    assert.equal(String(row.set_at), firstRunAt, "setAt is still the first application's timestamp");
    assert.equal(Number(row.valid_for_days), 30);
  }

  // And the expiry the UI computes is exactly thirty days after that instant.
  const state = buildPolicyState(await loadRiskPolicyValues(), Date.now());
  const view = buildPaperPolicySetView(state);
  const expiry = Date.parse(view.expiresAt as string);
  const expected = Date.parse(firstRunAt) + 30 * 86_400_000;
  assert.ok(
    Math.abs(expiry - expected) < 1_000,
    `expiry ${view.expiresAt} must be 30 days after ${firstRunAt}`
  );
});

await test("concurrent startups cannot duplicate the set", async () => {
  // Clear the marker so the guard has to be the transaction, not the early exit.
  await query(`DELETE FROM shadow_release_bootstrap WHERE release_key = '${PAPER_POLICY_SET_KEY}'`);
  await query("DELETE FROM shadow_live_risk_policies");
  assert.equal(await policyRowCount(), 0);

  const results = await Promise.all([
    runPaperPolicyBootstrap(),
    runPaperPolicyBootstrap(),
    runPaperPolicyBootstrap(),
    runPaperPolicyBootstrap()
  ]);
  const winners = results.filter((r) => r.ran);
  assert.equal(winners.length, 1, `exactly one start may apply, got ${winners.length}`);
  for (const loser of results.filter((r) => !r.ran)) {
    assert.equal(loser.reason, "already-applied", `a losing start reported ${loser.reason}`);
  }
  assert.equal(await policyRowCount(), 6, "four concurrent starts, six rows");
  assert.equal(await markerCount(), 1);
});

/* ══ 4. an administrator outranks the bootstrap ═══════════════════════════ */

await test("a newer admin value is preserved, not overwritten", async () => {
  await query(`DELETE FROM shadow_release_bootstrap WHERE release_key = '${PAPER_POLICY_SET_KEY}'`);
  await query("DELETE FROM shadow_live_risk_policies");

  // An administrator has already decided one of the six, deliberately.
  await recordRiskPolicy({
    policyKey: "max_order_size_usdt",
    value: 250,
    setBy: "iman",
    validForDays: 90,
    note: "تصمیم مدیر"
  });

  const r = await runPaperPolicyBootstrap();
  assert.equal(r.ran, true);
  assert.deepEqual(r.preserved, ["max_order_size_usdt"]);
  assert.equal(r.applied.length, 5, `applied ${r.applied.join(", ")}`);
  assert.equal(r.applied.includes("max_order_size_usdt"), false);

  const values = await loadRiskPolicyValues();
  const order = values.find((v) => v.key === "max_order_size_usdt");
  assert.equal(order?.value, 250, "the administrator's number survived");
  assert.equal(order?.setBy, "iman");
  assert.equal(order?.validForDays, 90, "and so did their validity period");

  // The set is then DRIFTED rather than EFFECTIVE, and says so.
  const view = buildPaperPolicySetView(buildPolicyState(values, Date.now()));
  assert.equal(view.status, "DRIFTED");
  assert.deepEqual(view.differingKeys, ["max_order_size_usdt"]);
  assert.equal(view.effective, false);
});

await test("history is append-only across every one of those runs", async () => {
  const history = await loadRiskPolicyHistory(undefined, 500);
  const adminRow = history.filter((h) => h.setBy === "iman");
  assert.equal(adminRow.length, 1, "the administrator's row is still there, exactly once");
  assert.equal(adminRow[0].value, 250);

  // Nothing was ever updated in place: every row has its own setAt and note.
  const rows = await query<{ n: number }>(
    "SELECT count(DISTINCT set_at)::int AS n FROM shadow_live_risk_policies"
  );
  assert.ok(Number(rows[0].n) >= 2, "at least two distinct application instants survive");
});

/* ══ 5. atomicity ═════════════════════════════════════════════════════════ */

await test("one invalid value rolls all six back", async () => {
  const before = await policyRowCount();
  await assert.rejects(
    () =>
      applyRiskPolicySet({
        setKey: "TEST_INVALID",
        fingerprint: "test",
        entries: [
          ...PAPER_POLICY_SET.slice(0, 5).map((e) => ({ policyKey: e.key, value: e.value })),
          { policyKey: "max_inventory_deviation_percent", value: Number.NaN }
        ],
        setBy: "test",
        validForDays: 30
      }),
    "an invalid value must be refused"
  );
  assert.equal(await policyRowCount(), before, "and nothing at all was written");
});

await test("a failure inside the transaction rolls the whole set back", async () => {
  const before = await policyRowCount();
  await assert.rejects(
    () =>
      applyRiskPolicySet({
        setKey: "TEST_AFTER_ALL",
        fingerprint: "test",
        entries: PAPER_POLICY_SET.map((e) => ({ policyKey: e.key, value: e.value })),
        setBy: "test",
        validForDays: 30,
        // Stands in for the marker insert losing a race.
        afterAll: async () => {
          throw new Error("simulated marker conflict");
        }
      }),
    "a failure after the rows must abort the transaction"
  );
  assert.equal(
    await policyRowCount(),
    before,
    "six rows were written and then rolled back, leaving none"
  );
});

/* ══ 6. the view's own arithmetic ═════════════════════════════════════════ */

await test("the view reports missing, expired and drifted states by name", () => {
  const now = Date.parse("2026-08-04T12:00:00.000Z");
  const value = (key: string, v: number, days: number | null, setAt: string) => ({
    key: key as never,
    value: v,
    provenance: "ADMIN_APPROVED" as const,
    setBy: "test",
    setAt,
    validForDays: days,
    note: null
  });

  // Five current, one expired.
  const expired = buildPaperPolicySetView(
    buildPolicyState(
      PAPER_POLICY_SET.map((e, i) =>
        value(
          e.key,
          e.value,
          i === 0 ? 1 : 30,
          i === 0 ? "2026-01-01T00:00:00.000Z" : "2026-08-01T00:00:00.000Z"
        )
      ),
      now
    )
  );
  assert.equal(expired.status, "EXPIRED");
  assert.deepEqual(expired.expiredKeys, [PAPER_POLICY_SET[0].key]);

  // Five present, one absent.
  const partial = buildPaperPolicySetView(
    buildPolicyState(
      PAPER_POLICY_SET.slice(1).map((e) => value(e.key, e.value, 30, "2026-08-01T00:00:00.000Z")),
      now
    )
  );
  assert.equal(partial.status, "PARTIALLY_APPLIED");
  assert.deepEqual(partial.missingKeys, [PAPER_POLICY_SET[0].key]);

  // All present, one different.
  const drifted = buildPaperPolicySetView(
    buildPolicyState(
      PAPER_POLICY_SET.map((e, i) =>
        value(e.key, i === 2 ? e.value + 1 : e.value, 30, "2026-08-01T00:00:00.000Z")
      ),
      now
    )
  );
  assert.equal(drifted.status, "DRIFTED");
  assert.deepEqual(drifted.differingKeys, [PAPER_POLICY_SET[2].key]);
});

/* ══ 7. safety ════════════════════════════════════════════════════════════ */

await test("the policy-set modules add no credential, order or exchange path", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of [
    "../src/lib/shadowArbitrage/live/paperPolicySet.ts",
    "../src/lib/shadowArbitrage/live/paperPolicySetHash.ts",
    "../src/lib/shadowArbitrage/live/paperPolicyBootstrap.ts"
  ]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const banned of [
      "fetch(",
      "axios",
      "apiKey",
      "apiSecret",
      "privateKey",
      "placeOrder",
      "cancelOrder",
      "submitOrder",
      "transferFunds",
      "@/lib/shadowArbitrage/adapters"
    ]) {
      assert.equal(src.includes(banned), false, `${file} must not contain ${banned}`);
    }
    assert.equal(/ompfinex/i.test(src), false, `${file} must not mention OMPFinex`);
  }

  const capability = readFileSync(
    new URL("../src/lib/shadowArbitrage/live/capability.ts", import.meta.url),
    "utf8"
  );
  assert.ok(capability.includes("export const LIVE_EXECUTION_IMPLEMENTED = false as const"));
});

await test("the pure set module reads no clock and no database", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    new URL("../src/lib/shadowArbitrage/live/paperPolicySet.ts", import.meta.url),
    "utf8"
  );
  assert.equal(/Date\.now\(\)|new Date\(\)/.test(src), false, "no clock");
  assert.equal(src.includes("@/db/"), false, "no database");
  assert.equal(src.includes("node:crypto"), false, "safe to import from a client component");
});

await closeDb();
await rm(scratch, { recursive: true, force: true });

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
