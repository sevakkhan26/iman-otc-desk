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

/* ── deterministic ordering ──────────────────────────────────────────────── */

await test("two confirmations appended in the same instant order by append, not by chance", async () => {
  /*
   * The failure this pins: a bulk import stamps ONE confirmedAt across every
   * venue, and two rows written back to back can also share createdAt at
   * millisecond resolution. With only those two keys the ordering fell through
   * to comparing random UUIDs, so the effective fee could differ between two
   * reads of identical data. The append sequence is the only monotonic fact.
   */
  const stamp = "2026-08-04T00:00:00.000Z";
  const first = await recordFeeTierEvidence(
    base({ sourceId: "ramzinex", evidenceKey: "same-1", takerFeeBps: 20, confirmedAt: stamp })
  );
  const second = await recordFeeTierEvidence(
    base({ sourceId: "ramzinex", evidenceKey: "same-2", takerFeeBps: 21, confirmedAt: stamp })
  );
  assert.equal(first.confirmedAt, second.confirmedAt, "the two share a confirmation instant");
  assert.ok(second.seq > first.seq, "but the later append has the higher sequence");

  // Resolving repeatedly — and over a shuffled record list — never wavers.
  const all = await records();
  for (const order of [all, [...all].reverse(), [...all].slice().sort((a, b) => a.id.localeCompare(b.id))]) {
    const pick = selectEffectiveFee({
      records: order,
      sourceId: "ramzinex",
      executionMode: "ORDER_BOOK",
      currentTierLabel: "Base",
      nowMs: NOW
    });
    assert.equal(pick.ok, true);
    if (pick.ok) assert.equal(pick.takerFeeBps, 21, "the last append wins, whatever the row order");
  }
});

/* ── the approved import, and the runtime that consumes it ───────────────── */

const {
  APPROVED_FEE_TIERS,
  EVIDENCE_KEY: APPROVED_KEY,
  CONFIRMED_AT: APPROVED_AT,
  CONFIRMED_BY: APPROVED_BY,
  PROVENANCE: APPROVED_PROVENANCE,
  VALID_FOR_DAYS: APPROVED_VALID_DAYS
} = await import("./approvedFeeTiers.mts");

const { buildEffectiveFees, executionModeFor, ZERO_FEE_ORDER_BOOK_ONLY_FA, QUOTE_EXECUTABLE_NO_TIER_FA, NO_EVIDENCE_FOR_REFERENCE_MODE_FA } =
  await import("../src/lib/shadowArbitrage/effectiveFees.ts");
const { buildAllReadiness, venueUsableForNetProfit } = await import(
  "../src/lib/shadowArbitrage/accounts.ts"
);
const { computeRouteEconomics } = await import("../src/lib/shadowArbitrage/fees.ts");
const { buildVenueRows } = await import("../src/components/shadowArbitrage/sourcesModel.ts");

/** What the administrator approved, restated here independently of the source. */
const EXPECTED_APPROVALS: Array<[string, string, string | null, number, number]> = [
  ["nobitex", "ORDER_BOOK", "Base", 25, 25],
  ["wallex", "ORDER_BOOK", "Base Level 1", 25, 30],
  ["tabdeal", "ORDER_BOOK", "VIP1", 24, 28],
  ["bitpin", "ORDER_BOOK", "Base Level 1", 30, 35],
  ["abantether", "OTC_QUOTE", null, 30, 30],
  ["ramzinex", "ORDER_BOOK", "Base", 20, 25],
  ["bit24", "ORDER_BOOK", "VIP0", 20, 20],
  ["tetherland", "ORDER_BOOK", "Bronze", 45, 45],
  ["arzinja", "ORDER_BOOK", "Level 1", 0, 0]
];

