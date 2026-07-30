/**
 * Phase 7A — execution design, interfaces and state machines only.
 *
 * This module describes what a two-leg execution WOULD look like. It contains
 * no exchange client, no credential, no authenticated call and no function that
 * can place, amend or cancel a real order. The only executable implementation
 * of the port defined here is the Phase 6 paper broker; tests use fakes.
 *
 * The pipeline is:
 *   opportunity → pre-trade validation → balance reservation → approval
 *   → two-leg execution plan → reconciliation
 *
 * Pure module: no database, no network.
 */
import { LIVE_EXECUTION_IMPLEMENTED, type ExecutionSurface } from "@/lib/shadowArbitrage/live/capability";
import type { RiskPolicyState } from "@/lib/shadowArbitrage/live/policy";
import type { ShadowSourceId } from "@/lib/shadowArbitrage/types";

/** Overall arming state of the desk. There is no ARMED member, by design. */
export type LiveArmingState = "DISARMED" | "READY_FOR_REVIEW" | "MANUAL_CANARY_ELIGIBLE";

/** Lifecycle of one execution plan. */
export type OrderPlanState =
  | "PLANNED"
  | "APPROVED"
  | "SENT"
  | "PARTIAL"
  | "FILLED"
  | "FAILED"
  | "HEDGE_REQUIRED"
  | "RECONCILED";

/**
 * Allowed transitions. Anything not listed is rejected, so a plan can never
 * skip approval, and a partially filled plan can never be quietly forgotten:
 * every terminal path ends at RECONCILED.
 */
export const ORDER_PLAN_TRANSITIONS: Record<OrderPlanState, OrderPlanState[]> = {
  PLANNED: ["APPROVED", "FAILED"],
  APPROVED: ["SENT", "FAILED"],
  SENT: ["PARTIAL", "FILLED", "FAILED", "HEDGE_REQUIRED"],
  PARTIAL: ["FILLED", "HEDGE_REQUIRED", "FAILED"],
  FILLED: ["RECONCILED"],
  FAILED: ["RECONCILED", "HEDGE_REQUIRED"],
  HEDGE_REQUIRED: ["RECONCILED", "FAILED"],
  RECONCILED: []
};

export const ORDER_PLAN_STATE_FA: Record<OrderPlanState, string> = {
  PLANNED: "طرح‌ریزی‌شده",
  APPROVED: "تأییدشده",
  SENT: "ارسال‌شده",
  PARTIAL: "اجرای جزئی",
  FILLED: "اجرای کامل",
  FAILED: "ناموفق",
  HEDGE_REQUIRED: "نیازمند پوشش ریسک",
  RECONCILED: "تطبیق‌شده"
};

export function canTransition(from: OrderPlanState, to: OrderPlanState): boolean {
  return (ORDER_PLAN_TRANSITIONS[from] ?? []).includes(to);
}

export function isTerminal(state: OrderPlanState): boolean {
  return state === "RECONCILED";
}

/**
 * Every state a restart may find a plan in, and what the recovery procedure is.
 * A plan left mid-flight must never be silently retried.
 */
export const RESTART_RECOVERY: Record<OrderPlanState, "RESUME" | "RECONCILE" | "DONE"> = {
  PLANNED: "RESUME",
  APPROVED: "RESUME",
  // A plan that was in flight must be reconciled against the venue, not resent.
  SENT: "RECONCILE",
  PARTIAL: "RECONCILE",
  FILLED: "RECONCILE",
  FAILED: "RECONCILE",
  HEDGE_REQUIRED: "RECONCILE",
  RECONCILED: "DONE"
};

export type LegSide = "BUY" | "SELL";

export type ExecutionLeg = {
  side: LegSide;
  sourceId: ShadowSourceId;
  sizeUsdt: number;
  limitPriceToman: number;
  /** Deterministic, idempotent identifier for this leg attempt. */
  clientOrderId: string;
};

