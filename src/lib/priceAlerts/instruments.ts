import type {
  DomesticQuote,
  FxStreetQuote,
  GlobalPrice,
  GoldMarketQuote,
  PriceAlertInstrumentId,
  PriceAlertInstrumentSnapshot,
  PriceAlertPriceType,
  PriceAlertProviderOption,
  SourceStatus
} from "@/lib/types";

export const PRICE_ALERT_INSTRUMENTS: Array<{
  id: PriceAlertInstrumentId;
  label: string;
  unit: "toman" | "usd";
  unitLabel: string;
}> = [
  { id: "usdt_irt", label: "تتر", unit: "toman", unitLabel: "تومان" },
  { id: "xau_usd", label: "اونس طلا", unit: "usd", unitLabel: "دلار" },
  { id: "coin_emami", label: "سکه امامی", unit: "toman", unitLabel: "تومان" },
  { id: "gold_18", label: "طلای ۱۸ عیار", unit: "toman", unitLabel: "تومان" },
  { id: "aed", label: "درهم امارات", unit: "toman", unitLabel: "تومان" },
  { id: "btc_usdt", label: "بیت‌کوین", unit: "usd", unitLabel: "USDT" },
  { id: "eth_usdt", label: "اتریوم", unit: "usd", unitLabel: "USDT" }
];

export function instrumentMeta(id: PriceAlertInstrumentId) {
  return PRICE_ALERT_INSTRUMENTS.find((item) => item.id === id)!;
}

export function priceTypeLabel(type: PriceAlertPriceType): string {
  if (type === "buy") return "خرید";
  if (type === "sell") return "فروش";
  if (type === "mid") return "قیمت وسط";
  return "قیمت مرجع";
}

export function conditionLabel(condition: string): string {
  if (condition === "gte") return "قیمت به هدف برسد یا بالاتر برود";
  if (condition === "lte") return "قیمت به هدف برسد یا پایین‌تر بیاید";
  if (condition === "cross_up") return "عبور صعودی از قیمت هدف";
  if (condition === "cross_down") return "عبور نزولی از قیمت هدف";
  return condition;
}

export function statusLabelFa(status: string): string {
  if (status === "active") return "فعال";
  if (status === "degraded") return "منبع ناقص";
  if (status === "disconnected") return "منبع قطع";
  if (status === "triggered") return "فعال‌شده";
  if (status === "disabled") return "غیرفعال";
  return status;
}

function pickPrice(
  buy: number | null | undefined,
  sell: number | null | undefined,
  mid: number | null | undefined,
  priceType: PriceAlertPriceType
): number | null {
  if (priceType === "buy") return buy != null && Number.isFinite(buy) && buy > 0 ? buy : null;
  if (priceType === "sell") return sell != null && Number.isFinite(sell) && sell > 0 ? sell : null;
  const m = mid != null && Number.isFinite(mid) && mid > 0 ? mid : null;
  if (priceType === "mid" || priceType === "reference") {
    if (m !== null) return m;
    if (buy != null && sell != null && buy > 0 && sell > 0) return (buy + sell) / 2;
    if (buy != null && buy > 0) return buy;
    if (sell != null && sell > 0) return sell;
  }
  return null;
}

function supportedTypes(buy: number | null, sell: number | null, mid: number | null): PriceAlertPriceType[] {
  const types: PriceAlertPriceType[] = [];
  if (buy != null && buy > 0) types.push("buy");
  if (sell != null && sell > 0) types.push("sell");
  if (mid != null && mid > 0) {
    types.push("mid");
    // Reference-only when buy/sell missing
    if ((buy == null || buy <= 0) && (sell == null || sell <= 0)) {
      if (!types.includes("reference")) types.push("reference");
    }
  } else if ((buy == null || buy <= 0) && (sell == null || sell <= 0)) {
    // nothing
  } else {
    // has buy/sell without explicit mid — mid is computable
    types.push("mid");
  }
  // Always allow reference when mid or any price exists
  if ((mid != null && mid > 0) || (buy != null && buy > 0) || (sell != null && sell > 0)) {
    if (!types.includes("reference") && types.includes("mid") === false && (buy == null || sell == null)) {
      types.push("reference");
    } else if (!types.includes("reference") && (buy == null || buy <= 0) && (sell == null || sell <= 0) && mid != null) {
      types.push("reference");
    }
  }
  // Clean: if only mid (no buy/sell), expose mid + reference only
  if ((buy == null || buy <= 0) && (sell == null || sell <= 0) && mid != null && mid > 0) {
    return ["mid", "reference"];
  }
  if (!types.includes("reference") && types.length) types.push("reference");
  return Array.from(new Set(types));
}

