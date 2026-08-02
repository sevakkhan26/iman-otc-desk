/**
 * Phase 7A — fail-closed live-execution readiness engine.
 *
 * Every gate starts BLOCKED and only opens on evidence that is present, fresh
 * and non-conflicting. Missing evidence is never treated as "probably fine",
 * and no threshold is invented: an unset risk policy stays a blocker.
 *
 * Even with every gate open the effective state is DISARMED, because
 * LIVE_EXECUTION_IMPLEMENTED is a compile-time false and there is no live
 * broker in this repository. The gates exist so the readiness work is real and
 * auditable, not so the system can arm itself.
 *
 * Pure module: no database, no network, no credentials.
 */
import { REQUIRED_SUCCESS_COVERAGE_PERCENT } from "@/lib/shadowArbitrage/config";
import {
  LIVE_EXECUTION_IMPLEMENTED,
  LIVE_UNAVAILABLE_REASON_FA
} from "@/lib/shadowArbitrage/live/capability";
import type { LiveArmingState } from "@/lib/shadowArbitrage/live/executionPlan";
import {
  policyValueOrNull,
  unsetPolicies,
  type RiskPolicyState
} from "@/lib/shadowArbitrage/live/policy";
import type { VenueCapitalState } from "@/lib/shadowArbitrage/capital";
import { settlementFor, settlementUsable } from "@/lib/shadowArbitrage/paper/broker";

/** Every readiness gate. Order is the order a reviewer should work through. */
export type ReadinessGateId =
  | "observation_window"
  | "collector_health"
  | "capital_plan_approved"
  | "paper_evidence"
  | "account_fee_readiness"
  | "fee_settlement"
  | "api_capability"
  | "key_permissions"
  | "transfer_costs"
  | "risk_policies"
  | "reconciliation_integrity"
  | "reconciliation_runbook";

export type GateStatus = "PASSED" | "BLOCKED" | "UNKNOWN";

/**
 * Why a gate is not passing. These are not all the same thing, and presenting
 * them identically makes a healthy system look broken:
 *
 *  SYSTEM_FAILURE    something is actually wrong right now (collector stopped,
 *                    heartbeat stale, duplicate keys, reconciliation mismatch).
 *  MISSING_POLICY    a required limit has never been chosen. Nothing is broken;
 *                    a human has to decide a number.
 *  MISSING_EVIDENCE  a fact nobody has attested or recorded yet.
 *  GATE_NOT_MATURE   the evidence is accruing correctly and simply needs time.
 */
export type BlockerKind =
  | "SYSTEM_FAILURE"
  | "MISSING_POLICY"
  | "MISSING_EVIDENCE"
  | "GATE_NOT_MATURE";

export const BLOCKER_KIND_FA: Record<BlockerKind, string> = {
  SYSTEM_FAILURE: "خرابی سامانه",
  MISSING_POLICY: "سیاست تعیین‌نشده",
  MISSING_EVIDENCE: "شواهد ثبت‌نشده",
  GATE_NOT_MATURE: "در حال تکمیل"
};

export type ReadinessGate = {
  id: ReadinessGateId;
  labelFa: string;
  status: GateStatus;
  /** Why it is blocked — null when the gate passes. */
  blockerKind: BlockerKind | null;
  /** What was actually checked, in the reviewer's language. */
  evidenceFa: string;
  /** When the evidence stops counting. Null when it does not expire. */
  expiresAt: string | null;
  expired: boolean;
  /** Exact cause when not PASSED. Never a generic message. */
  blockerFa: string | null;
  requiredActionFa: string;
};

/**
 * Attestations are explicit human statements recorded with an author and a
 * date. They are the only evidence for gates a machine cannot verify from
 * inside this system — such as whether a key has withdrawal disabled.
 */
export type AttestationKind =
  | "api_capability"
  | "key_permissions"
  | "transfer_costs"
  | "reconciliation_runbook";

export type AttestationRecord = {
  kind: AttestationKind;
  confirmedBy: string;
  confirmedAt: string;
  /** Structured claims; missing claims block rather than default to true. */
  claims: Record<string, boolean | number | string | null>;
  note: string | null;
};

/** Attested evidence must be re-confirmed at least this often. */
export const ATTESTATION_VALID_DAYS = 90;

