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
const { loadFeeConfirmations, loadLatestFeeConfirmations, recordFeeConfirmation } = await import(
  "../src/db/repositories/shadowArbitrage.ts"
);
const { closeDb } = await import("../src/db/client.ts");

import {
  APPROVED_FEE_TIERS as TIERS,
  CONFIRMED_AT,
  CONFIRMED_BY,
  EVIDENCE_KEY,
  PROVENANCE,
  TIER_IN_FORCE_KEY,
  VALID_FOR_DAYS
} from "./approvedFeeTiers.mts";

/**
 * Reconcile the tier the account is recorded as being ON.
 *
 * Effective-fee selection matches the evidence's tier against the tier in
 * force, and the tier in force lives on the append-only account/fee
 * confirmation. Where the stored value is not the approved tier label, an
 * append (never an update) states the approved one.
 *
 * The one venue this touches today is AbanTether, whose stored label reads
 * "current 0.30% tier" — a description of a rate, not the name of a tier. The
 * administrator's evidence names no tier for it, so the declared tier becomes
 * null: «پلکان اعلام نشده». Guessing "Base" there would have matched a real fee
 * row and quietly authorised it.
 */
async function reconcileTierInForce(): Promise<number> {
  const latest = await loadLatestFeeConfirmations();
  let appended = 0;
  for (const t of TIERS) {
    const row = latest[t.sourceId];
    if (!row) continue;
    if ((row.feeTier ?? null) === (t.tierLabel ?? null)) continue;
    // Already declared on a previous run: the key makes the write a no-op, so
    // report it as such instead of counting an append that did not happen.
    const already = (await loadFeeConfirmations(t.sourceId)).some(
      (r) => r.evidenceKey === TIER_IN_FORCE_KEY
    );
    if (already) continue;
    /*
     * Stamped NOW, not with the import's nominal date. The row being corrected
     * may itself have been confirmed later today, and "latest confirmation
     * wins" compares confirmation instants — a backdated correction would be
     * written, counted, and then quietly ignored by the very lookup it exists
     * to change. Idempotency comes from the evidence key, not the timestamp.
     */
    await recordFeeConfirmation({
      sourceId: t.sourceId,
      // Carried over unchanged — this append declares a tier, not a new rate.
      takerFeeBps: row.takerFeeBps,
      makerFeeBps: row.makerFeeBps,
      feeTier: t.tierLabel,
      sourceUrl: row.sourceUrl,
      provenance: PROVENANCE,
      validDays: row.validDays,
      referenceMetadata: row.referenceMetadata,
      evidenceKey: TIER_IN_FORCE_KEY,
      confirmedBy: CONFIRMED_BY,
      confirmedAt: new Date().toISOString(),
      note:
        t.tierLabel === null
          ? `پلکان اعلام‌شدهٔ قبلی «${row.feeTier}» نام یک پله نبود بلکه توصیف نرخ بود؛ شواهد موجود هیچ پله‌ای برای این صرافی نام نمی‌برد.`
          : `پلکان جاری حساب «${t.tierLabel}» اعلام شد؛ نرخ‌ها بدون تغییر منتقل شدند.`
    });
    console.log(
      `[tier-in-force] ${t.sourceId}: «${row.feeTier ?? "—"}» → «${t.tierLabel ?? "پلکان اعلام نشده"}»`
    );
    appended += 1;
  }
  return appended;
}

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

  const tierInForceAppends = await reconcileTierInForce();

  const after = await listFeeTierEvidence();
  console.log(`[fee-tier] rows before      ${before}`);
  console.log(`[fee-tier] written this run ${written}`);
  console.log(`[fee-tier] rows after       ${after.length}`);
  console.log(`[fee-tier] tier-in-force appends ${tierInForceAppends}`);
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
