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
import { unsetPolicies, type RiskPolicyState } from "@/lib/shadowArbitrage/live/policy";
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
  | "reconciliation_runbook";

export type GateStatus = "PASSED" | "BLOCKED" | "UNKNOWN";

export type ReadinessGate = {
  id: ReadinessGateId;
  labelFa: string;
  status: GateStatus;
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
    lastCycleStatus: string | null;
  } | null;
  capitalRecommendation: { status: string; reasonFa: string } | null;
  paper: {
    sessionPresent: boolean;
    status: string;
    cyclesEvaluated: number;
    tradesExecuted: number;
    economicNetPnlToman: number;
  } | null;
  venueStates: VenueCapitalState[];
  policies: RiskPolicyState[];
  attestations: AttestationRecord[];
  nowMs: number;
};

/** Minimum paper evidence before live readiness may even be reviewed. */
export const MIN_PAPER_CYCLES = 500;
export const MIN_PAPER_TRADES = 20;

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
    const daysOk = Boolean(o && o.elapsedMs >= o.targetDurationMs);
    const coverageOk = Boolean(o && o.successCoveragePercent >= REQUIRED_SUCCESS_COVERAGE_PERCENT);
    const blockers: string[] = [];
    if (!o) blockers.push("هیچ نشست مشاهده‌ای وجود ندارد.");
    if (o && !daysOk) {
      blockers.push(
        `دورهٔ مشاهده کامل نشده (${Math.floor(o.elapsedMs / 86_400_000)} روز از ${Math.round(
          o.targetDurationMs / 86_400_000
        )} روز).`
      );
    }
    if (o && !coverageOk) {
      blockers.push(
        `پوشش موفق ${o.successCoveragePercent}٪ کمتر از حداقل ${REQUIRED_SUCCESS_COVERAGE_PERCENT}٪ است.`
      );
    }
    gates.push({
      id: "observation_window",
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
    if (c && !c.running) blockers.push("جمع‌آورنده در حال اجرا نیست.");
    if (c && c.heartbeatStale) blockers.push("ضربان جمع‌آورنده کهنه است.");
    if (c && c.duplicateIdempotencyKeys > 0) {
      blockers.push(`${c.duplicateIdempotencyKeys} چرخهٔ تکراری ثبت شده است.`);
    }
    gates.push({
      id: "collector_health",
      labelFa: "سلامت جمع‌آورنده و نبود چرخهٔ تکراری",
      status: blockers.length ? "BLOCKED" : "PASSED",
      evidenceFa: c
        ? `اجرا=${c.running} · ضربان کهنه=${c.heartbeatStale} · تکراری=${c.duplicateIdempotencyKeys}`
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
    if (!p?.sessionPresent) blockers.push("هیچ نشست اجرای کاغذی وجود ندارد.");
    if (p && p.cyclesEvaluated < MIN_PAPER_CYCLES) {
      blockers.push(`تعداد چرخهٔ کاغذی ${p.cyclesEvaluated} کمتر از حداقل ${MIN_PAPER_CYCLES} است.`);
    }
    if (p && p.tradesExecuted < MIN_PAPER_TRADES) {
      blockers.push(`تعداد معاملهٔ کاغذی ${p.tradesExecuted} کمتر از حداقل ${MIN_PAPER_TRADES} است.`);
    }
    gates.push({
      id: "paper_evidence",
      labelFa: "شواهد کافی از اجرای کاغذی",
      status: blockers.length ? "BLOCKED" : "PASSED",
      evidenceFa: p
        ? `${p.cyclesEvaluated} چرخه · ${p.tradesExecuted} معامله · سود اقتصادی ${p.economicNetPnlToman}`
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

  // 11 — reconciliation and incident runbook
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

export type ReadinessReport = {
  /** What the gates alone would say. */
  gateState: LiveArmingState;
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
export function evaluateReadiness(input: ReadinessInput): ReadinessReport {
  const gates = evaluateGates(input);
  const blocked = gates.filter((g) => g.status !== "PASSED");
  const passed = gates.length - blocked.length;

  let gateState: LiveArmingState = "DISARMED";
  if (!blocked.length) gateState = "MANUAL_CANARY_ELIGIBLE";
  else if (blocked.length <= 2) gateState = "READY_FOR_REVIEW";

  return {
    gateState,
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