await test("the approved import is nine records over nine unique venue+mode pairs", () => {
  assert.equal(APPROVED_FEE_TIERS.length, 9);
  const pairs = APPROVED_FEE_TIERS.map((t) => `${t.sourceId}:${t.executionMode}`);
  assert.equal(new Set(pairs).size, 9, "no venue+mode pair appears twice");
  assert.equal(
    new Set(APPROVED_FEE_TIERS.map((t) => t.sourceId)).size,
    9,
    "and no venue appears twice either"
  );
  // Eight order books plus one dealer quote — the shape of the desk.
  assert.equal(APPROVED_FEE_TIERS.filter((t) => t.executionMode === "ORDER_BOOK").length, 8);
  assert.equal(APPROVED_FEE_TIERS.filter((t) => t.executionMode === "OTC_QUOTE").length, 1);
  for (const [sourceId, mode, tier, maker, taker] of EXPECTED_APPROVALS) {
    const t = APPROVED_FEE_TIERS.find((x) => x.sourceId === sourceId);
    assert.ok(t, `${sourceId} is present`);
    assert.equal(t!.executionMode, mode, `${sourceId} mode`);
    assert.equal(t!.tierLabel, tier, `${sourceId} tier`);
    assert.equal(t!.makerFeeBps, maker, `${sourceId} maker`);
    assert.equal(t!.takerFeeBps, taker, `${sourceId} taker`);
  }
  // The one venue whose evidence names no tier stays null, never "Base".
  assert.equal(APPROVED_FEE_TIERS.find((t) => t.sourceId === "abantether")!.tierLabel, null);
  // Not one Easy Trade or Convert rate was approved.
  assert.equal(
    APPROVED_FEE_TIERS.some((t) => t.executionMode === "EASY_TRADE" || t.executionMode === "CONVERT"),
    false
  );
});

await test("each venue's execution mode comes from the market it actually trades", () => {
  for (const [sourceId, mode] of EXPECTED_APPROVALS) {
    assert.equal(
      executionModeFor(sourceId as never),
      mode,
      `${sourceId} is matched on the mode the engine walks`
    );
  }
});

async function importApproved() {
  for (const t of APPROVED_FEE_TIERS) {
    await recordFeeTierEvidence({
      sourceId: t.sourceId,
      executionMode: t.executionMode,
      tierLabel: t.tierLabel,
      makerFeeBps: t.makerFeeBps,
      takerFeeBps: t.takerFeeBps,
      provenance: APPROVED_PROVENANCE,
      evidenceKey: APPROVED_KEY,
      confirmedBy: APPROVED_BY,
      confirmedAt: APPROVED_AT,
      validForDays: APPROVED_VALID_DAYS,
      sourceUrl: null,
      note: t.note ?? null
    });
  }
  return (await records()).filter((r) => r.evidenceKey === APPROVED_KEY);
}

await test("importing the approved tiers twice still leaves nine rows", async () => {
  const first = await importApproved();
  assert.equal(first.length, 9, "nine rows after the first import");
  const second = await importApproved();
  assert.equal(second.length, 9, "and nine after the second — the import is idempotent");
  assert.equal(
    new Set(second.map((r) => `${r.sourceId}:${r.executionMode}`)).size,
    9,
    "one row per venue+mode, no duplicate"
  );
});

/** Tier in force per venue, as the append-only confirmation table records it. */
function confirmationsFor(tierByVenue: Record<string, string | null>) {
  const out: Record<string, never> = {} as Record<string, never>;
  for (const t of APPROVED_FEE_TIERS) {
    (out as Record<string, unknown>)[t.sourceId] = {
      id: `c-${t.sourceId}`,
      sourceId: t.sourceId,
      takerFeeBps: 999,
      makerFeeBps: 999,
      feeTier: t.sourceId in tierByVenue ? tierByVenue[t.sourceId] : t.tierLabel,
      sourceUrl: null,
      provenance: APPROVED_PROVENANCE,
      validDays: 30,
      referenceMetadata: null,
      evidenceKey: "tier-in-force",
      confirmedBy: APPROVED_BY,
      confirmedAt: APPROVED_AT,
      note: null
    };
  }
  return out;
}

