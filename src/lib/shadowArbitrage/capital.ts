/**
 * Phase 5 — Capital Allocation Simulator.
 *
 * Pure, deterministic accounting over data the desk already observed. Nothing
 * here contacts an exchange, holds credentials, places an order, or moves funds:
 * every balance in this module is virtual and every output is an estimate the
 * user asked the simulator to compute.
 *
 * Three rules govern the whole module:
 *  1. Portfolio conservation — allocated value plus reserve always equals the
 *     stated capital, to the toman, by construction.
 *  2. No invented numbers — a missing fee, a stale fee or an unknown transfer
 *     cost yields UNKNOWN/BLOCKED, never a filled-in default.
 *  3. No profit is claimed — the simulator reports what the allocation could
 *     have funded, and the recommendation stays provisional until the 14-day
 *     observation completes with sufficient coverage.
 *
 * OMPFinex is intentionally absent: it belongs to the main OTC project only.
 */
import { venueUsableForNetProfit, type VenueReadiness } from "@/lib/shadowArbitrage/accounts";
import {
  REQUIRED_SUCCESS_COVERAGE_PERCENT,
  SHADOW_SOURCES,
  SHADOW_TRADE_SIZES
} from "@/lib/shadowArbitrage/config";
import { feeFromBps, mulPriceSizeToman, round2, round4 } from "@/lib/shadowArbitrage/money";
import type { ShadowSourceId } from "@/lib/shadowArbitrage/types";

/** Default virtual capital, editable by the admin. */
export const DEFAULT_CAPITAL_TOMAN = 50_000_000;

/** Guard rails for the editable capital field. */
export const MIN_CAPITAL_TOMAN = 1_000_000;
export const MAX_CAPITAL_TOMAN = 100_000_000_000;

/** USDT balances are tracked to six decimals; never as raw floats in accounting. */
const USDT_DECIMALS = 1_000_000;

/**
 * A value that may legitimately be unavailable. UNKNOWN means the inputs were
 * never verified; BLOCKED means a rule forbids computing it at all.
 */
export type Estimate<T> =
  | { status: "KNOWN"; value: T }
  | { status: "UNKNOWN"; reason: string }
  | { status: "BLOCKED"; reason: string };

export function known<T>(value: T): Estimate<T> {
  return { status: "KNOWN", value };
}
export function unknown<T>(reason: string): Estimate<T> {
  return { status: "UNKNOWN", reason };
}
export function blocked<T>(reason: string): Estimate<T> {
  return { status: "BLOCKED", reason };
}

/**
 * How a venue may participate in an allocation.
 *  EXECUTABLE      — verified account plus a fee that is known and fresh.
 *  WHATIF_DISABLED — allocation is allowed for exploration, but it can never
 *                    fund a covered route until the account and fee land.
 *  REFERENCE_ONLY  — comparison data only; capital there is inert.
 */
export type VenueCapitalClass = "EXECUTABLE" | "WHATIF_DISABLED" | "REFERENCE_ONLY";

export type VenueCapitalState = {
  sourceId: ShadowSourceId;
  nameFa: string;
  capitalClass: VenueCapitalClass;
  /** True only for EXECUTABLE venues — the ones a covered route may use. */
  executable: boolean;
  takerFeeBps: number | null;
  feeProvenance: VenueReadiness["feeProvenance"];
  feeStale: boolean;
  /** Why this venue is not executable; null when it is. */
  blockingReason: string | null;
};

export type CapitalAllocation = {
  sourceId: ShadowSourceId;
  /** Virtual toman held on this venue. Integer, never negative. */
  irtToman: number;
  /** Virtual USDT held on this venue. Six decimals, never negative. */
  usdtUnits: number;
};

export type CapitalPlanMode = "MANUAL" | "OPTIMIZED";

export type CapitalPlanInput = {
  totalCapitalToman: number;
  /**
   * Price used to value USDT balances in toman. Required: without it a USDT
   * balance has no comparable value and conservation cannot be checked.
   */
  valuationPriceToman: number;
  allocations: CapitalAllocation[];
  mode: CapitalPlanMode;
};

export type PlanViolationCode =
  | "unknown_venue"
  | "duplicate_venue"
  | "negative_irt"
  | "negative_usdt"
  | "non_finite_amount"
  | "capital_out_of_range"
  | "valuation_price_missing"
  | "over_allocated";