export type ExecutionPlan = {
  planId: string;
  lifecycleId: string;
  routeKey: string;
  /** Which surface would run it. Never a live venue in this build. */
  surface: ExecutionSurface;
  state: OrderPlanState;
  buyLeg: ExecutionLeg;
  sellLeg: ExecutionLeg;
  /** USDT/IRT reserved on each venue while the plan is in flight. */
  reservations: BalanceReservation[];
  createdAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
};

export type BalanceReservation = {
  sourceId: ShadowSourceId;
  irtToman: number;
  usdtMicros: number;
};

/**
 * Deterministic client order id.
 *
 * Same plan + leg + attempt always yields the same id, so a retry after a
 * timeout is recognised by the venue as the same request rather than becoming a
 * second order. The attempt counter is explicit: a genuine re-submission must
 * be a deliberate new attempt, not an accident.
 */
export function clientOrderId(planId: string, side: LegSide, attempt: number): string {
  const safePlan = planId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);
  return `sa-${safePlan}-${side.toLowerCase()}-${Math.max(1, Math.floor(attempt))}`;
}

/* ── pre-trade validation ─────────────────────────────────────────────────── */

export type PreTradeRejectionCode =
  | "live_not_implemented"
  | "not_armed"
  | "policy_unset"
  | "edge_below_minimum"
  | "order_too_large"
  | "quote_too_old"
  | "slippage_too_high"
  | "venue_exposure_exceeded"
  | "daily_loss_exceeded"
  | "kill_switch_engaged"
  | "circuit_breaker_open"
  | "insufficient_reservable_balance";

export const PRE_TRADE_FA: Record<PreTradeRejectionCode, string> = {
  live_not_implemented: "اجرای واقعی پیاده‌سازی نشده است",
  not_armed: "سامانه در وضعیت مسلح نیست",
  policy_unset: "سیاست ریسک لازم پیکربندی نشده است",
  edge_below_minimum: "سود اقتصادی تعدیل‌شده کمتر از حداقل مجاز است",
  order_too_large: "حجم سفارش از سقف مجاز بیشتر است",
  quote_too_old: "قیمت از حد کهنگی مجاز گذشته است",
  slippage_too_high: "لغزش تخمینی از سقف مجاز بیشتر است",
  venue_exposure_exceeded: "تمرکز روی این صرافی از سقف مجاز بیشتر است",
  daily_loss_exceeded: "زیان روزانه به سقف رسیده است",
  kill_switch_engaged: "کلید توقف اضطراری فعال است",
  circuit_breaker_open: "قطع‌کنندهٔ مدار این صرافی باز است",
  insufficient_reservable_balance: "موجودی قابل‌رزرو کافی نیست"
};

export type PreTradeInput = {
  armingState: LiveArmingState;
  policies: RiskPolicyState[];
  sizeUsdt: number;
  riskAdjustedEdgePercent: number;
  quoteAgeMs: number;
  estimatedSlippageBps: number;
  venueExposurePercent: number;
  dailyLossToman: number;
  killSwitchEngaged: boolean;
  openCircuitVenues: ShadowSourceId[];
  buySourceId: ShadowSourceId;
  sellSourceId: ShadowSourceId;
  reservableIrtToman: number;
  reservableUsdtMicros: number;
  requiredIrtToman: number;
  requiredUsdtMicros: number;
};

export type PreTradeResult =
  | { ok: true }
  | { ok: false; codes: PreTradeRejectionCode[]; reasonsFa: string[] };

function policyValue(policies: RiskPolicyState[], key: string): number | null {
  return policies.find((p) => p.definition.key === key)?.value ?? null;
}

/**
 * Fail-closed pre-trade validation.
 *
 * The first check is structural: live execution is not implemented, so this
 * function can never return ok for a live surface. Everything after it is the
 * risk model, evaluated so the design is testable today.
 */
