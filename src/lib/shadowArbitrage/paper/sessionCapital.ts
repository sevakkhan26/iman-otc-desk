/**
 * Configurable Paper session capital — pure helpers (Step 1 + Step 4 policy sync).
 *
 * Does not place orders. Capital is whole toman end-to-end; residual after
 * allocation must be zero. Changing capital may produce a matching immutable
 * order-cap policy snapshot when the order cap is capital-derived — never
 * when an explicit admin cap is in force.
 */
import { createHash } from "node:crypto";
import {
  MAX_CAPITAL_TOMAN,
  MIN_CAPITAL_TOMAN
} from "@/lib/shadowArbitrage/capital";
import {
  defaultAllocation,
  portfolioValueToman,
  validateAllocation,
  type AllocationValidation,
  type VenueAllocation
} from "@/lib/shadowArbitrage/paper/portfolio";
import {
  PAPER_4D_MAX_ROUTE_CAPITAL_PERCENT,
  PAPER_4D_MAX_UTILIZATION_PERCENT,
  PAPER_4D_MAX_VENUE_EXPOSURE_PERCENT,
  PAPER_4D_MIN_RESERVE_PERCENT
} from "@/lib/shadowArbitrage/paper/experimentPolicy";

/** Re-export bounds so UI/API share one source. */
export { MIN_CAPITAL_TOMAN, MAX_CAPITAL_TOMAN };

/** setBy value written when the order cap is recomputed from capital. */
export const ORDER_CAP_DERIVED_ACTOR = "capital-derived" as const;

export type OrderCapMode = "explicit_admin" | "capital_derived";

/**
 * Classify the live max_order_size_usdt policy.
 * Explicit admin (or any non-derived setBy) is never overwritten by capital apply.
 */
export function classifyOrderCapMode(input: {
  configured: boolean;
  setBy: string | null | undefined;
}): OrderCapMode {
  if (!input.configured) return "capital_derived";
  const by = (input.setBy ?? "").trim();
  if (!by || by === ORDER_CAP_DERIVED_ACTOR || by.startsWith("capital-derived")) {
    return "capital_derived";
  }
  return "explicit_admin";
}

/**
 * Capital-relative order ceiling (USDT, floored).
 *
 * min of:
 *  - usable equity after min reserve / max util (default 20% reserve → 80% usable)
 *  - route capital % of equity (default 10%)
 *  - venue exposure % of equity (default 20%)
 * converted at the reference mark. Never invents a mark.
 */
export function deriveOrderCapUsdt(input: {
  equityToman: number;
  markPriceToman: number;
  maxUtilizationPercent?: number;
  minReservePercent?: number;
  maxRouteCapitalPercent?: number;
  maxVenueExposurePercent?: number;
}): number {
  if (!(input.equityToman > 0) || !(input.markPriceToman > 0)) return 0;
  const maxUtil = input.maxUtilizationPercent ?? PAPER_4D_MAX_UTILIZATION_PERCENT;
  const minReserve = input.minReservePercent ?? PAPER_4D_MIN_RESERVE_PERCENT;
  const maxRoute = input.maxRouteCapitalPercent ?? PAPER_4D_MAX_ROUTE_CAPITAL_PERCENT;
  const maxVenue = input.maxVenueExposurePercent ?? PAPER_4D_MAX_VENUE_EXPOSURE_PERCENT;
  const usablePct = Math.min(maxUtil, Math.max(0, 100 - minReserve));
  const usableToman = Math.floor((input.equityToman * usablePct) / 100);
  const routeToman = Math.floor((input.equityToman * maxRoute) / 100);
  const venueToman = Math.floor((input.equityToman * maxVenue) / 100);
  const capToman = Math.min(usableToman, routeToman, venueToman);
  return Math.floor(capToman / input.markPriceToman);
}

export type CapitalAmountErrorCode =
  | "empty"
  | "not_integer"
  | "not_finite"
  | "zero"
  | "negative"
  | "fractional"
  | "below_min"
  | "above_max"
  | "malformed";

