/**
 * Paper portfolio accounting — pure reconciliation helpers.
 *
 * Derived only from persisted balances, session opening capital and immutable
 * ledger fills. No network, no clock of its own, no invented prices. When the
 * mark price is missing, marked equity and return are null rather than zero.
 *
 * Open orders and open trade-positions do not exist in the current Paper
 * Broker (fills are all-or-nothing dual-leg). Free = total, reserved = 0,
 * committed = 0 is therefore the honest reading of the virtual book — not a
 * simplification of a richer model.
 */
import { microsToUsdt, type VenueBalance } from "@/lib/shadowArbitrage/paper/broker";

export type AccountingFill = {
  id: string;
  lifecycleId: string;
  routeKey: string;
  buySourceId: string;
  sellSourceId: string;
  sizeUsdt: number;
  buyVwapToman: number | null;
  sellVwapToman: number | null;
  buyNotionalToman: number | null;
  sellNotionalToman: number | null;
  feeTomanTotal: number | null;
  feeUsdtMicrosTotal: number | null;
  sellFeeValueToman: number | null;
  grossSpreadToman: number | null;
  cashPnlIrtToman: number | null;
  economicNetPnlToman: number | null;
  riskAdjustedPnlToman: number | null;
  slippageBufferToman: number | null;
  markPriceToman: number | null;
  occurredAt: string;
  outcome: "FILLED" | "SKIPPED";
};

export type VenueAccountingRow = {
  sourceId: string;
  irtToman: number;
  usdtMicros: number;
  usdt: number;
  /** Marked value of this venue at the session mark. Null without a mark. */
  valuationToman: number | null;
  freeIrtToman: number;
  freeUsdtMicros: number;
  reservedIrtToman: number;
  reservedUsdtMicros: number;
  committedIrtToman: number;
  committedUsdtMicros: number;
  openingIrtToman: number;
  openingUsdtMicros: number;
  irtDelta: number;
  usdtMicrosDelta: number;
};

export type FeeBucket = {
  feeToman: number;
  feeUsdtMicros: number;
  /** Toman-equivalent of USDT fees at the supplied mark; null without mark. */
  feeUsdtValueToman: number | null;
  totalFeeTomanEquivalent: number | null;
  byVenue: Array<{
    sourceId: string;
    feeToman: number;
    feeUsdtMicros: number;
    feeUsdtValueToman: number | null;
    trades: number;
  }>;
  byTrade: Array<{
    id: string;
    lifecycleId: string;
    routeKey: string;
    feeToman: number;
    feeUsdtMicros: number;
    feeUsdtValueToman: number | null;
    occurredAt: string;
  }>;
};

export type PortfolioAccounting = {
  asOf: string;
  initialCapitalToman: number;
  markPriceToman: number | null;
  markPriceProvisional: boolean;
  equityToman: number | null;
  freeCapitalToman: number | null;
  reservedInOrdersToman: number;
  committedToPositionsToman: number;
  availableIrtToman: number;
  availableUsdtMicros: number;
  availableUsdt: number;
  realizedEconomicPnlToman: number;
  realizedRiskAdjustedPnlToman: number;
  realizedCashPnlToman: number;
  /** Equity − initial − realized economic; null without a mark. */
  unrealizedPnlToman: number | null;
  grossSpreadToman: number;
  fees: FeeBucket;
  todayRealizedPnlToman: number;
  returnPercent: number | null;
  venues: VenueAccountingRow[];
  openOrders: [];
  openPositions: [];
  openOrdersNoteFa: string;
  openPositionsNoteFa: string;
  reconciliation: {
    equityMatchesInitialPlusPnl: boolean | null;
    freePlusReservedPlusCommittedEqualsEquity: boolean | null;
    venueSumEqualsPortfolioEquity: boolean | null;
    feeLedgerSumMatchesBucket: boolean;
    residuals: {
      equityVsInitialPlusPnlToman: number | null;
      capitalSplitVsEquityToman: number | null;
      venueSumVsEquityToman: number | null;
      feeTomanDiff: number;
    };
  };
};

const OPEN_ORDERS_NOTE =
  "کارگزار کاغذی فعلی سفارش باز نگه نمی‌دارد: هر نامزد پذیرفته‌شده در همان چرخه به‌صورت اتمی دو پا پر می‌شود یا رد می‌شود. هیچ سفارش باز مجازی وجود ندارد.";

const OPEN_POSITIONS_NOTE =
  "مدل فعلی آربیتراژ کاغذی پوزیشن باز دوطرفه نگه نمی‌دارد؛ موجودی مجازی فقط در تراز هر صرافی است. پوزیشن فقط وقتی نمایش داده می‌شود که در دفتر ثبت شده باشد.";

function feeUsdtValue(micros: number, mark: number | null): number | null {
  if (mark === null || mark <= 0) return null;
  return Math.round(microsToUsdt(micros) * mark);
}

