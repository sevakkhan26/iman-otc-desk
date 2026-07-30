/**
 * Persian labels and formatting for the Shadow Arbitrage dashboard.
 *
 * Technical codes never reach the user directly: every blocked reason and status
 * has a plain-Persian explanation, and the raw code is only shown in a tooltip
 * or the details drawer.
 */
import type { BlockedReasonCode, OpportunityEligibility } from "@/lib/shadowArbitrage/types";

export const SHADOW_WARNING_FA = "حالت آزمایشی — هیچ سفارش یا انتقال واقعی انجام نمی‌شود";

/* ── observation / collector state ─────────────────────────────────────────── */

export type CollectorState = "watching" | "offline" | "stopped" | "degraded" | "stale" | "completed";

export const COLLECTOR_STATE_FA: Record<CollectorState, string> = {
  watching: "در حال پایش",
  offline: "جمع‌آورنده آفلاین",
  stopped: "متوقف",
  degraded: "اختلال جزئی",
  stale: "داده قدیمی",
  completed: "دوره تکمیل‌شده"
};

export function collectorTone(state: CollectorState): "good" | "warn" | "danger" | "muted" {
  if (state === "watching") return "good";
  if (state === "completed") return "muted";
  if (state === "stopped" || state === "offline") return "danger";
  return "warn";
}

/** Derive one honest headline state from observation + worker facts. */
export function deriveCollectorState(input: {
  observationStatus?: string | null;
  workerStale?: boolean | null;
  workerRunning?: boolean | null;
  lastSuccessAgeMs?: number | null;
  pollIntervalMs?: number | null;
}): CollectorState {
  if (input.observationStatus === "COMPLETED") return "completed";
  if (input.observationStatus === "PAUSED" || input.observationStatus === "NOT_STARTED") {
    return "stopped";
  }
  // Session says RUNNING but nothing is collecting: the collector is offline.
  if (!input.workerRunning || input.workerStale) return "offline";
  const budget = Math.max((input.pollIntervalMs ?? 30_000) * 3, 120_000);
  if (input.lastSuccessAgeMs !== null && input.lastSuccessAgeMs !== undefined) {
    if (input.lastSuccessAgeMs > budget) return "stale";
  }
  if (input.observationStatus === "DEGRADED") return "degraded";
  return "watching";
}

/* ── eligibility ───────────────────────────────────────────────────────────── */

export const ELIGIBILITY_FA: Record<OpportunityEligibility, string> = {
  EXECUTABLE_NOW: "قابل استفاده با حساب فعلی",
  ACCOUNT_REQUIRED: "نیازمند افتتاح حساب",
  REFERENCE_ONLY: "فقط مرجع",
  BLOCKED: "غیرقابل استفاده"
};

export function eligibilityTone(e: OpportunityEligibility): "good" | "warn" | "muted" | "danger" {
  if (e === "EXECUTABLE_NOW") return "good";
  if (e === "ACCOUNT_REQUIRED") return "warn";
  if (e === "REFERENCE_ONLY") return "muted";
  return "danger";
}

/* ── blocked reasons ───────────────────────────────────────────────────────── */

export type BlockedExplanation = { short: string; detail: string };

/**
 * Understandable Persian for every blocked code. `short` is the chip text,
 * `detail` explains what the admin should conclude.
 */
