/**
 * Phase 8C-4 — liquidity-aware allocation of the virtual portfolio.
 *
 * An equal split across nine venues is not a plan, it is the absence of one. A
 * venue that only ever appears on the BUY side of a profitable route needs
 * toman and will never touch the USDT parked there; a venue that only ever
 * appears on the SELL side needs USDT and its toman sits idle. Splitting every
 * venue 50/50 therefore strands roughly half the capital by construction.
 *
 * This module assigns each venue a ROLE from what the routes actually did, then
 * gives it the asset that role consumes:
 *
 *   BUY_SIDE   — appears as the buy venue on profitable routes → toman;
 *   SELL_SIDE  — appears as the sell venue → USDT;
 *   BOTH       — appears on both sides → split by observed weight;
 *   UNUSED     — appears on no profitable route → a floor, not a share.
 *
 * Weight comes from observed risk-adjusted profit and route frequency, not from
 * a preference: a venue that carried more profitable volume gets more capital.
 *
 * Conservation is exact. The plan sums to the requested total to the rial, and
 * the module proves it by re-valuing what it produced rather than trusting the
 * arithmetic that produced it. Rounding remainders land on one deterministic
 * venue — the first by sorted id — so the same inputs always produce the same
 * plan, byte for byte.
 *
 * Pure module: no database, no network, no clock. It proposes; it never saves.
 */
import { usdtToMicros, microsToUsdt } from "@/lib/shadowArbitrage/paper/liquidity";

export type VenueRole = "BUY_SIDE" | "SELL_SIDE" | "BOTH" | "UNUSED";

export const VENUE_ROLE_FA: Record<VenueRole, string> = {
  BUY_SIDE: "سمت خرید — نیازمند تومان",
  SELL_SIDE: "سمت فروش — نیازمند تتر",
  BOTH: "دوطرفه — نیازمند هر دو",
  UNUSED: "بدون مسیر سودآور مشاهده‌شده"
};

/** What one route was observed to do, aggregated over the window. */
export type RouteObservation = {
  buySourceId: string;
  sellSourceId: string;
  /** How many times this route appeared as a genuine candidate. */
  occurrences: number;
  /**
   * Risk-adjusted profit the route could have captured, in toman. Only
   * non-negative values contribute — a losing route earns no capital.
   */
  riskAdjustedPnlToman: number;
  /** Largest quantity both books supported, in micros. Caps a venue's need. */
  capacityUsdtMicros: number;
};

export type VenueDemand = {
  sourceId: string;
  role: VenueRole;
  /** Weight from buy-side participation, before normalisation. */
  buyWeight: number;
  sellWeight: number;
  occurrencesAsBuy: number;
  occurrencesAsSell: number;
  /** Observed profitable capacity, in micros, summed over its routes. */
  buyCapacityUsdtMicros: number;
  sellCapacityUsdtMicros: number;
};

export type VenueAllocationRow = {
  sourceId: string;
  role: VenueRole;
  irtToman: number;
  usdtUnits: number;
  /** Toman value of the row at the valuation price. */
  valueToman: number;
  sharePercent: number;
  reasonFa: string;
};

export type AllocationPlan = {
  totalCapitalToman: number;
  valuationPriceToman: number;
  rows: VenueAllocationRow[];
  /** Sum of the rows, valued the way the ledger values them. Must equal total. */
  allocatedToman: number;
  /** allocated − total. Zero is the only acceptable value. */
  residualToman: number;
  demands: VenueDemand[];
  errorsFa: string[];
};

/**
 * Every venue gets at least this share of the portfolio.
 *
 * A venue with no observed profitable route still needs enough capital to
 * PROVE whether it can carry one — allocating it nothing guarantees it never
 * appears in a future observation, which would make the first window's evidence
 * permanently self-confirming. This is a floor for discovery, not a reward.
 */
export const DISCOVERY_FLOOR_PERCENT = 2;

