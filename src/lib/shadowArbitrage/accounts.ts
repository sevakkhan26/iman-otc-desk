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

/** Where a fee number came from. UNKNOWN is a first-class, safe answer. */
export type FeeProvenance = "OFFICIAL_PUBLISHED" | "ADMIN_CONFIRMED" | "PROVISIONAL" | "UNKNOWN";

export type ApiCapability = "PUBLIC_MARKET_DATA" | "ACCOUNT_FEE_TIER" | "NONE_VERIFIED";

export type VenueReadiness = {
  sourceId: ShadowSourceId;
  nameFa: string;
  accountState: AccountState;
  /** Fee actually applied by the engine, in basis points; null when unknown. */
  takerFeeBps: number | null;
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
  bitpin: "NEEDS_ACCOUNT",
  abantether: "NEEDS_ACCOUNT",
  ramzinex: "NEEDS_ACCOUNT",
  tetherland: "NEEDS_ACCOUNT",
  bit24: "NEEDS_ACCOUNT",
  arzinja: "REFERENCE_ONLY"
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
  feeTier: string | null;
  sourceUrl: string | null;
  confirmedBy: string;
  confirmedAt: string;
  note: string | null;
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
  nowMs: number = Date.now()
): VenueReadiness {
  const cfg = getSourceConfig(sourceId);
  const accountState = ACCOUNT_STATE[sourceId];

  let takerFeeBps: number | null = null;
  let feeProvenance: FeeProvenance = "UNKNOWN";
  let feeTier: string | null = null;
  let officialSourceUrl: string | null = cfg.feeReferenceUrl;
  let feeVerifiedAt: string | null = null;

  if (override) {
    takerFeeBps = override.takerFeeBps;
    feeProvenance = "ADMIN_CONFIRMED";
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

  const feeStale =
    feeProvenance !== "UNKNOWN" &&
    (feeVerifiedAt === null || daysBetween(feeVerifiedAt, nowMs) > FEE_REVERIFY_DAYS);

  const apiCapabilities: ApiCapability[] = [];
  if (PUBLIC_DATA_VERIFIED[sourceId]) apiCapabilities.push("PUBLIC_MARKET_DATA");
  if (!apiCapabilities.length) apiCapabilities.push("NONE_VERIFIED");

  let requiredAction: string;
  let blockingReason: string | null = null;

  if (accountState === "REFERENCE_ONLY") {
    requiredAction = "اقدامی لازم نیست — این منبع فقط برای مقایسه است.";
    blockingReason = "منبع فقط مرجع است و اجرای آن تأیید نشده.";
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
    takerFeeBps,
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
  nowMs: number = Date.now()
): VenueReadiness[] {
  const byId = new Map(overrides.map((o) => [o.sourceId, o]));
  return SHADOW_SOURCES.map((cfg) => buildVenueReadiness(cfg.id, byId.get(cfg.id) ?? null, nowMs));
}

/**
 * Whether this venue may back a valid, net-positive opportunity.
 * Unknown fee, unusable account or reference-only status all disqualify it.
 */
export function venueUsableForNetProfit(r: VenueReadiness): boolean {
  return (
    r.accountState === "VERIFIED" &&
    r.takerFeeBps !== null &&
    r.feeProvenance !== "UNKNOWN" &&
    !r.feeStale
  );
}
