/**
 * Read-only per-venue fee attribution for a completed Paper trade.
 * Uses only persisted execution-time ledger fields. Never revalues USDT fees
 * with the current market price.
 */
import { TOMAN_TO_RIAL, tomanToRial, type MoneyTomanRial, asTomanRial } from "@/lib/shadowArbitrage/paper/tradeProfitability";

export const MISSING_FEE_FA = "ثبت نشده" as const;
export const UNSPLIT_FEE_FA = "تفکیک کارمزد هر صرافی ثبت نشده است" as const;
export const UNCOMPUTABLE_RATE_FA =
  "نرخ تبدیل تاریخی کارمزد USDT از شواهد اجرا قابل بازیابی نیست" as const;

export type FeeSideAttribution = {
  venueId: string | null;
  side: "buy" | "sell";
  sideFa: string;
  /** Original fee amount in native units when known. */
  amountNative: number | null;
  currency: "IRT" | "USDT" | null;
  /** Fee rate in bps when persisted. */
  feeBps: number | null;
  /** Historical mark used to value USDT fees (toman per USDT), if recoverable. */
  conversionRateTomanPerUsdt: number | null;
  equivalentToman: number | null;
  equivalentRial: number | null;
  missingReasonFa: string | null;
};

export type FeeAttributionView = {
  buy: FeeSideAttribution;
  sell: FeeSideAttribution;
  total: {
    ok: boolean;
    money: MoneyTomanRial | null;
    compactFa: string;
    reasonFa: string | null;
  };
  /** Gross − feeToman − sellFeeValueToman − other? = economic when all present. */
  reconciliation: {
    ok: boolean;
    grossToman: number | null;
    feeIrtToman: number | null;
    feeUsdtAsToman: number | null;
    impliedNetToman: number | null;
    economicNetToman: number | null;
    matches: boolean | null;
    noteFa: string;
  };
  /** When only combined fees exist without per-venue split. */
  unsplitNoteFa: string | null;
};

export type FeeAttributionInput = {
  buySourceId: string;
  sellSourceId: string;
  sizeUsdt: number;
  buyNotionalToman: number | null;
  sellNotionalToman: number | null;
  buyFeeBps: number | null;
  sellFeeBps: number | null;
  buyFeeAsset: string | null;
  sellFeeAsset: string | null;
  feeTomanTotal: number | null;
  feeUsdtMicrosTotal: number | null;
  sellFeeValueToman: number | null;
  grossSpreadToman: number | null;
  economicNetPnlToman: number | null;
  markPriceToman: number | null;
  slippageBufferToman: number | null;
};

function normAsset(a: string | null | undefined): "IRT" | "USDT" | null {
  if (!a) return null;
  const u = a.toUpperCase();
  if (u === "IRT" || u === "TOMAN" || u === "TMN") return "IRT";
  if (u === "USDT" || u === "USD") return "USDT";
  return null;
}

/**
 * Recover historical USDT→toman rate from persisted sellFeeValueToman / micros.
 * Never uses live market.
 */
export function historicalUsdtRateFromFee(
  sellFeeValueToman: number | null,
  feeUsdtMicrosTotal: number | null
): number | null {
  if (sellFeeValueToman === null || feeUsdtMicrosTotal === null) return null;
  if (!(feeUsdtMicrosTotal > 0) || !Number.isFinite(sellFeeValueToman)) return null;
  const usdt = feeUsdtMicrosTotal / 1_000_000;
  if (!(usdt > 0)) return null;
  const rate = sellFeeValueToman / usdt;
  return Number.isFinite(rate) ? rate : null;
}