export type ReadinessInput = {
  observation: {
    status: string;
    elapsedMs: number;
    targetDurationMs: number;
    successCoveragePercent: number;
  } | null;
  collector: {
    running: boolean;
    heartbeatStale: boolean;
    duplicateIdempotencyKeys: number;
    successfulCycles: number;
    lastCycleStatus: string | null;
  } | null;
  capitalRecommendation: { status: string; reasonFa: string } | null;
  paper: {
    sessionPresent: boolean;
    status: string;
    cyclesEvaluated: number;
    tradesExecuted: number;
    failedDecisions: number;
    economicNetPnlToman: number;
  } | null;
  /**
   * Ledger consistency count. Null means it could not be measured, which is a
   * blocker — an unmeasured ledger is not a reconciled one.
   */
  reconciliationMismatches: number | null;
  venueStates: VenueCapitalState[];
  policies: RiskPolicyState[];
  attestations: AttestationRecord[];
  nowMs: number;
};

function daysBetween(fromIso: string, toMs: number): number {
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (toMs - from) / 86_400_000);
}

function attestation(
  input: ReadinessInput,
  kind: AttestationKind
): { record: AttestationRecord | null; expiresAt: string | null; expired: boolean } {
  const matching = input.attestations
    .filter((a) => a.kind === kind)
    .sort((a, b) => Date.parse(b.confirmedAt) - Date.parse(a.confirmedAt));
  const record = matching[0] ?? null;
  if (!record) return { record: null, expiresAt: null, expired: false };
  const expiresAt = new Date(
    Date.parse(record.confirmedAt) + ATTESTATION_VALID_DAYS * 86_400_000
  ).toISOString();
  return {
    record,
    expiresAt,
    expired: daysBetween(record.confirmedAt, input.nowMs) > ATTESTATION_VALID_DAYS
  };
}

/** Every claim must be explicitly true; a missing claim blocks. */
function requireClaims(
  record: AttestationRecord | null,
  required: string[]
): { ok: boolean; missing: string[] } {
  if (!record) return { ok: false, missing: required };
  const missing = required.filter((c) => record.claims[c] !== true);
  return { ok: missing.length === 0, missing };
}

const CLAIM_FA: Record<string, string> = {
  public_market_data_verified: "دادهٔ عمومی بازار تأییدشده",
  private_api_documented: "مستندات API حساب بررسی‌شده",
  least_privilege_documented: "سیاست حداقل دسترسی مستند شده",
  trading_only_keys: "کلیدها فقط اجازهٔ معامله دارند",
  withdrawal_permission_disabled: "دسترسی برداشت غیرفعال است",
  ip_whitelist_confirmed: "محدودسازی IP تأیید شده است",
  transfer_cost_known: "هزینهٔ انتقال بین صرافی‌ها مشخص است",
  rebalancing_cost_known: "هزینهٔ بازتوازن مشخص است",
  reconciliation_procedure_approved: "رویهٔ تطبیق تأیید شده است",
  incident_runbook_approved: "دستورالعمل حادثه تأیید شده است",
  rollback_procedure_approved: "رویهٔ بازگشت تأیید شده است"
};

function missingClaimsFa(missing: string[]): string {
  return missing.map((m) => CLAIM_FA[m] ?? m).join("، ");
}

