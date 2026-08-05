/**
 * Multi-route Paper capital allocator for the four-day experiment.
 *
 * Ranks candidates by risk-adjusted economic PnL (descending), then greedily
 * selects a compatible set that never:
 *   - exceeds portfolio max utilization (default 80%)
 *   - violates min free reserve (default 20%)
 *   - exceeds per-route capital fraction (default 10%)
 *   - exceeds per-venue exposure (default 20%)
 *   - double-spends the same venue balance between routes
 *
 * Does not lower economic thresholds or force deployment. Zero selection is
 * correct when nothing is valid. Pure module.
 */
import {
  computeUtilization,
  routeCapitalToman,
  venueExposureAfter
} from "@/lib/shadowArbitrage/paper/utilization";
import {
  PAPER_4D_MAX_ROUTE_CAPITAL_PERCENT,
  PAPER_4D_MAX_UTILIZATION_PERCENT,
  PAPER_4D_MAX_VENUE_EXPOSURE_PERCENT,
  PAPER_4D_MIN_RESERVE_PERCENT
} from "@/lib/shadowArbitrage/paper/experimentPolicy";

export type AllocatorCandidate = {
  lifecycleId: string;
  routeKey: string;
  buySourceId: string;
  sellSourceId: string;
  sizeUsdt: number;
  buyVwapToman: number;
  sellVwapToman: number;
  riskAdjustedPnlToman: number;
  economicNetPnlToman: number;
  /** Buy notional (IRT required). */
  buyNotionalToman: number;
  /** USDT micros required on sell venue (including fee pad when known). */
  sellUsdtMicros: number;
};

export type AllocatorRejection = {
  lifecycleId: string;
  routeKey: string;
  code: string;
  reasonFa: string;
};

export type AllocatorSelection = {
  candidate: AllocatorCandidate;
  capitalUsedToman: number;
  utilizationBeforePercent: number;
  utilizationAfterPercent: number;
};

export type AllocatorResult = {
  selected: AllocatorSelection[];
  rejected: AllocatorRejection[];
  utilizationBefore: ReturnType<typeof computeUtilization>;
  utilizationAfter: ReturnType<typeof computeUtilization>;
};

