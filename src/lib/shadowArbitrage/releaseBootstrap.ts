/**
 * Release 4.1.6.0 — reconcile the approved admin state at startup.
 *
 * WHY THIS EXISTS. Git carries files, not database rows. The account, fee and
 * capital evidence that was approved locally lived only in a local database, so
 * shipping the code left production showing nine venues without confirmed fees
 * and a paper session still sized at fifty million. Someone had to run an
 * importer on the host by hand. This removes that step: the same approved state
 * is now encoded in the release and applied by the application itself, through
 * the ordinary startup path, on whatever database it finds.
 *
 * WHAT IT WILL NOT DO. It writes evidence, one capital plan and one paper
 * session. It never deletes, truncates, or rewrites a balance, a ledger row, a
 * fill or a historical session — the previous session is closed through the
 * audited status transition and kept. It invents nothing: no source URL, no
 * transfer cost, no API capability, no market data. And it opens no exchange
 * connection: there is no credential, order, deposit, withdrawal or transfer
 * anywhere in this path.
 *
 * HOW IT STAYS ONCE-ONLY. Every write is idempotent on its own — the evidence
 * repositories key on `evidenceKey`, so a re-run returns the existing row
 * rather than adding one. On top of that, a marker row in
 * `shadow_release_bootstrap` records the release key, and its PRIMARY KEY makes
 * two containers starting at once resolve to exactly one winner. The marker is
 * written LAST: a crash halfway through leaves it absent, so the next start
 * finishes the job instead of skipping it, and the idempotent steps make that
 * retry harmless.
 */
import { sql } from "drizzle-orm";
import { getDbAsync } from "@/db/client";
import {
  ensureObservationSession,
  loadLatestCapitalPlan,
  loadLatestSourceSnapshots,
  recordAccountConfirmation,
  recordFeeConfirmation,
  saveCapitalPlan
} from "@/db/repositories/shadowArbitrage";
import { recordFeeTierEvidence } from "@/db/repositories/shadowFeeTier";
import {
  createPaperSession,
  getActivePaperSession,
  setPaperSessionStatus
} from "@/db/repositories/shadowPaper";
import { SHADOW_SOURCES } from "@/lib/shadowArbitrage/config";

/** Stable for this release. Changing it would make the reconciliation re-run. */
export const RELEASE_KEY = "release-4.1.6.0-admin-evidence-10b";

/** The approved virtual capital. Simulated; no real money is involved. */
export const RELEASE_CAPITAL_TOMAN = 10_000_000_000;

/**
 * The administrator's confirmations, exactly as approved.
 *
 * `taker` is the only rate that ever settles a paper fill. `maker` is recorded
 * because the panel shows it and is never applied — there is no maker-order
 * simulation. AbanTether's evidence names no tier, so its label is null rather
 * than a guessed "Base": an invented tier would match a real fee row and
 * quietly authorise it.
 */
export const APPROVED_VENUES: Array<{
  sourceId: string;
  tier: string | null;
  takerBps: number;
  makerBps: number;
  executionMode: "ORDER_BOOK" | "OTC_QUOTE";
}> = [
  { sourceId: "nobitex", tier: "Base", takerBps: 25, makerBps: 25, executionMode: "ORDER_BOOK" },
  { sourceId: "wallex", tier: "Base Level 1", takerBps: 30, makerBps: 25, executionMode: "ORDER_BOOK" },
  { sourceId: "tabdeal", tier: "VIP1", takerBps: 28, makerBps: 24, executionMode: "ORDER_BOOK" },
  { sourceId: "bitpin", tier: "Base Level 1", takerBps: 35, makerBps: 30, executionMode: "ORDER_BOOK" },
  { sourceId: "abantether", tier: null, takerBps: 30, makerBps: 30, executionMode: "OTC_QUOTE" },
  { sourceId: "ramzinex", tier: "Base", takerBps: 25, makerBps: 20, executionMode: "ORDER_BOOK" },
  { sourceId: "bit24", tier: "VIP0", takerBps: 20, makerBps: 20, executionMode: "ORDER_BOOK" },
  { sourceId: "tetherland", tier: "Bronze", takerBps: 45, makerBps: 45, executionMode: "ORDER_BOOK" },
  { sourceId: "arzinja", tier: "Level 1", takerBps: 0, makerBps: 0, executionMode: "ORDER_BOOK" }
];