export const PLAN_VIOLATION_FA: Record<PlanViolationCode, string> = {
  unknown_venue: "صرافی خارج از فهرست مجاز آربیتراژ آزمایشی",
  duplicate_venue: "تخصیص تکراری برای یک صرافی",
  negative_irt: "موجودی تومانی منفی مجاز نیست",
  negative_usdt: "موجودی تتری منفی مجاز نیست",
  non_finite_amount: "مقدار عددی نامعتبر",
  capital_out_of_range: "سرمایهٔ واردشده خارج از بازهٔ مجاز است",
  valuation_price_missing: "قیمت ارزش‌گذاری تتر مشخص نیست",
  over_allocated: "مجموع تخصیص از کل سرمایه بیشتر است"
};

export type PlanViolation = {
  code: PlanViolationCode;
  sourceId: ShadowSourceId | null;
  messageFa: string;
};

/** One observed route, folded across the observation window. */
export type RouteEvidence = {
  routeKey: string;
  buySourceId: string;
  sellSourceId: string;
  sizeUsdt: number;
  samples: number;
  positiveNetSamples: number;
  positiveRawSamples: number;
  feeUnknown: boolean;
};

export type ObservationGate = {
  status: string;
  successCoveragePercent: number;
};

export function roundUsdt(units: number): number {
  if (!Number.isFinite(units)) return 0;
  return Math.round(units * USDT_DECIMALS) / USDT_DECIMALS;
}

/** Toman value of a USDT balance at the stated valuation price. */
export function usdtValueToman(units: number, valuationPriceToman: number): number {
  return mulPriceSizeToman(valuationPriceToman, units);
}

/**
 * Venue classification for capital purposes.
 *
 * Deliberately reuses Phase 4's `venueUsableForNetProfit` so there is exactly
 * one definition of "this venue may back a net-profit claim" in the codebase.
 */
export function classifyVenueForCapital(readiness: VenueReadiness): VenueCapitalState {
  let capitalClass: VenueCapitalClass;
  if (readiness.accountState === "REFERENCE_ONLY") capitalClass = "REFERENCE_ONLY";
  else if (venueUsableForNetProfit(readiness)) capitalClass = "EXECUTABLE";
  else capitalClass = "WHATIF_DISABLED";

  return {
    sourceId: readiness.sourceId,
    nameFa: readiness.nameFa,
    capitalClass,
    executable: capitalClass === "EXECUTABLE",
    takerFeeBps: readiness.takerFeeBps,
    feeProvenance: readiness.feeProvenance,
    feeStale: readiness.feeStale,
    blockingReason: capitalClass === "EXECUTABLE" ? null : readiness.blockingReason
  };
}

export function classifyAllVenues(readiness: VenueReadiness[]): VenueCapitalState[] {
  return readiness.map(classifyVenueForCapital);
}

const VALID_SOURCE_IDS = new Set<string>(SHADOW_SOURCES.map((s) => s.id));

/**
 * Structural validation. Runs before any metric so a malformed plan can never
 * reach the accounting code and produce a number that looks authoritative.
 */
export function validateCapitalPlan(plan: CapitalPlanInput): {
  ok: boolean;
  violations: PlanViolation[];
} {
  const violations: PlanViolation[] = [];
  const push = (code: PlanViolationCode, sourceId: ShadowSourceId | null = null) => {
    violations.push({ code, sourceId, messageFa: PLAN_VIOLATION_FA[code] });
  };

  if (
    !Number.isFinite(plan.totalCapitalToman) ||
    plan.totalCapitalToman < MIN_CAPITAL_TOMAN ||
    plan.totalCapitalToman > MAX_CAPITAL_TOMAN
  ) {
    push("capital_out_of_range");
  }
  if (!Number.isFinite(plan.valuationPriceToman) || plan.valuationPriceToman <= 0) {
    push("valuation_price_missing");
  }

  const seen = new Set<string>();
  for (const a of plan.allocations) {
    if (!VALID_SOURCE_IDS.has(a.sourceId)) {
      push("unknown_venue", a.sourceId);
      continue;
    }
    if (seen.has(a.sourceId)) push("duplicate_venue", a.sourceId);
    seen.add(a.sourceId);

    if (!Number.isFinite(a.irtToman) || !Number.isFinite(a.usdtUnits)) {
      push("non_finite_amount", a.sourceId);
      continue;
    }
    if (a.irtToman < 0) push("negative_irt", a.sourceId);
    if (a.usdtUnits < 0) push("negative_usdt", a.sourceId);
  }

  // Over-allocation is only meaningful once the amounts themselves are sane.
  if (!violations.length) {
    const allocated = plan.allocations.reduce(
      (sum, a) => sum + Math.round(a.irtToman) + usdtValueToman(a.usdtUnits, plan.valuationPriceToman),
      0
    );
    if (allocated > Math.round(plan.totalCapitalToman)) push("over_allocated");
  }

  return { ok: violations.length === 0, violations };
}

