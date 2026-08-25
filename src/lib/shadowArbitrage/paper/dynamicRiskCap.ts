/** Dynamic numeric feasibility cap for PAPER/FAKE sizing. Pure; no I/O. */

export const DYNAMIC_RISK_CAP_VERSION = "PAPER_DYNAMIC_RISK_CAP_V1" as const;

export type DynamicRiskStructuralCode =
  | "stale_snapshot"
  | "venue_unhealthy"
  | "fee_unconfirmed"
  | "settlement_unconfirmed"
  | "missing_required_data"
  | "inventory_unmeasurable"
  | "incomplete_two_leg_walk";

export type DynamicRiskHeadroomKey =
  | "accepted_buy_depth_b"
  | "accepted_sell_depth_b"
  | "two_leg_executable_c"
  | "buy_balance_c"
  | "sell_balance_c"
  | "venue_allocation_d"
  | "inventory_band_d"
  | "free_paper_capital_e"
  | "global_utilization_e"
  | "global_reserve_e"
  | "buy_concentration_e"
  | "sell_concentration_e"
  | "concurrent_reservations_e"
  | "venue_max_e"
  | "admin_order_max_e"
  | "late_numeric_clip_e";

export type DynamicRiskNumericHeadroom = {
  key: DynamicRiskHeadroomKey;
  capUsdtMicros: number | null;
  detail?: string;
};

export type DynamicRiskCapInput = {
  structural: {
    snapshotsFresh: boolean;
    venuesHealthy: boolean;
    feesCertain: boolean;
    settlementKnown: boolean;
    requiredDataPresent: boolean;
    inventoryMeasurable: boolean;
    completeTwoLegWalk: boolean;
  };
  numericHeadrooms: DynamicRiskNumericHeadroom[];
  /** The canonical RA curve must have at least one measured point. */
  riskAdjustedCurve: Array<{ sizeUsdtMicros: number; riskAdjustedPnlToman: number }>;
};

export type DynamicRiskCapResult =
  | { ok: false; version: typeof DYNAMIC_RISK_CAP_VERSION; code: DynamicRiskStructuralCode }
  | {
      ok: true;
      version: typeof DYNAMIC_RISK_CAP_VERSION;
      qEMicros: number;
      bindingHeadrooms: DynamicRiskHeadroomKey[];
      numericHeadrooms: DynamicRiskNumericHeadroom[];
    };

/**
 * E = minimum finite measured numeric headroom. It is a feasible-domain bound,
 * never an order-size objective and never a preferred-notional ladder.
 */
export function computeDynamicRiskCap(input: DynamicRiskCapInput): DynamicRiskCapResult {
  const s = input.structural;
  if (!s.snapshotsFresh) return { ok: false, version: DYNAMIC_RISK_CAP_VERSION, code: "stale_snapshot" };
  if (!s.venuesHealthy) return { ok: false, version: DYNAMIC_RISK_CAP_VERSION, code: "venue_unhealthy" };
  if (!s.feesCertain) return { ok: false, version: DYNAMIC_RISK_CAP_VERSION, code: "fee_unconfirmed" };
  if (!s.settlementKnown) return { ok: false, version: DYNAMIC_RISK_CAP_VERSION, code: "settlement_unconfirmed" };
  if (!s.requiredDataPresent || !input.riskAdjustedCurve.length) {
    return { ok: false, version: DYNAMIC_RISK_CAP_VERSION, code: "missing_required_data" };
  }
  if (!s.inventoryMeasurable) {
    return { ok: false, version: DYNAMIC_RISK_CAP_VERSION, code: "inventory_unmeasurable" };
  }
  if (!s.completeTwoLegWalk) {
    return { ok: false, version: DYNAMIC_RISK_CAP_VERSION, code: "incomplete_two_leg_walk" };
  }

  const finite = input.numericHeadrooms.filter(
    (h): h is DynamicRiskNumericHeadroom & { capUsdtMicros: number } =>
      h.capUsdtMicros !== null && Number.isFinite(h.capUsdtMicros) && h.capUsdtMicros >= 0
  );
  if (!finite.length) {
    return { ok: false, version: DYNAMIC_RISK_CAP_VERSION, code: "missing_required_data" };
  }
  const qE = Math.floor(Math.min(...finite.map((h) => h.capUsdtMicros)));
  return {
    ok: true,
    version: DYNAMIC_RISK_CAP_VERSION,
    qEMicros: qE,
    bindingHeadrooms: finite.filter((h) => h.capUsdtMicros === qE).map((h) => h.key),
    numericHeadrooms: input.numericHeadrooms.map((h) => ({ ...h }))
  };
}
