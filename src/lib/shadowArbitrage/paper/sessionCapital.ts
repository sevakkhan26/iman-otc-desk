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
import {
  PAPER_POLICY_MIN_KEY,
  PAPER_POLICY_MIN_USDT
} from "@/lib/shadowArbitrage/paper/venueExecutionLimits";

/** Re-export bounds so UI/API share one source. */
export { MIN_CAPITAL_TOMAN, MAX_CAPITAL_TOMAN, PAPER_POLICY_MIN_KEY, PAPER_POLICY_MIN_USDT };

/** setBy value written when the order cap is recomputed from capital. */
export const ORDER_CAP_DERIVED_ACTOR = "capital-derived" as const;

/**
 * Admin session-setup order-cap choice (API/UI labels).
 * AUTO_CAPITAL_DERIVED → capital-derived policy write on apply.
 * MANUAL → explicit admin USDT cap (not overwritten by capital math).
 */
export type SessionOrderCapChoice = "AUTO_CAPITAL_DERIVED" | "MANUAL";

export type OrderCapMode = "explicit_admin" | "capital_derived";

export const SESSION_SETUP_NOTE_PREFIX = "paper_session_setup_v1:" as const;

export type SessionSetupConfig = {
  version: 1;
  durationDays: number;
  /** Frozen at apply (ISO). */
  endsAt: string;
  /** Frozen at apply (ISO) — same as session startedAt. */
  startedAt: string;
  orderCapChoice: SessionOrderCapChoice;
  orderCapUsdt: number;
  paperPolicyMinUsdt: number;
  totalCapitalToman: number;
  valuationPriceToman: number;
  previewToken: string;
};

export function parseSessionSetupNote(note: string | null | undefined): SessionSetupConfig | null {
  if (!note) return null;
  const idx = note.indexOf(SESSION_SETUP_NOTE_PREFIX);
  if (idx < 0) return null;
  const raw = note.slice(idx + SESSION_SETUP_NOTE_PREFIX.length).trim();
  const jsonPart = raw.split(/\n|;/)[0]?.trim() ?? "";
  try {
    const o = JSON.parse(jsonPart) as SessionSetupConfig;
    if (o?.version !== 1 || !(o.durationDays > 0) || !o.endsAt) return null;
    return o;
  } catch {
    return null;
  }
}

export function formatSessionSetupNote(config: SessionSetupConfig, extra?: string): string {
  const body = SESSION_SETUP_NOTE_PREFIX + JSON.stringify(config);
  return [body, extra].filter(Boolean).join("\n").slice(0, 2000);
}

/**
 * endsAt = startedAtMs + durationDays * 86400000 (exact whole days, no rounding).
 */
export function computeSessionEndsAt(startedAtMs: number, durationDays: number): string {
  const days = Math.floor(durationDays);
  if (!(days >= 1) || !Number.isFinite(startedAtMs)) {
    throw new Error("durationDays must be a positive integer");
  }
  return new Date(startedAtMs + days * 86_400_000).toISOString();
}

export function parseDurationDays(
  raw: unknown
): { ok: true; value: number } | { ok: false; messageFa: string } {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 365) {
    return { ok: false, messageFa: "مدت نشست باید عدد صحیح ۱ تا ۳۶۵ روز باشد" };
  }
  return { ok: true, value: n };
}

export function parseManualOrderCapUsdt(
  raw: unknown
): { ok: true; value: number } | { ok: false; messageFa: string } {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim().replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, messageFa: "سقف سفارش دستی باید عدد مثبت تتر باشد" };
  }
  if (!Number.isInteger(n) && Math.abs(n - Math.round(n * 1e4) / 1e4) > 1e-9) {
    return { ok: false, messageFa: "سقف سفارش دستی حداکثر ۴ رقم اعشار دارد" };
  }
  if (n < 5) {
    return { ok: false, messageFa: "سقف سفارش دستی نمی‌تواند از حداقل Paper (۵ تتر) کمتر باشد" };
  }
  if (n > 10_000_000) {
    return { ok: false, messageFa: "سقف سفارش دستی بیش از حد مجاز است" };
  }
  return { ok: true, value: n };
}

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

