/**
 * Pure presentation model for a closed Paper trade detail panel.
 *
 * Read-only: maps already-persisted ledger fields into labeled groups.
 * Never invents timestamps, prices, fees, sizes or utilization. A missing
 * historical field is reported as `missing` so the UI shows «ثبت نشده».
 */
import {
  buildTradeProfitability,
  type TradeProfitabilityView
} from "@/lib/shadowArbitrage/paper/tradeProfitability";

export const MISSING_FA = "ثبت نشده" as const;
export const MISSING_HIST_FA = "در دادهٔ تاریخی موجود نیست" as const;

export type TradeDetailFieldStatus = "present" | "missing";

export type TradeDetailField<T> = {
  status: TradeDetailFieldStatus;
  value: T | null;
  /** Persian label when missing. */
  missingFa: string;
};

function present<T>(value: T): TradeDetailField<T> {
  return { status: "present", value, missingFa: MISSING_FA };
}

function missing<T>(reason: string = MISSING_HIST_FA): TradeDetailField<T> {
  return { status: "missing", value: null, missingFa: reason };
}

function fromNullable<T>(value: T | null | undefined, reason?: string): TradeDetailField<T> {
  if (value === null || value === undefined) return missing(reason);
  if (typeof value === "number" && !Number.isFinite(value)) return missing(reason);
  if (typeof value === "string" && value.trim() === "") return missing(reason);
  return present(value as T);
}

/** Subset of the paper ledger row used by the book detail panel. */
export type ClosedTradeEvidence = {
  id: string;
  sessionId?: string | null;
  runId?: string | null;
  experimentRunId?: string | null;
  lifecycleId: string;
  routeKey: string;
  buySourceId: string;
  sellSourceId: string;
  sizeUsdt: number;
  buyVwapToman: number | null;
  sellVwapToman: number | null;
  buyNotionalToman?: number | null;
  sellNotionalToman?: number | null;
  buyFeeBps?: number | null;
  sellFeeBps?: number | null;
  buyFeeAsset?: string | null;
  sellFeeAsset?: string | null;
  buyFeeDebitMode?: string | null;
  sellFeeDebitMode?: string | null;
  feeTomanTotal: number | null;
  feeUsdtMicrosTotal: number | null;
  sellFeeValueToman: number | null;
  grossSpreadToman: number | null;
  cashPnlIrtToman: number | null;
  economicNetPnlToman: number | null;
  riskAdjustedPnlToman: number | null;
  slippageBufferToman: number | null;
  markPriceToman?: number | null;
  occurredAt: string;
  outcome?: "FILLED" | "SKIPPED";
  rejectionCode?: string | null;
  rejectionReason?: string | null;
  sizingPolicy?: string | null;
  sizingReason?: string | null;
  bindingConstraint?: string | null;
  limitingSide?: string | null;
  limitingSourceId?: string | null;
  limitingUsableUsdtMicros?: number | null;
  capitalCapUsdtMicros?: number | null;
  depthCapUsdtMicros?: number | null;
  riskAdjustedReturnBps?: number | null;
  selectedPercentOfUsable?: number | null;
  inventoryImpactPoints?: number | null;
  nextLargerSizeUsdt?: number | null;
  nextLargerRejectionCode?: string | null;
  nextLargerRejectionReason?: string | null;
  nextLargerMarginalPnlToman?: number | null;
  balancesAfter?: Array<{ sourceId: string; irtToman: number; usdtMicros: number }>;
  /** Not currently mapped from the repository — always missing unless supplied. */
  idempotencyKey?: string | null;
  eventType?: string | null;
  reasonCodes?: string[];
};

export type TradeDetailsContext = {
  policyFingerprint?: string | null;
  releaseVersion?: string | null;
  experimentId?: string | null;
};

export type TradeDurationView = {
  /**
   * Atomic dual-leg Paper broker: buy and sell share one ledger `occurredAt`.
   * Duration is therefore zero and both endpoints are that same timestamp.
   */
  model: "atomic_dual_leg";
  startField: "occurredAt";
  endField: "occurredAt";
  startIso: string;
  endIso: string;
  durationMs: number;
  explanationFa: string;
};