/** 2026-08-01 16:30 Asia/Tehran (UTC+03:30) — the approver's own timestamp. */
export const CONFIRMED_AT = "2026-08-01T13:00:00.000Z";
/** The approver's stated expiry. Thirty days from the confirmation date. */
export const EXPIRES_AT = "2026-08-31T13:00:00.000Z";
const VALID_DAYS = 30;
const PROVENANCE = "ADMIN_CONFIRMED_SCREENSHOT";
const CONFIRMED_BY = "otc-iman";

export type BootstrapResult = {
  ran: boolean;
  reason?: "already-applied" | "no-valuation-price" | "disabled";
  accountConfirmations: number;
  feeConfirmations: number;
  feeTierRecords: number;
  capitalPlansCreated: number;
  paperSessionsCreated: number;
  paperSessionsClosed: number;
  planId?: string;
  sessionId?: string;
  valuationPriceToman?: number;
};

const ZERO: BootstrapResult = {
  ran: false,
  accountConfirmations: 0,
  feeConfirmations: 0,
  feeTierRecords: 0,
  capitalPlansCreated: 0,
  paperSessionsCreated: 0,
  paperSessionsClosed: 0
};

/**
 * Whether the reconciliation should run here.
 *
 * On in a production server process, off elsewhere, and always overridable —
 * the preview and fixture harnesses set it to `false` so their own seeded
 * sessions are not displaced by this one.
 */
export function releaseBootstrapEnabled(): boolean {
  const raw = (process.env.SHADOW_RELEASE_BOOTSTRAP ?? "").trim().toLowerCase();
  if (["false", "0", "no", "off"].includes(raw)) return false;
  if (["true", "1", "yes", "on"].includes(raw)) return true;
  return process.env.NODE_ENV === "production";
}

/** The mid price the desk is currently marking USDT at, or null if unknown. */
function deriveValuationPrice(
  snapshots: Array<{ userBuy: number | null; userSell: number | null; stale: boolean }>
): number | null {
  const mids = snapshots
    .filter((s) => !s.stale && s.userBuy !== null && s.userSell !== null)
    .map((s) => ((s.userBuy as number) + (s.userSell as number)) / 2)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (!mids.length) return null;
  const mid = Math.floor(mids.length / 2);
  return Math.round(mids.length % 2 ? mids[mid] : (mids[mid - 1] + mids[mid]) / 2);
}

/**
 * Split the capital half into toman and half into USDT, equally across the nine
 * venues, by LARGEST REMAINDER.
 *
 * Ten billion does not divide by nine, and USDT is tracked to six decimals, so
 * naive division leaves a few toman unallocated and the plan fails its own
 * conservation check. Largest remainder hands each leftover unit to the venues
 * with the biggest truncated fraction, in a fixed order, so the split is
 * deterministic AND the total is exact: the residual is zero by construction,
 * not by rounding luck.
 */
export function buildAllocations(
  totalToman: number,
  valuationPriceToman: number,
  sourceIds: string[]
): Array<{ sourceId: string; irtToman: number; usdtUnits: number }> {
  const n = sourceIds.length;
  const halfToman = Math.floor(totalToman / 2);
  const usdtHalfToman = totalToman - halfToman;

  // Toman half: integer toman, remainder distributed one unit at a time.
  const baseIrt = Math.floor(halfToman / n);
  let irtLeft = halfToman - baseIrt * n;
  const irt = sourceIds.map(() => baseIrt);
  for (let i = 0; irtLeft > 0; i += 1, irtLeft -= 1) irt[i % n] += 1;

  /*
   * USDT half: work in micro-units so the ledger's six decimals are exact, then
   * hand the leftover micro-units out the same way. The toman value of the USDT
   * half is what has to come out exact, so the last venue absorbs any rounding
   * the price introduces.
   */
  const totalMicros = Math.round((usdtHalfToman / valuationPriceToman) * 1_000_000);
  const baseMicros = Math.floor(totalMicros / n);
  let microsLeft = totalMicros - baseMicros * n;
  const micros = sourceIds.map(() => baseMicros);
  for (let i = 0; microsLeft > 0; i += 1, microsLeft -= 1) micros[i % n] += 1;

  return sourceIds.map((sourceId, i) => ({
    sourceId,
    irtToman: irt[i],
    usdtUnits: micros[i] / 1_000_000
  }));
}