/** Aggregate observed routes into per-venue demand with an explicit role. */
export function deriveVenueDemand(
  venueIds: readonly string[],
  observations: readonly RouteObservation[]
): VenueDemand[] {
  const demand = new Map<string, VenueDemand>(
    venueIds.map((sourceId) => [
      sourceId,
      {
        sourceId,
        role: "UNUSED" as VenueRole,
        buyWeight: 0,
        sellWeight: 0,
        occurrencesAsBuy: 0,
        occurrencesAsSell: 0,
        buyCapacityUsdtMicros: 0,
        sellCapacityUsdtMicros: 0
      }
    ])
  );

  for (const o of observations) {
    // A losing route earns no capital; it is observed, not funded.
    const profit = Math.max(0, o.riskAdjustedPnlToman);
    if (profit <= 0 || o.occurrences <= 0) continue;

    const buy = demand.get(o.buySourceId);
    if (buy) {
      buy.buyWeight += profit * o.occurrences;
      buy.occurrencesAsBuy += o.occurrences;
      buy.buyCapacityUsdtMicros += o.capacityUsdtMicros;
    }
    const sell = demand.get(o.sellSourceId);
    if (sell) {
      sell.sellWeight += profit * o.occurrences;
      sell.occurrencesAsSell += o.occurrences;
      sell.sellCapacityUsdtMicros += o.capacityUsdtMicros;
    }
  }

  for (const d of demand.values()) {
    const buys = d.buyWeight > 0;
    const sells = d.sellWeight > 0;
    d.role = buys && sells ? "BOTH" : buys ? "BUY_SIDE" : sells ? "SELL_SIDE" : "UNUSED";
  }

  return [...demand.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}

/**
 * Build the plan.
 *
 * Shares are proportional to observed weight above a discovery floor, then each
 * venue's share is split between toman and USDT by the role that share came
 * from. The USDT side is converted at the supplied valuation price — this module
 * has no rate of its own and will not invent one.
 */
export function buildLiquidityAwarePlan(input: {
  totalCapitalToman: number;
  valuationPriceToman: number;
  venueIds: readonly string[];
  observations: readonly RouteObservation[];
}): AllocationPlan {
  const errorsFa: string[] = [];
  const total = Math.round(input.totalCapitalToman);
  const price = Math.round(input.valuationPriceToman);
  const venueIds = [...input.venueIds].sort((a, b) => a.localeCompare(b));

  if (!Number.isFinite(price) || price <= 0) {
    errorsFa.push("قیمت مبنای تتر در دسترس نیست؛ بدون آن تبدیل انجام نمی‌شود.");
  }
  if (total <= 0) errorsFa.push("سرمایهٔ کل باید بزرگ‌تر از صفر باشد.");
  if (!venueIds.length) errorsFa.push("هیچ صرافی اجراپذیری برای تخصیص وجود ندارد.");
  if (errorsFa.length) {
    return {
      totalCapitalToman: total,
      valuationPriceToman: price,
      rows: [],
      allocatedToman: 0,
      residualToman: -total,
      demands: [],
      errorsFa
    };
  }

  const demands = deriveVenueDemand(venueIds, input.observations);

  /*
   * Shares: a discovery floor for everyone, and the remainder distributed by
   * observed weight. With no observations at all every venue falls back to the
   * floor, which then sums to less than the total — the leftover is spread
   * evenly and the plan says plainly that it is uninformed.
   */
  const floorToman = Math.floor((total * DISCOVERY_FLOOR_PERCENT) / 100);
  const weightPool = Math.max(0, total - floorToman * venueIds.length);
  const totalWeight = demands.reduce((s, d) => s + d.buyWeight + d.sellWeight, 0);

  if (totalWeight <= 0) {
    errorsFa.push(
      "هیچ مسیر سودآوری مشاهده نشده است؛ تخصیص فقط بر پایهٔ کف اکتشاف انجام شد و آگاهانه نیست."
    );
  }

  const shareToman = new Map<string, number>();
  for (const d of demands) {
    const weight = d.buyWeight + d.sellWeight;
    const fromWeight =
      totalWeight > 0
        ? Math.floor((weightPool * weight) / totalWeight)
        : Math.floor(weightPool / venueIds.length);
    shareToman.set(d.sourceId, floorToman + fromWeight);
  }

  /*
   * Exact conservation. Whatever the integer divisions dropped goes to one
   * deterministic venue — the first by sorted id — so the plan always sums to
   * the total and always sums the same way.
   */
  const assigned = [...shareToman.values()].reduce((s, v) => s + v, 0);
  const drift = total - assigned;
  if (drift !== 0) {
    const first = venueIds[0];
    shareToman.set(first, (shareToman.get(first) ?? 0) + drift);
  }

  const rows: VenueAllocationRow[] = demands.map((d) => {
    const share = shareToman.get(d.sourceId) ?? 0;
    const weight = d.buyWeight + d.sellWeight;

    /*
     * Split by role. A pure buy venue holds toman, a pure sell venue holds
     * USDT, and a bidirectional venue splits in proportion to the profit each
     * side actually carried. An unused venue holds the discovery floor as
     * toman, because a buy is the side a new route is most likely to need
     * first — a venue must be able to buy before it can have anything to sell.
     */
    let irtShare: number;
    if (d.role === "BUY_SIDE" || d.role === "UNUSED") irtShare = share;
    else if (d.role === "SELL_SIDE") irtShare = 0;
    else irtShare = weight > 0 ? Math.floor((share * d.buyWeight) / weight) : Math.floor(share / 2);

    const usdtSideToman = share - irtShare;
    const usdtMicros = usdtToMicros(usdtSideToman / price);
    const usdtUnits = microsToUsdt(usdtMicros);
    // The toman side absorbs the conversion remainder so the row is worth
    // exactly its share again.
    const usdtValue = Math.round(usdtUnits * price);
    const irtToman = share - usdtValue;

    return {
      sourceId: d.sourceId,
      role: d.role,
      irtToman,
      usdtUnits,
      valueToman: irtToman + usdtValue,
      sharePercent: total > 0 ? Math.round((share / total) * 10_000) / 100 : 0,
      reasonFa: reasonFor(d)
    };
  });

  /*
   * Value the plan the way the ledger holds it: add the USDT across venues,
   * then convert once. Rounding each venue first gives a figure that can differ
   * by a rial, and having two definitions of "exact" is how a portfolio ends up
   * exact under one and short under the other.
   */
  const irtTotal = rows.reduce((s, r) => s + r.irtToman, 0);
  const microsTotal = rows.reduce((s, r) => s + usdtToMicros(r.usdtUnits), 0);
  let allocatedToman = Math.round(irtTotal + microsToUsdt(microsTotal) * price);

  // One deterministic correction so the aggregate reading is exact too.
  const aggregateDrift = total - allocatedToman;
  if (aggregateDrift !== 0 && rows.length) {
    rows[0] = {
      ...rows[0],
      irtToman: rows[0].irtToman + aggregateDrift,
      valueToman: rows[0].valueToman + aggregateDrift
    };
    allocatedToman = total;
  }

  return {
    totalCapitalToman: total,
    valuationPriceToman: price,
    rows,
    allocatedToman,
    residualToman: allocatedToman - total,
    demands,
    errorsFa
  };
}

function reasonFor(d: VenueDemand): string {
  const buys = d.occurrencesAsBuy;
  const sells = d.occurrencesAsSell;
  switch (d.role) {
    case "BUY_SIDE":
      return `در ${buys} مسیر سودآور فقط سمت خرید بود؛ کل سهم به‌صورت تومان تخصیص یافت.`;
    case "SELL_SIDE":
      return `در ${sells} مسیر سودآور فقط سمت فروش بود؛ کل سهم به‌صورت تتر تخصیص یافت.`;
    case "BOTH":
      return `در ${buys} مسیر سمت خرید و در ${sells} مسیر سمت فروش بود؛ سهم به نسبت سود هر سمت تقسیم شد.`;
    default:
      return "هیچ مسیر سودآوری با این صرافی مشاهده نشد؛ فقط کف اکتشاف تخصیص یافت تا امکان سنجش آینده بماند.";
  }
}