export const CAPITAL_AMOUNT_ERROR_FA: Record<CapitalAmountErrorCode, string> = {
  empty: "مبلغ سرمایه خالی است",
  not_integer: "سرمایه باید عدد صحیح تومان باشد",
  not_finite: "مبلغ سرمایه نامعتبر است",
  zero: "سرمایه نمی‌تواند صفر باشد",
  negative: "سرمایه نمی‌تواند منفی باشد",
  fractional: "سرمایه کسری (ریال/اعشار) پذیرفته نمی‌شود — فقط تومان صحیح",
  below_min: `حداقل سرمایه ${MIN_CAPITAL_TOMAN.toLocaleString("en-US")} تومان است`,
  above_max: `حداکثر سرمایه ${MAX_CAPITAL_TOMAN.toLocaleString("en-US")} تومان است`,
  malformed: "فرمت مبلغ سرمایه نامعتبر است"
};

/**
 * Parse a whole-toman capital amount fail-closed.
 * Accepts number or decimal string without fraction (e.g. "100000000", "10,000,000,000").
 * Rejects rial-style fractions and non-integers.
 */
export function parseWholeTomanCapital(
  raw: unknown
): { ok: true; value: number } | { ok: false; code: CapitalAmountErrorCode; messageFa: string } {
  if (raw === null || raw === undefined || raw === "") {
    return { ok: false, code: "empty", messageFa: CAPITAL_AMOUNT_ERROR_FA.empty };
  }
  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string") {
    const cleaned = raw.trim().replace(/,/g, "").replace(/\s/g, "").replace(/[۰-۹]/g, (d) =>
      String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))
    );
    if (!cleaned) {
      return { ok: false, code: "empty", messageFa: CAPITAL_AMOUNT_ERROR_FA.empty };
    }
    if (!/^-?\d+(\.0+)?$/.test(cleaned)) {
      if (cleaned.includes(".")) {
        return { ok: false, code: "fractional", messageFa: CAPITAL_AMOUNT_ERROR_FA.fractional };
      }
      return { ok: false, code: "malformed", messageFa: CAPITAL_AMOUNT_ERROR_FA.malformed };
    }
    n = Number(cleaned);
  } else {
    return { ok: false, code: "malformed", messageFa: CAPITAL_AMOUNT_ERROR_FA.malformed };
  }

  if (!Number.isFinite(n)) {
    return { ok: false, code: "not_finite", messageFa: CAPITAL_AMOUNT_ERROR_FA.not_finite };
  }
  if (n < 0) {
    return { ok: false, code: "negative", messageFa: CAPITAL_AMOUNT_ERROR_FA.negative };
  }
  if (n === 0) {
    return { ok: false, code: "zero", messageFa: CAPITAL_AMOUNT_ERROR_FA.zero };
  }
  if (!Number.isInteger(n)) {
    return { ok: false, code: "fractional", messageFa: CAPITAL_AMOUNT_ERROR_FA.fractional };
  }
  if (n < MIN_CAPITAL_TOMAN) {
    return { ok: false, code: "below_min", messageFa: CAPITAL_AMOUNT_ERROR_FA.below_min };
  }
  if (n > MAX_CAPITAL_TOMAN) {
    return { ok: false, code: "above_max", messageFa: CAPITAL_AMOUNT_ERROR_FA.above_max };
  }
  return { ok: true, value: n };
}

export type SessionCapitalLimitsSnapshot = {
  maxUtilizationPercent: number;
  minReservePercent: number;
  maxRouteCapitalPercent: number;
  maxVenueExposurePercent: number;
};

export type SessionCapitalOrderCapPreview = {
  mode: OrderCapMode;
  /** Current stored policy value (USDT), null if unset. */
  currentMaxOrderUsdt: number | null;
  currentSetBy: string | null;
  /** Derived from the *new* capital (always computed for display). */
  derivedMaxOrderUsdt: number;
  /**
   * Value that will apply after capital apply:
   * - explicit_admin → currentMaxOrderUsdt (unchanged)
   * - capital_derived → derivedMaxOrderUsdt (will be persisted)
   */
  effectiveMaxOrderUsdt: number;
  willWritePolicy: boolean;
};

export type SessionCapitalPreview = {
  totalCapitalToman: number;
  valuationPriceToman: number;
  allocations: VenueAllocation[];
  allocationSumToman: number;
  residualToman: number;
  perVenue: AllocationValidation["perVenue"];
  /** Opaque token the apply step must echo. */
  previewToken: string;
  unit: "toman";
  /** Prior capital for old/new comparison (null when no active session). */
  oldCapitalToman: number | null;
  limits: SessionCapitalLimitsSnapshot;
  orderCap: SessionCapitalOrderCapPreview;
};

