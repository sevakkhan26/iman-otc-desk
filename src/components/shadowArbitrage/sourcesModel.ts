/**
 * Phase 8B — presentation model for the «منابع و کارمزدها» tab.
 *
 * Pure functions. Every value is joined from something the server already
 * returned: the observation payload (certification + health), the matrix
 * snapshot (freshness, market model), the accounts endpoint (account state,
 * taker fee, provenance, required action, blocking reason) and the paper
 * broker's per-venue, per-side settlement table.
 *
 * Two concerns are deliberately kept apart, because they fail independently:
 *   * source and data health — can we read this venue at all?
 *   * account and fee readiness — could we ever trade on it?
 *
 * Nothing is defaulted. A venue the accounts endpoint has not described yet
 * yields nulls, and the UI renders «—» with the reason instead of a number.
 */
import { PAPER_FEE_SETTLEMENT } from "@/lib/shadowArbitrage/paper/broker";
import type { SideSettlement } from "@/lib/shadowArbitrage/paper/broker";
import type { ShadowSourceId } from "@/lib/shadowArbitrage/types";
import type {
  Certification,
  NormalizedSourceSnapshot,
  SourceHealthRow
} from "@/components/shadowArbitrage/types";

/** One venue as the accounts endpoint returns it. */
export type VenueReadiness = {
  sourceId: string;
  nameFa: string;
  accountState: "VERIFIED" | "NEEDS_ACCOUNT" | "REFERENCE_ONLY";
  /** Identity verification finished at this venue, per admin evidence. */
  kycComplete?: boolean;
  /** May this venue ever back an execution? Separate from KYC on purpose. */
  executionEligible?: boolean;
  ineligibleReason?: string | null;
  takerFeeBps: number | null;
  /** Reference only until maker-order simulation exists; never settled. */
  makerFeeBps?: number | null;
  /** Quoted-market / easy-trade rates. Never applied to USDT/IRT maths. */
  referenceMetadata?: Record<string, unknown> | null;
  /** Server-computed expiry of this evidence. */
  feeExpiresAt?: string | null;
  feeProvenance:
    | "OFFICIAL_PUBLISHED"
    | "ADMIN_CONFIRMED"
    | "ADMIN_CONFIRMED_SCREENSHOT"
    | "PROVISIONAL"
    | "UNKNOWN";
  feeTier: string | null;
  officialSourceUrl: string | null;
  feeVerifiedAt: string | null;
  feeStale: boolean;
  apiCapabilities: string[];
  requiredAction: string;
  blockingReason: string | null;
  notes: string;
};

/**
 * Phase 8E-B — the applied fee for one venue, exactly as the server resolved it.
 *
 * Every field is transported, never recomputed: whether the evidence matched,
 * on which tier and execution mode, and the precise reason when it did not.
 * The panel has no way to decide a match on its own, which is the point.
 */
export type VenueFeeEvidence = {
  sourceId: string;
  nameFa: string;
  executionMode: string | null;
  executionModeFa: string;
  currentTierLabel: string | null;
  evidenceTierLabel: string | null;
  ok: boolean;
  makerFeeBps: number | null;
  takerFeeBps: number | null;
  provenance: string | null;
  evidenceKey: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  validForDays: number | null;
  expiresAt: string | null;
  sourceUrl: string | null;
  note: string | null;
  miss: string | null;
  blockerFa: string | null;
  executable: boolean;
  referenceModes: Array<{
    mode: string;
    modeFa: string;
    hasEvidence: boolean;
    makerFeeBps: number | null;
    takerFeeBps: number | null;
    labelFa: string;
  }>;
  noticesFa: string[];
  history: Array<{
    id: string;
    executionMode: string;
    tierLabel: string | null;
    makerFeeBps: number | null;
    takerFeeBps: number | null;
    provenance: string;
    evidenceKey: string;
    confirmedBy: string;
    confirmedAt: string;
    expiresAt: string | null;
    note: string | null;
  }>;
};

export type FeeConfirmationAudit = {
  id: string;
  sourceId: string;
  takerFeeBps: number;
  feeTier: string | null;
  confirmedBy: string;
  confirmedAt: string;
  note: string | null;
};

export const UNKNOWN_SETTLEMENT: SideSettlement = {
  feeAsset: "UNKNOWN",
  debitMode: "UNKNOWN",
  provenance: "UNKNOWN"
};

export const FEE_ASSET_FA: Record<string, string> = {
  IRT: "تومان",
  USDT: "تتر",
  UNKNOWN: "نامشخص"
};

export const DEBIT_MODE_FA: Record<string, string> = {
  ADD_TO_DEBIT: "افزوده به بدهی همان طرف",
  DEDUCT_FROM_CREDIT: "کسر از دریافتی همان طرف",
  UNKNOWN: "نامشخص"
};

export const SETTLEMENT_PROVENANCE_FA: Record<string, string> = {
  ADMIN_CONFIRMED: "تأیید مدیر",
  UNKNOWN: "تأییدنشده"
};

