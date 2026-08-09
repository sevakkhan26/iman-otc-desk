/**
 * Local-only fee/account evidence parity seed.
 *
 * Why Local shows fee_unknown: SHADOW_RELEASE_BOOTSTRAP is false in local RC
 * (and release bootstrap defaults off outside production), so the canonical
 * nine-venue fee evidence from releaseBootstrap is never written to the local
 * pglite database. Without tier + confirmation rows, effectiveFees miss and
 * every consumer reports fee_unknown / fee_unconfirmed.
 *
 * This module restores ONLY the account + fee evidence already defined by
 * releaseBootstrap (APPROVED_VENUES / RELEASE_KEY / timestamps / provenance).
 * It never invents rates, never copies screenshot pixels, never opens exchange
 * connections, and never creates capital plans or paper sessions.
 *
 * Idempotent: same evidenceKey returns existing rows. Newer admin evidence
 * (confirmedAt strictly after the canonical confirmation instant) is never
 * displaced — the seed skips that venue rather than appending an older rate
 * that would lose to newest-first selection anyway, and never deletes rows.
 */
import {
  loadLatestAccountConfirmations,
  loadLatestFeeConfirmations,
  recordAccountConfirmation,
  recordFeeConfirmation
} from "@/db/repositories/shadowArbitrage";
import {
  listFeeTierEvidence,
  recordFeeTierEvidence
} from "@/db/repositories/shadowFeeTier";
import {
  APPROVED_VENUES,
  CONFIRMED_AT,
  RELEASE_KEY
} from "@/lib/shadowArbitrage/releaseBootstrap";
/** Marker note only — not a second source of fee numbers. */
export const LOCAL_FEE_SEED_NOTE =
  "local fee parity — canonical evidence from releaseBootstrap APPROVED_VENUES";

const PROVENANCE = "ADMIN_CONFIRMED_SCREENSHOT";
const CONFIRMED_BY = "otc-iman";
const VALID_DAYS = 30;
const CANONICAL_CONFIRMED_MS = Date.parse(CONFIRMED_AT);

export type LocalFeeSeedVenueResult = {
  sourceId: string;
  action: "seeded" | "already_present" | "skipped_newer_admin";
  account: "written" | "existing" | "skipped";
  feeConfirmation: "written" | "existing" | "skipped";
  feeTier: "written" | "existing" | "skipped";
  reason?: string;
};

export type LocalFeeSeedResult = {
  ran: true;
  evidenceSource: "releaseBootstrap.APPROVED_VENUES";
  evidenceKey: typeof RELEASE_KEY;
  confirmedAt: typeof CONFIRMED_AT;
  venues: LocalFeeSeedVenueResult[];
  written: number;
  alreadyPresent: number;
  skippedNewer: number;
};

/**
 * Restore canonical fee/account evidence for all nine venues.
 * Safe to call repeatedly. Does not touch paper sessions, balances, ledgers.
 */
export async function seedLocalFeeEvidence(): Promise<LocalFeeSeedResult> {
  // Paper floor is paper_policy_min (5 USDT) in venueExecutionLimits — not a
  // seeded fake exchange min. Verified venue mins are optional and raise the floor.

  const latestFees = await loadLatestFeeConfirmations();
  const latestAccounts = await loadLatestAccountConfirmations();
  const allTiers = await listFeeTierEvidence();

  const venues: LocalFeeSeedVenueResult[] = [];
  let written = 0;
  let alreadyPresent = 0;
  let skippedNewer = 0;

  for (const v of APPROVED_VENUES) {
    const latestFee = latestFees[v.sourceId];
    const latestAcc = latestAccounts[v.sourceId];
    const latestTier = allTiers
      .filter((r) => r.sourceId === v.sourceId && r.executionMode === v.executionMode)
      .sort(
        (a, b) =>
          Date.parse(b.confirmedAt) - Date.parse(a.confirmedAt) || b.seq - a.seq
      )[0];

    // Never displace newer admin evidence (different key, later confirmation).
    const newerFee =
      latestFee &&
      latestFee.evidenceKey !== RELEASE_KEY &&
      Date.parse(latestFee.confirmedAt) > CANONICAL_CONFIRMED_MS;
    const newerAcc =
      latestAcc &&
      latestAcc.evidenceKey !== RELEASE_KEY &&
      Date.parse(latestAcc.confirmedAt) > CANONICAL_CONFIRMED_MS;
    const newerTier =
      latestTier &&
      latestTier.evidenceKey !== RELEASE_KEY &&
      Date.parse(latestTier.confirmedAt) > CANONICAL_CONFIRMED_MS;

    if (newerFee || newerAcc || newerTier) {
      skippedNewer += 1;
      venues.push({
        sourceId: v.sourceId,
        action: "skipped_newer_admin",
        account: "skipped",
        feeConfirmation: "skipped",
        feeTier: "skipped",
        reason: "newer admin evidence present; left untouched"
      });
      continue;
    }

    const beforeAcc = latestAcc?.evidenceKey === RELEASE_KEY;
    const beforeFee = latestFee?.evidenceKey === RELEASE_KEY;
    const beforeTier = latestTier?.evidenceKey === RELEASE_KEY;

    const account = await recordAccountConfirmation({
      sourceId: v.sourceId,
      kycComplete: true,
      accountState: "VERIFIED",
      executionEligible: true,
      ineligibleReason: null,
      provenance: PROVENANCE,
      validDays: VALID_DAYS,
      evidenceKey: RELEASE_KEY,
      confirmedBy: CONFIRMED_BY,
      confirmedAt: CONFIRMED_AT,
      note: "تأیید مدیر با تصویر پنل — احراز هویت کامل و واجد شرایط شبیه‌سازی"
    });

    const fee = await recordFeeConfirmation({
      sourceId: v.sourceId,
      takerFeeBps: v.takerBps,
      makerFeeBps: v.makerBps,
      feeTier: v.tier,
      sourceUrl: null,
      provenance: PROVENANCE,
      validDays: VALID_DAYS,
      referenceMetadata: null,
      evidenceKey: RELEASE_KEY,
      confirmedBy: CONFIRMED_BY,
      confirmedAt: CONFIRMED_AT,
      note: "نرخ taker اعمال می‌شود؛ maker فقط مرجع است"
    });

    const tier = await recordFeeTierEvidence({
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
      note: LOCAL_FEE_SEED_NOTE
    });

    const accState =
      beforeAcc || account.evidenceKey === RELEASE_KEY
        ? beforeAcc
          ? "existing"
          : "written"
        : "written";
    // record* returns existing row when key matches; detect write via pre-check.
    const feeState = beforeFee ? "existing" : "written";
    const tierState = beforeTier ? "existing" : "written";

    const allExisting = beforeAcc && beforeFee && beforeTier;
    if (allExisting) {
      alreadyPresent += 1;
      venues.push({
        sourceId: v.sourceId,
        action: "already_present",
        account: "existing",
        feeConfirmation: "existing",
        feeTier: "existing"
      });
    } else {
      written += 1;
      venues.push({
        sourceId: v.sourceId,
        action: "seeded",
        account: beforeAcc ? "existing" : "written",
        feeConfirmation: feeState,
        feeTier: tierState
      });
    }

    // Silence unused — keep for future audit fields without lint noise.
    void fee;
    void tier;
    void accState;
  }

  return {
    ran: true,
    evidenceSource: "releaseBootstrap.APPROVED_VENUES",
    evidenceKey: RELEASE_KEY,
    confirmedAt: CONFIRMED_AT,
    venues,
    written,
    alreadyPresent,
    skippedNewer
  };
}
