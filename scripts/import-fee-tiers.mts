#!/usr/bin/env npx tsx
/**
 * Phase 8E-B — import the administrator's approved fee-tier evidence.
 *
 *   DATABASE_URL=pglite:/path/to/db npx tsx scripts/import-fee-tiers.mts
 *
 * Idempotent: every record carries an evidence key, so re-running writes
 * nothing new. Append-only: nothing is updated or deleted.
 *
 * Everything below was supplied by the administrator. Nothing is inferred —
 * AbanTether names no tier in the evidence, so its tier is null rather than a
 * guessed "Base", and Easy Trade / Convert rates are absent rather than
 * assumed to match the order book.
 */
const { recordFeeTierEvidence, listFeeTierEvidence } = await import(
  "../src/db/repositories/shadowFeeTier.ts"
);
const { closeDb } = await import("../src/db/client.ts");

/** The confirmation this import represents. One key, one import. */
const EVIDENCE_KEY = "admin-tier-2026-08-02";
const CONFIRMED_AT = "2026-08-02T00:00:00.000Z";
const CONFIRMED_BY = "otc-iman";
const VALID_FOR_DAYS = 30;
const PROVENANCE = "ADMIN_CONFIRMED_SCREENSHOT";

/**
 * Approved tiers, exactly as supplied.
 *
 * `makerFeeBps`/`takerFeeBps` repeat the rates already confirmed for each
 * venue's ORDER_BOOK mode. Arzinja's 0/0 is scoped to ORDER_BOOK here and
 * nowhere else: no Easy Trade or Convert row is written, so those modes have no
 * evidence and will fail closed rather than inherit zero.
 */
const TIERS: Array<{
  sourceId: string;
  tierLabel: string | null;
  makerFeeBps: number | null;
  takerFeeBps: number | null;
  executionMode: "ORDER_BOOK" | "OTC_QUOTE";
  note?: string;
}> = [
  { sourceId: "nobitex", tierLabel: "Base", makerFeeBps: 25, takerFeeBps: 25, executionMode: "ORDER_BOOK" },
  { sourceId: "wallex", tierLabel: "Base Level 1", makerFeeBps: 25, takerFeeBps: 30, executionMode: "ORDER_BOOK" },
  { sourceId: "tabdeal", tierLabel: "VIP1", makerFeeBps: 24, takerFeeBps: 28, executionMode: "ORDER_BOOK" },
  { sourceId: "bitpin", tierLabel: "Base Level 1", makerFeeBps: 30, takerFeeBps: 35, executionMode: "ORDER_BOOK" },
  {
    sourceId: "abantether",
    // The supplied evidence names no tier for this venue. Null, not "Base".
    tierLabel: null,
    makerFeeBps: 30,
    takerFeeBps: 30,
    executionMode: "OTC_QUOTE",
    note: "شواهد ارائه‌شده هیچ پلکانی برای این صرافی نام نبرده است"
  },
  { sourceId: "ramzinex", tierLabel: "Base", makerFeeBps: 20, takerFeeBps: 25, executionMode: "ORDER_BOOK" },
  { sourceId: "bit24", tierLabel: "VIP0", makerFeeBps: 20, takerFeeBps: 20, executionMode: "ORDER_BOOK" },
  { sourceId: "tetherland", tierLabel: "Bronze", makerFeeBps: 45, takerFeeBps: 45, executionMode: "ORDER_BOOK" },
  {
    sourceId: "arzinja",
    tierLabel: "Level 1",
    makerFeeBps: 0,
    takerFeeBps: 0,
    executionMode: "ORDER_BOOK",
    note: "صفر فقط برای حالت دفتر سفارش/معاملهٔ بازار تأیید شده است؛ خرید و فروش آسان و تبدیل شواهد جداگانه لازم دارند"
  }
];

async function main() {
  const before = (await listFeeTierEvidence()).length;
  let written = 0;

  for (const t of TIERS) {
    const existing = (await listFeeTierEvidence(t.sourceId)).some(
      (r) => r.executionMode === t.executionMode && r.evidenceKey === EVIDENCE_KEY
    );
    await recordFeeTierEvidence({
      sourceId: t.sourceId,
      executionMode: t.executionMode,
      tierLabel: t.tierLabel,
      makerFeeBps: t.makerFeeBps,
      takerFeeBps: t.takerFeeBps,
      provenance: PROVENANCE,
      evidenceKey: EVIDENCE_KEY,
      confirmedBy: CONFIRMED_BY,
      confirmedAt: CONFIRMED_AT,
      validForDays: VALID_FOR_DAYS,
      // No document URL was supplied. Null, never invented.
      sourceUrl: null,
      note: t.note ?? null
    });
    if (!existing) written += 1;
  }

  const after = await listFeeTierEvidence();
  console.log(`[fee-tier] rows before      ${before}`);
  console.log(`[fee-tier] written this run ${written}`);
  console.log(`[fee-tier] rows after       ${after.length}`);
  console.log("");
  for (const r of [...after].sort((a, b) => a.sourceId.localeCompare(b.sourceId))) {
    console.log(
      `  ${r.sourceId.padEnd(12)} ${r.executionMode.padEnd(11)} tier=${String(r.tierLabel ?? "—").padEnd(14)} maker/taker=${r.makerFeeBps}/${r.takerFeeBps} expires=${r.expiresAt?.slice(0, 10) ?? "—"}`
    );
  }
  console.log("");
  console.log("[fee-tier] Easy Trade / Convert have NO evidence and will fail closed.");
  console.log("[fee-tier] no credential, order or transfer was involved.");
  await closeDb();
}

await main();
