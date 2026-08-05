/**
 * `PAPER_BALANCED_10B_V1` — the Paper sizing policy set.
 *
 * Six numbers decide whether the Paper Broker may size a trade at all. Offering
 * them as six independent rows with six «ثبت» buttons made the safe state look
 * like a chore: an operator could set four, walk away, and leave the desk in a
 * configuration nobody had reviewed as a whole. Worse, each value only makes
 * sense next to the others — a 500 USDT order cap means something different
 * against a 20% venue ceiling than against 100%.
 *
 * So they are one reviewed, versioned SET. It is applied atomically or not at
 * all, it carries a fingerprint of exactly which numbers were approved, and its
 * validity is a property of the set rather than of each row.
 *
 * Pure module: no database, no network, no clock, no crypto. It describes the
 * set and reads a policy state; it cannot apply anything. Safe to import from
 * a client component.
 */
import type { RiskPolicyKey, RiskPolicyState } from "@/lib/shadowArbitrage/live/policy";

/** The set's stable identity. Changing a value means minting a new version. */
export const PAPER_POLICY_SET_KEY = "PAPER_BALANCED_10B_V1" as const;

/** How long an application of this set stays in force. */
export const PAPER_POLICY_SET_VALID_DAYS = 30;

export type PaperPolicyEntry = {
  key: RiskPolicyKey;
  /** The approved value, in the policy's own unit. */
  value: number;
  labelFa: string;
  /** The unit the number is stored in. */
  unitFa: string;
  /**
   * How the value should READ to an operator. Milliseconds and basis points
   * are storage units, not human ones: 30000 ms is thirty seconds, and 10 bps
   * is a tenth of a percent. Both are shown.
   */
  displayFa: string;
  /** What this value actually controls, in one sentence. */
  controlsFa: string;
};

/**
 * The approved set.
 *
 * Order is the order an operator reads them in: how big a single trade may be,
 * how much may sit on one venue, how thin an edge is still worth taking, how
 * old a price may be, how far the book may be walked, and how far inventory may
 * drift from where the session opened.
 */
export const PAPER_POLICY_SET: PaperPolicyEntry[] = [
  {
    key: "max_order_size_usdt",
    value: 500,
    labelFa: "حداکثر حجم هر سفارش",
    unitFa: "تتر",
    displayFa: "۵۰۰ تتر",
    controlsFa:
      "سقف مطلق یک معاملهٔ کاغذی. هیچ حجمی — هرچقدر هم سودآور — از این عدد بزرگ‌تر نمی‌شود."
  },
  {
    key: "max_venue_exposure_percent",
    value: 20,
    labelFa: "حداکثر تمرکز روی یک صرافی",
    unitFa: "درصد",
    displayFa: "۲۰٪ از کل پرتفوی",
    controlsFa:
      "بیشترین سهمی از کل پرتفوی که اجازه دارد روی یک صرافی باشد؛ ریسک نکول یک صرافی را محدود می‌کند."
  },
  {
    key: "min_risk_adjusted_edge_percent",
    value: 0.05,
    labelFa: "حداقل سود اقتصادی تعدیل‌شده",
    unitFa: "درصد",
    displayFa: "۰٫۰۵٪ (۵ bps)",
    controlsFa:
      "کف سودی که یک معامله باید پس از کارمزد، ارزش تتری کارمزد و بافر لغزش داشته باشد تا اجرا شود."
  },
  {
    key: "max_quote_age_ms",
    value: 30_000,
    labelFa: "حداکثر کهنگی قیمت",
    unitFa: "میلی‌ثانیه",
    displayFa: "۳۰ ثانیه (۳۰٬۰۰۰ میلی‌ثانیه)",
    controlsFa:
      "بیشترین سنی که دادهٔ بازار می‌تواند داشته باشد و هنوز برای قیمت‌گذاری استفاده شود."
  },
  {
    key: "max_slippage_bps",
    value: 10,
    labelFa: "حداکثر لغزش مجاز",
    unitFa: "bps",
    displayFa: "۱۰ bps (۰٫۱۰٪)",
    controlsFa:
      "تا چه فاصله‌ای از بهترین قیمت دفتر، عمق «اجراپذیر» شمرده می‌شود؛ سقف عمق از همین محدوده حساب می‌شود."
  },
  {
    key: "max_inventory_deviation_percent",
    value: 20,
    labelFa: "حداکثر انحراف موجودی",
    unitFa: "واحد درصدی",
    displayFa: "۲۰ واحد درصدی",
    controlsFa:
      "سهم تتری هر صرافی چقدر می‌تواند از سهمی که نشست با آن باز شده فاصله بگیرد، بر حسب واحد درصدی."
  }
];

