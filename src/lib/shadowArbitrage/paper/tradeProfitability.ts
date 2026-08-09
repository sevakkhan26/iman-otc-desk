/**
 * Read-only profitability presentation for closed Paper trades.
 *
 * Derives display figures only from already-persisted ledger fields.
 * Does not re-price fees from the live market. Rial is a display conversion
 * of toman (1 toman = 10 rial), not a second accounting ledger.
 *
 * Volume: each atomic two-leg fill contributes `sizeUsdt` once.
 */
export const TOMAN_TO_RIAL = 10 as const;

export const UNCOMPUTABLE_FA = "قابل محاسبه نیست" as const;

/** Pure presentation conversion: rial = toman × 10. */
export function tomanToRial(toman: number): number {
  if (!Number.isFinite(toman)) return NaN;
  // Exact integer path when toman is integer; otherwise preserve finite product.
  return toman * TOMAN_TO_RIAL;
}

export type MoneyTomanRial = {
  toman: number;
  rial: number;
};

export function asTomanRial(toman: number): MoneyTomanRial {
  return { toman, rial: tomanToRial(toman) };
}

/**
 * Total modeled fee in toman from persisted sides only.
 *
 * - IRT fee: `feeTomanTotal` when present (treat null as 0 only if no USDT fee either)
 * - USDT fee value: `sellFeeValueToman` (already valued at execution mark)
 * - If `feeUsdtMicrosTotal > 0` but `sellFeeValueToman` is null → uncomputable
 *   (must not revalue with current market).
 */
export function totalModeledFeeToman(input: {
  feeTomanTotal: number | null;
  feeUsdtMicrosTotal: number | null;
  sellFeeValueToman: number | null;
}): { ok: true; toman: number } | { ok: false; reasonFa: string } {
  const usdtMicros = input.feeUsdtMicrosTotal ?? 0;
  const hasUsdtFee = usdtMicros > 0;
  if (hasUsdtFee && (input.sellFeeValueToman === null || input.sellFeeValueToman === undefined)) {
    return {
      ok: false,
      reasonFa: `${UNCOMPUTABLE_FA} — کارمزد USDT ثبت شده ولی معادل تومانی اجرای آن (sellFeeValueToman) در دفتر نیست؛ قیمت جاری بازار استفاده نمی‌شود.`
    };
  }
  const irt = input.feeTomanTotal ?? 0;
  const usdtVal = hasUsdtFee ? (input.sellFeeValueToman as number) : (input.sellFeeValueToman ?? 0);
  // When both sides null and no USDT micros: fee is 0 (known), not missing.
  if (
    input.feeTomanTotal === null &&
    !hasUsdtFee &&
    (input.sellFeeValueToman === null || input.sellFeeValueToman === undefined)
  ) {
    // Ambiguous: no fee fields at all — treat as 0 only if micros also 0/null.
    return { ok: true, toman: 0 };
  }
  const toman = irt + (Number.isFinite(usdtVal) ? usdtVal : 0);
  if (!Number.isFinite(toman)) {
    return { ok: false, reasonFa: UNCOMPUTABLE_FA };
  }
  return { ok: true, toman };
}

/**
 * Net economic profit per 1 USDT of executed size (size counted once).
 * Returns null when volume is zero or non-finite, or net is missing.
 */
export function netProfitPerUsdt(
  economicNetPnlToman: number | null,
  sizeUsdt: number
): number | null {
  if (economicNetPnlToman === null || !Number.isFinite(economicNetPnlToman)) return null;
  if (!(sizeUsdt > 0) || !Number.isFinite(sizeUsdt)) return null;
  return economicNetPnlToman / sizeUsdt;
}

/**
 * Net return on committed buy notional: percent and basis points.
 * capital = buyNotionalToman (authoritative when present).
 * bps = percent × 100.
 */
export function netReturnOnCapital(
  economicNetPnlToman: number | null,
  buyNotionalToman: number | null | undefined
): { percent: number; bps: number } | null {
  if (economicNetPnlToman === null || !Number.isFinite(economicNetPnlToman)) return null;
  if (buyNotionalToman === null || buyNotionalToman === undefined || !(buyNotionalToman > 0)) {
    return null;
  }
  const percent = (economicNetPnlToman / buyNotionalToman) * 100;
  if (!Number.isFinite(percent)) return null;
  return { percent, bps: percent * 100 };
}

/** Per-trade profitability block for UI. */
export type TradeProfitabilityView = {
  sizeUsdt: number | null;
  grossProfit: { ok: true; money: MoneyTomanRial } | { ok: false; reasonFa: string };
  totalFees: { ok: true; money: MoneyTomanRial } | { ok: false; reasonFa: string };
  /** Primary profitability figure: economic net after both-side fees. */
  economicNet: { ok: true; money: MoneyTomanRial } | { ok: false; reasonFa: string };
  profitPerUsdt: { ok: true; money: MoneyTomanRial } | { ok: false; reasonFa: string };
  netReturn: { ok: true; percent: number; bps: number } | { ok: false; reasonFa: string };
};