/** Build every gate. Each one fails closed with its own exact reason. */
export function evaluateGates(input: ReadinessInput): ReadinessGate[] {
  const gates: ReadinessGate[] = [];

  // 1 — observation window
  {
    const o = input.observation;
    // The required duration is an admin decision, not a constant in this file.
    const requiredDays = policyValueOrNull(input.policies, "min_observation_duration_days");
    const requiredMs = requiredDays === null ? null : requiredDays * 86_400_000;
    const daysOk = Boolean(o && requiredMs !== null && o.elapsedMs >= requiredMs);
    const coverageOk = Boolean(o && o.successCoveragePercent >= REQUIRED_SUCCESS_COVERAGE_PERCENT);
    const blockers: string[] = [];
    if (!o) blockers.push("هیچ نشست مشاهده‌ای وجود ندارد.");
    if (requiredDays === null) {
      blockers.push("سیاست «حداقل مدت مشاهده» تعیین نشده است؛ هیچ مدتی فرض نمی‌شود.");
    }
    if (o && requiredMs !== null && !daysOk) {
      blockers.push(
        `دورهٔ مشاهده کامل نشده (${Math.floor(o.elapsedMs / 86_400_000)} روز از ${Math.round(
          requiredDays ?? 0
        )} روز لازم).`
      );
    }
    if (o && !coverageOk) {
      blockers.push(
        `پوشش موفق ${o.successCoveragePercent}٪ کمتر از حداقل ${REQUIRED_SUCCESS_COVERAGE_PERCENT}٪ است.`
      );
    }
    gates.push({
      id: "observation_window",
      blockerKind: classifyBlockers(blockers, "GATE_NOT_MATURE"),
      labelFa: "دورهٔ مشاهدهٔ ۱۴ روزه با پوشش کافی",
      status: blockers.length ? "BLOCKED" : "PASSED",
      evidenceFa: o
        ? `وضعیت ${o.status} · ${Math.floor(o.elapsedMs / 86_400_000)} روز · پوشش ${o.successCoveragePercent}٪`
        : "بدون شواهد",
      expiresAt: null,
      expired: false,
      blockerFa: blockers.join(" ") || null,
      requiredActionFa: "ادامهٔ مشاهده تا کامل شدن ۱۴ روز با پوشش موفق حداقل ۸۰٪."
    });
  }

  // 2 — collector health
  {
    const c = input.collector;
    const blockers: string[] = [];
    if (!c) blockers.push("وضعیت جمع‌آورنده در دسترس نیست.");
    /*
     * Faults are tracked separately from policy gaps: a running, fresh,
     * duplicate-free collector is healthy even while this gate is blocked
     * because nobody has chosen the limits yet.
     */
    const faults: string[] = [];
    if (c && !c.running) faults.push("جمع‌آورنده در حال اجرا نیست.");
    if (c && c.heartbeatStale) faults.push("ضربان جمع‌آورنده کهنه است.");
    blockers.push(...faults);

    const maxDuplicates = policyValueOrNull(input.policies, "max_duplicate_idempotency_keys");
    const minCycles = policyValueOrNull(input.policies, "min_successful_cycles");
    if (maxDuplicates === null) {
      blockers.push("سیاست «حداکثر کلید تکراری مجاز» تعیین نشده است؛ حتی صفر هم باید انتخاب صریح باشد.");
    } else if (c && c.duplicateIdempotencyKeys > maxDuplicates) {
      faults.push(
        `${c.duplicateIdempotencyKeys} چرخهٔ تکراری ثبت شده که از سقف ${maxDuplicates} بیشتر است.`
      );
      blockers.push(faults[faults.length - 1]);
    }
    if (minCycles === null) {
      blockers.push("سیاست «حداقل چرخهٔ موفق» تعیین نشده است.");
    } else if (c && c.successfulCycles < minCycles) {
      blockers.push(`${c.successfulCycles} چرخهٔ موفق کمتر از حداقل ${minCycles} است.`);
    }
    gates.push({
      id: "collector_health",
      blockerKind: classifyBlockers(blockers, "SYSTEM_FAILURE", faults),
      labelFa: "سلامت جمع‌آورنده و نبود چرخهٔ تکراری",
      status: blockers.length ? "BLOCKED" : "PASSED",
      evidenceFa: c
        ? `اجرا=${c.running} · ضربان کهنه=${c.heartbeatStale} · تکراری=${c.duplicateIdempotencyKeys} · چرخهٔ موفق=${c.successfulCycles}`
        : "بدون شواهد",
      expiresAt: null,
      expired: false,
      blockerFa: blockers.join(" ") || null,
      requiredActionFa: "رفع مشکل جمع‌آورنده و اطمینان از صفر بودن چرخه‌های تکراری."
    });
  }

  // 3 — approved capital plan
  {
    const r = input.capitalRecommendation;
    const ok = r?.status === "APPROVED_SIMULATION_PLAN";
    gates.push({
      id: "capital_plan_approved",
      // Not an error: the plan is provisional until an admin approves it.
      blockerKind: ok ? null : "MISSING_EVIDENCE",
      labelFa: "طرح سرمایهٔ تأییدشدهٔ فاز ۵",
      status: ok ? "PASSED" : "BLOCKED",
      evidenceFa: r ? `وضعیت توصیه: ${r.status}` : "بدون شواهد",
      expiresAt: null,
      expired: false,
      blockerFa: ok ? null : (r?.reasonFa ?? "هیچ طرح تأییدشده‌ای وجود ندارد."),
      requiredActionFa: "تأیید صریح طرح تخصیص سرمایه در بخش شبیه‌ساز سرمایه."
    });
  }

  // 4 — paper evidence
  {
    const p = input.paper;
    const blockers: string[] = [];
    // Every threshold below is an admin policy. None is chosen in this file.
    const minCycles = policyValueOrNull(input.policies, "min_successful_cycles");
    const minFills = policyValueOrNull(input.policies, "min_paper_fills");
    const maxFailures = policyValueOrNull(input.policies, "max_paper_failures");

    if (!p?.sessionPresent) blockers.push("هیچ نشست اجرای کاغذی وجود ندارد.");
    if (minCycles === null) blockers.push("سیاست «حداقل چرخهٔ موفق» تعیین نشده است.");
    else if (p && p.cyclesEvaluated < minCycles) {
      blockers.push(`تعداد چرخهٔ کاغذی ${p.cyclesEvaluated} کمتر از حداقل ${minCycles} است.`);
    }
    if (minFills === null) blockers.push("سیاست «حداقل معاملهٔ کاغذی اجراشده» تعیین نشده است.");
    else if (p && p.tradesExecuted < minFills) {
      blockers.push(`تعداد معاملهٔ کاغذی ${p.tradesExecuted} کمتر از حداقل ${minFills} است.`);
    }
    if (maxFailures === null) blockers.push("سیاست «حداکثر خطای مجاز در اجرای کاغذی» تعیین نشده است.");
    else if (p && p.failedDecisions > maxFailures) {
      blockers.push(`${p.failedDecisions} خطای کاغذی از سقف ${maxFailures} بیشتر است.`);
    }
    gates.push({
      id: "paper_evidence",
      blockerKind: classifyBlockers(blockers, "GATE_NOT_MATURE"),
      labelFa: "شواهد کافی از اجرای کاغذی",
      status: blockers.length ? "BLOCKED" : "PASSED",
      evidenceFa: p
        ? `${p.cyclesEvaluated} چرخه · ${p.tradesExecuted} معامله · ${p.failedDecisions} خطا · سود اقتصادی ${p.economicNetPnlToman}`
        : "بدون شواهد",
      expiresAt: null,
      expired: false,
      blockerFa: blockers.join(" ") || null,
      requiredActionFa: "ادامهٔ نشست کاغذی تا رسیدن به حداقل شواهد."
    });
  }

  // 5 — account and fee readiness
  {
    const executable = input.venueStates.filter((v) => v.executable);
    const stale = input.venueStates.filter((v) => v.feeStale);
    const blockers: string[] = [];
    if (!executable.length) blockers.push("هیچ صرافی با حساب احرازشده و کارمزد معتبر وجود ندارد.");
    if (stale.length) {
      blockers.push(`کارمزد ${stale.map((v) => v.nameFa).join("، ")} منقضی شده است.`);
    }
    gates.push({
      id: "account_fee_readiness",
      blockerKind: classifyBlockers(blockers, "MISSING_EVIDENCE"),
      labelFa: "آمادگی حساب و کارمزد صرافی‌ها",
      status: blockers.length ? "BLOCKED" : "PASSED",
      evidenceFa: `${executable.length} صرافی اجراپذیر از ${input.venueStates.length}`,
      expiresAt: null,
      expired: false,
      blockerFa: blockers.join(" ") || null,
      requiredActionFa: "تکمیل احراز حساب و ثبت/بازبینی کارمزد رسمی."
    });
  }

  // 6 — fee settlement confirmed on both sides
  {
    const executable = input.venueStates.filter((v) => v.executable);
    const unconfirmed = executable.filter(
      (v) => !settlementUsable(settlementFor(v.sourceId, "buy")) || !settlementUsable(settlementFor(v.sourceId, "sell"))
    );
    const blockers: string[] = [];
    if (!executable.length) blockers.push("صرافی اجراپذیری برای بررسی تسویه وجود ندارد.");
    if (unconfirmed.length) {
      blockers.push(`تسویهٔ کارمزد ${unconfirmed.map((v) => v.nameFa).join("، ")} تأیید نشده است.`);
    }
    gates.push({
      id: "fee_settlement",
      blockerKind: classifyBlockers(blockers, "MISSING_EVIDENCE"),
      labelFa: "تأیید نحوهٔ تسویهٔ کارمزد در هر دو سمت",
      status: blockers.length ? "BLOCKED" : "PASSED",
      evidenceFa: `${executable.length - unconfirmed.length} از ${executable.length} صرافی تأییدشده`,
      expiresAt: null,
      expired: false,
      blockerFa: blockers.join(" ") || null,
      requiredActionFa: "ثبت دارایی و نحوهٔ کسر کارمزد برای سمت خرید و فروش هر صرافی."
    });
  }

  // 7 — API capability and least privilege
  {
    const { record, expiresAt, expired } = attestation(input, "api_capability");
    const claims = requireClaims(record, [
      "public_market_data_verified",
      "private_api_documented",
      "least_privilege_documented"
    ]);
    const blockers: string[] = [];
    if (!record) blockers.push("هیچ تأییدیه‌ای برای توان API ثبت نشده است.");
    if (record && expired) blockers.push("تأییدیهٔ توان API منقضی شده است.");
    if (record && !claims.ok) blockers.push(`موارد تأییدنشده: ${missingClaimsFa(claims.missing)}.`);
    gates.push({
      id: "api_capability",
      blockerKind: classifyBlockers(blockers, "MISSING_EVIDENCE"),
      labelFa: "توان API و سیاست حداقل دسترسی",
      status: blockers.length ? "BLOCKED" : "PASSED",
      evidenceFa: record ? `تأیید ${record.confirmedBy} در ${record.confirmedAt.slice(0, 10)}` : "بدون شواهد",
      expiresAt,
      expired,
      blockerFa: blockers.join(" ") || null,
      requiredActionFa: "بررسی و ثبت مستند توان API حساب و سیاست حداقل دسترسی."
    });
  }

  // 8 — key permissions
  {
    const { record, expiresAt, expired } = attestation(input, "key_permissions");
    const claims = requireClaims(record, [
      "trading_only_keys",
      "withdrawal_permission_disabled",
      "ip_whitelist_confirmed"
    ]);
    const blockers: string[] = [];
    if (!record) blockers.push("هیچ تأییدیه‌ای برای محدودیت کلیدها ثبت نشده است.");
    if (record && expired) blockers.push("تأییدیهٔ محدودیت کلیدها منقضی شده است.");
    if (record && !claims.ok) blockers.push(`موارد تأییدنشده: ${missingClaimsFa(claims.missing)}.`);
    gates.push({
      id: "key_permissions",
      blockerKind: classifyBlockers(blockers, "MISSING_EVIDENCE"),
      labelFa: "کلید فقط معاملاتی، برداشت غیرفعال و محدودسازی IP",
      status: blockers.length ? "BLOCKED" : "PASSED",
      evidenceFa: record ? `تأیید ${record.confirmedBy} در ${record.confirmedAt.slice(0, 10)}` : "بدون شواهد",
      expiresAt,
      expired,
      blockerFa: blockers.join(" ") || null,
      requiredActionFa:
        "تأیید اینکه کلیدها فقط اجازهٔ معامله دارند، برداشت غیرفعال است و IP محدود شده است. کلید در این سامانه ذخیره نمی‌شود."
    });
  }

  // 9 — transfer and rebalancing costs
  {
    const { record, expiresAt, expired } = attestation(input, "transfer_costs");
    const claims = requireClaims(record, ["transfer_cost_known", "rebalancing_cost_known"]);
    const blockers: string[] = [];
    if (!record) blockers.push("هزینهٔ انتقال و بازتوازن هنوز مشخص و ثبت نشده است.");
    if (record && expired) blockers.push("تأییدیهٔ هزینهٔ انتقال منقضی شده است.");
    if (record && !claims.ok) blockers.push(`موارد تأییدنشده: ${missingClaimsFa(claims.missing)}.`);
    gates.push({
      id: "transfer_costs",
      blockerKind: classifyBlockers(blockers, "MISSING_EVIDENCE"),
      labelFa: "مشخص بودن هزینهٔ انتقال و بازتوازن",
      status: blockers.length ? "BLOCKED" : "PASSED",
      evidenceFa: record ? `تأیید ${record.confirmedBy} در ${record.confirmedAt.slice(0, 10)}` : "بدون شواهد",
      expiresAt,
      expired,
      blockerFa: blockers.join(" ") || null,
      requiredActionFa: "اندازه‌گیری و ثبت هزینهٔ واقعی انتقال بین صرافی‌ها."
    });
  }

  // 10 — risk policies
  {
    const missing = unsetPolicies(input.policies);
    gates.push({
      id: "risk_policies",
      blockerKind: missing.length ? "MISSING_POLICY" : null,
      labelFa: "پیکربندی صریح همهٔ حدود ریسک",
      status: missing.length ? "BLOCKED" : "PASSED",
      evidenceFa: `${input.policies.length - missing.length} از ${input.policies.length} سیاست پیکربندی شده`,
      expiresAt: null,
      expired: false,
      blockerFa: missing.length
        ? `پیکربندی‌نشده: ${missing.map((p) => p.definition.labelFa).join("، ")}.`
        : null,
      requiredActionFa: "تعیین صریح مقدار هر سیاست ریسک. هیچ مقدار پیش‌فرضی فرض نمی‌شود."
    });
  }

  // 11 — reconciliation integrity of the existing ledgers
  {
    const maxMismatch = policyValueOrNull(input.policies, "max_reconciliation_mismatches");
    const observed = input.reconciliationMismatches;
    const blockers: string[] = [];
    if (maxMismatch === null) {
      blockers.push("سیاست «حداکثر مغایرت تطبیق مجاز» تعیین نشده است.");
    }
    if (observed === null) {
      blockers.push("مغایرت تطبیق اندازه‌گیری نشده است؛ دفتر اندازه‌گیری‌نشده تطبیق‌شده نیست.");
    } else if (maxMismatch !== null && observed > maxMismatch) {
      blockers.push(`${observed} مغایرت تطبیق از سقف ${maxMismatch} بیشتر است.`);
    }
    gates.push({
      id: "reconciliation_integrity",
      blockerKind: classifyBlockers(blockers, "SYSTEM_FAILURE"),
      labelFa: "یکپارچگی تطبیق دفاتر موجود",
      status: blockers.length ? "BLOCKED" : "PASSED",
      evidenceFa: observed === null ? "اندازه‌گیری نشده" : `${observed} مغایرت مشاهده‌شده`,
      expiresAt: null,
      expired: false,
      blockerFa: blockers.join(" ") || null,
      requiredActionFa: "تعیین سقف مغایرت و رفع هر مغایرت مشاهده‌شده در دفاتر."
    });
  }

  // 12 — reconciliation and incident runbook
  {
    const { record, expiresAt, expired } = attestation(input, "reconciliation_runbook");
    const claims = requireClaims(record, [
      "reconciliation_procedure_approved",
      "incident_runbook_approved",
      "rollback_procedure_approved"
    ]);
    const blockers: string[] = [];
    if (!record) blockers.push("رویهٔ تطبیق و دستورالعمل حادثه تأیید نشده است.");
    if (record && expired) blockers.push("تأییدیهٔ رویهٔ تطبیق منقضی شده است.");
    if (record && !claims.ok) blockers.push(`موارد تأییدنشده: ${missingClaimsFa(claims.missing)}.`);
    gates.push({
      id: "reconciliation_runbook",
      blockerKind: classifyBlockers(blockers, "MISSING_EVIDENCE"),
      labelFa: "تأیید رویهٔ تطبیق، دستورالعمل حادثه و بازگشت",
      status: blockers.length ? "BLOCKED" : "PASSED",
      evidenceFa: record ? `تأیید ${record.confirmedBy} در ${record.confirmedAt.slice(0, 10)}` : "بدون شواهد",
      expiresAt,
      expired,
      blockerFa: blockers.join(" ") || null,
      requiredActionFa: "بازبینی و تأیید رویهٔ تطبیق، دستورالعمل حادثه و رویهٔ بازگشت."
    });
  }

  return gates;
}