export const BLOCKED_FA: Record<BlockedReasonCode, BlockedExplanation> = {
  fee_unknown: {
    short: "کارمزد نامشخص",
    detail:
      "کارمزد رسمی یکی از دو صرافی تأیید نشده است، بنابراین فقط اسپرد خام گزارش می‌شود و سود خالص محاسبه نمی‌شود."
  },
  stale_buy_source: {
    short: "دادهٔ صرافی خرید قدیمی",
    detail: "آخرین قیمت دریافتی از صرافی خرید از بودجهٔ تازگی عبور کرده و قابل اتکا نیست."
  },
  stale_sell_source: {
    short: "دادهٔ صرافی فروش قدیمی",
    detail: "آخرین قیمت دریافتی از صرافی فروش از بودجهٔ تازگی عبور کرده و قابل اتکا نیست."
  },
  insufficient_buy_depth: {
    short: "عمق ناکافی",
    detail: "عمق دفتر سفارش صرافی خرید برای این حجم کافی نیست؛ کل حجم با این قیمت پر نمی‌شود."
  },
  insufficient_sell_depth: {
    short: "عمق ناکافی",
    detail: "عمق دفتر سفارش صرافی فروش برای این حجم کافی نیست؛ کل حجم با این قیمت پر نمی‌شود."
  },
  account_required: {
    short: "نیازمند افتتاح حساب",
    detail: "برای اجرای این مسیر باید در یکی از دو صرافی حساب احرازشده داشته باشید."
  },
  reference_only: {
    short: "فقط مرجع",
    detail: "یکی از منابع این مسیر فقط برای مقایسه است و اجراپذیری آن تأیید نشده است."
  },
  source_unhealthy: {
    short: "منبع در دسترس نیست",
    detail: "یکی از دو صرافی در این چرخه پاسخ معتبر نداد."
  },
  quote_direction_unverified: {
    short: "جهت قیمت تأییدنشده",
    detail:
      "نگاشت خرید/فروش این منبع مستند نشده است؛ تا زمان تأیید، قیمت آن مبنای اجرا قرار نمی‌گیرد."
  },
  market_data_missing: {
    short: "دادهٔ بازار موجود نیست",
    detail: "برای این حجم قیمت اجراپذیری از این منبع استخراج نشد."
  },
  same_venue: { short: "یک صرافی", detail: "خرید و فروش در یک صرافی معنا ندارد." },
  non_positive_net: {
    short: "سود خالص منفی",
    detail: "پس از کارمزد و بافر ریسک، این مسیر سودی باقی نمی‌گذارد."
  },
  depth_unverified: {
    short: "عمق تأییدنشده",
    detail:
      "این منبع فقط قیمت سرصفحه منتشر کرده و عمق دفتر در دسترس نبود؛ هیچ حجمی اجراپذیر اعلام نمی‌شود."
  },
  quote_max_unverified: {
    short: "حد اجرا نامشخص",
    detail: "صرافی حداکثر حجم قابل معاملهٔ این نقل‌قول را منتشر نکرده است."
  },
  units_ambiguous: {
    short: "واحد قیمت مبهم",
    detail: "تشخیص ریال یا تومان برای این پاسخ قطعی نشد یا قیمت از میانهٔ بازار فاصلهٔ غیرعادی دارد."
  },
  rate_limited: {
    short: "محدودیت نرخ درخواست",
    detail: "صرافی در این چرخه پاسخ محدودیت نرخ داد؛ داده ممکن است ناقص باشد."
  },
  source_not_certified: {
    short: "منبع گواهی‌نشده",
    detail: "این منبع هنوز وضعیت «تأیید زنده» نگرفته است، بنابراین مبنای اجرا قرار نمی‌گیرد."
  }
};

export function blockedShort(code: string): string {
  return BLOCKED_FA[code as BlockedReasonCode]?.short ?? code;
}

export function blockedDetail(code: string): string {
  return BLOCKED_FA[code as BlockedReasonCode]?.detail ?? code;
}

/* ── certification / source status ─────────────────────────────────────────── */

export const CERT_FA: Record<string, string> = {
  LIVE_VERIFIED: "زنده و تأییدشده",
  LIVE_DEGRADED: "زنده با اختلال",
  REFERENCE_ONLY: "فقط مرجع",
  UNSUPPORTED: "پشتیبانی‌نشده",
  PENDING_PROBE: "در انتظار بررسی"
};

export function certTone(status: string): "good" | "warn" | "muted" | "danger" {
  if (status === "LIVE_VERIFIED") return "good";
  if (status === "LIVE_DEGRADED") return "warn";
  if (status === "REFERENCE_ONLY" || status === "PENDING_PROBE") return "muted";
  return "danger";
}

export const ACCOUNT_FA: Record<string, string> = {
  verified: "قابل استفاده با حساب فعلی",
  unverified: "نیازمند افتتاح حساب",
  unknown: "وضعیت حساب نامشخص"
};

export const FEE_STATUS_FA: Record<string, string> = {
  official: "رسمی",
  account_api: "از حساب کاربری",
  provisional: "موقت",
  unknown: "کارمزد نامشخص"
};

export const MARKET_MODEL_FA: Record<string, string> = {
  ORDER_BOOK: "دفتر سفارش",
  OTC_QUOTE: "نقل‌قول OTC",
  REFERENCE: "مرجع"
};

/* ── formatting ────────────────────────────────────────────────────────────── */

const FA_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

export function toFaDigits(input: string | number): string {
  return String(input).replace(/\d/g, (d) => FA_DIGITS[Number(d)]!);
}