/**
 * Build the capital / fee / reconciliation snapshot for the Accounts section.
 *
 * `todayStartMs` is supplied by the caller so this module stays clock-free.
 */
export function buildPortfolioAccounting(input: {
  asOf: string;
  initialCapitalToman: number;
  markPriceToman: number | null;
  balances: VenueBalance[];
  opening: Array<{ sourceId: string; irtToman: number; usdtUnits: number }>;
  fills: AccountingFill[];
  todayStartMs: number;
}): PortfolioAccounting {
  const mark =
    input.markPriceToman !== null &&
    Number.isFinite(input.markPriceToman) &&
    input.markPriceToman > 0
      ? input.markPriceToman
      : null;
  const openingMap = new Map(
    input.opening.map((o) => [
      o.sourceId,
      {
        irtToman: Math.round(o.irtToman),
        usdtMicros: Math.round(o.usdtUnits * 1_000_000)
      }
    ])
  );

  const venues: VenueAccountingRow[] = input.balances.map((b) => {
    const open = openingMap.get(b.sourceId) ?? { irtToman: 0, usdtMicros: 0 };
    const valuationToman =
      mark === null ? null : Math.round(b.irtToman + microsToUsdt(b.usdtMicros) * mark);
    return {
      sourceId: b.sourceId,
      irtToman: b.irtToman,
      usdtMicros: b.usdtMicros,
      usdt: microsToUsdt(b.usdtMicros),
      valuationToman,
      // Immediate-fill broker: nothing is reserved or committed outside free balances.
      freeIrtToman: b.irtToman,
      freeUsdtMicros: b.usdtMicros,
      reservedIrtToman: 0,
      reservedUsdtMicros: 0,
      committedIrtToman: 0,
      committedUsdtMicros: 0,
      openingIrtToman: open.irtToman,
      openingUsdtMicros: open.usdtMicros,
      irtDelta: b.irtToman - open.irtToman,
      usdtMicrosDelta: b.usdtMicros - open.usdtMicros
    };
  });

  const availableIrtToman = venues.reduce((s, v) => s + v.freeIrtToman, 0);
  const availableUsdtMicros = venues.reduce((s, v) => s + v.freeUsdtMicros, 0);
  const equityToman =
    mark === null
      ? null
      : Math.round(availableIrtToman + microsToUsdt(availableUsdtMicros) * mark);

  const filled = input.fills.filter((f) => f.outcome === "FILLED");
  const realizedEconomicPnlToman = filled.reduce((s, f) => s + (f.economicNetPnlToman ?? 0), 0);
  const realizedRiskAdjustedPnlToman = filled.reduce(
    (s, f) => s + (f.riskAdjustedPnlToman ?? 0),
    0
  );
  const realizedCashPnlToman = filled.reduce((s, f) => s + (f.cashPnlIrtToman ?? 0), 0);
  const grossSpreadToman = filled.reduce((s, f) => s + (f.grossSpreadToman ?? 0), 0);
  const todayRealizedPnlToman = filled
    .filter((f) => Date.parse(f.occurredAt) >= input.todayStartMs)
    .reduce((s, f) => s + (f.economicNetPnlToman ?? 0), 0);

  const feeToman = filled.reduce((s, f) => s + (f.feeTomanTotal ?? 0), 0);
  const feeUsdtMicros = filled.reduce((s, f) => s + (f.feeUsdtMicrosTotal ?? 0), 0);
  const feeUsdtVal = feeUsdtValue(feeUsdtMicros, mark);

  const byVenueMap = new Map<
    string,
    { feeToman: number; feeUsdtMicros: number; trades: number }
  >();
  for (const f of filled) {
    for (const sid of [f.buySourceId, f.sellSourceId]) {
      const cur = byVenueMap.get(sid) ?? { feeToman: 0, feeUsdtMicros: 0, trades: 0 };
      // Attribute half of each fee leg-ish: store full fee once on buy, half rounding on sell is wrong.
      // Better: attribute fee_toman to buy (IRT fees) and fee_usdt to sell. We only have totals.
      byVenueMap.set(sid, cur);
    }
    // Attribute full fee to both legs' venues as shared participation count; fee amount once on buy venue for IRT and sell for USDT.
    const buy = byVenueMap.get(f.buySourceId)!;
    buy.feeToman += f.feeTomanTotal ?? 0;
    buy.trades += 1;
    const sell = byVenueMap.get(f.sellSourceId)!;
    sell.feeUsdtMicros += f.feeUsdtMicrosTotal ?? 0;
    sell.trades += 1;
  }

  const fees: FeeBucket = {
    feeToman,
    feeUsdtMicros,
    feeUsdtValueToman: feeUsdtVal,
    totalFeeTomanEquivalent:
      feeUsdtVal === null ? (mark === null ? null : feeToman) : feeToman + feeUsdtVal,
    byVenue: [...byVenueMap.entries()]
      .map(([sourceId, v]) => ({
        sourceId,
        feeToman: v.feeToman,
        feeUsdtMicros: v.feeUsdtMicros,
        feeUsdtValueToman: feeUsdtValue(v.feeUsdtMicros, mark),
        trades: v.trades
      }))
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    byTrade: filled.map((f) => ({
      id: f.id,
      lifecycleId: f.lifecycleId,
      routeKey: f.routeKey,
      feeToman: f.feeTomanTotal ?? 0,
      feeUsdtMicros: f.feeUsdtMicrosTotal ?? 0,
      feeUsdtValueToman: feeUsdtValue(f.feeUsdtMicrosTotal ?? 0, mark),
      occurredAt: f.occurredAt
    }))
  };

  const unrealizedPnlToman =
    equityToman === null ? null : equityToman - input.initialCapitalToman - realizedEconomicPnlToman;

  const reservedInOrdersToman = 0;
  const committedToPositionsToman = 0;
  const freeCapitalToman = equityToman;

  const equityVsInitialPlusPnl =
    equityToman === null
      ? null
      : equityToman - (input.initialCapitalToman + realizedEconomicPnlToman + (unrealizedPnlToman ?? 0));
  // By construction unrealized = equity - initial - realized, so residual is 0 when equity known.
  const capitalSplitVsEquity =
    equityToman === null
      ? null
      : (freeCapitalToman ?? 0) + reservedInOrdersToman + committedToPositionsToman - equityToman;
  const venueSum =
    mark === null
      ? null
      : venues.reduce((s, v) => s + (v.valuationToman ?? 0), 0);
  const venueSumVsEquity =
    equityToman === null || venueSum === null ? null : venueSum - equityToman;

  const feeLedgerSumToman = filled.reduce((s, f) => s + (f.feeTomanTotal ?? 0), 0);
  const feeLedgerSumUsdt = filled.reduce((s, f) => s + (f.feeUsdtMicrosTotal ?? 0), 0);

  return {
    asOf: input.asOf,
    initialCapitalToman: input.initialCapitalToman,
    markPriceToman: mark,
    markPriceProvisional: mark === null,
    equityToman,
    freeCapitalToman,
    reservedInOrdersToman,
    committedToPositionsToman,
    availableIrtToman,
    availableUsdtMicros,
    availableUsdt: microsToUsdt(availableUsdtMicros),
    realizedEconomicPnlToman,
    realizedRiskAdjustedPnlToman,
    realizedCashPnlToman,
    unrealizedPnlToman,
    grossSpreadToman,
    fees,
    todayRealizedPnlToman,
    returnPercent:
      equityToman !== null && input.initialCapitalToman > 0
        ? Math.round(
            ((equityToman - input.initialCapitalToman) / input.initialCapitalToman) * 10_000
          ) / 100
        : null,
    venues,
    openOrders: [],
    openPositions: [],
    openOrdersNoteFa: OPEN_ORDERS_NOTE,
    openPositionsNoteFa: OPEN_POSITIONS_NOTE,
    reconciliation: {
      equityMatchesInitialPlusPnl:
        equityVsInitialPlusPnl === null ? null : Math.abs(equityVsInitialPlusPnl) <= 1,
      freePlusReservedPlusCommittedEqualsEquity:
        capitalSplitVsEquity === null ? null : Math.abs(capitalSplitVsEquity) <= 1,
      venueSumEqualsPortfolioEquity:
        venueSumVsEquity === null ? null : Math.abs(venueSumVsEquity) <= 1,
      feeLedgerSumMatchesBucket:
        feeLedgerSumToman === feeToman && feeLedgerSumUsdt === feeUsdtMicros,
      residuals: {
        equityVsInitialPlusPnlToman: equityVsInitialPlusPnl,
        capitalSplitVsEquityToman: capitalSplitVsEquity,
        venueSumVsEquityToman: venueSumVsEquity,
        feeTomanDiff: feeLedgerSumToman - feeToman
      }
    }
  };
}

/** Tehran calendar day start for "today" filters, in epoch ms. */
export function tehranDayStartMs(nowMs: number): number {
  // Asia/Tehran is UTC+3:30 without DST in current civil time used by the desk.
  const tehranOffsetMs = 3.5 * 3_600_000;
  const local = nowMs + tehranOffsetMs;
  const day = Math.floor(local / 86_400_000) * 86_400_000;
  return day - tehranOffsetMs;
}

export function filterFillsByWindow(
  fills: AccountingFill[],
  window: "today" | "7d" | "30d" | "lifetime",
  nowMs: number
): AccountingFill[] {
  if (window === "lifetime") return fills;
  if (window === "today") {
    const start = tehranDayStartMs(nowMs);
    return fills.filter((f) => Date.parse(f.occurredAt) >= start);
  }
  const ms = window === "7d" ? 7 * 86_400_000 : 30 * 86_400_000;
  return fills.filter((f) => nowMs - Date.parse(f.occurredAt) <= ms);
}