export type VenueAllocationView = {
  sourceId: ShadowSourceId;
  nameFa: string;
  capitalClass: VenueCapitalClass;
  irtToman: number;
  usdtUnits: number;
  usdtValueToman: number;
  totalValueToman: number;
  /** Share of allocated capital (not of total capital). */
  sharePercent: number;
  /** Largest single trade this venue's IRT can buy, in USDT, at valuation price. */
  maxBuyUsdt: number;
  /** Largest single trade this venue's USDT can sell. */
  maxSellUsdt: number;
  blockingReason: string | null;
};

export type ConcentrationRisk = {
  /** Herfindahl–Hirschman index over venue shares of allocated capital, 0–10000. */
  hhi: number;
  maxVenueSharePercent: number;
  venueCount: number;
  band: "LOW" | "MODERATE" | "HIGH";
  labelFa: string;
};

export type RebalanceEstimate = {
  costToman: Estimate<number>;
  /** Deterministic extrapolation of transfers per 30 days from observed data. */
  expectedMonthlyRebalances: Estimate<number>;
};

export type CapitalSimulation = {
  ok: boolean;
  violations: PlanViolation[];
  mode: CapitalPlanMode;
  totalCapitalToman: number;
  valuationPriceToman: number;
  allocatedToman: number;
  /** Capital deliberately left unallocated. Always total − allocated. */
  unusedReserveToman: number;
  unusedReservePercent: number;
  /** Allocated to EXECUTABLE venues ÷ total capital. */
  capitalUtilizationPercent: number;
  /** Allocated to venues that cannot execute today. */
  idleOnDisabledVenuesToman: number;
  venues: VenueAllocationView[];
  concentration: Estimate<ConcentrationRisk>;
  opportunityCoveragePercent: Estimate<number>;
  coverage: {
    observedRouteSamples: number;
    executableRouteSamples: number;
    fundedRouteSamples: number;
    /** Routes the allocation could fund, of those it structurally could. */
    fundedOfExecutablePercent: Estimate<number>;
    unfundedTopReasons: Array<{ reasonFa: string; samples: number }>;
  };
  rebalance: RebalanceEstimate;
  recommendation: {
    status: "PROVISIONAL";
    locked: true;
    reasonFa: string;
    observationStatus: string;
    successCoveragePercent: number;
    requiredCoveragePercent: number;
    /** True when the observation gate itself is satisfied. Status stays provisional regardless. */
    observationGatePassed: boolean;
  };
  /** Conservation proof: allocated + reserve − total. Must be exactly zero. */
  conservationResidualToman: number;
  notesFa: string[];
};

function concentrationBand(hhi: number): ConcentrationRisk["band"] {
  if (hhi < 1_500) return "LOW";
  if (hhi <= 2_500) return "MODERATE";
  return "HIGH";
}

const CONCENTRATION_FA: Record<ConcentrationRisk["band"], string> = {
  LOW: "پراکندگی مناسب",
  MODERATE: "تمرکز متوسط",
  HIGH: "تمرکز بالا"
};

/**
 * Monthly rebalancing cost.
 *
 * Returns UNKNOWN unless a per-transfer cost was actually confirmed. The
 * project's configured rebalance cost is provisional zero, which is not
 * evidence, so the honest answer today is UNKNOWN rather than "۰ تومان".
 */
