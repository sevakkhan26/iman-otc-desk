/**
 * Configurable Paper session capital — pure helpers only (Step 1).
 *
 * Does not size trades, touch SMART_CAPITAL_DEPTH, or place orders.
 * Capital is whole toman end-to-end; residual after allocation must be zero.
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

/** Re-export bounds so UI/API share one source. */
export { MIN_CAPITAL_TOMAN, MAX_CAPITAL_TOMAN };

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
};

export function buildSessionCapitalPreview(input: {
  totalCapitalToman: number;
  valuationPriceToman: number;
  venueIds: string[];
  activeSessionId: string | null;
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

  const previewToken = createHash("sha256")
    .update(
      [
        "paper-session-capital-v1",
        input.activeSessionId ?? "none",
        String(total),
        String(mark),
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
    unit: "toman"
  };
}

/** Recompute token for apply verification (same inputs as preview). */
export function sessionCapitalPreviewToken(input: {
  totalCapitalToman: number;
  valuationPriceToman: number;
  venueIds: string[];
  activeSessionId: string | null;
}): string {
  return buildSessionCapitalPreview(input).previewToken;
}