export const FEE_PROVENANCE_FA: Record<VenueReadiness["feeProvenance"], string> = {
  OFFICIAL_PUBLISHED: "سند رسمی",
  ADMIN_CONFIRMED: "تأیید مدیر",
  ADMIN_CONFIRMED_SCREENSHOT: "تأیید مدیر (تصویر پنل)",
  PROVISIONAL: "موقت",
  UNKNOWN: "نامشخص"
};

export const ACCOUNT_STATE_FA: Record<VenueReadiness["accountState"], string> = {
  VERIFIED: "حساب موجود",
  NEEDS_ACCOUNT: "نیازمند افتتاح حساب",
  REFERENCE_ONLY: "فقط مرجع"
};

export const API_CAPABILITY_FA: Record<string, string> = {
  PUBLIC_MARKET_DATA: "دادهٔ عمومی بازار",
  ACCOUNT_FEE_TIER: "پلهٔ کارمزد حساب",
  NONE_VERIFIED: "تأییدنشده"
};

/** Everything the tab shows for one venue, health and readiness kept apart. */
export type VenueRow = {
  sourceId: string;
  nameFa: string;
  marketSymbol: string | null;
  marketModel: string | null;
  referenceOnly: boolean;

  /* source and data health */
  certStatus: string | null;
  health: "healthy" | "degraded" | "unavailable" | null;
  ageMs: number | null;
  freshnessPercent: number | null;
  availabilityPercent: number | null;
  errorRatePercent: number | null;
  samples: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  lastProbeAt: string | null;

  /* account and fee readiness */
  accountState: VenueReadiness["accountState"] | null;
  kycComplete: boolean | null;
  executionEligible: boolean | null;
  ineligibleReason: string | null;
  takerFeeBps: number | null;
  makerFeeBps: number | null;
  feeProvenance: VenueReadiness["feeProvenance"] | null;
  feeTier: string | null;
  officialSourceUrl: string | null;
  feeVerifiedAt: string | null;
  feeExpiresAt: string | null;
  feeStale: boolean | null;
  apiCapabilities: string[];
  requiredAction: string | null;
  blockingReason: string | null;
  buySettlement: SideSettlement;
  sellSettlement: SideSettlement;

  /** The applied-fee resolution, or null when the endpoint did not describe it. */
  feeEvidence: VenueFeeEvidence | null;
};

const DAY_MS = 86_400_000;

export const FEE_MISS_FA: Record<string, string> = {
  no_evidence_for_mode: "شواهدی برای این حالت اجرا نیست",
  tier_mismatch: "ناسازگاری پله",
  expired: "منقضی",
  fees_missing: "نرخ ثبت نشده",
  reference_only_venue: "بدون حالت اجرایی"
};

export const EXECUTION_MODE_LABEL_FA: Record<string, string> = {
  ORDER_BOOK: "دفتر سفارش (معاملهٔ بازار)",
  EASY_TRADE: "خرید و فروش آسان",
  CONVERT: "تبدیل",
  OTC_QUOTE: "نقل‌قول OTC"
};

/**
 * Fee expiry from the same rule the accounts endpoint applies for staleness:
 * confirmation date + the re-verification window it reported. Returned as null
 * when either input is missing rather than guessed.
 */
export function feeExpiryIso(feeVerifiedAt: string | null, reverifyDays: number | null): string | null {
  if (!feeVerifiedAt || !reverifyDays || !Number.isFinite(reverifyDays)) return null;
  const t = Date.parse(feeVerifiedAt);
  if (!Number.isFinite(t)) return null;
  return new Date(t + reverifyDays * DAY_MS).toISOString();
}

export function settlementFor(sourceId: string, side: "buy" | "sell"): SideSettlement {
  const venue = PAPER_FEE_SETTLEMENT[sourceId as ShadowSourceId];
  return venue ? venue[side] : UNKNOWN_SETTLEMENT;
}

export type BuildVenueRowsInput = {
  certifications: Certification[];
  health: SourceHealthRow[];
  snapshots: NormalizedSourceSnapshot[];
  venues: VenueReadiness[];
  feeEvidence?: VenueFeeEvidence[];
  feeReverifyDays: number | null;
};

/**
 * One row per venue, ordered by the certification list the collector produced
 * so the table order matches every other Shadow surface.
 */