export function estimateMonthlyRebalance(input: {
  perTransferCostToman: number | null;
  perTransferCostConfirmed: boolean;
  observedWindowMs: number;
  fundedSamples: number;
}): RebalanceEstimate {
  const monthMs = 30 * 24 * 60 * 60_000;

  let expected: Estimate<number>;
  if (input.observedWindowMs <= 0 || input.fundedSamples <= 0) {
    expected = unknown(
      "تعداد بازتوازن ماهانه بدون دادهٔ کافی از دورهٔ مشاهده قابل برآورد نیست."
    );
  } else {
    // One funded opportunity implies one round trip of inventory.
    expected = known(Math.round((input.fundedSamples * monthMs) / input.observedWindowMs));
  }

  if (!input.perTransferCostConfirmed || input.perTransferCostToman === null) {
    return {
      costToman: unknown(
        "هزینهٔ واقعی انتقال/بازتوازن بین صرافی‌ها تأیید نشده است؛ هیچ عددی جایگزین آن نمی‌شود."
      ),
      expectedMonthlyRebalances: expected
    };
  }
  if (expected.status !== "KNOWN") {
    return {
      costToman: unknown("تعداد بازتوازن ماهانه نامشخص است، پس هزینهٔ ماهانه قابل محاسبه نیست."),
      expectedMonthlyRebalances: expected
    };
  }
  return {
    costToman: known(Math.round(expected.value * input.perTransferCostToman)),
    expectedMonthlyRebalances: expected
  };
}

/**
 * Whether an allocation can fund one instance of a route.
 *
 * Requires both venues executable, enough IRT on the buy venue to pay the VWAP
 * cost plus its taker fee, and enough USDT on the sell venue to deliver.
 */
function routeFundable(
  route: RouteEvidence,
  byVenue: Map<string, VenueAllocationView>,
  states: Map<string, VenueCapitalState>,
  valuationPriceToman: number
): { fundable: boolean; reasonFa: string | null } {
  const buyState = states.get(route.buySourceId);
  const sellState = states.get(route.sellSourceId);
  if (!buyState || !sellState) {
    return { fundable: false, reasonFa: "صرافی ناشناخته در مسیر" };
  }
  if (!buyState.executable || !sellState.executable) {
    return { fundable: false, reasonFa: "یکی از دو صرافی مسیر اجراپذیر نیست" };
  }
  if (route.feeUnknown) {
    return { fundable: false, reasonFa: "کارمزد مسیر تأییدنشده است" };
  }

  const buy = byVenue.get(route.buySourceId);
  const sell = byVenue.get(route.sellSourceId);
  const grossCost = mulPriceSizeToman(valuationPriceToman, route.sizeUsdt);
  const requiredIrt = grossCost + feeFromBps(grossCost, buyState.takerFeeBps ?? 0);

  if (!buy || buy.irtToman < requiredIrt) {
    return { fundable: false, reasonFa: "موجودی تومانی صرافی خرید کافی نیست" };
  }
  if (!sell || sell.usdtUnits < route.sizeUsdt) {
    return { fundable: false, reasonFa: "موجودی تتری صرافی فروش کافی نیست" };
  }
  return { fundable: true, reasonFa: null };
}

export type SimulateInput = {
  plan: CapitalPlanInput;
  readiness: VenueReadiness[];
  routes: RouteEvidence[];
  observation: ObservationGate | null;
  observedWindowMs: number;
  /** Confirmed per-transfer cost, when one exists. Provisional values do not count. */
  perTransferCostToman?: number | null;
  perTransferCostConfirmed?: boolean;
};