/** The keys the set covers, in application order. */
export const PAPER_POLICY_SET_KEYS: RiskPolicyKey[] = PAPER_POLICY_SET.map((p) => p.key);

/**
 * The exact string the fingerprint is taken over.
 *
 * Canonical and sorted, so the same six values always produce the same input
 * regardless of the order they were written in. The validity is part of it:
 * the same numbers approved for a different period are a different decision.
 */
export function paperPolicySetCanonical(
  entries: Array<{ key: string; value: number }> = PAPER_POLICY_SET,
  validForDays: number = PAPER_POLICY_SET_VALID_DAYS
): string {
  const body = [...entries]
    .map((e) => `${e.key}=${e.value}`)
    .sort()
    .join(";");
  return `${PAPER_POLICY_SET_KEY}|validForDays=${validForDays}|${body}`;
}

export type PaperPolicyRowStatus =
  | "MATCHES"
  | "DIFFERS"
  | "EXPIRED"
  | "MISSING";

export const PAPER_POLICY_ROW_STATUS_FA: Record<PaperPolicyRowStatus, string> = {
  MATCHES: "مطابق مجموعه",
  DIFFERS: "مقدار فعلی متفاوت است",
  EXPIRED: "منقضی شده",
  MISSING: "تعیین نشده"
};

export type PaperPolicySetStatus =
  | "EFFECTIVE"
  | "PARTIALLY_APPLIED"
  | "DRIFTED"
  | "EXPIRED"
  | "NOT_APPLIED";

export const PAPER_POLICY_SET_STATUS_FA: Record<PaperPolicySetStatus, string> = {
  EFFECTIVE: "مجموعه فعال و معتبر است",
  PARTIALLY_APPLIED: "بخشی از مجموعه اعمال شده است",
  DRIFTED: "مقادیر فعلی با مجموعهٔ تأییدشده یکی نیستند",
  EXPIRED: "اعتبار مجموعه منقضی شده است",
  NOT_APPLIED: "این مجموعه هنوز اعمال نشده است"
};

export type PaperPolicyRowView = {
  key: RiskPolicyKey;
  labelFa: string;
  unitFa: string;
  controlsFa: string;
  /** The approved value and how it should read. */
  proposedValue: number;
  proposedDisplayFa: string;
  /** What is in force right now. Null means nothing is. */
  currentValue: number | null;
  currentDisplayFa: string | null;
  setBy: string | null;
  setAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  configured: boolean;
  status: PaperPolicyRowStatus;
  statusFa: string;
  blockerFa: string | null;
};

export type PaperPolicySetView = {
  setKey: typeof PAPER_POLICY_SET_KEY;
  validForDays: number;
  canonical: string;
  status: PaperPolicySetStatus;
  statusFa: string;
  /** True only when all six match the set and none has expired. */
  effective: boolean;
  /** Keys with nothing in force at all. */
  missingKeys: RiskPolicyKey[];
  /** Keys in force with a value other than the set's. */
  differingKeys: RiskPolicyKey[];
  /** Keys whose value has expired. */
  expiredKeys: RiskPolicyKey[];
  /** The soonest expiry among the applied rows. Null when none is applied. */
  expiresAt: string | null;
  rows: PaperPolicyRowView[];
};