export function buildVenueRows(input: BuildVenueRowsInput): VenueRow[] {
  const healthById = new Map(input.health.map((h) => [h.sourceId, h]));
  const snapById = new Map<string, NormalizedSourceSnapshot>(
    input.snapshots.map((s) => [s.sourceId, s])
  );
  const venueById = new Map(input.venues.map((v) => [v.sourceId, v]));
  const feeEvidenceById = new Map((input.feeEvidence ?? []).map((f) => [f.sourceId, f]));

  // Union of every id any source described, so nothing silently disappears.
  const ids: string[] = [];
  for (const list of [
    input.certifications.map((c) => c.sourceId),
    input.venues.map((v) => v.sourceId),
    input.snapshots.map((s) => s.sourceId)
  ]) {
    for (const id of list) if (!ids.includes(id)) ids.push(id);
  }

  return ids.map((sourceId) => {
    const cert = input.certifications.find((c) => c.sourceId === sourceId) ?? null;
    const h = healthById.get(sourceId) ?? null;
    const snap = snapById.get(sourceId) ?? null;
    const v = venueById.get(sourceId) ?? null;
    const referenceOnly =
      cert?.status === "REFERENCE_ONLY" ||
      v?.accountState === "REFERENCE_ONLY" ||
      snap?.marketModel === "REFERENCE";

    return {
      sourceId,
      nameFa: v?.nameFa ?? cert?.sourceName ?? snap?.sourceName ?? sourceId,
      marketSymbol: cert?.marketSymbol ?? null,
      marketModel: cert?.marketModel ?? snap?.marketModel ?? null,
      referenceOnly,

      certStatus: cert?.status ?? null,
      health: snap?.health ?? null,
      ageMs: snap?.ageMs ?? null,
      freshnessPercent: h?.freshnessPercent ?? null,
      availabilityPercent: h?.uptimePercent ?? null,
      errorRatePercent: h?.errorRatePercent ?? null,
      samples: h?.samples ?? null,
      lastError: h?.lastError ?? cert?.lastError ?? null,
      lastErrorAt: h?.lastErrorAt ?? null,
      latencyP50Ms: h?.latencyP50Ms ?? null,
      latencyP95Ms: h?.latencyP95Ms ?? null,
      lastProbeAt: cert?.lastProbeAt ?? null,

      accountState: v?.accountState ?? null,
      kycComplete: v?.kycComplete ?? null,
      executionEligible: v?.executionEligible ?? null,
      ineligibleReason: v?.ineligibleReason ?? null,
      takerFeeBps: v?.takerFeeBps ?? null,
      makerFeeBps: v?.makerFeeBps ?? null,
      feeProvenance: v?.feeProvenance ?? null,
      feeTier: v?.feeTier ?? null,
      officialSourceUrl: v?.officialSourceUrl ?? null,
      feeVerifiedAt: v?.feeVerifiedAt ?? null,
      // The server knows the per-confirmation validity; only fall back locally.
      feeExpiresAt: v?.feeExpiresAt ?? feeExpiryIso(v?.feeVerifiedAt ?? null, input.feeReverifyDays),
      feeStale: v?.feeStale ?? null,
      apiCapabilities: v?.apiCapabilities ?? [],
      requiredAction: v?.requiredAction ?? null,
      blockingReason: v?.blockingReason ?? null,
      buySettlement: settlementFor(sourceId, "buy"),
      sellSettlement: settlementFor(sourceId, "sell"),
      feeEvidence: feeEvidenceById.get(sourceId) ?? null
    };
  });
}

export type VenueSummary = {
  total: number;
  /** Venues whose identity verification the admin has confirmed. */
  kycConfirmed: number;
  healthy: number;
  degraded: number;
  unavailable: number;
  accountsReady: number;
  referenceOnly: number;
  feesCurrent: number;
  feesStale: number;
  feesUnknown: number;
  /** Venues whose applied rate matched venue + execution mode + tier in force. */
  feeEvidenceMatched: number;
  /** Venues that failed closed, counted by the exact miss. */
  feeEvidenceBlocked: number;
};

/**
 * Counts for the compact summary strip.
 *
 * A fee counts as current only when its provenance is a real document or an
 * admin confirmation AND it has not expired. Anything provisional, expired or
 * absent is counted honestly in its own bucket instead of being rounded up.
 */
export function summarizeVenues(rows: VenueRow[]): VenueSummary {
  const summary: VenueSummary = {
    total: rows.length,
    kycConfirmed: 0,
    healthy: 0,
    degraded: 0,
    unavailable: 0,
    accountsReady: 0,
    referenceOnly: 0,
    feesCurrent: 0,
    feesStale: 0,
    feesUnknown: 0,
    feeEvidenceMatched: 0,
    feeEvidenceBlocked: 0
  };
  for (const r of rows) {
    if (r.health === "healthy") summary.healthy += 1;
    else if (r.health === "degraded") summary.degraded += 1;
    else if (r.health === "unavailable") summary.unavailable += 1;

    if (r.kycComplete) summary.kycConfirmed += 1;
    if (r.accountState === "VERIFIED") summary.accountsReady += 1;
    if (r.referenceOnly) summary.referenceOnly += 1;

    if (r.feeEvidence) {
      if (r.feeEvidence.ok) summary.feeEvidenceMatched += 1;
      else summary.feeEvidenceBlocked += 1;
    }

    const documented =
      r.feeProvenance === "OFFICIAL_PUBLISHED" || r.feeProvenance === "ADMIN_CONFIRMED";
    if (r.feeProvenance === null || r.feeProvenance === "UNKNOWN" || r.takerFeeBps === null) {
      summary.feesUnknown += 1;
    } else if (r.feeStale || !documented) {
      summary.feesStale += 1;
    } else {
      summary.feesCurrent += 1;
    }
  }
  return summary;
}