/** Run the full simulation. Deterministic: same inputs always give same output. */
export function simulateCapitalPlan(input: SimulateInput): CapitalSimulation {
  const { plan } = input;
  const states = new Map<string, VenueCapitalState>(
    classifyAllVenues(input.readiness).map((s) => [s.sourceId, s])
  );
  const notesFa: string[] = [];

  const validation = validateCapitalPlan(plan);
  const totalCapitalToman = Math.round(plan.totalCapitalToman);
  const valuationPriceToman = Math.round(plan.valuationPriceToman);

  if (!validation.ok) {
    return {
      ok: false,
      violations: validation.violations,
      mode: plan.mode,
      totalCapitalToman,
      valuationPriceToman,
      allocatedToman: 0,
      unusedReserveToman: 0,
      unusedReservePercent: 0,
      capitalUtilizationPercent: 0,
      idleOnDisabledVenuesToman: 0,
      venues: [],
      concentration: blocked("طرح تخصیص معتبر نیست؛ محاسبهٔ ریسک تمرکز انجام نمی‌شود."),
      opportunityCoveragePercent: blocked(
        "طرح تخصیص معتبر نیست؛ پوشش فرصت‌ها محاسبه نمی‌شود."
      ),
      coverage: {
        observedRouteSamples: 0,
        executableRouteSamples: 0,
        fundedRouteSamples: 0,
        fundedOfExecutablePercent: blocked("طرح تخصیص معتبر نیست."),
        unfundedTopReasons: []
      },
      rebalance: {
        costToman: blocked("طرح تخصیص معتبر نیست."),
        expectedMonthlyRebalances: blocked("طرح تخصیص معتبر نیست.")
      },
      recommendation: {
        status: "PROVISIONAL",
        locked: true,
        reasonFa: "طرح تخصیص معتبر نیست.",
        observationStatus: input.observation?.status ?? "NOT_STARTED",
        successCoveragePercent: input.observation?.successCoveragePercent ?? 0,
        requiredCoveragePercent: REQUIRED_SUCCESS_COVERAGE_PERCENT,
        observationGatePassed: false
      },
      conservationResidualToman: 0,
      notesFa: ["ورودی نامعتبر است؛ هیچ عددی گزارش نمی‌شود."]
    };
  }

  // ── Balances ────────────────────────────────────────────────────────────
  const venues: VenueAllocationView[] = [];
  let allocatedToman = 0;
  let executableAllocatedToman = 0;
  let idleOnDisabledVenuesToman = 0;

  for (const a of plan.allocations) {
    const state = states.get(a.sourceId);
    const irt = Math.round(a.irtToman);
    const units = roundUsdt(a.usdtUnits);
    const usdtValue = usdtValueToman(units, valuationPriceToman);
    const total = irt + usdtValue;
    allocatedToman += total;
    if (state?.executable) executableAllocatedToman += total;
    else idleOnDisabledVenuesToman += total;

    venues.push({
      sourceId: a.sourceId,
      nameFa: state?.nameFa ?? a.sourceId,
      capitalClass: state?.capitalClass ?? "WHATIF_DISABLED",
      irtToman: irt,
      usdtUnits: units,
      usdtValueToman: usdtValue,
      totalValueToman: total,
      sharePercent: 0,
      maxBuyUsdt: valuationPriceToman > 0 ? roundUsdt(irt / valuationPriceToman) : 0,
      maxSellUsdt: units,
      blockingReason: state?.blockingReason ?? null
    });
  }

  for (const v of venues) {
    v.sharePercent = allocatedToman > 0 ? round4((v.totalValueToman / allocatedToman) * 100) : 0;
  }
  // Deterministic order: largest allocation first, then venue id.
  venues.sort((a, b) => b.totalValueToman - a.totalValueToman || a.sourceId.localeCompare(b.sourceId));

  const unusedReserveToman = totalCapitalToman - allocatedToman;
  const conservationResidualToman = totalCapitalToman - (allocatedToman + unusedReserveToman);

  // ── Concentration ───────────────────────────────────────────────────────
  let concentration: Estimate<ConcentrationRisk>;
  if (allocatedToman <= 0) {
    concentration = unknown("هیچ سرمایه‌ای تخصیص نیافته است؛ ریسک تمرکز معنا ندارد.");
  } else {
    const hhi = Math.round(venues.reduce((sum, v) => sum + v.sharePercent * v.sharePercent, 0));
    const maxShare = venues.reduce((m, v) => Math.max(m, v.sharePercent), 0);
    const band = concentrationBand(hhi);
    concentration = known({
      hhi,
      maxVenueSharePercent: round2(maxShare),
      venueCount: venues.filter((v) => v.totalValueToman > 0).length,
      band,
      labelFa: CONCENTRATION_FA[band]
    });
  }

  // ── Opportunity coverage ────────────────────────────────────────────────
  const byVenue = new Map(venues.map((v) => [v.sourceId as string, v]));
  let observedRouteSamples = 0;
  let executableRouteSamples = 0;
  let fundedRouteSamples = 0;
  const unfunded = new Map<string, number>();

  for (const route of input.routes) {
    const samples = Math.max(0, Math.round(route.samples));
    if (samples <= 0) continue;
    observedRouteSamples += samples;

    const buyState = states.get(route.buySourceId);
    const sellState = states.get(route.sellSourceId);
    const structurallyExecutable =
      Boolean(buyState?.executable) && Boolean(sellState?.executable) && !route.feeUnknown;
    if (structurallyExecutable) executableRouteSamples += samples;

    const verdict = routeFundable(route, byVenue, states, valuationPriceToman);
    if (verdict.fundable) fundedRouteSamples += samples;
    else if (verdict.reasonFa) unfunded.set(verdict.reasonFa, (unfunded.get(verdict.reasonFa) ?? 0) + samples);
  }

  let opportunityCoveragePercent: Estimate<number>;
  let fundedOfExecutablePercent: Estimate<number>;
  if (observedRouteSamples === 0) {
    const reason = "هنوز دادهٔ مسیر کافی از دورهٔ مشاهده ثبت نشده است.";
    opportunityCoveragePercent = unknown(reason);
    fundedOfExecutablePercent = unknown(reason);
  } else {
    opportunityCoveragePercent = known(round2((fundedRouteSamples / observedRouteSamples) * 100));
    fundedOfExecutablePercent =
      executableRouteSamples === 0
        ? unknown("هیچ مسیری با هر دو صرافی اجراپذیر و کارمزد تأییدشده مشاهده نشده است.")
        : known(round2((fundedRouteSamples / executableRouteSamples) * 100));
  }

  const unfundedTopReasons = [...unfunded.entries()]
    .map(([reasonFa, samples]) => ({ reasonFa, samples }))
    .sort((a, b) => b.samples - a.samples || a.reasonFa.localeCompare(b.reasonFa))
    .slice(0, 5);

  // ── Rebalancing ─────────────────────────────────────────────────────────
  const rebalance = estimateMonthlyRebalance({
    perTransferCostToman: input.perTransferCostToman ?? null,
    perTransferCostConfirmed: input.perTransferCostConfirmed ?? false,
    observedWindowMs: input.observedWindowMs,
    fundedSamples: fundedRouteSamples
  });

  // ── Recommendation lock ─────────────────────────────────────────────────
  const obs = input.observation;
  const coverage = obs?.successCoveragePercent ?? 0;
  const gatePassed = obs?.status === "COMPLETED" && coverage >= REQUIRED_SUCCESS_COVERAGE_PERCENT;
  const reasonFa = gatePassed
    ? "دورهٔ ۱۴ روزه کامل شده است، اما توصیهٔ نهایی تا تأیید صریح مدیر همچنان موقت می‌ماند."
    : obs?.status === "COMPLETED"
      ? `پوشش موفق ${round2(coverage)}٪ کمتر از حداقل ${REQUIRED_SUCCESS_COVERAGE_PERCENT}٪ است.`
      : "دورهٔ مشاهدهٔ ۱۴ روزه هنوز کامل نشده است.";

  // ── Notes ───────────────────────────────────────────────────────────────
  if (idleOnDisabledVenuesToman > 0) {
    notesFa.push(
      "بخشی از سرمایه روی صرافی‌هایی قرار گرفته که هنوز اجراپذیر نیستند؛ این مبلغ در بهره‌وری سرمایه شمرده نمی‌شود."
    );
  }
  if (rebalance.costToman.status !== "KNOWN") {
    notesFa.push("هزینهٔ بازتوازن ماهانه نامشخص است و با هیچ عدد پیش‌فرضی جایگزین نشده است.");
  }
  if (opportunityCoveragePercent.status !== "KNOWN") {
    notesFa.push("پوشش فرصت‌ها بدون دادهٔ مشاهده قابل محاسبه نیست.");
  }
  notesFa.push("این شبیه‌ساز هیچ سفارشی ثبت نمی‌کند و هیچ وجهی جابه‌جا نمی‌شود.");

  return {
    ok: true,
    violations: [],
    mode: plan.mode,
    totalCapitalToman,
    valuationPriceToman,
    allocatedToman,
    unusedReserveToman,
    unusedReservePercent:
      totalCapitalToman > 0 ? round2((unusedReserveToman / totalCapitalToman) * 100) : 0,
    capitalUtilizationPercent:
      totalCapitalToman > 0 ? round2((executableAllocatedToman / totalCapitalToman) * 100) : 0,
    idleOnDisabledVenuesToman,
    venues,
    concentration,
    opportunityCoveragePercent,
    coverage: {
      observedRouteSamples,
      executableRouteSamples,
      fundedRouteSamples,
      fundedOfExecutablePercent,
      unfundedTopReasons
    },
    rebalance,
    recommendation: {
      status: "PROVISIONAL",
      locked: true,
      reasonFa,
      observationStatus: obs?.status ?? "NOT_STARTED",
      successCoveragePercent: round2(coverage),
      requiredCoveragePercent: REQUIRED_SUCCESS_COVERAGE_PERCENT,
      observationGatePassed: gatePassed
    },
    conservationResidualToman,
    notesFa
  };
}