export function buildTradeProfitability(trade: {
  sizeUsdt: number;
  grossSpreadToman: number | null;
  feeTomanTotal: number | null;
  feeUsdtMicrosTotal: number | null;
  sellFeeValueToman: number | null;
  economicNetPnlToman: number | null;
  buyNotionalToman?: number | null;
}): TradeProfitabilityView {
  const sizeUsdt = Number.isFinite(trade.sizeUsdt) ? trade.sizeUsdt : null;

  const gross =
    trade.grossSpreadToman !== null && Number.isFinite(trade.grossSpreadToman)
      ? ({ ok: true as const, money: asTomanRial(trade.grossSpreadToman) } as const)
      : ({
          ok: false as const,
          reasonFa: "سود ناخالص (grossSpreadToman) در دفتر ثبت نشده"
        } as const);

  const feesRaw = totalModeledFeeToman({
    feeTomanTotal: trade.feeTomanTotal,
    feeUsdtMicrosTotal: trade.feeUsdtMicrosTotal,
    sellFeeValueToman: trade.sellFeeValueToman
  });
  const totalFees =
    feesRaw.ok === true
      ? ({ ok: true as const, money: asTomanRial(feesRaw.toman) } as const)
      : ({ ok: false as const, reasonFa: feesRaw.reasonFa } as const);

  const economic =
    trade.economicNetPnlToman !== null && Number.isFinite(trade.economicNetPnlToman)
      ? ({ ok: true as const, money: asTomanRial(trade.economicNetPnlToman) } as const)
      : ({
          ok: false as const,
          reasonFa: "سود اقتصادی خالص (economicNetPnlToman) در دفتر ثبت نشده"
        } as const);

  const perUsdtRaw =
    economic.ok && sizeUsdt !== null
      ? netProfitPerUsdt(economic.money.toman, sizeUsdt)
      : null;
  const profitPerUsdt =
    perUsdtRaw !== null
      ? ({ ok: true as const, money: asTomanRial(perUsdtRaw) } as const)
      : ({
          ok: false as const,
          reasonFa:
            sizeUsdt === null || !(sizeUsdt > 0)
              ? "حجم معامله صفر یا نامعتبر است"
              : "سود اقتصادی یا حجم برای محاسبهٔ سود به‌ازای هر تتر کافی نیست"
        } as const);

  const ret = netReturnOnCapital(trade.economicNetPnlToman, trade.buyNotionalToman);
  const netReturn =
    ret !== null
      ? ({ ok: true as const, percent: ret.percent, bps: ret.bps } as const)
      : ({
          ok: false as const,
          reasonFa:
            "بازده خالص نیاز به economicNetPnlToman و buyNotionalToman مثبت دارد"
        } as const);

  return {
    sizeUsdt,
    grossProfit: gross,
    totalFees,
    economicNet: economic,
    profitPerUsdt,
    netReturn
  };
}

export type TradeSetSummaryInput = {
  sizeUsdt: number;
  grossSpreadToman: number | null;
  feeTomanTotal: number | null;
  feeUsdtMicrosTotal: number | null;
  sellFeeValueToman: number | null;
  economicNetPnlToman: number | null;
  buyNotionalToman?: number | null;
};

export type TradeSetSummary = {
  tradeCount: number;
  volumeUsdt: number;
  grossProfit: { ok: true; money: MoneyTomanRial } | { ok: false; reasonFa: string };
  totalFees: { ok: true; money: MoneyTomanRial } | { ok: false; reasonFa: string };
  economicNet: { ok: true; money: MoneyTomanRial } | { ok: false; reasonFa: string };
  profitPerUsdt: { ok: true; money: MoneyTomanRial } | { ok: false; reasonFa: string };
  netReturn: { ok: true; percent: number; bps: number } | { ok: false; reasonFa: string };
  profitableCount: number;
  losingCount: number;
  zeroCount: number;
};

/**
 * Aggregate a set of closed trades (e.g. current filter). Volume uses sizeUsdt once.
 * If any trade lacks a required component for a total, that total is marked uncomputable.
 */
