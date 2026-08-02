import type {
  AccountStatus,
  FeeStatus,
  MarketModel,
  OpportunityEligibility,
  ShadowSourceId,
  ShadowTradeSizeUsdt
} from "@/lib/shadowArbitrage/types";

export const SHADOW_BANNER =
  "SHADOW MODE — NO REAL ORDERS OR FUND TRANSFERS · حالت سایه — بدون سفارش واقعی یا انتقال وجه";

export const SHADOW_TRADE_SIZES: ShadowTradeSizeUsdt[] = [5, 10, 20, 25];

/** Default poll cadence for the background collector. */
export const SHADOW_POLL_INTERVAL_MS = 30_000;

/** Safe configurable polling range. */
export const SHADOW_POLL_MIN_MS = 15_000;
export const SHADOW_POLL_MAX_MS = 300_000;

/** Snapshot older than this is stale for executable routes. */
export const SHADOW_STALE_MS = 90_000;

/** Retention for opportunity history (spec minimum: 14 days). */
export const SHADOW_RETENTION_DAYS = 14;

/** Target observation window. */
export const SHADOW_OBSERVATION_TARGET_MS = SHADOW_RETENTION_DAYS * 24 * 60 * 60_000;

/**
 * A 14-day observation only counts as complete with enough real coverage.
 * Declared here so the capital simulator can gate on it without importing the
 * database layer.
 */
export const REQUIRED_SUCCESS_COVERAGE_PERCENT = 80;

/** Minimum spacing between manual (UI) refresh collections. */
export const SHADOW_MANUAL_REFRESH_MIN_MS = 15_000;

/** Heartbeat lease length as a multiple of the poll interval. */
export const SHADOW_LEASE_MULTIPLIER = 3;

/** Per-source retry policy for public endpoints. */
export const SHADOW_MAX_ATTEMPTS = 3;
export const SHADOW_BACKOFF_BASE_MS = 400;
export const SHADOW_BACKOFF_MAX_MS = 4_000;
/** Extra wait applied after an HTTP 429/418 before the next attempt. */
export const SHADOW_RATE_LIMIT_BACKOFF_MS = 5_000;

/** Clamp any requested interval into the safe range. */
export function clampPollInterval(ms: number | undefined | null): number {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return SHADOW_POLL_INTERVAL_MS;
  return Math.min(SHADOW_POLL_MAX_MS, Math.max(SHADOW_POLL_MIN_MS, Math.round(n)));
}

/** Interval from env (worker/collector), clamped. */
export function pollIntervalFromEnv(): number {
  return clampPollInterval(Number(process.env.SHADOW_POLL_MS ?? SHADOW_POLL_INTERVAL_MS));
}

/**
 * Cost inputs kept separate from fees so raw spread, fees, buffers and net edge
 * never collapse into one number.
 */
export type CostRecord = {
  key: string;
  label: string;
  value: number;
  unit: "bps_of_buy_cost" | "toman_per_route";
  status: FeeStatus;
  reference: string | null;
  verifiedAt: string | null;
  explanation: string;
};

/** Slippage / risk buffer as bps of buy cost (provisional). */
export const SLIPPAGE_BUFFER_BPS = 5; // 0.05%

/** Allocated rebalancing cost in toman per route (provisional constant). */
export const REBALANCE_COST_TOMAN = 0;

export const SHADOW_COST_RECORDS: CostRecord[] = [
  {
    key: "slippage_buffer",
    label: "بافر لغزش/ریسک",
    value: SLIPPAGE_BUFFER_BPS,
    unit: "bps_of_buy_cost",
    status: "provisional",
    reference: null,
    verifiedAt: "2026-07-01",
    explanation:
      "۰٫۰۵٪ از هزینهٔ خرید به‌عنوان بافر لغزش. مقدار موقت است و از دادهٔ اجرای واقعی استخراج نشده."
  },
  {
    key: "rebalance_cost",
    label: "هزینهٔ بازتوازن",
    value: REBALANCE_COST_TOMAN,
    unit: "toman_per_route",
    status: "provisional",
    reference: null,
    verifiedAt: "2026-07-01",
    explanation:
      "صفر تومان به‌صورت موقت. هزینهٔ واقعی انتقال/بازتوازن بین صرافی‌ها بدون دادهٔ حساب قابل اثبات نیست."
  }
];