export function buildSessionCapitalPreview(input: {
  totalCapitalToman: number;
  valuationPriceToman: number;
  venueIds: string[];
  activeSessionId: string | null;
  oldCapitalToman?: number | null;
  /** Current max_order_size_usdt policy if configured. */
  currentOrderCap?: { value: number; setBy: string | null } | null;
  limits?: Partial<SessionCapitalLimitsSnapshot>;
}): SessionCapitalPreview {
  const total = Math.round(input.totalCapitalToman);
  const mark = Math.round(input.valuationPriceToman);
  if (!Number.isFinite(mark) || mark <= 0) {
    throw new Error("valuation price required");
  }
  const allocations = defaultAllocation(total, input.venueIds, mark);
  const validation = validateAllocation({
    totalCapitalToman: total,
    allocations,
    markPriceToman: mark
  });
  if (!validation.ok || validation.residualToman !== 0) {
    throw new Error(
      `allocation residual not zero: ${validation.residualToman} (${validation.errorsFa.join("; ")})`
    );
  }
  const allocationSumToman = portfolioValueToman(allocations, mark);
  const residualToman = total - allocationSumToman;
  if (residualToman !== 0) {
    throw new Error(`allocation residual not zero: ${residualToman}`);
  }

  const limits: SessionCapitalLimitsSnapshot = {
    maxUtilizationPercent:
      input.limits?.maxUtilizationPercent ?? PAPER_4D_MAX_UTILIZATION_PERCENT,
    minReservePercent: input.limits?.minReservePercent ?? PAPER_4D_MIN_RESERVE_PERCENT,
    maxRouteCapitalPercent:
      input.limits?.maxRouteCapitalPercent ?? PAPER_4D_MAX_ROUTE_CAPITAL_PERCENT,
    maxVenueExposurePercent:
      input.limits?.maxVenueExposurePercent ?? PAPER_4D_MAX_VENUE_EXPOSURE_PERCENT
  };

  const derivedMaxOrderUsdt = deriveOrderCapUsdt({
    equityToman: total,
    markPriceToman: mark,
    maxUtilizationPercent: limits.maxUtilizationPercent,
    minReservePercent: limits.minReservePercent,
    maxRouteCapitalPercent: limits.maxRouteCapitalPercent,
    maxVenueExposurePercent: limits.maxVenueExposurePercent
  });

  const currentMaxOrderUsdt =
    input.currentOrderCap && Number.isFinite(input.currentOrderCap.value)
      ? input.currentOrderCap.value
      : null;
  const currentSetBy = input.currentOrderCap?.setBy ?? null;
  const mode = classifyOrderCapMode({
    configured: currentMaxOrderUsdt !== null,
    setBy: currentSetBy
  });
  const willWritePolicy = mode === "capital_derived";
  const effectiveMaxOrderUsdt =
    mode === "explicit_admin" && currentMaxOrderUsdt !== null
      ? currentMaxOrderUsdt
      : derivedMaxOrderUsdt;

  const oldCapitalToman =
    input.oldCapitalToman === undefined || input.oldCapitalToman === null
      ? null
      : Math.round(input.oldCapitalToman);

  const previewToken = createHash("sha256")
    .update(
      [
        "paper-session-capital-v2",
        input.activeSessionId ?? "none",
        String(total),
        String(mark),
        String(oldCapitalToman ?? "none"),
        mode,
        String(effectiveMaxOrderUsdt),
        String(willWritePolicy),
        ...allocations.map((a) => `${a.sourceId}:${a.irtToman}:${a.usdtUnits}`)
      ].join("|")
    )
    .digest("hex");

  return {
    totalCapitalToman: total,
    valuationPriceToman: mark,
    allocations,
    allocationSumToman,
    residualToman: 0,
    perVenue: validation.perVenue,
    previewToken,
    unit: "toman",
    oldCapitalToman,
    limits,
    orderCap: {
      mode,
      currentMaxOrderUsdt,
      currentSetBy,
      derivedMaxOrderUsdt,
      effectiveMaxOrderUsdt,
      willWritePolicy
    }
  };
}

/** Recompute token for apply verification (same inputs as preview). */
export function sessionCapitalPreviewToken(input: {
  totalCapitalToman: number;
  valuationPriceToman: number;
  venueIds: string[];
  activeSessionId: string | null;
  oldCapitalToman?: number | null;
  currentOrderCap?: { value: number; setBy: string | null } | null;
  limits?: Partial<SessionCapitalLimitsSnapshot>;
}): string {
  return buildSessionCapitalPreview(input).previewToken;
}
