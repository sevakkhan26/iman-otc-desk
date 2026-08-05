/**
 * Portfolio capital utilization for the four-day Paper experiment.
 *
 * Canonical formula (toman):
 *
 *   utilized = reservedBuyIRT
 *            + markedValue(reservedSellUSDT)
 *            + committedResidualExposure
 *
 *   utilizationPercent = utilized / currentPaperEquity × 100
 *
 * Free reserve = equity − utilized. Target 70%, hard max 80%, min free 20%.
 * Pure: no I/O.
 */
import { microsToUsdt } from "@/lib/shadowArbitrage/paper/broker";

export type UtilizationSnapshot = {
  equityToman: number;
  utilizedToman: number;
  freeToman: number;
  utilizationPercent: number;
  freeReservePercent: number;
  reservedBuyIrtToman: number;
  reservedSellUsdtMarkedToman: number;
  committedResidualToman: number;
  /** True when adding `extraToman` would breach max utilization or min reserve. */
  wouldBreach: (extraToman: number, maxUtilPercent: number, minReservePercent: number) => boolean;
};

/**
 * Build the portfolio utilization snapshot.
 *
 * For the immediate-fill broker, reserved and residual are normally 0 between
 * cycles; during multi-route allocation within a cycle, the allocator passes
 * in the capital it has already reserved for earlier selections.
 */
export function computeUtilization(input: {
  equityToman: number;
  reservedBuyIrtToman?: number;
  reservedSellUsdtMicros?: number;
  markPriceToman: number;
  committedResidualToman?: number;
}): UtilizationSnapshot {
  const equity = Math.max(0, Math.round(input.equityToman));
  const reservedBuy = Math.max(0, Math.round(input.reservedBuyIrtToman ?? 0));
  const mark = input.markPriceToman > 0 ? input.markPriceToman : 0;
  const reservedSellMarked =
    mark > 0
      ? Math.round(microsToUsdt(Math.max(0, input.reservedSellUsdtMicros ?? 0)) * mark)
      : 0;
  const residual = Math.max(0, Math.round(input.committedResidualToman ?? 0));
  const utilized = reservedBuy + reservedSellMarked + residual;
  const free = Math.max(0, equity - utilized);
  const utilizationPercent = equity > 0 ? (utilized / equity) * 100 : 0;
  const freeReservePercent = equity > 0 ? (free / equity) * 100 : 100;

  return {
    equityToman: equity,
    utilizedToman: utilized,
    freeToman: free,
    utilizationPercent,
    freeReservePercent,
    reservedBuyIrtToman: reservedBuy,
    reservedSellUsdtMarkedToman: reservedSellMarked,
    committedResidualToman: residual,
    wouldBreach(extraToman, maxUtilPercent, minReservePercent) {
      const nextUtilized = utilized + Math.max(0, Math.round(extraToman));
      const nextUtilPct = equity > 0 ? (nextUtilized / equity) * 100 : 100;
      const nextFreePct = equity > 0 ? ((equity - nextUtilized) / equity) * 100 : 0;
      return nextUtilPct > maxUtilPercent + 1e-9 || nextFreePct + 1e-9 < minReservePercent;
    }
  };
}

/** Combined two-leg capital for a route at a given size (buy notional + sell USDT marked). */
export function routeCapitalToman(input: {
  sizeUsdt: number;
  buyVwapToman: number;
  sellVwapToman: number | null;
  markPriceToman: number;
}): number {
  const size = Math.max(0, input.sizeUsdt);
  const buyNotional = Math.round(size * input.buyVwapToman);
  const mark = input.sellVwapToman && input.sellVwapToman > 0 ? input.sellVwapToman : input.markPriceToman;
  const sellMarked = Math.round(size * mark);
  // Combined capital committed across both legs for exposure accounting.
  return buyNotional + sellMarked;
}

export function venueExposureAfter(input: {
  currentExposureToman: number;
  addToman: number;
  equityToman: number;
  maxVenuePercent: number;
}): boolean {
  if (!(input.equityToman > 0)) return false;
  const next = input.currentExposureToman + input.addToman;
  return (next / input.equityToman) * 100 <= input.maxVenuePercent + 1e-9;
}