/** Duration in Persian, coarse and readable. */
export function formatDurationFa(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${toFaDigits(sec)} ثانیه`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${toFaDigits(min)} دقیقه`;
  const hours = Math.floor(min / 60);
  const restMin = min % 60;
  if (hours < 24) {
    return restMin ? `${toFaDigits(hours)} ساعت و ${toFaDigits(restMin)} دقیقه` : `${toFaDigits(hours)} ساعت`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${toFaDigits(days)} روز و ${toFaDigits(restHours)} ساعت` : `${toFaDigits(days)} روز`;
}

/** Age of a timestamp as «۱۲ ثانیه پیش». */
export function formatAgoFa(iso: string | null | undefined, nowMs?: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const diff = Math.max(0, (nowMs ?? Date.now()) - t);
  return `${formatDurationFa(diff)} پیش`;
}

/** Percentage with Persian digits and a sign for edges. */
export function formatPercentFa(value: number | null | undefined, digits = 2, signed = false): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = signed && value > 0 ? "+" : "";
  return `${sign}${toFaDigits(value.toFixed(digits))}٪`;
}

export function formatCountFa(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return toFaDigits(value.toLocaleString("en-US"));
}

/** Freshness bucket for a data age. */
export function freshnessLabel(ageMs: number | null | undefined, pollIntervalMs = 30_000): {
  label: string;
  tone: "good" | "warn" | "danger";
} {
  if (ageMs === null || ageMs === undefined || !Number.isFinite(ageMs)) {
    return { label: "نامشخص", tone: "warn" };
  }
  if (ageMs <= pollIntervalMs * 1.5) return { label: "تازه", tone: "good" };
  if (ageMs <= pollIntervalMs * 4) return { label: "کمی قدیمی", tone: "warn" };
  return { label: "قدیمی", tone: "danger" };
}

/** Account-opening priority from observed evidence, never from a guess. */
export function accountPriorityLabel(score: number | null): { label: string; tone: string } {
  if (score === null || !Number.isFinite(score) || score <= 0) {
    return { label: "بدون شواهد کافی", tone: "muted" };
  }
  if (score >= 0.5) return { label: "اولویت بالا", tone: "good" };
  if (score >= 0.2) return { label: "اولویت متوسط", tone: "warn" };
  return { label: "اولویت پایین", tone: "muted" };
}

/* ── opportunity classification ────────────────────────────────────────────── */

export type OppClass = "valid" | "raw" | "blocked";

/**
 * A valid opportunity needs both sides healthy and fresh, confirmed direction,
 * sufficient depth, known fees, positive net profit and available accounts.
 * The engine already encodes all of that: EXECUTABLE_NOW means nothing
 * disqualifying was found, so validity is that plus known fees and net > 0.
 */
export function classifyOpportunity(o: {
  eligibility: OpportunityEligibility;
  feeUnknown: boolean;
  netProfitToman: number;
  rawSpreadPercent: number;
}): OppClass {
  if (o.eligibility === "EXECUTABLE_NOW" && !o.feeUnknown && o.netProfitToman > 0) return "valid";
  if (o.rawSpreadPercent > 0 && o.eligibility !== "BLOCKED") return "raw";
  return "blocked";
}

/** Valid first, then raw candidates, then blocked. */
export const OPP_CLASS_ORDER: Record<OppClass, number> = { valid: 0, raw: 1, blocked: 2 };

export const OPP_CLASS_FA: Record<OppClass, string> = {
  valid: "معتبر و خالص مثبت",
  raw: "پتانسیل خام / مرجع",
  blocked: "مسدودشده"
};

export const NO_VALID_OPPORTUNITY_FA = "در حال حاضر فرصت معتبر خالص مثبت وجود ندارد";

/** Short explanations shown as tooltips on metric headers. */
export const TOOLTIP_FA = {
  rawSpread: "اختلاف قیمت فروش و خرید پیش از کارمزد. سود نیست.",
  netEdge: "حاشیه پس از کسر کارمزد دو طرف و بافر ریسک. فقط وقتی کارمزد معلوم باشد.",
  fee: "کارمزد taker دو صرافی. «نامشخص» یعنی جدول رسمی تأیید نشده است.",
  buffer: "بافر لغزش و ریسک: ۰٫۰۵٪ از هزینه خرید (مقدار موقت).",
  coverage: "سهم چرخه‌های موفق از چرخه‌های مورد انتظار در بازه پایش.",
  sourceResponse: "سهم منابعی که در آخرین چرخه پاسخ سالم دادند.",
  downtime: "مدتی که هیچ چرخه موفقی ثبت نشده است.",
  p50: "میانه زمان پاسخ منبع.",
  p95: "زمان پاسخ در بدترین ۵٪ درخواست‌ها."
} as const;