export type ShadowSourceConfig = {
  id: ShadowSourceId;
  nameFa: string;
  marketModel: MarketModel;
  accountStatus: AccountStatus;
  /** Base eligibility before live data quality */
  eligibilityBase: OpportunityEligibility;
  feeBps: number | null;
  feeStatus: FeeStatus;
  feeLabel: string;
  feeReferenceUrl: string | null;
  feeVerifiedAt: string | null;
  /** Why this fee value is what it is — surfaced in the UI, never inferred silently. */
  feeExplanation: string;
  enabled: boolean;
  timeoutMs: number;
  /** Documented or conservatively assumed public rate limit. */
  rateLimitNote: string;
  /** Minimum spacing we self-impose between requests to this host. */
  minRequestSpacingMs: number;
};

/**
 * Nine Phase-1 sources. OMPFinex is intentionally absent.
 * Account status is configuration-driven (verified = user has account).
 */
export const SHADOW_SOURCES: ShadowSourceConfig[] = [
  {
    id: "nobitex",
    nameFa: "نوبیتکس",
    marketModel: "ORDER_BOOK",
    accountStatus: "verified",
    eligibilityBase: "EXECUTABLE_NOW",
    feeBps: 25, // 0.25% provisional taker
    feeStatus: "provisional",
    feeLabel: "کارمزد taker موقت ۰٫۲۵٪",
    feeReferenceUrl: "https://nobitex.ir/fees/",
    feeVerifiedAt: "2026-07-01",
    feeExplanation:
      "۰٫۲۵٪ به‌عنوان مقدار موقت نگه داشته شده. پلهٔ کارمزد شخصی بدون دادهٔ حساب احرازشده قابل تعیین نیست.",
    enabled: true,
    timeoutMs: 12_000,
    rateLimitNote: "محدودیت نرخ عمومی مستند تأیید نشده — فاصلهٔ محافظه‌کارانه اعمال می‌شود.",
    minRequestSpacingMs: 1_000
  },
  {
    id: "wallex",
    nameFa: "والکس",
    marketModel: "ORDER_BOOK",
    accountStatus: "verified",
    eligibilityBase: "EXECUTABLE_NOW",
    feeBps: 35, // 0.35% conservative provisional
    feeStatus: "provisional",
    feeLabel: "کارمزد taker محافظه‌کارانه ۰٫۳۵٪",
    feeReferenceUrl: "https://wallex.ir/fees",
    feeVerifiedAt: "2026-07-01",
    feeExplanation:
      "۰٫۳۵٪ محافظه‌کارانه و موقت. جدول رسمی به‌صورت ماشین‌خوان تأیید نشده است.",
    enabled: true,
    timeoutMs: 10_000,
    rateLimitNote: "محدودیت نرخ عمومی مستند تأیید نشده — فاصلهٔ محافظه‌کارانه اعمال می‌شود.",
    minRequestSpacingMs: 1_000
  },
  {
    id: "tabdeal",
    nameFa: "تبدیل",
    marketModel: "ORDER_BOOK",
    accountStatus: "verified",
    eligibilityBase: "EXECUTABLE_NOW",
    feeBps: 35,
    feeStatus: "provisional",
    feeLabel: "کارمزد taker موقت ۰٫۳۵٪",
    feeReferenceUrl: null,
    feeVerifiedAt: "2026-07-01",
    feeExplanation:
      "۰٫۳۵٪ موقت. هیچ جدول کارمزد عمومی تأییدشده‌ای برای این منبع ثبت نشده است.",
    enabled: true,
    timeoutMs: 10_000,
    rateLimitNote: "محدودیت نرخ عمومی مستند تأیید نشده — فاصلهٔ محافظه‌کارانه اعمال می‌شود.",
    minRequestSpacingMs: 1_000
  },
  {
    id: "bitpin",
    nameFa: "بیت‌پین",
    marketModel: "ORDER_BOOK",
    accountStatus: "unverified",
    eligibilityBase: "ACCOUNT_REQUIRED",
    feeBps: null,
    feeStatus: "unknown",
    feeLabel: "کارمزد تأییدنشده",
    feeReferenceUrl: null,
    feeVerifiedAt: null,
    feeExplanation:
      "کارمزد نامشخص است؛ بنابراین فقط اسپرد خام گزارش می‌شود و نتیجه «پتانسیل خام» است نه سود انتظاری.",
    enabled: true,
    timeoutMs: 10_000,
    rateLimitNote: "محدودیت نرخ عمومی مستند تأیید نشده — فاصلهٔ محافظه‌کارانه اعمال می‌شود.",
    minRequestSpacingMs: 1_000
  },
  {
    id: "abantether",
    nameFa: "آبان‌تتر",
    marketModel: "OTC_QUOTE",
    accountStatus: "unverified",
    eligibilityBase: "ACCOUNT_REQUIRED",
    feeBps: null,
    feeStatus: "unknown",
    feeLabel: "کارمزد تأییدنشده (OTC)",
    feeReferenceUrl: null,
    feeVerifiedAt: null,
    feeExplanation:
      "در مدل OTC کارمزد معمولاً داخل اسپرد نقل‌قول است و جداگانه منتشر نمی‌شود؛ مقدار قابل اثبات نیست.",
    enabled: true,
    timeoutMs: 10_000,
    rateLimitNote: "محدودیت نرخ عمومی مستند تأیید نشده — فاصلهٔ محافظه‌کارانه اعمال می‌شود.",
    minRequestSpacingMs: 1_500
  },
  {
    id: "ramzinex",
    nameFa: "رمزینکس",
    marketModel: "ORDER_BOOK",
    accountStatus: "unverified",
    eligibilityBase: "ACCOUNT_REQUIRED",
    feeBps: null,
    feeStatus: "unknown",
    feeLabel: "کارمزد تأییدنشده",
    feeReferenceUrl: null,
    feeVerifiedAt: null,
    feeExplanation: "کارمزد عمومی تأییدنشده — نتایج این منبع «پتانسیل خام» هستند.",
    enabled: true,
    timeoutMs: 12_000,
    rateLimitNote: "ممکن است نیاز به پروکسی خروجی داشته باشد؛ فاصلهٔ محافظه‌کارانه اعمال می‌شود.",
    minRequestSpacingMs: 1_500
  },
  {
    id: "tetherland",
    nameFa: "تترلند",
    marketModel: "ORDER_BOOK",
    accountStatus: "verified",
    eligibilityBase: "EXECUTABLE_NOW",
    feeBps: null,
    feeStatus: "unknown",
    feeLabel: "کارمزد تأییدنشده",
    feeReferenceUrl: null,
    feeVerifiedAt: null,
    feeExplanation: "کارمزد عمومی تأییدنشده — نتایج این منبع «پتانسیل خام» هستند.",
    enabled: true,
    timeoutMs: 12_000,
    rateLimitNote: "نیازمند هدرهای مرورگرمانند؛ فاصلهٔ محافظه‌کارانه اعمال می‌شود.",
    minRequestSpacingMs: 1_500
  },
  {
    id: "bit24",
    nameFa: "بیت۲۴",
    marketModel: "ORDER_BOOK",
    accountStatus: "unverified",
    eligibilityBase: "ACCOUNT_REQUIRED",
    feeBps: null,
    feeStatus: "unknown",
    feeLabel: "کارمزد تأییدنشده",
    feeReferenceUrl: null,
    feeVerifiedAt: null,
    feeExplanation: "کارمزد عمومی تأییدنشده — نتایج این منبع «پتانسیل خام» هستند.",
    enabled: true,
    timeoutMs: 12_000,
    rateLimitNote: "ممکن است WAF برخی IPها را محدود کند؛ فاصلهٔ محافظه‌کارانه اعمال می‌شود.",
    minRequestSpacingMs: 1_500
  },
  {
    id: "arzinja",
    nameFa: "ارزینجا",
    /*
     * Promoted from REFERENCE after certification: the P2P order book is a
     * documented public endpoint, its direction is proved per cycle, and it
     * publishes real multi-level depth. It is now walked like any other book.
     */
    marketModel: "ORDER_BOOK",
    accountStatus: "verified",
    eligibilityBase: "EXECUTABLE_NOW",
    feeBps: null,
    feeStatus: "unknown",
    feeLabel: "کارمزد از شواهد پلکان حساب خوانده می‌شود",
    feeReferenceUrl: null,
    feeVerifiedAt: null,
    /*
     * The old text read "this source is reference-only; neither its fee nor its
     * executability is confirmed" — untrue on both counts since the promotion,
     * and it is rendered verbatim on the venue card.
     */
    feeExplanation:
      "کارمزد این صرافی از شواهد پلکان حساب (صرافی + حالت اجرا + پلهٔ جاری) خوانده می‌شود و در نبود تطابق، نرخی اعمال نمی‌شود.",
    enabled: true,
    timeoutMs: 12_000,
    rateLimitNote: "API عمومی پایدار تأیید نشده — فاصلهٔ محافظه‌کارانه اعمال می‌شود.",
    minRequestSpacingMs: 2_000
  }
];

export function getSourceConfig(id: ShadowSourceId): ShadowSourceConfig {
  const c = SHADOW_SOURCES.find((s) => s.id === id);
  if (!c) throw new Error(`unknown shadow source ${id}`);
  return c;
}
