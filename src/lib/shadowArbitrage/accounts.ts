/**
 * Phase 4 — exchange account and fee readiness for the nine Shadow venues.
 *
 * Evidence rules:
 *  - a fee value exists only when an official published source was checked;
 *  - anything unverified, inaccessible or ambiguous stays UNKNOWN;
 *  - nothing here contacts an exchange, requests credentials, or stores keys.
 *
 * OMPFinex is intentionally absent: it belongs to the main OTC project only.
 */
import { SHADOW_SOURCES, getSourceConfig } from "@/lib/shadowArbitrage/config";
import type { ShadowSourceId } from "@/lib/shadowArbitrage/types";

/** How usable the venue's account is for the desk today. */
export type AccountState = "VERIFIED" | "NEEDS_ACCOUNT" | "REFERENCE_ONLY";

/**
 * Where a fee number came from. UNKNOWN is a first-class, safe answer.
 * ADMIN_CONFIRMED_SCREENSHOT is an admin confirmation evidenced by a screenshot
 * of the venue's own panel rather than a published document.
 */
export type FeeProvenance =
  | "OFFICIAL_PUBLISHED"
  | "ADMIN_CONFIRMED"
  | "ADMIN_CONFIRMED_SCREENSHOT"
  | "PROVISIONAL"
  | "UNKNOWN";

export type ApiCapability = "PUBLIC_MARKET_DATA" | "ACCOUNT_FEE_TIER" | "NONE_VERIFIED";

export type VenueReadiness = {
  sourceId: ShadowSourceId;
  nameFa: string;
  accountState: AccountState;
  /** Identity verification finished at this venue, per admin evidence. */
  kycComplete: boolean;
  /**
   * Whether this venue may ever back an execution. Deliberately separate from
   * KYC: a fully verified venue can still be barred (degraded data feed,
   * reference-only venue), and that bar outranks any fee evidence.
   */
  executionEligible: boolean;
  ineligibleReason: string | null;
  /** Fee actually applied by the engine, in basis points; null when unknown. */
  takerFeeBps: number | null;
  /** Reference only until maker-order simulation exists; never settled. */
  makerFeeBps: number | null;
  /** Quoted-market / easy-trade rates. Never applied to USDT/IRT maths. */
  referenceMetadata: Record<string, unknown> | null;
  /** Days this confirmation stays valid; null falls back to the global window. */
  feeValidDays: number | null;
  /** When this evidence expires, derived from confirmation date + validity. */
  feeExpiresAt: string | null;
  feeProvenance: FeeProvenance;
  /** Named tier, when the venue publishes tiers and one was confirmed. */
  feeTier: string | null;
  officialSourceUrl: string | null;
  /** ISO date the fee evidence was last checked. */
  feeVerifiedAt: string | null;
  feeStale: boolean;
  apiCapabilities: ApiCapability[];
  requiredAction: string;
  blockingReason: string | null;
  notes: string;
};

/** Fee evidence must be re-checked at least this often. */
export const FEE_REVERIFY_DAYS = 90;

/**
 * Account state per venue. Verified = the desk already holds a usable account.
 * This is configuration, not something the code can discover on its own.
 */
const ACCOUNT_STATE: Record<ShadowSourceId, AccountState> = {
  nobitex: "VERIFIED",
  wallex: "VERIFIED",
  tabdeal: "VERIFIED",
  bitpin: "VERIFIED",
  abantether: "VERIFIED",
  ramzinex: "VERIFIED",
  tetherland: "VERIFIED",
  bit24: "VERIFIED",
  /*
   * Arzinja is no longer reference-only: its P2P order book is a documented
   * public endpoint whose direction, units, depth and freshness are certified
   * per cycle. The venue still has to clear every gate every cycle, like the
   * other eight — promotion removes a blanket bar, not the checks.
   */
  arzinja: "VERIFIED"
};

/** Public market data is verified per venue by the certification layer. */
const PUBLIC_DATA_VERIFIED: Record<ShadowSourceId, boolean> = {
  nobitex: true,
  wallex: true,
  tabdeal: true,
  bitpin: true,
  abantether: true,
  ramzinex: true,
  tetherland: true,
  bit24: true,
  arzinja: true
};