const approvedRecords = async () => (await records()).filter((r) => r.evidenceKey === APPROVED_KEY);

await test("the runtime resolves all nine venues from the tier evidence alone", async () => {
  const eff = buildEffectiveFees({
    records: await approvedRecords(),
    confirmations: confirmationsFor({}),
    nowMs: NOW
  });
  assert.equal(eff.venues.length, 9);
  assert.equal(eff.venues.filter((v) => v.ok).length, 9, "every venue matched");
  assert.equal(eff.blocks.length, 0);
  for (const [sourceId, mode, tier, maker, taker] of EXPECTED_APPROVALS) {
    const v = eff.byVenue[sourceId];
    assert.equal(v.executionMode, mode);
    assert.equal(v.evidenceTierLabel, tier);
    assert.equal(v.makerFeeBps, maker);
    assert.equal(v.takerFeeBps, taker);
    // The applied rate is the evidence's, never the confirmation's 999.
    assert.equal(eff.confirmedFeeBps[sourceId as never], taker, `${sourceId} applied taker`);
  }
});

await test("Arzinja's zero and AbanTether's missing tier are stated, not implied", async () => {
  const eff = buildEffectiveFees({
    records: await approvedRecords(),
    confirmations: confirmationsFor({}),
    nowMs: NOW
  });

  const arz = eff.byVenue.arzinja;
  assert.ok(
    arz.noticesFa.includes(ZERO_FEE_ORDER_BOOK_ONLY_FA),
    "the zero-fee caveat names the order book"
  );
  for (const m of arz.referenceModes) {
    assert.equal(m.hasEvidence, false, `${m.mode} has no evidence`);
    assert.equal(m.labelFa, NO_EVIDENCE_FOR_REFERENCE_MODE_FA);
    assert.equal(m.takerFeeBps, null, "and therefore no rate — zero never leaks into it");
  }

  const aban = eff.byVenue.abantether;
  assert.equal(aban.evidenceTierLabel, null);
  assert.equal(aban.executable, true, "a dealer quote is executable");
  assert.ok(aban.noticesFa.includes(QUOTE_EXECUTABLE_NO_TIER_FA));

  // Every other venue is an order book with a named tier and no such caveat.
  for (const v of eff.venues) {
    if (v.sourceId === "arzinja" || v.sourceId === "abantether") continue;
    assert.equal(v.noticesFa.length, 0, `${v.sourceId} needs no caveat`);
  }
});

await test("a tier change blocks the venue end to end until it is reconfirmed", async () => {
  const all = await approvedRecords();
  const changed = buildEffectiveFees({
    records: all,
    // The account moved to VIP2. Nothing else changed.
    confirmations: confirmationsFor({ tabdeal: "VIP2" }),
    nowMs: NOW
  });
  const v = changed.byVenue.tabdeal;
  assert.equal(v.ok, false);
  assert.equal(v.miss, "tier_mismatch");
  assert.equal(v.takerFeeBps, null, "no rate survives the mismatch");
  assert.equal(changed.confirmedFeeBps.tabdeal, null, "and none reaches route economics");
  assert.ok(v.blockerFa && v.blockerFa.includes("VIP2"), "the reason names both tiers");
  // The other eight are untouched — invalidation is per venue, not global.
  assert.equal(changed.venues.filter((x) => x.ok).length, 8);

  // Reconfirming fees for the new tier restores it, by appending not updating.
  await recordFeeTierEvidence({
    sourceId: "tabdeal",
    executionMode: "ORDER_BOOK",
    tierLabel: "VIP2",
    makerFeeBps: 20,
    takerFeeBps: 24,
    provenance: APPROVED_PROVENANCE,
    evidenceKey: "admin-tier-vip2",
    confirmedBy: APPROVED_BY,
    confirmedAt: "2026-08-05T00:00:00.000Z",
    validForDays: 30,
    sourceUrl: null,
    note: null
  });
  const after = buildEffectiveFees({
    records: (await records()).filter(
      (r) => r.evidenceKey === APPROVED_KEY || r.evidenceKey === "admin-tier-vip2"
    ),
    confirmations: confirmationsFor({ tabdeal: "VIP2" }),
    nowMs: NOW
  });
  assert.equal(after.byVenue.tabdeal.ok, true);
  assert.equal(after.byVenue.tabdeal.takerFeeBps, 24);
  // The superseded record is still on file. Nothing was overwritten.
  assert.ok(
    after.byVenue.tabdeal.history.some((h) => h.tierLabel === "VIP1"),
    "the old confirmation survives in the append-only history"
  );
});