/**
 * Largest-remainder split of an integer total across weights.
 * Guarantees the parts sum exactly to `total`, which is what keeps the
 * portfolio conserved after rounding.
 */
export function splitIntegerByWeights(total: number, weights: number[]): number[] {
  const t = Math.round(total);
  const sum = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (t <= 0 || weights.length === 0 || sum <= 0) return weights.map(() => 0);

  const exact = weights.map((w) => (Math.max(0, w) / sum) * t);
  const floors = exact.map((x) => Math.floor(x));
  let remainder = t - floors.reduce((s, x) => s + x, 0);

  // Deterministic tie-break: larger fractional part first, then lower index.
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const out = [...floors];
  for (const { i } of order) {
    if (remainder <= 0) break;
    out[i] += 1;
    remainder -= 1;
  }
  return out;
}

export type OptimizeInput = {
  totalCapitalToman: number;
  valuationPriceToman: number;
  readiness: VenueReadiness[];
  routes: RouteEvidence[];
  /** Fraction of capital deliberately held back, 0–90. Default 0: nothing invented. */
  reservePercent?: number;
};

export type OptimizedPlan = {
  plan: CapitalPlanInput;
  /** How the weights were derived — surfaced so the split is never a black box. */
  basis: "OBSERVED_NET_POSITIVE" | "OBSERVED_RAW_POSITIVE" | "EQUAL_SPLIT_NO_EVIDENCE" | "NONE";
  basisFa: string;
  status: "PROVISIONAL";
  reasonFa: string;
  venueWeights: Array<{ sourceId: ShadowSourceId; buyWeight: number; sellWeight: number }>;
};