export function buildFeeAttribution(input: FeeAttributionInput): FeeAttributionView {
  const buyAsset = normAsset(input.buyFeeAsset);
  const sellAsset = normAsset(input.sellFeeAsset);
  const usdtMicros = input.feeUsdtMicrosTotal;
  const usdtAmt = usdtMicros !== null && usdtMicros > 0 ? usdtMicros / 1_000_000 : null;
  const histRate = historicalUsdtRateFromFee(input.sellFeeValueToman, usdtMicros);

  // Buy side: typically IRT fee = feeTomanTotal when buyFeeAsset is IRT
  const buy: FeeSideAttribution = {
    venueId: input.buySourceId,
    side: "buy",
    sideFa: "خرید",
    amountNative: null,
    currency: buyAsset,
    feeBps: input.buyFeeBps,
    conversionRateTomanPerUsdt: null,
    equivalentToman: null,
    equivalentRial: null,
    missingReasonFa: null
  };

  if (buyAsset === "IRT" || (buyAsset === null && input.feeTomanTotal !== null && usdtAmt === null)) {
    // Prefer feeTomanTotal as buy IRT fee when asset is IRT or only IRT fees exist
    if (input.feeTomanTotal !== null) {
      buy.amountNative = input.feeTomanTotal;
      buy.currency = "IRT";
      buy.equivalentToman = input.feeTomanTotal;
      buy.equivalentRial = tomanToRial(input.feeTomanTotal);
    } else if (input.buyFeeBps !== null && input.buyNotionalToman !== null) {
      // Do not invent fee amount from bps — amount must be persisted
      buy.missingReasonFa = "مبلغ کارمزد خرید در دفتر ثبت نشده (فقط bps موجود است)";
    } else {
      buy.missingReasonFa = MISSING_FEE_FA;
    }
  } else if (buyAsset === "USDT") {
    buy.missingReasonFa =
      "کارمزد خرید به‌صورت USDT ادعا شده ولی مبلغ/معادل جدا در دفتر ثبت نشده";
  } else if (input.feeTomanTotal === null && input.buyFeeBps === null) {
    buy.amountNative = 0;
    buy.currency = "IRT";
    buy.equivalentToman = 0;
    buy.equivalentRial = 0;
    buy.missingReasonFa = null;
  } else if (input.feeTomanTotal !== null && buyAsset === null) {
    // Combined IRT total without asset label — attribute to buy venue as IRT with note
    buy.amountNative = input.feeTomanTotal;
    buy.currency = "IRT";
    buy.equivalentToman = input.feeTomanTotal;
    buy.equivalentRial = tomanToRial(input.feeTomanTotal);
  } else {
    buy.missingReasonFa = MISSING_FEE_FA;
  }

  const sell: FeeSideAttribution = {
    venueId: input.sellSourceId,
    side: "sell",
    sideFa: "فروش",
    amountNative: null,
    currency: sellAsset,
    feeBps: input.sellFeeBps,
    conversionRateTomanPerUsdt: histRate,
    equivalentToman: null,
    equivalentRial: null,
    missingReasonFa: null
  };

  if (sellAsset === "USDT" || (usdtAmt !== null && sellAsset !== "IRT")) {
    if (usdtAmt !== null) {
      sell.amountNative = usdtAmt;
      sell.currency = "USDT";
      if (input.sellFeeValueToman !== null) {
        sell.equivalentToman = input.sellFeeValueToman;
        sell.equivalentRial = tomanToRial(input.sellFeeValueToman);
        sell.conversionRateTomanPerUsdt = histRate;
      } else {
        sell.equivalentToman = null;
        sell.equivalentRial = null;
        sell.missingReasonFa = UNCOMPUTABLE_RATE_FA;
      }
    } else if (input.sellFeeBps !== null) {
      sell.missingReasonFa = "مبلغ کارمزد فروش USDT در دفتر ثبت نشده (فقط bps موجود است)";
    } else {
      sell.missingReasonFa = MISSING_FEE_FA;
    }
  } else if (sellAsset === "IRT") {
    sell.missingReasonFa = "کارمزد فروش IRT جدا از feeTomanTotal در دفتر ثبت نشده";
  } else if (usdtAmt === null && input.sellFeeValueToman === null) {
    sell.amountNative = 0;
    sell.currency = "USDT";
    sell.equivalentToman = 0;
    sell.equivalentRial = 0;
  } else {
    sell.missingReasonFa = MISSING_FEE_FA;
  }

  // Total
  let totalOk = true;
  let totalToman = 0;
  let totalReason: string | null = null;
  const parts: string[] = [];

  if (buy.equivalentToman !== null) {
    totalToman += buy.equivalentToman;
    if (buy.currency === "IRT" && buy.amountNative !== null) {
      parts.push(`${buy.amountNative.toLocaleString("en-US")} IRT`);
    }
  } else if (buy.missingReasonFa && buy.amountNative !== 0) {
    totalOk = false;
    totalReason = buy.missingReasonFa;
  }

  if (sell.equivalentToman !== null) {
    totalToman += sell.equivalentToman;
    if (sell.currency === "USDT" && sell.amountNative !== null) {
      parts.push(`${sell.amountNative.toFixed(4)} USDT`);
    }
  } else if (sell.missingReasonFa && !(usdtAmt === null || usdtAmt === 0)) {
    totalOk = false;
    totalReason = sell.missingReasonFa;
  }

  const money = totalOk ? asTomanRial(totalToman) : null;
  const compactFa = totalOk
    ? parts.length
      ? `${parts.join(" · ")} · معادل ${Math.round(totalToman).toLocaleString("en-US")} تومان / ${Math.round(totalToman * TOMAN_TO_RIAL).toLocaleString("en-US")} ریال`
      : `۰ · معادل ۰ تومان / ۰ ریال`
    : totalReason ?? UNCOMPUTABLE_RATE_FA;

  // Unsplit: we have fee totals but no venue assets
  let unsplit: string | null = null;
  if (
    (input.feeTomanTotal !== null || usdtAmt !== null) &&
    !input.buyFeeAsset &&
    !input.sellFeeAsset
  ) {
    unsplit = UNSPLIT_FEE_FA;
  }

  // Reconciliation: gross − feeIrt − feeUsdtToman (− slippage if treated as cost?)
  // User: Gross − toman fee − historical toman equivalent of USDT fee − other recorded costs = net economic
  // Use slippageBuffer as "other recorded cost" only when both gross and economic present and residual matches
  const gross = input.grossSpreadToman;
  const feeIrt = input.feeTomanTotal;
  const feeUsdtT = input.sellFeeValueToman;
  const economic = input.economicNetPnlToman;
  let matches: boolean | null = null;
  let implied: number | null = null;
  let note =
    "سود ناخالص − کارمزد تومانی − معادل تومانی کارمزد USDT (نرخ اجرا) = سود اقتصادی خالص (وقتی همه فیلدها ثبت شده باشند).";
  if (gross !== null && feeIrt !== null && feeUsdtT !== null && economic !== null) {
    implied = gross - feeIrt - feeUsdtT;
    // slippage may be inside economic model as buffer already deducted from risk-adjusted;
    // economic net typically already nets fees; check equality with small tolerance
    matches = Math.abs(implied - economic) <= 1;
    if (!matches && input.slippageBufferToman !== null) {
      const withSlip = implied - input.slippageBufferToman;
      if (Math.abs(withSlip - economic) <= 1) {
        matches = true;
        implied = withSlip;
        note =
          "تطبیق با احتساب بافر لغزش ثبت‌شده: ناخالص − کارمزد IRT − کارمزد USDT(معادل) − slippageBuffer.";
      }
    }
  } else {
    note = "برای تطبیق کامل، grossSpreadToman، feeTomanTotal، sellFeeValueToman و economicNetPnlToman لازم است.";
  }

  return {
    buy,
    sell,
    total: {
      ok: totalOk,
      money,
      compactFa,
      reasonFa: totalReason
    },
    reconciliation: {
      ok: gross !== null && economic !== null,
      grossToman: gross,
      feeIrtToman: feeIrt,
      feeUsdtAsToman: feeUsdtT,
      impliedNetToman: implied,
      economicNetToman: economic,
      matches,
      noteFa: note
    },
    unsplitNoteFa: unsplit
  };
}