await test("readiness fails closed on a block instead of using the config fee", async () => {
  const eff = buildEffectiveFees({
    records: await approvedRecords(),
    confirmations: confirmationsFor({ bitpin: "VIP9" }),
    nowMs: NOW
  });
  const readiness = buildAllReadiness(eff.overrides, NOW, [], eff.blocks);
  const bitpin = readiness.find((r) => r.sourceId === "bitpin")!;
  assert.equal(bitpin.takerFeeBps, null, "no rate at all — not the compiled-in 30 bps");
  assert.equal(bitpin.feeProvenance, "UNKNOWN");
  assert.equal(venueUsableForNetProfit(bitpin), false, "and it cannot back a net-positive route");
  assert.ok(bitpin.blockingReason && bitpin.blockingReason.includes("پلکان"), "with the exact reason");
  // A matched venue keeps the rate the evidence gave it.
  const nobitex = readiness.find((r) => r.sourceId === "nobitex")!;
  assert.equal(nobitex.takerFeeBps, 25);
  assert.equal(venueUsableForNetProfit(nobitex), true);
});

await test("an explicit null fee blocks a route rather than falling back", () => {
  /*
   * Wallex carries a compiled-in provisional 35 bps, so it is the venue that
   * actually demonstrates the fix: before presence became authoritative, a
   * refused rate fell straight through to that number and the route priced as
   * though the fee were known.
   */
  const priced = computeRouteEconomics({
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    sizeUsdt: 100,
    buyVwapToman: 100_000,
    sellVwapToman: 102_000,
    confirmedFeeBps: { nobitex: 25, wallex: null }
  });
  assert.equal(priced.feeUnknown, true, "a refused fee is unknown, not the config value");
  assert.ok(priced.blocked.includes("fee_unknown"));
  assert.equal(priced.buyFeeToman, 0, "and nothing is charged on a fee we do not know");
  assert.equal(priced.sellFeeBps, 0, "the 35 bps default never appears");

  // A venue the caller never described still falls back — unchanged behaviour.
  const legacy = computeRouteEconomics({
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    sizeUsdt: 100,
    buyVwapToman: 100_000,
    sellVwapToman: 102_000,
    confirmedFeeBps: { nobitex: 25 }
  });
  assert.equal(legacy.feeUnknown, false);
  assert.equal(legacy.sellFeeBps, 35);
});

await test("every runtime consumer of a fee goes through the effective selector", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

  const consumers = [
    "src/lib/shadowArbitrage/collector.ts",
    "src/lib/shadowArbitrage/paper/run.ts",
    "app/api/shadow-arbitrage/accounts/route.ts",
    "app/api/shadow-arbitrage/capital/route.ts",
    "app/api/shadow-arbitrage/paper/route.ts",
    "app/api/shadow-arbitrage/live-readiness/route.ts"
  ];
  for (const rel of consumers) {
    const src = read(rel);
    assert.ok(src.includes("loadEffectiveFees("), `${rel} resolves fees through the selector`);
    assert.equal(
      src.includes("loadLatestFeeConfirmations("),
      false,
      `${rel} no longer reads the raw confirmation table for a rate`
    );
  }

  // Exactly one module may read it — the resolver that matches mode and tier.
  const resolver = read("src/lib/shadowArbitrage/effectiveFees.ts");
  assert.ok(resolver.includes("loadLatestFeeConfirmations()"));
  assert.ok(resolver.includes("selectEffectiveFee("), "and it uses the fail-closed selector");
});