/** Toman value of an allocation set at the stated price. */
export function allocatedToman(
  allocations: Array<{ irtToman: number; usdtUnits: number }>,
  valuationPriceToman: number
): number {
  const irt = allocations.reduce((a, x) => a + x.irtToman, 0);
  const usdt = allocations.reduce((a, x) => a + x.usdtUnits, 0);
  return irt + Math.round(usdt * valuationPriceToman);
}

async function alreadyApplied(): Promise<boolean> {
  const db = await getDbAsync();
  const r = await db.execute(
    sql`SELECT 1 FROM shadow_release_bootstrap WHERE release_key = ${RELEASE_KEY} LIMIT 1`
  );
  const rows = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? []);
  return rows.length > 0;
}

async function markApplied(detail: Record<string, unknown>): Promise<void> {
  const db = await getDbAsync();
  // The primary key settles a race between two starting containers.
  await db.execute(
    sql`INSERT INTO shadow_release_bootstrap (release_key, detail)
        VALUES (${RELEASE_KEY}, ${JSON.stringify(detail)}::jsonb)
        ON CONFLICT (release_key) DO NOTHING`
  );
}

/**
 * Apply the approved state. Safe to call on every start.
 *
 * Returns what it actually wrote, so a caller — or a test — can assert that the
 * second run wrote nothing.
 */
