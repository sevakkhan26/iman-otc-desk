/**
 * Phase 7A — risk control policies.
 *
 * Every policy here is REQUIRED and starts UNSET. There is no default value
 * anywhere in this file: an unset policy is a blocker, never a silently assumed
 * threshold. Inventing a "reasonable" default would be the single easiest way
 * to make an unreviewed system look ready.
 *
 * Pure module: no database, no network, no credentials.
 */

export type RiskPolicyKey =
  | "max_order_size_usdt"
  | "max_daily_loss_toman"
  | "max_venue_exposure_percent"
  | "min_risk_adjusted_edge_percent"
  | "max_quote_age_ms"
  | "max_latency_ms"
  | "max_slippage_bps"
  | "max_consecutive_errors"
  | "api_rate_limit_per_minute"
  | "max_inventory_deviation_percent"
  | "global_kill_switch"
  | "per_venue_circuit_breaker_errors";

export type RiskPolicyUnit =
  | "USDT"
  | "TOMAN"
  | "PERCENT"
  | "BPS"
  | "MILLISECONDS"
  | "COUNT"
  | "PER_MINUTE"
  | "SWITCH";

export type RiskPolicyDefinition = {
  key: RiskPolicyKey;
  labelFa: string;
  unit: RiskPolicyUnit;
  /** What breaks if this is left unset. Shown as the blocker text. */
  rationaleFa: string;
  /** Inclusive bounds used only to reject nonsense input, never as a default. */
  min: number;
  max: number;
};

/**
 * The full required set. A readiness gate fails while any of these is unset.
 * Note the absence of a `default` field — that is deliberate and load-bearing.
 */
export const REQUIRED_RISK_POLICIES: RiskPolicyDefinition[] = [
  {
    key: "max_order_size_usdt",
    labelFa: "حداکثر حجم هر سفارش",
    unit: "USDT",
    rationaleFa: "بدون سقف حجم، یک خطای قیمت می‌تواند کل سرمایه را درگیر کند.",
    min: 1,
    max: 100_000
  },
  {
    key: "max_daily_loss_toman",
    labelFa: "حداکثر زیان روزانه",
    unit: "TOMAN",
    rationaleFa: "بدون سقف زیان روزانه هیچ نقطهٔ توقف خودکاری وجود ندارد.",
    min: 1,
    max: 100_000_000_000
  },
  {
    key: "max_venue_exposure_percent",
    labelFa: "حداکثر تمرکز روی یک صرافی",
    unit: "PERCENT",
    rationaleFa: "بدون سقف تمرکز، ریسک نکول یک صرافی کل پرتفوی را تهدید می‌کند.",
    min: 1,
    max: 100
  },
  {
    key: "min_risk_adjusted_edge_percent",
    labelFa: "حداقل سود اقتصادی تعدیل‌شده",
    unit: "PERCENT",
    rationaleFa: "بدون کف سود، معاملات با حاشیهٔ ناچیز هم اجرا می‌شوند.",
    min: 0.01,
    max: 100
  },
  {
    key: "max_quote_age_ms",
    labelFa: "حداکثر کهنگی قیمت",
    unit: "MILLISECONDS",
    rationaleFa: "بدون سقف کهنگی، ممکن است روی قیمتی اجرا شود که دیگر وجود ندارد.",
    min: 100,
    max: 300_000
  },
  {
    key: "max_latency_ms",
    labelFa: "حداکثر تأخیر مجاز",
    unit: "MILLISECONDS",
    rationaleFa: "تأخیر بالا یعنی نتیجهٔ پای دوم نامعلوم می‌ماند.",
    min: 100,
    max: 60_000
  },
  {
    key: "max_slippage_bps",
    labelFa: "حداکثر لغزش مجاز",
    unit: "BPS",
    rationaleFa: "بدون سقف لغزش، اجرای بدتر از انتظار محدود نمی‌شود.",
    min: 1,
    max: 1_000
  },
  {
    key: "max_consecutive_errors",
    labelFa: "حداکثر خطای متوالی",
    unit: "COUNT",
    rationaleFa: "بدون این حد، یک خرابی پایدار بی‌وقفه تکرار می‌شود.",
    min: 1,
    max: 100
  },
  {
    key: "api_rate_limit_per_minute",
    labelFa: "سقف نرخ درخواست به هر صرافی",
    unit: "PER_MINUTE",
    rationaleFa: "عبور از محدودیت نرخ می‌تواند حساب را مسدود کند.",
    min: 1,
    max: 6_000
  },
  {
    key: "max_inventory_deviation_percent",
    labelFa: "حداکثر انحراف موجودی",
    unit: "PERCENT",
    rationaleFa: "بدون این حد، رانش موجودی بی‌صدا به ریسک جهت‌دار تبدیل می‌شود.",
    min: 1,
    max: 100
  },
  {
    key: "global_kill_switch",
    labelFa: "کلید توقف اضطراری سراسری",
    unit: "SWITCH",
    rationaleFa: "باید صریحاً پیکربندی شود؛ نبودِ آن یعنی راه توقف فوری وجود ندارد.",
    min: 0,
    max: 1
  },
  {
    key: "per_venue_circuit_breaker_errors",
    labelFa: "قطع‌کنندهٔ مدار هر صرافی",
    unit: "COUNT",
    rationaleFa: "بدون قطع‌کننده، یک صرافی خراب کل چرخه را آلوده می‌کند.",
    min: 1,
    max: 100
  }
];

export const RISK_POLICY_BY_KEY = new Map(REQUIRED_RISK_POLICIES.map((p) => [p.key, p]));

/** A stored policy value. `setBy`/`setAt` make every value attributable. */
export type RiskPolicyValue = {
  key: RiskPolicyKey;
  value: number;
  setBy: string;
  setAt: string;
  note: string | null;
};

export type RiskPolicyState = {
  definition: RiskPolicyDefinition;
  /** null means UNSET — a blocker, never a default. */
  value: number | null;
  setBy: string | null;
  setAt: string | null;
  configured: boolean;
  blockerFa: string | null;
};

export function validatePolicyValue(
  key: string,
  value: number
): { ok: true } | { ok: false; messageFa: string } {
  const def = RISK_POLICY_BY_KEY.get(key as RiskPolicyKey);
  if (!def) return { ok: false, messageFa: "سیاست ریسک ناشناخته است" };
  if (!Number.isFinite(value)) return { ok: false, messageFa: "مقدار عددی نامعتبر است" };
  if (value < def.min || value > def.max) {
    return {
      ok: false,
      messageFa: `مقدار باید بین ${def.min} و ${def.max} باشد (${def.labelFa})`
    };
  }
  return { ok: true };
}

/**
 * Fold stored values onto the required set.
 * Anything absent stays `configured: false` with its own blocker text.
 */
export function buildPolicyState(values: RiskPolicyValue[]): RiskPolicyState[] {
  const byKey = new Map(values.map((v) => [v.key, v]));
  return REQUIRED_RISK_POLICIES.map((definition) => {
    const stored = byKey.get(definition.key);
    return {
      definition,
      value: stored ? stored.value : null,
      setBy: stored?.setBy ?? null,
      setAt: stored?.setAt ?? null,
      configured: Boolean(stored),
      blockerFa: stored ? null : `پیکربندی نشده — ${definition.rationaleFa}`
    };
  });
}

export function unsetPolicies(state: RiskPolicyState[]): RiskPolicyState[] {
  return state.filter((p) => !p.configured);
}