const STALE_MS = 15 * 60_000;

function isFresh(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= STALE_MS;
}

export type LivePriceBundle = {
  domestic: DomesticQuote[];
  gold: GoldMarketQuote[];
  fx: FxStreetQuote[];
  global: GlobalPrice[];
};

export type ObservedQuote = {
  providerId: string;
  providerName: string;
  price: number;
  priceType: PriceAlertPriceType;
  status: SourceStatus;
  lastUpdated: string | null;
  stale: boolean;
};

function domesticProviders(quotes: DomesticQuote[]): PriceAlertProviderOption[] {
  return quotes.map((q) => {
    const buy = q.buyPrice;
    const sell = q.sellPrice;
    const mid = q.midPrice;
    return {
      id: q.exchangeId,
      name: q.exchangeName,
      supportedPriceTypes: supportedTypes(buy, sell, mid),
      status: q.sourceStatus,
      buy,
      sell,
      mid,
      lastUpdated: q.lastUpdated
    };
  });
}

function goldProviders(quotes: GoldMarketQuote[], instrument: GoldMarketQuote["instrument"]): PriceAlertProviderOption[] {
  return quotes
    .filter((q) => q.instrument === instrument)
    .map((q) => ({
      id: q.sourceId,
      name: q.sourceName,
      supportedPriceTypes: supportedTypes(q.buyPrice, q.sellPrice, q.midPrice),
      status: q.status,
      buy: q.buyPrice,
      sell: q.sellPrice,
      mid: q.midPrice,
      lastUpdated: q.lastUpdated
    }));
}

function fxProviders(quotes: FxStreetQuote[], asset: FxStreetQuote["assetType"]): PriceAlertProviderOption[] {
  return quotes
    .filter((q) => q.assetType === asset)
    .map((q) => ({
      id: q.sourceId,
      name: q.sourceName,
      supportedPriceTypes: supportedTypes(q.buyPrice, q.sellPrice, q.midPrice),
      status: q.status,
      buy: q.buyPrice,
      sell: q.sellPrice,
      mid: q.midPrice,
      lastUpdated: q.lastUpdated
    }));
}

function globalProvider(prices: GlobalPrice[], symbol: GlobalPrice["symbol"]): PriceAlertProviderOption[] {
  const row = prices.find((p) => p.symbol === symbol);
  if (!row) return [];
  const mid = row.price;
  return [
    {
      id: row.source.toLowerCase().replace(/\s+/g, "_") || "global",
      name: row.source,
      supportedPriceTypes: mid != null && mid > 0 ? (["mid", "reference"] as PriceAlertPriceType[]) : [],
      status: row.sourceStatus,
      buy: null,
      sell: null,
      mid,
      lastUpdated: row.lastUpdated
    }
  ];
}

export function providersForInstrument(
  instrument: PriceAlertInstrumentId,
  live: LivePriceBundle
): PriceAlertProviderOption[] {
  if (instrument === "usdt_irt") return domesticProviders(live.domestic);
  if (instrument === "xau_usd") return goldProviders(live.gold, "اونس طلا به دلار");
  if (instrument === "coin_emami") return goldProviders(live.gold, "سکه طرح امامی");
  if (instrument === "gold_18") return goldProviders(live.gold, "یک گرم طلای 18 عیار");
  if (instrument === "aed") return fxProviders(live.fx, "درهم امارات");
  if (instrument === "btc_usdt") return globalProvider(live.global, "BTC/USDT");
  if (instrument === "eth_usdt") return globalProvider(live.global, "ETH/USDT");
  return [];
}

