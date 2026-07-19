import type { DecisionLevel, ForexImpact, MarketState, PremiumImpact, Severity, SourceStatus } from "@/lib/types";

const faInteger = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 0 });

const tomanFormatter = new Intl.NumberFormat("fa-IR", {
  maximumFractionDigits: 0
});

const decimalFormatter = new Intl.NumberFormat("fa-IR", {
  maximumFractionDigits: 2
});

/** Left-to-Right Isolate / Pop Directional Isolate — one LTR unit inside RTL UI. */
const LRI = "\u2066";
const PDI = "\u2069";
const NBSP = "\u00A0";
const TOMAN_UNAVAILABLE = "داده‌ای دریافت نشد";

/**
 * Toman display unit. Visual order L→R (isolated LTR): «تومان» then number.
 * Example: تومان ۱۹۳٬۴۱۴  (unit left, amount right). Does not change digits/rounding.
 */
export function formatToman(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return TOMAN_UNAVAILABLE;
  return `${LRI}تومان${NBSP}${tomanFormatter.format(value)}${PDI}`;
}

/** Unit + number without bidi marks (for tests / <bdi> markup). */
export function formatTomanCore(value: number): string {
  return `تومان${NBSP}${tomanFormatter.format(value)}`;
}

export function formatNumber(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "داده‌ای دریافت نشد";
  return new Intl.NumberFormat("fa-IR", { maximumFractionDigits: digits }).format(value);
}

export function formatUsd(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "داده‌ای دریافت نشد";
  return `$${decimalFormatter.format(value)}`;
}

export function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "داده‌ای دریافت نشد";
  return `${decimalFormatter.format(value)}٪`;
}

export function formatDate(value: string | null | undefined) {
  if (!value) return "داده‌ای دریافت نشد";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "داده‌ای دریافت نشد";
  return new Intl.DateTimeFormat("fa-IR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(date);
}

export function statusLabel(status: SourceStatus | "unknown") {
  if (status === "available") return "فعال";
  if (status === "degraded") return "ناقص";
  if (status === "unavailable") return "قطع";
  return "نامشخص";
}

export function statusTone(status: SourceStatus | "unknown") {
  if (status === "available") return "good";
  if (status === "degraded" || status === "unknown") return "warn";
  return "danger";
}

export function severityLabel(severity: Severity) {
  if (severity === "high") return "زیاد";
  if (severity === "medium") return "متوسط";
  return "کم";
}

export function severityTone(severity: Severity) {
  if (severity === "high") return "danger";
  if (severity === "medium") return "warn";
  return "good";
}

export function marketStateLabel(state: MarketState) {
  if (state === "risky") return "پرریسک";
  if (state === "caution") return "احتیاط";
  return "آرام";
}

export function marketStateTone(state: MarketState) {
  if (state === "risky") return "danger";
  if (state === "caution") return "warn";
  return "good";
}

export function decisionTone(level: DecisionLevel): "good" | "warn" | "danger" {
  if (level === "act") return "danger";
  if (level === "watch") return "warn";
  return "good";
}

export function decisionLabel(level: DecisionLevel) {
  if (level === "act") return "اقدام";
  if (level === "watch") return "مراقب باش";
  return "عادی";
}

/** Gold timestamps: single Asia/Tehran display pass from stored UTC ISO. */
export function formatGoldTehran(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("fa-IR", {
    timeZone: "Asia/Tehran",
    dateStyle: "short",
    timeStyle: "short",
    hour12: false
  }).format(date);
}

export function formatTehran(value: string | null | undefined) {
  if (!value) return "داده‌ای دریافت نشد";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "داده‌ای دریافت نشد";
  return new Intl.DateTimeFormat("fa-IR", {
    timeZone: "Asia/Tehran",
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

/** News timestamps in Tehran local time: HH:mm ، YYYY/MM/DD (Jalali, Persian digits). */
export function formatNewsTehranTime(value: string | null | undefined) {
  if (!value) return "زمان نامشخص";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "زمان نامشخص";

  const time = new Intl.DateTimeFormat("fa-IR", {
    timeZone: "Asia/Tehran",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);

  const parts = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) return "زمان نامشخص";

  return `${time} ، ${year}/${month}/${day}`;
}

export function forexImpactLabel(impact: ForexImpact) {
  if (impact === "high") return "اثر بالا";
  if (impact === "medium") return "اثر متوسط";
  if (impact === "holiday") return "تعطیلی";
  return "اثر کم";
}

export function forexImpactTone(impact: ForexImpact): "danger" | "warn" | "neutral" {
  if (impact === "high") return "danger";
  if (impact === "medium") return "warn";
  return "neutral";
}

export function premiumImpactLabel(impact: PremiumImpact) {
  if (impact === "up") return "افزایش پرمیوم تتر";
  if (impact === "down") return "کاهش پرمیوم تتر";
  return "خنثی";
}

export function premiumImpactTone(impact: PremiumImpact): "danger" | "good" | "neutral" {
  if (impact === "up") return "danger";
  if (impact === "down") return "good";
  return "neutral";
}

export function formatCountdown(
  targetIso: string | null | undefined,
  nowMs: number,
  hasActual = false
): { text: string; state: "soon" | "upcoming" | "passed" } {
  if (!targetIso) return { text: "—", state: "upcoming" };
  const target = new Date(targetIso).getTime();
  if (!Number.isFinite(target)) return { text: "—", state: "upcoming" };
  const diffMs = target - nowMs;
  if (diffMs <= 0) {
    if (hasActual) {
      return { text: "منتشر شد", state: "passed" };
    }
    return { text: "در انتظار داده", state: "passed" };
  }
  const totalMin = Math.round(diffMs / 60_000);
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  const text =
    hours > 0
      ? `${faInteger.format(hours)} ساعت و ${faInteger.format(minutes)} دقیقه مانده`
      : `${faInteger.format(minutes)} دقیقه مانده`;
  return { text, state: totalMin <= 30 ? "soon" : "upcoming" };
}
