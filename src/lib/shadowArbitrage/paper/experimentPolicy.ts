/**
 * `PAPER_BALANCED_10B_4D_V1` — four-day Paper experiment policy set.
 *
 * Separate from PAPER_BALANCED_10B_V1: that set remains in history unchanged.
 * This set adds portfolio utilization, reserve, route/venue capital fractions
 * and a 96-hour observation window. Risk thresholds (edge, age, slippage,
 * inventory) keep the same approved numbers as the balanced set unless a
 * capital-relative order cap supersedes the old fixed 500 USDT ceiling.
 *
 * Pure module: safe to import from UI for labels. Application happens only in
 * bootstrap / repository code.
 */
import type { RiskPolicyKey } from "@/lib/shadowArbitrage/live/policy";

export const PAPER_4D_POLICY_SET_KEY = "PAPER_BALANCED_10B_4D_V1" as const;
export const PAPER_4D_RUN_KEY = "paper-experiment-4d-v1" as const;
export const PAPER_4D_DURATION_MS = 96 * 60 * 60 * 1000;
export const PAPER_4D_DURATION_HOURS = 96;

/** Portfolio-wide targets — not per-trade percentages. */
export const PAPER_4D_TARGET_UTILIZATION_PERCENT = 70;
export const PAPER_4D_MAX_UTILIZATION_PERCENT = 80;
export const PAPER_4D_MIN_RESERVE_PERCENT = 20;
export const PAPER_4D_MAX_ROUTE_CAPITAL_PERCENT = 10;
export const PAPER_4D_MAX_VENUE_EXPOSURE_PERCENT = 20;

/**
 * Portfolio allocator policy for Paper sessions created after the portfolio
 * optimizer shipped. The 4D constants above are historical V1 snapshot values
 * and deliberately remain unchanged so old experiment rows keep their meaning.
 */
export const PAPER_PORTFOLIO_POLICY_SET_KEY = "PAPER_PORTFOLIO_90_10_V2" as const;
export const PAPER_PORTFOLIO_MAX_UTILIZATION_PERCENT = 90;
export const PAPER_PORTFOLIO_MIN_RESERVE_PERCENT = 10;
/**
 * Catastrophic concentration backstop, not a target and not the venue cap
 * normally reached by the optimizer. 65% lets a genuinely deep two-leg route
 * engage roughly 45% of capital on either venue at the 90% global ceiling,
 * while ensuring no single venue can represent nearly the whole portfolio.
 * The effective cap is dynamically tightened by balances, accepted depth,
 * readiness, inventory and remaining global headroom.
 */
export const PAPER_PORTFOLIO_FAILSAFE_VENUE_PERCENT = 65;

/**
 * Risk policies shared with SMART_CAPITAL_DEPTH (values match PAPER_BALANCED_10B_V1
 * except max_order_size_usdt, which is replaced by the capital-relative freeze
 * written at experiment start).
 */
export const PAPER_4D_RISK_POLICIES: Array<{
  key: RiskPolicyKey;
  value: number;
  labelFa: string;
}> = [
  {
    key: "max_venue_exposure_percent",
    value: PAPER_4D_MAX_VENUE_EXPOSURE_PERCENT,
    labelFa: "حداکثر تمرکز روی یک صرافی"
  },
  {
    key: "min_risk_adjusted_edge_percent",
    value: 0.05,
    labelFa: "حداقل سود اقتصادی تعدیل‌شده"
  },
  {
    key: "max_quote_age_ms",
    value: 30_000,
    labelFa: "حداکثر کهنگی قیمت"
  },
  {
    key: "max_slippage_bps",
    value: 10,
    labelFa: "حداکثر لغزش مجاز"
  },
  {
    key: "max_inventory_deviation_percent",
    value: 20,
    labelFa: "حداکثر انحراف موجودی"
  }
];

/**
 * Derive a session-opening order maximum from dynamic portfolio/venue
 * headroom. The historical route percentage is deliberately not applied.
 */
export function deriveMaxOrderUsdt(input: {
  equityToman: number;
  markPriceToman: number;
  /** @deprecated Historical comparison input; deliberately ignored. */
  routeCapitalPercent?: number;
  maxUtilizationPercent?: number;
  minReservePercent?: number;
  maxVenueExposurePercent?: number;
}): number {
  if (!(input.equityToman > 0) || !(input.markPriceToman > 0)) return 0;
  const usablePct = Math.min(
    input.maxUtilizationPercent ?? PAPER_4D_MAX_UTILIZATION_PERCENT,
    100 - (input.minReservePercent ?? PAPER_4D_MIN_RESERVE_PERCENT)
  );
  const globalQ = (input.equityToman * usablePct) / 100 / (2 * input.markPriceToman);
  const venueQ =
    (input.equityToman *
      (input.maxVenueExposurePercent ?? PAPER_4D_MAX_VENUE_EXPOSURE_PERCENT)) /
    100 /
    input.markPriceToman;
  return Math.floor(Math.min(globalQ, venueQ));
}

export function paper4dCanonical(input: {
  maxOrderUsdt: number;
  markPriceToman: number;
}): string {
  const risk = PAPER_4D_RISK_POLICIES.map((p) => `${p.key}=${p.value}`).sort().join(";");
  return [
    PAPER_4D_POLICY_SET_KEY,
    `hours=${PAPER_4D_DURATION_HOURS}`,
    `targetUtil=${PAPER_4D_TARGET_UTILIZATION_PERCENT}`,
    `maxUtil=${PAPER_4D_MAX_UTILIZATION_PERCENT}`,
    `minReserve=${PAPER_4D_MIN_RESERVE_PERCENT}`,
    `historicalMaxRouteNotApplied=${PAPER_4D_MAX_ROUTE_CAPITAL_PERCENT}`,
    `maxVenue=${PAPER_4D_MAX_VENUE_EXPOSURE_PERCENT}`,
    `maxOrderUsdt=${input.maxOrderUsdt}`,
    `mark=${input.markPriceToman}`,
    risk
  ].join("|");
}