export function validatePreTrade(input: PreTradeInput): PreTradeResult {
  const codes: PreTradeRejectionCode[] = [];

  // Structural refusal first — no configuration can get past this.
  if (!LIVE_EXECUTION_IMPLEMENTED) codes.push("live_not_implemented");
  if (input.armingState !== "MANUAL_CANARY_ELIGIBLE") codes.push("not_armed");

  const unset = input.policies.filter((p) => !p.configured);
  if (unset.length) codes.push("policy_unset");

  if (input.killSwitchEngaged) codes.push("kill_switch_engaged");
  if (
    input.openCircuitVenues.includes(input.buySourceId) ||
    input.openCircuitVenues.includes(input.sellSourceId)
  ) {
    codes.push("circuit_breaker_open");
  }

  // Threshold checks only run against values that were actually configured;
  // an unset policy is already a blocker above and is never assumed.
  const maxSize = policyValue(input.policies, "max_order_size_usdt");
  if (maxSize !== null && input.sizeUsdt > maxSize) codes.push("order_too_large");

  const minEdge = policyValue(input.policies, "min_risk_adjusted_edge_percent");
  if (minEdge !== null && input.riskAdjustedEdgePercent < minEdge) codes.push("edge_below_minimum");

  const maxAge = policyValue(input.policies, "max_quote_age_ms");
  if (maxAge !== null && input.quoteAgeMs > maxAge) codes.push("quote_too_old");

  const maxSlip = policyValue(input.policies, "max_slippage_bps");
  if (maxSlip !== null && input.estimatedSlippageBps > maxSlip) codes.push("slippage_too_high");

  const maxExposure = policyValue(input.policies, "max_venue_exposure_percent");
  if (maxExposure !== null && input.venueExposurePercent > maxExposure) {
    codes.push("venue_exposure_exceeded");
  }

  const maxLoss = policyValue(input.policies, "max_daily_loss_toman");
  if (maxLoss !== null && input.dailyLossToman >= maxLoss) codes.push("daily_loss_exceeded");

  if (
    input.reservableIrtToman < input.requiredIrtToman ||
    input.reservableUsdtMicros < input.requiredUsdtMicros
  ) {
    codes.push("insufficient_reservable_balance");
  }

  if (!codes.length) return { ok: true };
  return { ok: false, codes, reasonsFa: codes.map((c) => PRE_TRADE_FA[c]) };
}

/* ── broker port ──────────────────────────────────────────────────────────── */

export type LegRequest = {
  clientOrderId: string;
  side: LegSide;
  sourceId: ShadowSourceId;
  sizeUsdt: number;
  limitPriceToman: number;
};

export type LegOutcome = {
  clientOrderId: string;
  /** Filled quantity in USDT micros. Less than requested means partial. */
  filledUsdtMicros: number;
  requestedUsdtMicros: number;
  avgPriceToman: number | null;
  status: "FILLED" | "PARTIAL" | "REJECTED";
  /** True when the port recognised a repeat of an id it already answered. */
  duplicateOfPriorRequest: boolean;
  reasonFa: string | null;
};

/**
 * The port an execution surface must satisfy.
 *
 * `canPlaceRealOrders` is typed as the literal `false`: no implementation of
 * this interface can claim otherwise without failing to compile. There is no
 * live implementation in this repository.
 */
export interface ExecutionSurfacePort {
  readonly surface: ExecutionSurface;
  readonly canPlaceRealOrders: false;
  /** Simulate one leg. Idempotent on clientOrderId. */
  simulateLeg(request: LegRequest): Promise<LegOutcome>;
}

/* ── two-leg orchestration ────────────────────────────────────────────────── */

export type TwoLegOutcome = {
  state: OrderPlanState;
  buy: LegOutcome | null;
  sell: LegOutcome | null;
  /** Set when one leg filled and the other did not — the open risk. */
  hedgeRequiredUsdtMicros: number;
  reasonFa: string | null;
};

/**
 * Run both legs against a surface port and classify the result.
 *
 * Leg risk is the whole point: if the first leg fills and the second does not,
 * the desk is left holding inventory. That case is never reported as FAILED —
 * it becomes HEDGE_REQUIRED with the exact exposure, because pretending it
 * failed would hide a real position.
 */