export function allocatePaperRoutes(input: {
  candidates: AllocatorCandidate[];
  equityToman: number;
  markPriceToman: number;
  /** Current venue exposure toman (from balances). */
  venueExposureToman: Map<string, number>;
  /** Available balances for double-spend checks. */
  availableIrtByVenue: Map<string, number>;
  availableUsdtMicrosByVenue: Map<string, number>;
  maxUtilizationPercent?: number;
  minReservePercent?: number;
  maxRouteCapitalPercent?: number;
  maxVenueExposurePercent?: number;
  /** Already reserved within this cycle (normally 0 at start). */
  reservedBuyIrtToman?: number;
  reservedSellUsdtMicros?: number;
}): AllocatorResult {
  const maxUtil = input.maxUtilizationPercent ?? PAPER_4D_MAX_UTILIZATION_PERCENT;
  const minReserve = input.minReservePercent ?? PAPER_4D_MIN_RESERVE_PERCENT;
  const maxRoute = input.maxRouteCapitalPercent ?? PAPER_4D_MAX_ROUTE_CAPITAL_PERCENT;
  const maxVenue = input.maxVenueExposurePercent ?? PAPER_4D_MAX_VENUE_EXPOSURE_PERCENT;

  const utilBefore = computeUtilization({
    equityToman: input.equityToman,
    markPriceToman: input.markPriceToman,
    reservedBuyIrtToman: input.reservedBuyIrtToman ?? 0,
    reservedSellUsdtMicros: input.reservedSellUsdtMicros ?? 0
  });

  // Deterministic rank: risk-adjusted PnL desc, then routeKey, then lifecycleId.
  const ranked = [...input.candidates].sort((a, b) => {
    if (b.riskAdjustedPnlToman !== a.riskAdjustedPnlToman) {
      return b.riskAdjustedPnlToman - a.riskAdjustedPnlToman;
    }
    const rk = a.routeKey.localeCompare(b.routeKey);
    if (rk !== 0) return rk;
    return a.lifecycleId.localeCompare(b.lifecycleId);
  });

  const selected: AllocatorSelection[] = [];
  const rejected: AllocatorRejection[] = [];
  let reservedBuy = input.reservedBuyIrtToman ?? 0;
  let reservedSell = input.reservedSellUsdtMicros ?? 0;
  const irtLeft = new Map(input.availableIrtByVenue);
  const usdtLeft = new Map(input.availableUsdtMicrosByVenue);
  const exposure = new Map(input.venueExposureToman);

  for (const c of ranked) {
    if (!(c.riskAdjustedPnlToman > 0) || !(c.economicNetPnlToman > 0)) {
      rejected.push({
        lifecycleId: c.lifecycleId,
        routeKey: c.routeKey,
        code: "net_non_positive",
        reasonFa: "سود اقتصادی تعدیل‌شده مثبت نیست — تخصیص صفر"
      });
      continue;
    }
    if (!(c.sizeUsdt > 0) || !(c.buyVwapToman > 0)) {
      rejected.push({
        lifecycleId: c.lifecycleId,
        routeKey: c.routeKey,
        code: "invalid_size",
        reasonFa: "حجم یا قیمت نامعتبر است"
      });
      continue;
    }

    const capital = routeCapitalToman({
      sizeUsdt: c.sizeUsdt,
      buyVwapToman: c.buyVwapToman,
      sellVwapToman: c.sellVwapToman,
      markPriceToman: input.markPriceToman
    });
    const routeCapToman = Math.floor((input.equityToman * maxRoute) / 100);
    if (capital > routeCapToman) {
      rejected.push({
        lifecycleId: c.lifecycleId,
        routeKey: c.routeKey,
        code: "route_capital_cap",
        reasonFa: `سرمایهٔ مسیر از ${maxRoute}٪ سهام تجاوز می‌کند`
      });
      continue;
    }

    const utilNow = computeUtilization({
      equityToman: input.equityToman,
      markPriceToman: input.markPriceToman,
      reservedBuyIrtToman: reservedBuy,
      reservedSellUsdtMicros: reservedSell
    });
    if (utilNow.wouldBreach(capital, maxUtil, minReserve)) {
      rejected.push({
        lifecycleId: c.lifecycleId,
        routeKey: c.routeKey,
        code: "portfolio_utilization_cap",
        reasonFa: `تخصیص از سقف ${maxUtil}٪ استفاده یا کف ${minReserve}٪ نقدینگی آزاد عبور می‌کند`
      });
      continue;
    }

    const buyExp = exposure.get(c.buySourceId) ?? 0;
    const sellExp = exposure.get(c.sellSourceId) ?? 0;
    const buyAdd = c.buyNotionalToman;
    const sellAdd = Math.round(c.sizeUsdt * (c.sellVwapToman || input.markPriceToman));
    if (
      !venueExposureAfter({
        currentExposureToman: buyExp,
        addToman: buyAdd,
        equityToman: input.equityToman,
        maxVenuePercent: maxVenue
      }) ||
      !venueExposureAfter({
        currentExposureToman: sellExp,
        addToman: sellAdd,
        equityToman: input.equityToman,
        maxVenuePercent: maxVenue
      })
    ) {
      rejected.push({
        lifecycleId: c.lifecycleId,
        routeKey: c.routeKey,
        code: "venue_exposure_cap",
        reasonFa: `تمرکز روی صرافی از ${maxVenue}٪ سهام تجاوز می‌کند`
      });
      continue;
    }

    const irtAvail = irtLeft.get(c.buySourceId) ?? 0;
    const usdtAvail = usdtLeft.get(c.sellSourceId) ?? 0;
    if (c.buyNotionalToman > irtAvail) {
      rejected.push({
        lifecycleId: c.lifecycleId,
        routeKey: c.routeKey,
        code: "insufficient_irt",
        reasonFa: "موجودی تومانی آزاد برای این مسیر کافی نیست (بدون دوباره‌خرجی)"
      });
      continue;
    }
    if (c.sellUsdtMicros > usdtAvail) {
      rejected.push({
        lifecycleId: c.lifecycleId,
        routeKey: c.routeKey,
        code: "insufficient_usdt",
        reasonFa: "موجودی تتری آزاد برای این مسیر کافی نیست (بدون دوباره‌خرجی)"
      });
      continue;
    }

    const beforePct = utilNow.utilizationPercent;
    reservedBuy += c.buyNotionalToman;
    reservedSell += c.sellUsdtMicros;
    irtLeft.set(c.buySourceId, irtAvail - c.buyNotionalToman);
    usdtLeft.set(c.sellSourceId, usdtAvail - c.sellUsdtMicros);
    exposure.set(c.buySourceId, buyExp + buyAdd);
    exposure.set(c.sellSourceId, sellExp + sellAdd);

    const after = computeUtilization({
      equityToman: input.equityToman,
      markPriceToman: input.markPriceToman,
      reservedBuyIrtToman: reservedBuy,
      reservedSellUsdtMicros: reservedSell
    });

    selected.push({
      candidate: c,
      capitalUsedToman: capital,
      utilizationBeforePercent: beforePct,
      utilizationAfterPercent: after.utilizationPercent
    });
  }

  const utilAfter = computeUtilization({
    equityToman: input.equityToman,
    markPriceToman: input.markPriceToman,
    reservedBuyIrtToman: reservedBuy,
    reservedSellUsdtMicros: reservedSell
  });

  return {
    selected,
    rejected,
    utilizationBefore: utilBefore,
    utilizationAfter: utilAfter
  };
}