export type FeeOverride = {
  sourceId: string;
  takerFeeBps: number;
  makerFeeBps?: number | null;
  feeTier: string | null;
  sourceUrl: string | null;
  provenance?: string | null;
  validDays?: number | null;
  referenceMetadata?: Record<string, unknown> | null;
  confirmedBy: string;
  confirmedAt: string;
  note: string | null;
};

/** Admin-confirmed account evidence, as the readiness layer consumes it. */
export type AccountOverride = {
  sourceId: string;
  kycComplete: boolean;
  accountState: string;
  executionEligible: boolean;
  ineligibleReason: string | null;
  provenance: string;
  validDays?: number | null;
  confirmedAt: string;
};

function daysBetween(fromIso: string, toMs: number): number {
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (toMs - from) / 86_400_000);
}

/**
 * Build the readiness row for one venue.
 *
 * An admin-confirmed fee tier (Phase 4 UI) takes precedence over the provisional
 * config value, because it is real evidence about this desk's account. It never
 * introduces a fee where none was confirmed.
 */
export function buildVenueReadiness(
  sourceId: ShadowSourceId,
  override?: FeeOverride | null,
  nowMs: number = Date.now(),
  accountOverride?: AccountOverride | null
): VenueReadiness {
  const cfg = getSourceConfig(sourceId);

  /*
   * Admin evidence outranks the compiled-in default, but only in the safe
   * direction: it can confirm an account, and it can bar a venue from
   * execution. A confirmation can never make a REFERENCE_ONLY venue executable.
   */
  const configState = ACCOUNT_STATE[sourceId];
  const accountState: AccountState =
    configState === "REFERENCE_ONLY"
      ? "REFERENCE_ONLY"
      : accountOverride && accountOverride.accountState === "VERIFIED"
        ? "VERIFIED"
        : configState;
  const kycComplete = accountOverride?.kycComplete ?? configState === "VERIFIED";
  const executionEligible =
    configState === "REFERENCE_ONLY"
      ? false
      : accountOverride
        ? accountOverride.executionEligible
        : accountState === "VERIFIED";
  const ineligibleReason =
    configState === "REFERENCE_ONLY"
      ? "منبع فقط مرجع است و هیچ‌گاه مبنای اجرا قرار نمی‌گیرد."
      : executionEligible
        ? null
        : (accountOverride?.ineligibleReason ?? "این صرافی برای اجرا واجد شرایط نیست.");

  let takerFeeBps: number | null = null;
  let makerFeeBps: number | null = null;
  let referenceMetadata: Record<string, unknown> | null = null;
  let feeValidDays: number | null = null;
  let feeProvenance: FeeProvenance = "UNKNOWN";
  let feeTier: string | null = null;
  let officialSourceUrl: string | null = cfg.feeReferenceUrl;
  let feeVerifiedAt: string | null = null;

  if (override) {
    takerFeeBps = override.takerFeeBps;
    makerFeeBps = override.makerFeeBps ?? null;
    referenceMetadata = override.referenceMetadata ?? null;
    feeValidDays = override.validDays ?? null;
    feeProvenance =
      override.provenance === "ADMIN_CONFIRMED_SCREENSHOT"
        ? "ADMIN_CONFIRMED_SCREENSHOT"
        : override.provenance === "OFFICIAL_PUBLISHED"
          ? "OFFICIAL_PUBLISHED"
          : "ADMIN_CONFIRMED";
    feeTier = override.feeTier;
    officialSourceUrl = override.sourceUrl ?? cfg.feeReferenceUrl;
    feeVerifiedAt = override.confirmedAt;
  } else if (cfg.feeBps !== null && cfg.feeStatus === "official") {
    takerFeeBps = cfg.feeBps;
    feeProvenance = "OFFICIAL_PUBLISHED";
    feeVerifiedAt = cfg.feeVerifiedAt;
  } else if (cfg.feeBps !== null) {
    // Kept as a conservative working value, but never presented as verified.
    takerFeeBps = cfg.feeBps;
    feeProvenance = "PROVISIONAL";
    feeVerifiedAt = cfg.feeVerifiedAt;
  }

  /*
   * A confirmation may carry its own, shorter validity. Screenshot evidence of
   * a live fee tier ages faster than a published schedule, so the tighter of
   * the two windows always wins.
   */
  const windowDays = feeValidDays !== null ? Math.min(feeValidDays, FEE_REVERIFY_DAYS) : FEE_REVERIFY_DAYS;
  const feeStale =
    feeProvenance !== "UNKNOWN" &&
    (feeVerifiedAt === null || daysBetween(feeVerifiedAt, nowMs) > windowDays);
  const feeExpiresAt =
    feeVerifiedAt && Number.isFinite(Date.parse(feeVerifiedAt))
      ? new Date(Date.parse(feeVerifiedAt) + windowDays * 86_400_000).toISOString()
      : null;

  const apiCapabilities: ApiCapability[] = [];
  if (PUBLIC_DATA_VERIFIED[sourceId]) apiCapabilities.push("PUBLIC_MARKET_DATA");
  if (!apiCapabilities.length) apiCapabilities.push("NONE_VERIFIED");

  let requiredAction: string;
  let blockingReason: string | null = null;

  if (accountState === "REFERENCE_ONLY") {
    requiredAction = "اقدامی لازم نیست — این منبع فقط برای مقایسه است.";
    blockingReason = "منبع فقط مرجع است و اجرای آن تأیید نشده.";
  } else if (!executionEligible) {
    requiredAction = "رفع اختلال منبع پیش از هرگونه اجراپذیری.";
    blockingReason = ineligibleReason;
  } else if (accountState === "NEEDS_ACCOUNT") {
    requiredAction = "افتتاح و احراز هویت حساب در این صرافی.";
    blockingReason = "حساب کاربری احرازشده وجود ندارد.";
  } else if (feeProvenance === "UNKNOWN") {
    requiredAction = "ثبت پلهٔ کارمزد رسمی حساب از پنل صرافی.";
    blockingReason = "کارمزد این صرافی تأیید نشده است.";
  } else if (feeProvenance === "PROVISIONAL") {
    requiredAction = "تأیید پلهٔ واقعی کارمزد حساب و ثبت آن در همین صفحه.";
    blockingReason = "کارمزد موقت است و از سند رسمی حساب تأیید نشده.";
  } else if (feeStale) {
    requiredAction = `بازبینی کارمزد (بیش از ${FEE_REVERIFY_DAYS} روز از آخرین تأیید گذشته).`;
    blockingReason = "اعتبار کارمزد منقضی شده است.";
  } else {
    requiredAction = "اقدامی لازم نیست.";
  }

  return {
    sourceId,
    nameFa: cfg.nameFa,
    accountState,
    kycComplete,
    executionEligible,
    ineligibleReason,
    takerFeeBps,
    makerFeeBps,
    referenceMetadata,
    feeValidDays,
    feeExpiresAt,
    feeProvenance,
    feeTier,
    officialSourceUrl,
    feeVerifiedAt,
    feeStale,
    apiCapabilities,
    requiredAction,
    blockingReason,
    notes: cfg.feeExplanation
  };
}

export function buildAllReadiness(
  overrides: FeeOverride[] = [],
  nowMs: number = Date.now(),
  accountOverrides: AccountOverride[] = []
): VenueReadiness[] {
  const byId = new Map(overrides.map((o) => [o.sourceId, o]));
  const accountsById = new Map(accountOverrides.map((a) => [a.sourceId, a]));
  return SHADOW_SOURCES.map((cfg) =>
    buildVenueReadiness(cfg.id, byId.get(cfg.id) ?? null, nowMs, accountsById.get(cfg.id) ?? null)
  );
}

/**
 * Whether this venue may back a valid, net-positive opportunity.
 * Unknown fee, unusable account or reference-only status all disqualify it.
 */
export function venueUsableForNetProfit(r: VenueReadiness): boolean {
  return (
    r.accountState === "VERIFIED" &&
    // A barred venue never becomes usable, however good its fee evidence is.
    r.executionEligible &&
    r.takerFeeBps !== null &&
    r.feeProvenance !== "UNKNOWN" &&
    !r.feeStale
  );
}