await test("all nine Sources cards carry the server's own resolution", async () => {
  const eff = buildEffectiveFees({
    records: await approvedRecords(),
    confirmations: confirmationsFor({ tetherland: "Silver" }),
    nowMs: NOW
  });
  const readiness = buildAllReadiness(eff.overrides, NOW, [], eff.blocks);
  const rows = buildVenueRows({
    certifications: [],
    health: [],
    snapshots: [],
    venues: readiness as never,
    feeEvidence: eff.venues as never,
    feeReverifyDays: 90
  });
  assert.equal(rows.length, 9, "one card per venue");
  for (const r of rows) {
    assert.ok(r.feeEvidence, `${r.sourceId} has its resolution attached`);
    const src = eff.byVenue[r.sourceId];
    assert.equal(r.feeEvidence!.takerFeeBps, src.takerFeeBps, `${r.sourceId} taker is transported`);
    assert.equal(r.feeEvidence!.executionMode, src.executionMode);
    assert.equal(r.feeEvidence!.evidenceTierLabel, src.evidenceTierLabel);
    assert.equal(r.feeEvidence!.currentTierLabel, src.currentTierLabel);
    assert.equal(r.feeEvidence!.ok, src.ok);
    assert.equal(r.feeEvidence!.blockerFa, src.blockerFa);
    // Confirmation and expiry are present whenever a record backed the answer.
    if (src.ok) {
      assert.ok(r.feeEvidence!.confirmedAt, `${r.sourceId} states when it was confirmed`);
      assert.ok(r.feeEvidence!.expiresAt, `${r.sourceId} states when it expires`);
      assert.ok(r.feeEvidence!.provenance, `${r.sourceId} states where it came from`);
    }
  }
  const blocked = rows.find((r) => r.sourceId === "tetherland")!;
  assert.equal(blocked.feeEvidence!.ok, false, "a mismatched venue is shown as blocked");
  assert.equal(blocked.feeEvidence!.miss, "tier_mismatch");

  // The panel renders these; it must not compute a match of its own.
  const panel = (await import("node:fs")).readFileSync(
    new URL("../src/components/shadowArbitrage/SourcesPanel.tsx", import.meta.url),
    "utf8"
  );
  assert.equal(
    /selectEffectiveFee|tier_mismatch\s*===|currentTierLabel\s*===/.test(panel),
    false,
    "the panel decides no match on its own"
  );
});

await test("the Sources panel prints the three required statements", async () => {
  const { readFileSync } = await import("node:fs");
  const effSrc = readFileSync(
    new URL("../src/lib/shadowArbitrage/effectiveFees.ts", import.meta.url),
    "utf8"
  );
  for (const label of [
    "کارمزد ۰/۰ فقط برای دفتر سفارش",
    "اعمال نمی‌شود؛ شواهد این حالت وجود ندارد",
    "نقل‌قول اجراپذیر — پلکان اعلام نشده"
  ]) {
    assert.ok(effSrc.includes(label), `the server produces «${label}»`);
  }
  const panel = readFileSync(
    new URL("../src/components/shadowArbitrage/SourcesPanel.tsx", import.meta.url),
    "utf8"
  );
  // The panel renders them from the payload rather than restating them.
  assert.ok(panel.includes("noticesFa"), "notices are rendered from the server payload");
  assert.ok(panel.includes("labelFa"), "reference-mode labels come from the server too");
  assert.ok(panel.includes("پلکان اعلام نشده"), "a null tier is named, never blank");
});

await closeDb();
await rm(dataDir, { recursive: true, force: true });

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