export function resolveObservedQuotes(
  instrument: PriceAlertInstrumentId,
  priceType: PriceAlertPriceType,
  providerMode: "any" | "specific",
  providerId: string | null,
  live: LivePriceBundle
): ObservedQuote[] {
  const providers = providersForInstrument(instrument, live);
  const selected =
    providerMode === "specific" && providerId
      ? providers.filter((p) => p.id === providerId)
      : providers.filter((p) => p.status !== "unavailable");

  const out: ObservedQuote[] = [];
  for (const p of selected) {
    if (!p.supportedPriceTypes.includes(priceType) && priceType !== "reference") continue;
    const price = pickPrice(p.buy, p.sell, p.mid, priceType);
    if (price === null) continue;
    const stale = !isFresh(p.lastUpdated) || p.status === "unavailable";
    if (p.status === "unavailable") continue;
    if (stale && providerMode === "any") continue; // any-source: skip stale
    if (stale && providerMode === "specific") {
      // include but mark stale so engine can refuse trigger
      out.push({
        providerId: p.id,
        providerName: p.name,
        price,
        priceType,
        status: p.status,
        lastUpdated: p.lastUpdated,
        stale: true
      });
      continue;
    }
    out.push({
      providerId: p.id,
      providerName: p.name,
      price,
      priceType,
      status: p.status,
      lastUpdated: p.lastUpdated,
      stale: false
    });
  }
  return out;
}

export function buildInstrumentSnapshots(live: LivePriceBundle): PriceAlertInstrumentSnapshot[] {
  return PRICE_ALERT_INSTRUMENTS.map((meta) => {
    const providers = providersForInstrument(meta.id, live);
    const healthy = providers.filter((p) => p.status === "available" && isFresh(p.lastUpdated));
    const preferredType: PriceAlertPriceType =
      healthy.find((p) => p.supportedPriceTypes.includes("mid"))?.supportedPriceTypes.includes("mid")
        ? "mid"
        : healthy[0]?.supportedPriceTypes[0] ?? "reference";

    let bestPrice: number | null = null;
    let bestUpdated: string | null = null;
    let bestType: PriceAlertPriceType | null = null;
    for (const p of healthy) {
      const price = pickPrice(p.buy, p.sell, p.mid, preferredType);
      if (price === null) continue;
      if (bestPrice === null || (meta.unit === "toman" ? price < bestPrice : true)) {
        // show a representative price: median-ish first healthy mid
        if (bestPrice === null) {
          bestPrice = price;
          bestUpdated = p.lastUpdated;
          bestType = preferredType;
        }
      }
    }
    if (bestPrice === null) {
      for (const p of providers) {
        const price = pickPrice(p.buy, p.sell, p.mid, "mid") ?? pickPrice(p.buy, p.sell, p.mid, "reference");
        if (price != null) {
          bestPrice = price;
          bestUpdated = p.lastUpdated;
          bestType = "mid";
          break;
        }
      }
    }

    let health: SourceStatus = "unavailable";
    if (healthy.length) health = "available";
    else if (providers.some((p) => p.status === "degraded" || p.status === "available")) health = "degraded";

    return {
      id: meta.id,
      label: meta.label,
      unit: meta.unit,
      unitLabel: meta.unitLabel,
      price: bestPrice,
      priceType: bestType,
      lastUpdated: bestUpdated,
      sourceCount: providers.filter((p) => p.buy != null || p.sell != null || p.mid != null).length,
      health,
      providers
    };
  });
}

export function isValidTargetPrice(instrument: PriceAlertInstrumentId, value: number): boolean {
  if (!Number.isFinite(value) || value <= 0) return false;
  const meta = instrumentMeta(instrument);
  if (meta.unit === "toman") {
    // reject absurd toman values
    if (value > 1e12) return false;
  } else {
    if (value > 1e9) return false;
  }
  return true;
}