export type TradeDetailsView = {
  timeline: {
    decisionAt: TradeDetailField<string>;
    orderCreatedAt: TradeDetailField<string>;
    submissionAt: TradeDetailField<string>;
    buyFillAt: TradeDetailField<string>;
    sellFillAt: TradeDetailField<string>;
    completionAt: TradeDetailField<string>;
    duration: TradeDurationView;
  };
  transaction: {
    buyVenue: TradeDetailField<string>;
    sellVenue: TradeDetailField<string>;
    sizingMode: TradeDetailField<string>;
    sizeUsdt: TradeDetailField<number>;
    buyPrice: TradeDetailField<number>;
    buyVwap: TradeDetailField<number>;
    sellPrice: TradeDetailField<number>;
    sellVwap: TradeDetailField<number>;
    buyNotional: TradeDetailField<number>;
    sellNotional: TradeDetailField<number>;
    grossSpread: TradeDetailField<number>;
    grossProfit: TradeDetailField<number>;
    buyFeeBps: TradeDetailField<number>;
    sellFeeBps: TradeDetailField<number>;
    buyFeeAsset: TradeDetailField<string>;
    sellFeeAsset: TradeDetailField<string>;
    feeTomanTotal: TradeDetailField<number>;
    feeUsdtMicros: TradeDetailField<number>;
    sellFeeValueToman: TradeDetailField<number>;
    totalModeledFeeNoteFa: string;
    economicNetPnl: TradeDetailField<number>;
    cashPnl: TradeDetailField<number>;
    status: TradeDetailField<string>;
    failureReason: TradeDetailField<string>;
  };
  sizing: {
    selectedSizeUsdt: TradeDetailField<number>;
    candidatesEvaluated: TradeDetailField<string>;
    utilBefore: TradeDetailField<number>;
    utilAfter: TradeDetailField<number>;
    rawBuyDepth: TradeDetailField<number>;
    rawSellDepth: TradeDetailField<number>;
    usableBuyCapacity: TradeDetailField<number>;
    usableSellCapacity: TradeDetailField<number>;
    availableIrt: TradeDetailField<number>;
    availableUsdt: TradeDetailField<number>;
    orderSizePolicyCap: TradeDetailField<number>;
    venueExposureCap: TradeDetailField<number>;
    routeExposureCap: TradeDetailField<number>;
    slippageCap: TradeDetailField<number>;
    capitalCapUsdt: TradeDetailField<number>;
    depthCapUsdt: TradeDetailField<number>;
    bindingConstraint: TradeDetailField<string>;
    sizingReason: TradeDetailField<string>;
    nextLargerSizeUsdt: TradeDetailField<number>;
    nextLargerRejectionCode: TradeDetailField<string>;
    nextLargerRejectionReason: TradeDetailField<string>;
    selectedPercentOfUsable: TradeDetailField<number>;
    limitingSide: TradeDetailField<string>;
    limitingSourceId: TradeDetailField<string>;
    limitingUsableUsdt: TradeDetailField<number>;
  };
  technical: {
    runId: TradeDetailField<string>;
    sessionId: TradeDetailField<string>;
    cycleId: TradeDetailField<string>;
    decisionId: TradeDetailField<string>;
    ledgerId: TradeDetailField<string>;
    lifecycleId: TradeDetailField<string>;
    orderId: TradeDetailField<string>;
    fillId: TradeDetailField<string>;
    tradeId: TradeDetailField<string>;
    experimentId: TradeDetailField<string>;
    policyFingerprint: TradeDetailField<string>;
    releaseVersion: TradeDetailField<string>;
    idempotencyKey: TradeDetailField<string>;
  };
  /**
   * Profitability presentation (economic net is primary).
   * Rial is display-only conversion from toman.
   */
  profitability: TradeProfitabilityView;
  /** Exact field keys that are not present in persisted evidence. */
  missingFieldKeys: string[];
};