export type SessionSetupPreview = SessionCapitalPreview & {
  durationDays: number;
  /** ISO endsAt for the prospective session (from clockMs + duration). */
  endsAt: string;
  /** ISO provisional start (clock used for preview). */
  startedAt: string;
  orderCapChoice: SessionOrderCapChoice;
  paperPolicyMinUsdt: number;
  /**
   * Upper bound on smart size for this setup: min(effective order cap, capital-derived
   * route/venue ceilings). Not a live book walk — books change every cycle.
   */
  smartSizeCeilingUsdt: number;
  usableCapitalToman: number;
  reserveCapitalToman: number;
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
  /**
   * When set, overrides policy classification for this setup preview/apply.
   * AUTO_CAPITAL_DERIVED forces capital-derived write; MANUAL forces explicit.
   */
  orderCapChoice?: SessionOrderCapChoice | null;
  /** Required when orderCapChoice === MANUAL. */
  manualOrderCapUsdt?: number | null;
  /** Whole days of session life; default 4 for legacy callers. */
  durationDays?: number | null;
  /** Clock for endsAt (tests inject; API uses Date.now()). */
  clockMs?: number;
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

  let mode: OrderCapMode;
  let willWritePolicy: boolean;
  let effectiveMaxOrderUsdt: number;

  if (input.orderCapChoice === "AUTO_CAPITAL_DERIVED") {
    mode = "capital_derived";
    willWritePolicy = true;
    effectiveMaxOrderUsdt = derivedMaxOrderUsdt;
  } else if (input.orderCapChoice === "MANUAL") {
    const manual = input.manualOrderCapUsdt;
    if (manual == null || !(manual > 0)) {
      throw new Error("manual order cap required");
    }
    mode = "explicit_admin";
    willWritePolicy = true; // write the manual policy on apply
    effectiveMaxOrderUsdt = manual;
  } else {
    mode = classifyOrderCapMode({
      configured: currentMaxOrderUsdt !== null,
      setBy: currentSetBy
    });
    willWritePolicy = mode === "capital_derived";
    effectiveMaxOrderUsdt =
      mode === "explicit_admin" && currentMaxOrderUsdt !== null
        ? currentMaxOrderUsdt
        : derivedMaxOrderUsdt;
  }

  // Smart size never exceeds paper_policy_min floor relationship: ceiling ≥ min.
  const smartSizeCeilingUsdt = Math.max(
    PAPER_POLICY_MIN_USDT,
    Math.min(effectiveMaxOrderUsdt, derivedMaxOrderUsdt > 0 ? Math.max(effectiveMaxOrderUsdt, derivedMaxOrderUsdt) : effectiveMaxOrderUsdt)
  );
  // Effective smart ceiling for setup display: min(order cap, capital-derived route backstop).
  const setupSmartCeilingUsdt = Math.max(
    PAPER_POLICY_MIN_USDT,
    Math.min(effectiveMaxOrderUsdt, Math.max(derivedMaxOrderUsdt, PAPER_POLICY_MIN_USDT))
  );
  void smartSizeCeilingUsdt;

  const oldCapitalToman =
    input.oldCapitalToman === undefined || input.oldCapitalToman === null
      ? null
      : Math.round(input.oldCapitalToman);

  const durationDays =
    input.durationDays != null && input.durationDays > 0
      ? Math.floor(input.durationDays)
      : null;
  const orderCapChoice = input.orderCapChoice ?? null;
  const manualCap = input.manualOrderCapUsdt ?? null;

  const previewToken = createHash("sha256")
    .update(
      [
        "paper-session-setup-v3",
        input.activeSessionId ?? "none",
        String(total),
        String(mark),
        String(oldCapitalToman ?? "none"),
        mode,
        String(effectiveMaxOrderUsdt),
        String(willWritePolicy),
        String(orderCapChoice ?? "inherit"),
        String(manualCap ?? "none"),
        String(durationDays ?? "none"),
        ...allocations.map((a) => `${a.sourceId}:${a.irtToman}:${a.usdtUnits}`)
      ].join("|")
    )
    .digest("hex");

  const base: SessionCapitalPreview = {
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

  // Attach setup fields when duration/choice requested (API uses buildSessionSetupPreview).
  if (durationDays != null || orderCapChoice != null) {
    const clock = input.clockMs ?? Date.now();
    const startedAt = new Date(clock).toISOString();
    const days = durationDays ?? 4;
    const endsAt = computeSessionEndsAt(clock, days);
    const usablePct = Math.min(
      limits.maxUtilizationPercent,
      Math.max(0, 100 - limits.minReservePercent)
    );
    const usableCapitalToman = Math.floor((total * usablePct) / 100);
    const reserveCapitalToman = total - usableCapitalToman;
    return {
      ...base,
      durationDays: days,
      endsAt,
      startedAt,
      orderCapChoice: orderCapChoice ?? "AUTO_CAPITAL_DERIVED",
      paperPolicyMinUsdt: PAPER_POLICY_MIN_USDT,
      smartSizeCeilingUsdt: setupSmartCeilingUsdt,
      usableCapitalToman,
      reserveCapitalToman
    } as SessionSetupPreview;
  }

  return base;
}

/** Full session-setup preview (capital + duration + order-cap choice). */
export function buildSessionSetupPreview(input: {
  totalCapitalToman: number;
  valuationPriceToman: number;
  venueIds: string[];
  activeSessionId: string | null;
  oldCapitalToman?: number | null;
  currentOrderCap?: { value: number; setBy: string | null } | null;
  limits?: Partial<SessionCapitalLimitsSnapshot>;
  orderCapChoice: SessionOrderCapChoice;
  manualOrderCapUsdt?: number | null;
  durationDays: number;
  clockMs?: number;
}): SessionSetupPreview {
  const p = buildSessionCapitalPreview({
    ...input,
    orderCapChoice: input.orderCapChoice,
    manualOrderCapUsdt: input.manualOrderCapUsdt,
    durationDays: input.durationDays,
    clockMs: input.clockMs
  }) as SessionSetupPreview;
  if (!("endsAt" in p) || !p.endsAt) {
    throw new Error("session setup preview missing endsAt");
  }
  return p;
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