const BASIS_FA: Record<OptimizedPlan["basis"], string> = {
  OBSERVED_NET_POSITIVE: "بر پایهٔ نمونه‌های سود خالص مثبت مشاهده‌شده",
  OBSERVED_RAW_POSITIVE: "بر پایهٔ نمونه‌های اسپرد خام مثبت (سود خالص هنوز مشاهده نشده)",
  EQUAL_SPLIT_NO_EVIDENCE: "تقسیم مساوی — شواهد تاریخی کافی وجود ندارد",
  NONE: "هیچ صرافی اجراپذیری وجود ندارد"
};

/**
 * Provisional optimized allocation.
 *
 * Deterministic and evidence-weighted: capital follows the venues that actually
 * appeared on the profitable side of observed routes. It never allocates to a
 * venue that cannot execute, and it always conserves the portfolio exactly.
 */
export function buildOptimizedPlan(input: OptimizeInput): OptimizedPlan {
  const states = classifyAllVenues(input.readiness);
  const executable = states.filter((s) => s.executable);
  const reservePercent = Math.min(90, Math.max(0, input.reservePercent ?? 0));
  const total = Math.round(input.totalCapitalToman);
  const price = Math.round(input.valuationPriceToman);
  const allocatable = Math.round((total * (100 - reservePercent)) / 100);

  const base: CapitalPlanInput = {
    totalCapitalToman: total,
    valuationPriceToman: price,
    allocations: [],
    mode: "OPTIMIZED"
  };

  if (!executable.length || allocatable <= 0 || price <= 0) {
    return {
      plan: base,
      basis: "NONE",
      basisFa: BASIS_FA.NONE,
      status: "PROVISIONAL",
      reasonFa:
        "هیچ صرافی با حساب احرازشده و کارمزد تأییدشدهٔ معتبر وجود ندارد؛ تخصیص خودکار انجام نمی‌شود."
    ,
      venueWeights: []
    };
  }

  const executableIds = new Set(executable.map((s) => s.sourceId as string));
  const buyWeight = new Map<string, number>(executable.map((s) => [s.sourceId as string, 0]));
  const sellWeight = new Map<string, number>(executable.map((s) => [s.sourceId as string, 0]));

  const accumulate = (pick: (r: RouteEvidence) => number): number => {
    let touched = 0;
    for (const r of input.routes) {
      if (r.feeUnknown) continue;
      if (!executableIds.has(r.buySourceId) || !executableIds.has(r.sellSourceId)) continue;
      const w = Math.max(0, pick(r));
      if (w <= 0) continue;
      buyWeight.set(r.buySourceId, (buyWeight.get(r.buySourceId) ?? 0) + w);
      sellWeight.set(r.sellSourceId, (sellWeight.get(r.sellSourceId) ?? 0) + w);
      touched += w;
    }
    return touched;
  };

  let basis: OptimizedPlan["basis"] = "OBSERVED_NET_POSITIVE";
  let touched = accumulate((r) => r.positiveNetSamples);
  if (touched === 0) {
    basis = "OBSERVED_RAW_POSITIVE";
    touched = accumulate((r) => r.positiveRawSamples);
  }
  if (touched === 0) {
    basis = "EQUAL_SPLIT_NO_EVIDENCE";
    for (const s of executable) {
      buyWeight.set(s.sourceId, 1);
      sellWeight.set(s.sourceId, 1);
    }
  }

  // Venue-level split of allocatable capital, exact by largest remainder.
  const ordered = [...executable].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  const venueWeights = ordered.map((s) => ({
    sourceId: s.sourceId,
    buyWeight: buyWeight.get(s.sourceId) ?? 0,
    sellWeight: sellWeight.get(s.sourceId) ?? 0
  }));
  const venueTotals = splitIntegerByWeights(
    allocatable,
    venueWeights.map((w) => w.buyWeight + w.sellWeight)
  );

  const allocations: CapitalAllocation[] = ordered.map((s, i) => {
    const w = venueWeights[i];
    const venueTotal = venueTotals[i];
    // Only the USDT side is taken from the split; the IRT side is whatever is
    // left, which is what makes `irt + usdtValue === venueTotal` exact.
    const usdtPart = splitIntegerByWeights(venueTotal, [w.buyWeight, w.sellWeight])[1];
    // Derive units from the toman part, then give the venue exactly what is
    // left as IRT so `irt + usdtValue === venueTotal` holds to the toman.
    const units = roundUsdt(usdtPart / price);
    const usdtValue = usdtValueToman(units, price);
    return {
      sourceId: s.sourceId,
      irtToman: Math.max(0, venueTotal - usdtValue),
      usdtUnits: units
    };
  });

  return {
    plan: { ...base, allocations },
    basis,
    basisFa: BASIS_FA[basis],
    status: "PROVISIONAL",
    reasonFa:
      "این تخصیص پیشنهادی و موقت است و تا پایان دورهٔ مشاهدهٔ ۱۴ روزه با پوشش کافی، نهایی محسوب نمی‌شود.",
    venueWeights
  };
}

/**
 * Smallest trade size the desk can still fund on both legs — used by the UI to
 * warn when an allocation is too thin to cover any observed route.
 */
export function smallestFundableSizeUsdt(
  venues: VenueAllocationView[],
  valuationPriceToman: number
): number | null {
  const executableVenues = venues.filter((v) => v.capitalClass === "EXECUTABLE");
  for (const size of SHADOW_TRADE_SIZES) {
    const cost = mulPriceSizeToman(valuationPriceToman, size);
    const canBuy = executableVenues.some((v) => v.irtToman >= cost);
    const canSell = executableVenues.some((v) => v.usdtUnits >= size);
    if (canBuy && canSell) return size;
  }
  return null;
}