/**
 * Is the machinery running right now?
 *
 * Deliberately separate from arming readiness: a collector can be perfectly
 * healthy while the system stays DISARMED because a human has not chosen the
 * risk limits yet. Conflating the two makes an operator chase a fault that does
 * not exist.
 */
export type OperationalHealth = {
  healthy: boolean;
  running: boolean;
  heartbeatStale: boolean;
  duplicateIdempotencyKeys: number;
  successfulCycles: number;
  summaryFa: string;
};

export type ReadinessReport = {
  /** What the gates alone would say. */
  gateState: LiveArmingState;
  /** Whether the system is running well, independent of arming readiness. */
  operationalHealth: OperationalHealth;
  /** Blocked gates grouped by cause, so the UI need not treat them alike. */
  blockerCounts: Record<BlockerKind, number>;
  /** What the system actually is. Always DISARMED in this build. */
  effectiveState: "DISARMED";
  liveExecutionImplemented: false;
  unavailableReasonFa: string;
  gates: ReadinessGate[];
  passedCount: number;
  blockedCount: number;
  blockers: Array<{ gate: ReadinessGateId; labelFa: string; blockerFa: string }>;
  nextActionsFa: string[];
};

/**
 * Fail-closed evaluation.
 *
 * `gateState` reaches MANUAL_CANARY_ELIGIBLE only when every gate passes, and
 * even then `effectiveState` is DISARMED: there is no live broker to arm.
 */