const ATOMIC_DURATION_FA =
  "کارگزار کاغذی فعلی دو پایه را اتمیک پر می‌کند؛ زمان شروع و پایان هر دو «occurredAt» دفتر است و مدت تراکنش صفر میلی‌ثانیه است.";

/**
 * Build the detail view from one immutable FILLED (or SKIPPED) ledger row.
 * Pure: no I/O, no market lookup, no recalculation of PnL.
 */
export function buildTradeDetailsView(
  trade: ClosedTradeEvidence,
  ctx: TradeDetailsContext = {}
): TradeDetailsView {
  const missingKeys: string[] = [];
  const track = <T>(key: string, field: TradeDetailField<T>): TradeDetailField<T> => {
    if (field.status === "missing") missingKeys.push(key);
    return field;
  };

  // Single persisted event time for atomic fills.
  const occurred = trade.occurredAt;

  const duration: TradeDurationView = {
    model: "atomic_dual_leg",
    startField: "occurredAt",
    endField: "occurredAt",
    startIso: occurred,
    endIso: occurred,
    durationMs: 0,
    explanationFa: ATOMIC_DURATION_FA
  };

  // Gross profit: only use the persisted grossSpreadToman; do not recompute.
  const grossProfit = fromNullable(trade.grossSpreadToman);
  const profitability = buildTradeProfitability({
    sizeUsdt: trade.sizeUsdt,
    grossSpreadToman: trade.grossSpreadToman,
    feeTomanTotal: trade.feeTomanTotal,
    feeUsdtMicrosTotal: trade.feeUsdtMicrosTotal,
    sellFeeValueToman: trade.sellFeeValueToman,
    economicNetPnlToman: trade.economicNetPnlToman,
    buyNotionalToman: trade.buyNotionalToman
  });

  const view: TradeDetailsView = {
    timeline: {
      decisionAt: track(
        "timeline.decisionAt",
        missing("مهر جداگانهٔ تصمیم در دفتر ثبت نشده — فقط occurredAt پر موجود است")
      ),
      orderCreatedAt: track(
        "timeline.orderCreatedAt",
        missing("زمان ایجاد سفارش جداگانه ثبت نشده (مدل اتمیک)")
      ),
      submissionAt: track(
        "timeline.submissionAt",
        missing("زمان ارسال سفارش جداگانه ثبت نشده (مدل اتمیک)")
      ),
      buyFillAt: track("timeline.buyFillAt", present(occurred)),
      sellFillAt: track("timeline.sellFillAt", present(occurred)),
      completionAt: track("timeline.completionAt", present(occurred)),
      duration
    },
    transaction: {
      buyVenue: track("transaction.buyVenue", present(trade.buySourceId)),
      sellVenue: track("transaction.sellVenue", present(trade.sellSourceId)),
      sizingMode: track("transaction.sizingMode", fromNullable(trade.sizingPolicy)),
      sizeUsdt: track("transaction.sizeUsdt", present(trade.sizeUsdt)),
      // Separate "price" vs VWAP not stored; VWAP is the execution price of record.
      buyPrice: track(
        "transaction.buyPrice",
        fromNullable(trade.buyVwapToman, "قیمت جدا از VWAP خرید ثبت نشده")
      ),
      buyVwap: track("transaction.buyVwap", fromNullable(trade.buyVwapToman)),
      sellPrice: track(
        "transaction.sellPrice",
        fromNullable(trade.sellVwapToman, "قیمت جدا از VWAP فروش ثبت نشده")
      ),
      sellVwap: track("transaction.sellVwap", fromNullable(trade.sellVwapToman)),
      buyNotional: track("transaction.buyNotional", fromNullable(trade.buyNotionalToman ?? null)),
      sellNotional: track(
        "transaction.sellNotional",
        fromNullable(trade.sellNotionalToman ?? null)
      ),
      grossSpread: track("transaction.grossSpread", fromNullable(trade.grossSpreadToman)),
      grossProfit: track("transaction.grossProfit", grossProfit),
      buyFeeBps: track("transaction.buyFeeBps", fromNullable(trade.buyFeeBps ?? null)),
      sellFeeBps: track("transaction.sellFeeBps", fromNullable(trade.sellFeeBps ?? null)),
      buyFeeAsset: track("transaction.buyFeeAsset", fromNullable(trade.buyFeeAsset ?? null)),
      sellFeeAsset: track("transaction.sellFeeAsset", fromNullable(trade.sellFeeAsset ?? null)),
      feeTomanTotal: track("transaction.feeTomanTotal", fromNullable(trade.feeTomanTotal)),
      feeUsdtMicros: track(
        "transaction.feeUsdtMicros",
        fromNullable(trade.feeUsdtMicrosTotal)
      ),
      sellFeeValueToman: track(
        "transaction.sellFeeValueToman",
        fromNullable(trade.sellFeeValueToman)
      ),
      totalModeledFeeNoteFa:
        "کارمزد مدل‌شده از فیلدهای feeTomanTotal (IRT) و feeUsdtMicrosTotal / sellFeeValueToman (سمت تتر) خوانده می‌شود — بدون محاسبهٔ دوباره.",
      economicNetPnl: track(
        "transaction.economicNetPnl",
        fromNullable(trade.economicNetPnlToman)
      ),
      cashPnl: track("transaction.cashPnl", fromNullable(trade.cashPnlIrtToman)),
      status: track(
        "transaction.status",
        present(trade.outcome === "SKIPPED" ? "SKIPPED" : "FILLED")
      ),
      failureReason: track(
        "transaction.failureReason",
        trade.outcome === "SKIPPED"
          ? fromNullable(trade.rejectionReason ?? trade.rejectionCode ?? null)
          : missing("برای معاملهٔ FILLED دلیل شکست وجود ندارد")
      )
    },
    sizing: {
      selectedSizeUsdt: track("sizing.selectedSizeUsdt", present(trade.sizeUsdt)),
      candidatesEvaluated: track(
        "sizing.candidatesEvaluated",
        missing("فهرست کامل اندازه‌های کاندید در دفتر ثبت نشده")
      ),
      utilBefore: track(
        "sizing.utilBefore",
        missing("utilization قبل از تخصیص روی ردیف معامله ثبت نشده")
      ),
      utilAfter: track(
        "sizing.utilAfter",
        missing("utilization بعد از تخصیص روی ردیف معامله ثبت نشده")
      ),
      rawBuyDepth: track(
        "sizing.rawBuyDepth",
        missing("عمق خام خرید در ردیف معامله ثبت نشده")
      ),
      rawSellDepth: track(
        "sizing.rawSellDepth",
        missing("عمق خام فروش در ردیف معامله ثبت نشده")
      ),
      usableBuyCapacity: track(
        "sizing.usableBuyCapacity",
        missing("ظرفیت قابل‌استفاده خرید در ردیف معامله ثبت نشده")
      ),
      usableSellCapacity: track(
        "sizing.usableSellCapacity",
        missing("ظرفیت قابل‌استفاده فروش در ردیف معامله ثبت نشده")
      ),
      availableIrt: track(
        "sizing.availableIrt",
        missing("موجودی IRT قبل از معامله در ردیف ثبت نشده")
      ),
      availableUsdt: track(
        "sizing.availableUsdt",
        missing("موجودی USDT قبل از معامله در ردیف ثبت نشده")
      ),
      orderSizePolicyCap: track(
        "sizing.orderSizePolicyCap",
        missing("سقف سیاست max_order_size_usdt روی ردیف ثبت نشده")
      ),
      venueExposureCap: track(
        "sizing.venueExposureCap",
        missing("سقف تمرکز صرافی روی ردیف ثبت نشده")
      ),
      routeExposureCap: track(
        "sizing.routeExposureCap",
        missing("سقف سرمایهٔ مسیر روی ردیف ثبت نشده")
      ),
      slippageCap: track(
        "sizing.slippageCap",
        fromNullable(trade.slippageBufferToman, "سقف لغزش به صورت bps جدا ثبت نشده؛ فقط بافر تومانی")
      ),
      capitalCapUsdt: track(
        "sizing.capitalCapUsdt",
        trade.capitalCapUsdtMicros != null
          ? present(trade.capitalCapUsdtMicros / 1_000_000)
          : missing()
      ),
      depthCapUsdt: track(
        "sizing.depthCapUsdt",
        trade.depthCapUsdtMicros != null
          ? present(trade.depthCapUsdtMicros / 1_000_000)
          : missing()
      ),
      bindingConstraint: track(
        "sizing.bindingConstraint",
        fromNullable(trade.bindingConstraint ?? null)
      ),
      sizingReason: track("sizing.sizingReason", fromNullable(trade.sizingReason ?? null)),
      nextLargerSizeUsdt: track(
        "sizing.nextLargerSizeUsdt",
        fromNullable(trade.nextLargerSizeUsdt ?? null)
      ),
      nextLargerRejectionCode: track(
        "sizing.nextLargerRejectionCode",
        fromNullable(trade.nextLargerRejectionCode ?? null)
      ),
      nextLargerRejectionReason: track(
        "sizing.nextLargerRejectionReason",
        fromNullable(trade.nextLargerRejectionReason ?? null)
      ),
      selectedPercentOfUsable: track(
        "sizing.selectedPercentOfUsable",
        fromNullable(trade.selectedPercentOfUsable ?? null)
      ),
      limitingSide: track("sizing.limitingSide", fromNullable(trade.limitingSide ?? null)),
      limitingSourceId: track(
        "sizing.limitingSourceId",
        fromNullable(trade.limitingSourceId ?? null)
      ),
      limitingUsableUsdt: track(
        "sizing.limitingUsableUsdt",
        trade.limitingUsableUsdtMicros != null
          ? present(trade.limitingUsableUsdtMicros / 1_000_000)
          : missing()
      )
    },
    profitability,
    technical: {
      runId: track("technical.runId", fromNullable(trade.runId ?? null)),
      sessionId: track("technical.sessionId", fromNullable(trade.sessionId ?? null)),
      // Collection cycle uses the same runId field when present.
      cycleId: track(
        "technical.cycleId",
        fromNullable(trade.runId ?? null, "شناسهٔ چرخهٔ جدا از runId ثبت نشده")
      ),
      decisionId: track(
        "technical.decisionId",
        missing("شناسهٔ تصمیم جدا از ردیف دفتر ثبت نشده")
      ),
      ledgerId: track("technical.ledgerId", present(trade.id)),
      lifecycleId: track("technical.lifecycleId", present(trade.lifecycleId)),
      orderId: track(
        "technical.orderId",
        missing("شناسهٔ سفارش جداگانه ثبت نشده (پر اتمیک)")
      ),
      fillId: track(
        "technical.fillId",
        missing("شناسهٔ fill جدا از ledger id ثبت نشده")
      ),
      tradeId: track("technical.tradeId", present(trade.id)),
      experimentId: track(
        "technical.experimentId",
        fromNullable(trade.experimentRunId ?? ctx.experimentId ?? null)
      ),
      policyFingerprint: track(
        "technical.policyFingerprint",
        fromNullable(ctx.policyFingerprint ?? null)
      ),
      releaseVersion: track(
        "technical.releaseVersion",
        fromNullable(ctx.releaseVersion ?? null)
      ),
      idempotencyKey: track(
        "technical.idempotencyKey",
        fromNullable(
          trade.idempotencyKey ?? null,
          "idempotencyKey در پاسخ API دفتر نقشه‌برداری نشده است"
        )
      )
    },
    missingFieldKeys: []
  };

  view.missingFieldKeys = [...new Set(missingKeys)].sort();
  return view;
}

/** Exact list of evidence gaps for the audit report. */
export function listMissingTradeEvidenceKeys(view: TradeDetailsView): string[] {
  return view.missingFieldKeys;
}
