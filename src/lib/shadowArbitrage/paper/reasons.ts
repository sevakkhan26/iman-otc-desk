/**
 * Phase 6 / v4.9.1 — exact decision reasons for the paper engine.
 *
 * A rejected candidate must always carry the reason the upstream layers already
 * established. A generic "this was blocked" message is never an acceptable
 * substitute for a known cause: it destroys the only evidence that makes a
 * rejection actionable, and it makes every rejection look identical, which is
 * what turned one cycle into 242 indistinguishable rows.
 *
 * Pure module: no database, no network.
 */
import type { BlockedReasonCode, OpportunityEligibility } from "@/lib/shadowArbitrage/types";

/** Every reason the paper engine may record. Deliberately specific. */
export type PaperReasonCode =
  // upstream opportunity state
  | "account_not_ready"
  | "fee_unknown"
  | "fee_stale"
  | "fee_settlement_unknown"
  | "fee_settlement_unsupported"
  | "net_non_positive"
  | "insufficient_depth"
  | "reference_only"
  | "source_unhealthy"
  | "stale_market_data"
  | "market_data_missing"
  | "market_data_unverified"
  | "rate_limited"
  | "same_venue"
  // paper-engine state
  | "mark_price_unavailable"
  | "insufficient_irt"
  | "insufficient_usdt"
  | "negative_balance_guard"
  | "no_balance_record"
  | "lifecycle_already_processed"
  | "size_not_selected"
  | "venue_not_executable";

export const PAPER_REASON_FA: Record<PaperReasonCode, string> = {
  account_not_ready: "حساب کاربری صرافی آماده نیست",
  fee_unknown: "کارمزد تأییدنشده",
  fee_stale: "اعتبار کارمزد منقضی شده است",
  fee_settlement_unknown: "نحوهٔ تسویهٔ کارمزد (دارایی و سمت) تأیید نشده است",
  fee_settlement_unsupported: "ترکیب دارایی و نحوهٔ کسر کارمزد برای این سمت معنا ندارد",
  net_non_positive: "سود خالص اقتصادی پس از کارمزد و بافر مثبت نیست",
  insufficient_depth: "عمق دفتر برای این حجم کافی نیست",
  reference_only: "منبع فقط مرجع است و اجراپذیر نیست",
  source_unhealthy: "منبع ناسالم یا گواهی‌نشده است",
  stale_market_data: "دادهٔ بازار کهنه است",
  market_data_missing: "دادهٔ بازار برای این حجم موجود نیست",
  market_data_unverified: "واحد یا جهت قیمت تأیید نشده است",
  rate_limited: "محدودیت نرخ درخواست منبع",
  same_venue: "خرید و فروش روی یک صرافی",
  mark_price_unavailable: "قیمت مرجع تتر در همین چرخه در دسترس یا تازه نیست",
  insufficient_irt: "موجودی تومانی صرافی خرید کافی نیست",
  insufficient_usdt: "موجودی تتری صرافی فروش کافی نیست",
  negative_balance_guard: "این معامله موجودی را منفی می‌کرد",
  no_balance_record: "برای این صرافی موجودی مجازی ثبت نشده است",
  lifecycle_already_processed: "این فرصت قبلاً در همین نشست پردازش شده است",
  size_not_selected: "حجم بهتری برای همین مسیر انتخاب شد",
  venue_not_executable: "صرافی اجراپذیر نیست"
};

/**
 * Upstream blocked-reason codes mapped onto paper reasons, one to one where a
 * distinct cause exists. Nothing collapses into a catch-all.
 */
const FROM_UPSTREAM: Record<BlockedReasonCode, PaperReasonCode> = {
  fee_unknown: "fee_unknown",
  stale_buy_source: "stale_market_data",
  stale_sell_source: "stale_market_data",
  insufficient_buy_depth: "insufficient_depth",
  insufficient_sell_depth: "insufficient_depth",
  account_required: "account_not_ready",
  reference_only: "reference_only",
  source_unhealthy: "source_unhealthy",
  quote_direction_unverified: "market_data_unverified",
  market_data_missing: "market_data_missing",
  same_venue: "same_venue",
  non_positive_net: "net_non_positive",
  depth_unverified: "insufficient_depth",
  quote_max_unverified: "insufficient_depth",
  units_ambiguous: "market_data_unverified",
  rate_limited: "rate_limited",
  source_not_certified: "source_unhealthy"
};

/**
 * Priority when a candidate carries several reasons at once.
 *
 * The primary reason is the most fundamental one — the thing that must be fixed
 * first. Ordering is fixed so the same set of causes always yields the same
 * primary, which is what keeps the compact per-cycle counts stable.
 */
const PRIORITY: PaperReasonCode[] = [
  "same_venue",
  "reference_only",
  "account_not_ready",
  "venue_not_executable",
  "fee_unknown",
  "fee_stale",
  "fee_settlement_unknown",
  "fee_settlement_unsupported",
  "source_unhealthy",
  "rate_limited",
  "stale_market_data",
  "market_data_missing",
  "market_data_unverified",
  "insufficient_depth",
  "mark_price_unavailable",
  "net_non_positive",
  "insufficient_irt",
  "insufficient_usdt",
  "negative_balance_guard",
  "no_balance_record",
  "lifecycle_already_processed",
  "size_not_selected"
];

const PRIORITY_INDEX = new Map(PRIORITY.map((code, i) => [code, i]));

/** Deterministic primary reason from a set. Never returns a generic value. */
export function primaryReason(codes: PaperReasonCode[]): PaperReasonCode {
  if (!codes.length) throw new Error("primaryReason requires at least one reason");
  return [...codes].sort(
    (a, b) => (PRIORITY_INDEX.get(a) ?? 999) - (PRIORITY_INDEX.get(b) ?? 999) || a.localeCompare(b)
  )[0];
}

/** Sorted, de-duplicated reason list — the canonical form stored and compared. */
export function normalizeReasons(codes: PaperReasonCode[]): PaperReasonCode[] {
  return [...new Set(codes)].sort(
    (a, b) => (PRIORITY_INDEX.get(a) ?? 999) - (PRIORITY_INDEX.get(b) ?? 999) || a.localeCompare(b)
  );
}

/**
 * Translate an opportunity's own state into exact paper reasons.
 * `feeStale` comes from Phase 4 readiness, which the opportunity does not carry.
 */
export function reasonsFromOpportunity(input: {
  eligibility: OpportunityEligibility;
  blockedReasons: BlockedReasonCode[];
  feeUnknown: boolean;
  buyFeeStale?: boolean;
  sellFeeStale?: boolean;
}): PaperReasonCode[] {
  const out: PaperReasonCode[] = [];
  for (const r of input.blockedReasons ?? []) {
    const mapped = FROM_UPSTREAM[r];
    if (mapped) out.push(mapped);
  }
  if (input.eligibility === "REFERENCE_ONLY") out.push("reference_only");
  if (input.eligibility === "ACCOUNT_REQUIRED") out.push("account_not_ready");
  if (input.feeUnknown) out.push("fee_unknown");
  if (input.buyFeeStale || input.sellFeeStale) out.push("fee_stale");
  return normalizeReasons(out);
}

/** Stable key for "has this candidate's decision changed since last cycle?". */
export function reasonKey(outcome: string, codes: PaperReasonCode[]): string {
  return `${outcome}:${normalizeReasons(codes).join(",")}`;
}

export function reasonLabel(code: string): string {
  return PAPER_REASON_FA[code as PaperReasonCode] ?? code;
}