/**
 * Classify a gate's blockers.
 *
 * A gate can collect several reasons at once; the most serious one wins, so a
 * genuine fault is never hidden behind a missing policy. The policy blockers
 * are recognised from the exact phrasing the gates emit, which keeps the
 * classification next to the text a reviewer reads.
 */
function classifyBlockers(
  blockers: string[],
  fallback: BlockerKind,
  faults: string[] = []
): BlockerKind | null {
  if (!blockers.length) return null;
  if (faults.length) return "SYSTEM_FAILURE";
  const policyOnly = blockers.every((b) => b.includes("سیاست") && b.includes("تعیین نشده"));
  if (policyOnly) return "MISSING_POLICY";
  if (blockers.some((b) => b.includes("سیاست") && b.includes("تعیین نشده"))) {
    // Mixed: a policy is missing AND something else. Report the other cause.
    const others = blockers.filter((b) => !(b.includes("سیاست") && b.includes("تعیین نشده")));
    return others.length ? fallback : "MISSING_POLICY";
  }
  return fallback;
}

export function evaluateReadiness(input: ReadinessInput): ReadinessReport {
  const gates = evaluateGates(input);
  const blocked = gates.filter((g) => g.status !== "PASSED");
  const passed = gates.length - blocked.length;

  let gateState: LiveArmingState = "DISARMED";
  if (!blocked.length) gateState = "MANUAL_CANARY_ELIGIBLE";
  else if (blocked.length <= 2) gateState = "READY_FOR_REVIEW";

  const blockerCounts: Record<BlockerKind, number> = {
    SYSTEM_FAILURE: 0,
    MISSING_POLICY: 0,
    MISSING_EVIDENCE: 0,
    GATE_NOT_MATURE: 0
  };
  for (const g of blocked) {
    if (g.blockerKind) blockerCounts[g.blockerKind] += 1;
  }

  /*
   * Operational health answers a different question from readiness: is the
   * machinery running right now? It deliberately ignores unset policies, which
   * are a decision waiting to be made rather than a fault.
   */
  const c = input.collector;
  const running = Boolean(c?.running);
  const heartbeatStale = Boolean(c?.heartbeatStale);
  const duplicates = c?.duplicateIdempotencyKeys ?? 0;
  const healthy = Boolean(c) && running && !heartbeatStale && duplicates === 0;
  const operationalHealth: OperationalHealth = {
    healthy,
    running,
    heartbeatStale,
    duplicateIdempotencyKeys: duplicates,
    successfulCycles: c?.successfulCycles ?? 0,
    summaryFa: !c
      ? "شواهدی از جمع‌آورنده ثبت نشده است."
      : healthy
        ? `جمع‌آورنده سالم است: در حال اجرا، ضربان تازه، بدون کلید تکراری، ${c.successfulCycles} چرخهٔ موفق.`
        : [
            running ? null : "جمع‌آورنده در حال اجرا نیست",
            heartbeatStale ? "ضربان کهنه است" : null,
            duplicates > 0 ? `${duplicates} کلید تکراری ثبت شده` : null
          ]
            .filter(Boolean)
            .join(" · ")
  };

  return {
    gateState,
    operationalHealth,
    blockerCounts,
    // Structural, not a policy outcome: this build has no live execution.
    effectiveState: "DISARMED",
    liveExecutionImplemented: LIVE_EXECUTION_IMPLEMENTED,
    unavailableReasonFa: LIVE_UNAVAILABLE_REASON_FA,
    gates,
    passedCount: passed,
    blockedCount: blocked.length,
    blockers: blocked.map((g) => ({
      gate: g.id,
      labelFa: g.labelFa,
      blockerFa: g.blockerFa ?? "شواهد کافی وجود ندارد."
    })),
    nextActionsFa: blocked.map((g) => g.requiredActionFa)
  };
}
