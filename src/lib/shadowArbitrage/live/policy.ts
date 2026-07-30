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

/**
 * Policy families.
 *  RISK     — limits that constrain execution behaviour.
 *  EVIDENCE — how much proof the readiness gates require before they open.
 *
 * Both are equally required. Evidence thresholds used to be hard-coded numbers
 * invented inside the readiness engine; they are now explicit admin decisions,
 * because a threshold nobody chose is a threshold nobody reviewed.
 */
export type PolicyCategory = "RISK" | "EVIDENCE";

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
  | "per_venue_circuit_breaker_errors"
  // evidence thresholds — no value is chosen anywhere in this codebase
  | "min_observation_duration_days"
  | "min_successful_cycles"
  | "min_paper_fills"
  | "max_paper_failures"
  | "max_duplicate_idempotency_keys"
  | "max_reconciliation_mismatches";

export type RiskPolicyUnit =
  | "USDT"
  | "TOMAN"
  | "PERCENT"
  | "BPS"
  | "MILLISECONDS"
  | "COUNT"
  | "PER_MINUTE"
  | "SWITCH"
  | "DAYS";

export type RiskPolicyDefinition = {
  key: RiskPolicyKey;
  category: PolicyCategory;
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
    category: "RISK",
    labelFa: "حداکثر حجم هر سفارش",
    unit: "USDT",
    rationaleFa: "بدون سقف حجم، یک خطای قیمت می‌تواند کل سرمایه را درگیر کند.",
    min: 1,
    max: 100_000
  },
  {
    key: "max_daily_loss_toman",
    category: "RISK",
    labelFa: "حداکثر زیان روزانه",
    unit: "TOMAN",
    rationaleFa: "بدون سقف زیان روزانه هیچ نقطهٔ توقف خودکاری وجود ندارد.",
    min: 1,
    max: 100_000_000_000
  },
  {
    key: "max_venue_exposure_percent",
    category: "RISK",
    labelFa: "حداکثر تمرکز روی یک صرافی",
    unit: "PERCENT",
    rationaleFa: "بدون سقف تمرکز، ریسک نکول یک صرافی کل پرتفوی را تهدید می‌کند.",
    min: 1,
    max: 100
  },
  {
    key: "min_risk_adjusted_edge_percent",
    category: "RISK",
    labelFa: "حداقل سود اقتصادی تعدیل‌شده",
    unit: "PERCENT",
    rationaleFa: "بدون کف سود، معاملات با حاشیهٔ ناچیز هم اجرا می‌شوند.",
    min: 0.01,
    max: 100
  },
  {
    key: "max_quote_age_ms",
    category: "RISK",
    labelFa: "حداکثر کهنگی قیمت",
    unit: "MILLISECONDS",
    rationaleFa: "بدون سقف کهنگی، ممکن است روی قیمتی اجرا شود که دیگر وجود ندارد.",
    min: 100,
    max: 300_000
  },
  {
    key: "max_latency_ms",
    category: "RISK",
    labelFa: "حداکثر تأخیر مجاز",
    unit: "MILLISECONDS",
    rationaleFa: "تأخیر بالا یعنی نتیجهٔ پای دوم نامعلوم می‌ماند.",
    min: 100,
    max: 60_000
  },
  {
    key: "max_slippage_bps",
    category: "RISK",
    labelFa: "حداکثر لغزش مجاز",
    unit: "BPS",
    rationaleFa: "بدون سقف لغزش، اجرای بدتر از انتظار محدود نمی‌شود.",
    min: 1,
    max: 1_000
  },
  {
    key: "max_consecutive_errors",
    category: "RISK",
    labelFa: "حداکثر خطای متوالی",
    unit: "COUNT",
    rationaleFa: "بدون این حد، یک خرابی پایدار بی‌وقفه تکرار می‌شود.",
    min: 1,
    max: 100
  },
  {
    key: "api_rate_limit_per_minute",
    category: "RISK",
    labelFa: "سقف نرخ درخواست به هر صرافی",
    unit: "PER_MINUTE",
    rationaleFa: "عبور از محدودیت نرخ می‌تواند حساب را مسدود کند.",
    min: 1,
    max: 6_000
  },
  {
    key: "max_inventory_deviation_percent",
    category: "RISK",
    labelFa: "حداکثر انحراف موجودی",
    unit: "PERCENT",
    rationaleFa: "بدون این حد، رانش موجودی بی‌صدا به ریسک جهت‌دار تبدیل می‌شود.",
    min: 1,
    max: 100
  },
  {
    key: "global_kill_switch",
    category: "RISK",
    labelFa: "کلید توقف اضطراری سراسری",
    unit: "SWITCH",
    rationaleFa: "باید صریحاً پیکربندی شود؛ نبودِ آن یعنی راه توقف فوری وجود ندارد.",
    min: 0,
    max: 1
  },
  {
    key: "per_venue_circuit_breaker_errors",
    category: "RISK",
    labelFa: "قطع‌کنندهٔ مدار هر صرافی",
    unit: "COUNT",
    rationaleFa: "بدون قطع‌کننده، یک صرافی خراب کل چرخه را آلوده می‌کند.",
    min: 1,
    max: 100
  },
  {
    key: "min_observation_duration_days",
    category: "EVIDENCE",
    labelFa: "حداقل مدت مشاهده",
    unit: "DAYS",
    rationaleFa:
      "مدت لازم مشاهده باید تصمیم صریح مدیر باشد؛ هیچ عددی در کد انتخاب نشده است.",
    min: 1,
    max: 365
  },
  {
    key: "min_successful_cycles",
    category: "EVIDENCE",
    labelFa: "حداقل چرخهٔ موفق",
    unit: "COUNT",
    rationaleFa: "تعداد چرخهٔ لازم برای اعتماد به داده باید صریحاً تعیین شود.",
    min: 1,
    max: 10_000_000
  },
  {
    key: "min_paper_fills",
    category: "EVIDENCE",
    labelFa: "حداقل معاملهٔ کاغذی اجراشده",
    unit: "COUNT",
    rationaleFa: "تعداد اجرای کاغذی لازم برای اعتماد به موتور باید صریحاً تعیین شود.",
    min: 1,
    max: 1_000_000
  },
  {
    key: "max_paper_failures",
    category: "EVIDENCE",
    labelFa: "حداکثر خطای مجاز در اجرای کاغذی",
    unit: "COUNT",
    rationaleFa: "سقف خطای قابل‌تحمل باید تصمیم مدیر باشد، نه فرض کد.",
    min: 0,
    max: 1_000_000
  },
  {
    key: "max_duplicate_idempotency_keys",
    category: "EVIDENCE",
    labelFa: "حداکثر کلید تکراری مجاز",
    unit: "COUNT",
    rationaleFa: "حتی «صفر» هم باید انتخاب صریح باشد تا قابل بازبینی بماند.",
    min: 0,
    max: 1_000_000
  },
  {
    key: "max_reconciliation_mismatches",
    category: "EVIDENCE",
    labelFa: "حداکثر مغایرت تطبیق مجاز",
    unit: "COUNT",
    rationaleFa: "سقف مغایرت دفاتر باید صریحاً تعیین شود.",
    min: 0,
    max: 1_000_000
  }
];