export async function runTwoLegPlan(
  port: ExecutionSurfacePort,
  plan: ExecutionPlan
): Promise<TwoLegOutcome> {
  const buy = await port.simulateLeg({
    clientOrderId: plan.buyLeg.clientOrderId,
    side: "BUY",
    sourceId: plan.buyLeg.sourceId,
    sizeUsdt: plan.buyLeg.sizeUsdt,
    limitPriceToman: plan.buyLeg.limitPriceToman
  });

  if (buy.status === "REJECTED") {
    // Nothing was acquired, so there is no exposure to hedge.
    return { state: "FAILED", buy, sell: null, hedgeRequiredUsdtMicros: 0, reasonFa: buy.reasonFa };
  }

  const sell = await port.simulateLeg({
    clientOrderId: plan.sellLeg.clientOrderId,
    side: "SELL",
    sourceId: plan.sellLeg.sourceId,
    sizeUsdt: plan.sellLeg.sizeUsdt,
    limitPriceToman: plan.sellLeg.limitPriceToman
  });

  const exposure = buy.filledUsdtMicros - sell.filledUsdtMicros;

  if (sell.status === "REJECTED") {
    return {
      state: "HEDGE_REQUIRED",
      buy,
      sell,
      hedgeRequiredUsdtMicros: Math.max(0, buy.filledUsdtMicros),
      reasonFa: "پای خرید اجرا شد ولی پای فروش رد شد؛ موجودی باز نیازمند پوشش است."
    };
  }

  if (exposure !== 0) {
    return {
      state: "HEDGE_REQUIRED",
      buy,
      sell,
      hedgeRequiredUsdtMicros: Math.abs(exposure),
      reasonFa: "دو پا با حجم برابر اجرا نشدند؛ اختلاف موجودی نیازمند پوشش است."
    };
  }

  const partial =
    buy.status === "PARTIAL" ||
    sell.status === "PARTIAL" ||
    buy.filledUsdtMicros < buy.requestedUsdtMicros;

  return {
    state: partial ? "PARTIAL" : "FILLED",
    buy,
    sell,
    hedgeRequiredUsdtMicros: 0,
    reasonFa: partial ? "هر دو پا جزئی و برابر اجرا شدند." : null
  };
}

/* ── reconciliation ───────────────────────────────────────────────────────── */

export type ReconciliationResult = {
  reconciled: boolean;
  state: OrderPlanState;
  /** Difference between what the plan intended and what actually happened. */
  buyDeltaUsdtMicros: number;
  sellDeltaUsdtMicros: number;
  openExposureUsdtMicros: number;
  reasonFa: string | null;
};

/**
 * Compare intent with outcome. A plan is only RECONCILED when the books agree
 * and no exposure is left open; otherwise it stays HEDGE_REQUIRED so a human
 * has to resolve it.
 */
export function reconcilePlan(plan: ExecutionPlan, outcome: TwoLegOutcome): ReconciliationResult {
  const intendedBuy = Math.round(plan.buyLeg.sizeUsdt * 1_000_000);
  const intendedSell = Math.round(plan.sellLeg.sizeUsdt * 1_000_000);
  const buyDelta = (outcome.buy?.filledUsdtMicros ?? 0) - intendedBuy;
  const sellDelta = (outcome.sell?.filledUsdtMicros ?? 0) - intendedSell;
  const openExposure = outcome.hedgeRequiredUsdtMicros;

  if (openExposure !== 0) {
    return {
      reconciled: false,
      state: "HEDGE_REQUIRED",
      buyDeltaUsdtMicros: buyDelta,
      sellDeltaUsdtMicros: sellDelta,
      openExposureUsdtMicros: openExposure,
      reasonFa: "موجودی باز وجود دارد؛ تا تعیین تکلیف انسانی تطبیق کامل نمی‌شود."
    };
  }

  return {
    reconciled: true,
    state: "RECONCILED",
    buyDeltaUsdtMicros: buyDelta,
    sellDeltaUsdtMicros: sellDelta,
    openExposureUsdtMicros: 0,
    reasonFa: null
  };
}