/**
 * Render one stored value the way the set's own display renders it.
 *
 * A current value that happens to equal the approved one is shown with the same
 * words, so "matches" is visible rather than inferred from two formats.
 */
function displayFor(entry: PaperPolicyEntry, value: number): string {
  if (value === entry.value) return entry.displayFa;
  if (entry.key === "max_quote_age_ms") {
    return `${(value / 1000).toLocaleString("fa-IR")} ثانیه (${value.toLocaleString("fa-IR")} میلی‌ثانیه)`;
  }
  if (entry.key === "max_slippage_bps") {
    return `${value.toLocaleString("fa-IR")} bps (${(value / 100).toFixed(2)}٪)`;
  }
  return `${value.toLocaleString("fa-IR")} ${entry.unitFa}`;
}

/**
 * Compare the approved set against what is actually in force.
 *
 * Pure: it reads the policy state the caller already built and returns a view.
 * It never decides to apply anything, and it never treats an unset value as a
 * default — a missing row is reported as missing, by name.
 */
export function buildPaperPolicySetView(policies: RiskPolicyState[]): PaperPolicySetView {
  const byKey = new Map(policies.map((p) => [p.definition.key, p]));

  const missingKeys: RiskPolicyKey[] = [];
  const differingKeys: RiskPolicyKey[] = [];
  const expiredKeys: RiskPolicyKey[] = [];
  const expiries: string[] = [];

  const rows: PaperPolicyRowView[] = PAPER_POLICY_SET.map((entry) => {
    const state = byKey.get(entry.key);
    const currentValue = state?.value ?? null;
    const expired = Boolean(state?.expired);
    const configured = Boolean(state?.configured);

    let status: PaperPolicyRowStatus;
    if (currentValue === null) {
      status = "MISSING";
      missingKeys.push(entry.key);
    } else if (expired) {
      status = "EXPIRED";
      expiredKeys.push(entry.key);
    } else if (currentValue !== entry.value) {
      status = "DIFFERS";
      differingKeys.push(entry.key);
    } else {
      status = "MATCHES";
    }

    if (state?.expiresAt && configured) expiries.push(state.expiresAt);

    return {
      key: entry.key,
      labelFa: entry.labelFa,
      unitFa: entry.unitFa,
      controlsFa: entry.controlsFa,
      proposedValue: entry.value,
      proposedDisplayFa: entry.displayFa,
      currentValue,
      currentDisplayFa: currentValue === null ? null : displayFor(entry, currentValue),
      setBy: state?.setBy ?? null,
      setAt: state?.setAt ?? null,
      expiresAt: state?.expiresAt ?? null,
      expired,
      configured,
      status,
      statusFa: PAPER_POLICY_ROW_STATUS_FA[status],
      blockerFa: state?.blockerFa ?? null
    };
  });

  let status: PaperPolicySetStatus;
  if (missingKeys.length === PAPER_POLICY_SET.length) status = "NOT_APPLIED";
  else if (expiredKeys.length) status = "EXPIRED";
  else if (missingKeys.length) status = "PARTIALLY_APPLIED";
  else if (differingKeys.length) status = "DRIFTED";
  else status = "EFFECTIVE";

  return {
    setKey: PAPER_POLICY_SET_KEY,
    validForDays: PAPER_POLICY_SET_VALID_DAYS,
    canonical: paperPolicySetCanonical(),
    status,
    statusFa: PAPER_POLICY_SET_STATUS_FA[status],
    effective: status === "EFFECTIVE",
    missingKeys,
    differingKeys,
    expiredKeys,
    // The set is only in force until its earliest row lapses.
    expiresAt: expiries.length ? expiries.sort()[0] : null,
    rows
  };
}