export const RISK_POLICY_BY_KEY = new Map(REQUIRED_RISK_POLICIES.map((p) => [p.key, p]));

/** A stored policy value. `setBy`/`setAt` make every value attributable. */
export type RiskPolicyValue = {
  key: RiskPolicyKey;
  value: number;
  /** How the value came to exist. There is no other provenance in this build. */
  provenance: "ADMIN_APPROVED";
  setBy: string;
  setAt: string;
  /** Chosen by the approver. Null means the approver stated no expiry. */
  validForDays: number | null;
  note: string | null;
};

export type RiskPolicyState = {
  definition: RiskPolicyDefinition;
  /** null means UNSET — a blocker, never a default. */
  value: number | null;
  provenance: "ADMIN_APPROVED" | "UNSET";
  setBy: string | null;
  setAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  /** True only when a value exists AND has not expired. */
  configured: boolean;
  blockerFa: string | null;
  requiredActionFa: string;
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
 *
 * Anything absent — or expired — stays `configured: false` with its own blocker
 * and its own required action. Nothing is filled in.
 */
export function buildPolicyState(
  values: RiskPolicyValue[],
  nowMs: number = Date.now()
): RiskPolicyState[] {
  const byKey = new Map(values.map((v) => [v.key, v]));
  return REQUIRED_RISK_POLICIES.map((definition) => {
    const stored = byKey.get(definition.key);
    if (!stored) {
      return {
        definition,
        value: null,
        provenance: "UNSET" as const,
        setBy: null,
        setAt: null,
        expiresAt: null,
        expired: false,
        configured: false,
        blockerFa: `پیکربندی نشده — ${definition.rationaleFa}`,
        requiredActionFa: `تعیین صریح «${definition.labelFa}» توسط مدیر. هیچ مقدار پیش‌فرضی وجود ندارد.`
      };
    }

    const expiresAt =
      stored.validForDays === null
        ? null
        : new Date(Date.parse(stored.setAt) + stored.validForDays * 86_400_000).toISOString();
    const expired = expiresAt !== null && Date.parse(expiresAt) <= nowMs;

    return {
      definition,
      value: stored.value,
      provenance: stored.provenance,
      setBy: stored.setBy,
      setAt: stored.setAt,
      expiresAt,
      expired,
      // An expired value is treated exactly like an unset one.
      configured: !expired,
      blockerFa: expired
        ? `اعتبار این مقدار در ${expiresAt?.slice(0, 10)} منقضی شده است.`
        : null,
      requiredActionFa: expired
        ? `بازتأیید «${definition.labelFa}» توسط مدیر.`
        : "اقدامی لازم نیست."
    };
  });
}

/** Configured value for a key, or null when unset or expired. Never a default. */
export function policyValueOrNull(state: RiskPolicyState[], key: RiskPolicyKey): number | null {
  const found = state.find((p) => p.definition.key === key);
  return found && found.configured ? found.value : null;
}

export function unsetPolicies(state: RiskPolicyState[]): RiskPolicyState[] {
  return state.filter((p) => !p.configured);
}