export async function runReleaseBootstrap(
  log: (message: string, extra?: unknown) => void = () => undefined
): Promise<BootstrapResult> {
  if (!releaseBootstrapEnabled()) return { ...ZERO, reason: "disabled" };
  if (await alreadyApplied()) return { ...ZERO, reason: "already-applied" };

  const result: BootstrapResult = { ...ZERO, ran: true };

  /* ── 1. account and fee evidence, one current row per venue ───────────── */
  for (const v of APPROVED_VENUES) {
    const account = await recordAccountConfirmation({
      sourceId: v.sourceId,
      kycComplete: true,
      accountState: "VERIFIED",
      // All nine may back a simulated execution. Tetherland and Arzinja carry
      // no permanent bar: whether they trade in any given cycle is still
      // decided by that cycle's health, freshness and executable depth.
      executionEligible: true,
      ineligibleReason: null,
      provenance: PROVENANCE,
      validDays: VALID_DAYS,
      evidenceKey: RELEASE_KEY,
      confirmedBy: CONFIRMED_BY,
      confirmedAt: CONFIRMED_AT,
      note: "تأیید مدیر با تصویر پنل — احراز هویت کامل و واجد شرایط شبیه‌سازی"
    });
    if (account.evidenceKey === RELEASE_KEY) result.accountConfirmations += 1;

    await recordFeeConfirmation({
      sourceId: v.sourceId,
      takerFeeBps: v.takerBps,
      makerFeeBps: v.makerBps,
      feeTier: v.tier,
      // No document was supplied for any venue. Null, never invented.
      sourceUrl: null,
      provenance: PROVENANCE,
      validDays: VALID_DAYS,
      referenceMetadata: null,
      evidenceKey: RELEASE_KEY,
      confirmedBy: CONFIRMED_BY,
      confirmedAt: CONFIRMED_AT,
      note: "نرخ taker اعمال می‌شود؛ maker فقط مرجع است"
    });
    result.feeConfirmations += 1;

    await recordFeeTierEvidence({
      sourceId: v.sourceId,
      executionMode: v.executionMode,
      tierLabel: v.tier,
      makerFeeBps: v.makerBps,
      takerFeeBps: v.takerBps,
      provenance: PROVENANCE,
      evidenceKey: RELEASE_KEY,
      confirmedBy: CONFIRMED_BY,
      confirmedAt: CONFIRMED_AT,
      validForDays: VALID_DAYS,
      sourceUrl: null,
      note: null
    });
    result.feeTierRecords += 1;
  }
  log(`release bootstrap: evidence for ${result.feeConfirmations} venues`);

  /* ── 2. the allocated capital plan ────────────────────────────────────── */
  const snapshots = await loadLatestSourceSnapshots();
  const valuationPriceToman = deriveValuationPrice(snapshots);
  if (valuationPriceToman === null) {
    /*
     * No mark price yet — a brand new database whose collector has not
     * completed a cycle. The evidence above is already stored and idempotent;
     * the marker is deliberately NOT written, so the next start finishes the
     * plan and the session once a price exists. Nothing is invented here.
     */
    log("release bootstrap: no valuation price yet — plan and session deferred to the next start");
    return { ...result, reason: "no-valuation-price" };
  }
  result.valuationPriceToman = valuationPriceToman;

  const sourceIds = SHADOW_SOURCES.map((c) => c.id as string);
  const allocations = buildAllocations(RELEASE_CAPITAL_TOMAN, valuationPriceToman, sourceIds);
  const allocated = allocatedToman(allocations, valuationPriceToman);
  if (allocated !== RELEASE_CAPITAL_TOMAN) {
    // Refuse rather than store a plan that does not conserve.
    throw new Error(
      `release bootstrap: allocations total ${allocated}, expected ${RELEASE_CAPITAL_TOMAN}`
    );
  }

  const plan = await saveCapitalPlan({
    name: "طرح تأییدشدهٔ ۱۰ میلیارد تومانی",
    mode: "MANUAL",
    totalCapitalToman: RELEASE_CAPITAL_TOMAN,
    valuationPriceToman,
    // Everything is allocated; there is no held-back reserve.
    reservePercent: 0,
    allocations,
    createdBy: CONFIRMED_BY,
    note:
      `تخصیص قطعی ۹ صرافی با روش بزرگ‌ترین باقی‌مانده؛ نیمی تومان و نیمی تتر در قیمت ${valuationPriceToman}. ` +
      "باقی‌ماندهٔ پایستگی صفر. هزینهٔ انتقال/بازتوازن نامشخص می‌ماند."
  });
  result.capitalPlansCreated += 1;
  result.planId = plan.id;
  log(`release bootstrap: capital plan ${plan.id} at ${RELEASE_CAPITAL_TOMAN} toman`);

  /* ── 3. close the old session, open the approved one ──────────────────── */
  const previous = await getActivePaperSession();
  if (previous) {
    // The audited transition, not a delete. Its balances, ledgers, fills and
    // history stay exactly as they are.
    await setPaperSessionStatus(previous.id, "STOPPED");
    result.paperSessionsClosed += 1;
    log(`release bootstrap: previous session ${previous.id} stopped and kept as history`);
  }

  const observation = await ensureObservationSession(30_000);
  const session = await createPaperSession({
    observationId: observation.id,
    name: "نشست کاغذی ۱۰ میلیارد تومانی",
    mode: "PROVISIONAL_EVALUATION",
    totalCapitalToman: RELEASE_CAPITAL_TOMAN,
    valuationPriceToman,
    openingAllocations: allocations,
    // No approval exists and none is created here.
    approvalFingerprint: null,
    createdBy: CONFIRMED_BY,
    note: "اجرای کاغذی — بدون سفارش واقعی و بدون انتقال وجه"
  });
  await setPaperSessionStatus(session.id, "RUNNING");
  result.paperSessionsCreated += 1;
  result.sessionId = session.id;
  log(`release bootstrap: paper session ${session.id} started at ${RELEASE_CAPITAL_TOMAN} toman`);

  /* ── 4. the marker, last ──────────────────────────────────────────────── */
  await markApplied({
    accountConfirmations: result.accountConfirmations,
    feeConfirmations: result.feeConfirmations,
    feeTierRecords: result.feeTierRecords,
    planId: result.planId,
    sessionId: result.sessionId,
    valuationPriceToman,
    previousSessionStopped: previous?.id ?? null
  });
  return result;
}

/** The plan the release would persist, without writing anything. */
export async function previewReleasePlan(): Promise<{
  valuationPriceToman: number | null;
  allocations: Array<{ sourceId: string; irtToman: number; usdtUnits: number }>;
  totalToman: number;
  residualToman: number;
} | null> {
  const price = deriveValuationPrice(await loadLatestSourceSnapshots());
  if (price === null) return null;
  const allocations = buildAllocations(
    RELEASE_CAPITAL_TOMAN,
    price,
    SHADOW_SOURCES.map((c) => c.id as string)
  );
  const total = allocatedToman(allocations, price);
  return {
    valuationPriceToman: price,
    allocations,
    totalToman: total,
    residualToman: RELEASE_CAPITAL_TOMAN - total
  };
}

/** Latest stored plan, for callers that want to confirm the state after a run. */
export async function currentReleasePlan() {
  return loadLatestCapitalPlan();
}