export function summarizeTradeSet(trades: TradeSetSummaryInput[]): TradeSetSummary {
  let volumeUsdt = 0;
  let grossSum = 0;
  let grossOk = true;
  let feeSum = 0;
  let feeOk = true;
  let netSum = 0;
  let netOk = true;
  let capitalSum = 0;
  let capitalOk = true;
  let profitableCount = 0;
  let losingCount = 0;
  let zeroCount = 0;

  for (const t of trades) {
    const size = Number.isFinite(t.sizeUsdt) ? t.sizeUsdt : 0;
    volumeUsdt += size > 0 ? size : 0;

    if (t.grossSpreadToman === null || !Number.isFinite(t.grossSpreadToman)) {
      grossOk = false;
    } else {
      grossSum += t.grossSpreadToman;
    }

    const fees = totalModeledFeeToman({
      feeTomanTotal: t.feeTomanTotal,
      feeUsdtMicrosTotal: t.feeUsdtMicrosTotal,
      sellFeeValueToman: t.sellFeeValueToman
    });
    if (!fees.ok) feeOk = false;
    else feeSum += fees.toman;

    if (t.economicNetPnlToman === null || !Number.isFinite(t.economicNetPnlToman)) {
      netOk = false;
    } else {
      netSum += t.economicNetPnlToman;
      if (t.economicNetPnlToman > 0) profitableCount += 1;
      else if (t.economicNetPnlToman < 0) losingCount += 1;
      else zeroCount += 1;
    }

    if (t.buyNotionalToman === null || t.buyNotionalToman === undefined || !(t.buyNotionalToman > 0)) {
      capitalOk = false;
    } else {
      capitalSum += t.buyNotionalToman;
    }
  }

  const grossProfit = grossOk
    ? ({ ok: true as const, money: asTomanRial(grossSum) } as const)
    : ({
        ok: false as const,
        reasonFa: "حداقل یک معامله grossSpreadToman ندارد — جمع ناخالص قابل اعتماد نیست"
      } as const);

  const totalFees = feeOk
    ? ({ ok: true as const, money: asTomanRial(feeSum) } as const)
    : ({
        ok: false as const,
        reasonFa: `${UNCOMPUTABLE_FA} — حداقل یک معامله کارمزد USDT بدون معادل تومانی اجرا دارد`
      } as const);

  const economicNet = netOk
    ? ({ ok: true as const, money: asTomanRial(netSum) } as const)
    : ({
        ok: false as const,
        reasonFa: "حداقل یک معامله economicNetPnlToman ندارد — جمع خالص اقتصادی کامل نیست"
      } as const);

  const perUsdt =
    netOk && volumeUsdt > 0
      ? ({ ok: true as const, money: asTomanRial(netSum / volumeUsdt) } as const)
      : ({
          ok: false as const,
          reasonFa:
            volumeUsdt <= 0
              ? "حجم کل صفر است"
              : "سود خالص کل یا حجم برای سود به‌ازای هر تتر کافی نیست"
        } as const);

  const netReturn =
    netOk && capitalOk && capitalSum > 0
      ? (() => {
          const percent = (netSum / capitalSum) * 100;
          return {
            ok: true as const,
            percent,
            bps: percent * 100
          };
        })()
      : ({
          ok: false as const,
          reasonFa: "بازده کل نیاز به جمع buyNotional و economicNet کامل دارد"
        } as const);

  return {
    tradeCount: trades.length,
    volumeUsdt,
    grossProfit,
    totalFees,
    economicNet,
    profitPerUsdt: perUsdt,
    netReturn,
    profitableCount,
    losingCount,
    zeroCount
  };
}

/**
 * Whether the loaded closed-trade array can represent the full experiment.
 * API historically caps FILLED ledger at 2000 rows in the paper snapshot.
 */
export function experimentTotalsCoverage(input: {
  loadedFilledCount: number;
  /** Server-side filled count when available (stats.filled or countPaperLedger). */
  serverFilledCount: number | null;
}): {
  complete: boolean;
  gapFa: string | null;
  loadedFilledCount: number;
  serverFilledCount: number | null;
} {
  if (input.serverFilledCount === null || !Number.isFinite(input.serverFilledCount)) {
    return {
      complete: false,
      loadedFilledCount: input.loadedFilledCount,
      serverFilledCount: null,
      gapFa:
        "تعداد کل معاملات تکمیل‌شدهٔ آزمایش در API جداگانه در دسترس نیست — جمع کل آزمایش به‌صورت امن قابل اعلام نیست (آرایهٔ trades ممکن است محدود باشد)."
    };
  }
  if (input.loadedFilledCount < input.serverFilledCount) {
    return {
      complete: false,
      loadedFilledCount: input.loadedFilledCount,
      serverFilledCount: input.serverFilledCount,
      gapFa: `فقط ${input.loadedFilledCount} از ${input.serverFilledCount} معاملهٔ FILLED در پاسخ بارگذاری شده — جمع جزئی به‌عنوان «کل آزمایش» نمایش داده نمی‌شود.`
    };
  }
  return {
    complete: true,
    loadedFilledCount: input.loadedFilledCount,
    serverFilledCount: input.serverFilledCount,
    gapFa: null
  };
}
