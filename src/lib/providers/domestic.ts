import { fetchJson, numeric } from "@/lib/http";
import type { DeskSettings, DomesticQuote, SourceStatus } from "@/lib/types";

type Provider = {
  id: string;
  name: string;
  fetchQuote: () => Promise<DomesticQuote>;
};

const nowIso = () => new Date().toISOString();

function unavailable(exchangeId: string, exchangeName: string, message: string): DomesticQuote {
  return {
    exchangeId,
    exchangeName,
    buyPrice: null,
    sellPrice: null,
    midPrice: null,
    volume: null,
    spread: null,
    spreadPercent: null,
    deviationFromMedianPercent: null,
    sourceStatus: "unavailable",
    lastUpdated: null,
    errorMessage: message,
    isOutlier: false,
    excludedFromMedian: false
  };
}

function buildQuote(
  exchangeId: string,
  exchangeName: string,
  buyPrice: number | null,
  sellPrice: number | null,
  options?: {
    midPrice?: number | null;
    volume?: number | null;
    status?: SourceStatus;
    errorMessage?: string;
    lastUpdated?: string | null;
  }
): DomesticQuote {
  const midPrice =
    options?.midPrice ??
    (buyPrice !== null && sellPrice !== null ? (buyPrice + sellPrice) / 2 : buyPrice ?? sellPrice ?? null);
  const spread = buyPrice !== null && sellPrice !== null ? Math.abs(sellPrice - buyPrice) : null;
  const spreadPercent = spread !== null && midPrice ? (spread / midPrice) * 100 : null;

  return {
    exchangeId,
    exchangeName,
    buyPrice,
    sellPrice,
    midPrice,
    volume: options?.volume ?? null,
    spread,
    spreadPercent,
    deviationFromMedianPercent: null,
    sourceStatus: options?.status ?? "available",
    lastUpdated: options?.lastUpdated ?? nowIso(),
    errorMessage: options?.errorMessage,
    isOutlier: false,
    excludedFromMedian: false
  };
}

function toToman(value: unknown, unit: "toman" | "rial" = "toman"): number | null {
  const parsed = numeric(value);
  if (parsed === null) {
    return null;
  }
  return unit === "rial" ? parsed / 10 : parsed;
}

async function nobitex(): Promise<DomesticQuote> {
  const id = "nobitex";
  const name = "نوبیتکس";
  try {
    const data = await fetchJson<{
      stats?: Record<string, { bestBuy?: string; bestSell?: string; latest?: string; volumeSrc?: string }>;
      status?: string;
    }>("https://api.nobitex.ir/market/stats?srcCurrency=usdt&dstCurrency=rls", 9_000);

    const stats = data.stats?.["usdt-rls"] ?? data.stats?.USDT_RLS;
    const buyPrice = toToman(stats?.bestBuy, "rial");
    const sellPrice = toToman(stats?.bestSell, "rial");
    if (buyPrice === null && sellPrice === null) {
      return unavailable(id, name, "داده قیمت تتر در پاسخ منبع پیدا نشد");
    }
    return buildQuote(id, name, buyPrice, sellPrice, { volume: numeric(stats?.volumeSrc) });
  } catch (error) {
    return unavailable(id, name, error instanceof Error ? error.message : "منبع در دسترس نیست");
  }
}

async function wallex(): Promise<DomesticQuote> {
  const id = "wallex";
  const name = "والکس";
  try {
    const data = await fetchJson<{
      result?: { symbols?: Record<string, { stats?: { bidPrice?: string; askPrice?: string } }> };
    }>("https://api.wallex.ir/v1/markets", 9_000);

    const stats = data.result?.symbols?.USDTTMN?.stats;
    const buyPrice = toToman(stats?.bidPrice);
    const sellPrice = toToman(stats?.askPrice);
    if (buyPrice === null && sellPrice === null) {
      return unavailable(id, name, "داده قیمت تتر در پاسخ منبع پیدا نشد");
    }
    return buildQuote(id, name, buyPrice, sellPrice);
  } catch (error) {
    return unavailable(id, name, error instanceof Error ? error.message : "منبع در دسترس نیست");
  }
}

async function bitpin(): Promise<DomesticQuote> {
  const id = "bitpin";
  const name = "بیت‌پین";
  try {
    const data = await fetchJson<Array<{ symbol?: string; price?: string; timestamp?: number }>>(
      "https://api.bitpin.org/api/v1/mkt/tickers/?symbol=USDT_IRT",
      9_000
    );
    const item = data.find((entry) => entry.symbol === "USDT_IRT");
    const midPrice = toToman(item?.price);
    if (midPrice === null) {
      return unavailable(id, name, "داده قیمت تتر در پاسخ منبع پیدا نشد");
    }
    return buildQuote(id, name, null, null, {
      midPrice,
      status: "degraded",
      lastUpdated: item?.timestamp ? new Date(item.timestamp * 1000).toISOString() : nowIso(),
      errorMessage: "API عمومی فقط آخرین قیمت را برگرداند؛ خرید و فروش دریافت نشد"
    });
  } catch (error) {
    return unavailable(id, name, error instanceof Error ? error.message : "منبع در دسترس نیست");
  }
}

async function tabdeal(): Promise<DomesticQuote> {
  const id = "tabdeal";
  const name = "تبدیل";
  try {
    const data = await fetchJson<{ asks?: Array<[string, string]>; bids?: Array<[string, string]> }>(
      "https://api1.tabdeal.org/r/api/v1/depth?symbol=USDTIRT&limit=1",
      9_000
    );
    const buyPrice = toToman(data.bids?.[0]?.[0]);
    const sellPrice = toToman(data.asks?.[0]?.[0]);
    if (buyPrice === null && sellPrice === null) {
      return unavailable(id, name, "داده دفتر سفارش تتر دریافت نشد");
    }
    return buildQuote(id, name, buyPrice, sellPrice);
  } catch (error) {
    return unavailable(id, name, error instanceof Error ? error.message : "منبع در دسترس نیست");
  }
}

async function ramzinex(): Promise<DomesticQuote> {
  const id = "ramzinex";
  const name = "رمزینکس";
  try {
    const data = await fetchJson<{
      data?: Array<{
        pair_id?: number;
        base_currency_symbol?: { en?: string };
        quote_currency_symbol?: { en?: string };
        buy?: number;
        sell?: number;
      }>;
    }>("https://publicapi.ramzinex.com/exchange/api/v1.0/exchange/pairs", 9_000);

    const item = data.data?.find(
      (entry) =>
        entry.pair_id === 11 ||
        (entry.base_currency_symbol?.en?.toLowerCase() === "usdt" &&
          entry.quote_currency_symbol?.en?.toLowerCase() === "irr")
    );
    const buyPrice = toToman(item?.buy, "rial");
    const sellPrice = toToman(item?.sell, "rial");
    if (buyPrice === null && sellPrice === null) {
      return unavailable(id, name, "داده قیمت تتر در پاسخ منبع پیدا نشد");
    }
    return buildQuote(id, name, buyPrice, sellPrice);
  } catch (error) {
    return unavailable(id, name, error instanceof Error ? error.message : "منبع در دسترس نیست");
  }
}

async function abanTether(): Promise<DomesticQuote> {
  const id = "abantether";
  const name = "آبان‌تتر";
  try {
    const data = await fetchJson<Record<string, unknown>>(
      "https://api.abantether.com/api/v1/otc/coin-price/?symbol=USDT",
      9_000
    );
    const buyPrice = toToman(data.buy ?? data.buyPrice ?? data.bid);
    const sellPrice = toToman(data.sell ?? data.sellPrice ?? data.ask);
    if (buyPrice === null && sellPrice === null) {
      return unavailable(id, name, "API عمومی سازگار برای قیمت تتر دریافت نشد");
    }
    return buildQuote(id, name, buyPrice, sellPrice);
  } catch (error) {
    return unavailable(id, name, error instanceof Error ? error.message : "منبع در دسترس نیست");
  }
}

async function ompFinex(): Promise<DomesticQuote> {
  const id = "ompfinex";
  const name = "OMPFinex";
  try {
    const data = await fetchJson<Record<string, unknown>>("https://api.ompfinex.com/v1/markets", 9_000);
    const markets = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : [];
    const item = markets.find((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const row = entry as Record<string, unknown>;
      const symbol = String(row.symbol ?? row.name ?? row.market ?? "").toLowerCase();
      return symbol.includes("usdt") && (symbol.includes("irt") || symbol.includes("tmn"));
    }) as Record<string, unknown> | undefined;

    const buyPrice = toToman(item?.buy ?? item?.bid ?? item?.highest_bid);
    const sellPrice = toToman(item?.sell ?? item?.ask ?? item?.lowest_ask);
    const midPrice = toToman(item?.last ?? item?.lastPrice ?? item?.price);
    if (buyPrice === null && sellPrice === null && midPrice === null) {
      return unavailable(id, name, "داده قیمت تتر در پاسخ منبع پیدا نشد");
    }
    return buildQuote(id, name, buyPrice, sellPrice, {
      midPrice,
      status: buyPrice === null || sellPrice === null ? "degraded" : "available",
      errorMessage: buyPrice === null || sellPrice === null ? "خرید و فروش کامل دریافت نشد" : undefined
    });
  } catch (error) {
    return unavailable(id, name, error instanceof Error ? error.message : "منبع در دسترس نیست");
  }
}

async function tetherland(): Promise<DomesticQuote> {
  const id = "tetherland";
  const name = "تترلند";
  try {
    const data = await fetchJson<{
      status?: number;
      data?: { currencies?: { USDT?: { buy_price?: number; sell_price?: number; price?: number } } };
    }>("https://api.tetherland.com/currencies", 9_000);

    const usdt = data.data?.currencies?.USDT;
    const buyPrice = toToman(usdt?.sell_price ?? usdt?.price);
    const sellPrice = toToman(usdt?.buy_price ?? usdt?.price);
    const midPrice = toToman(usdt?.price);
    if (buyPrice === null && sellPrice === null && midPrice === null) {
      return unavailable(id, name, "داده قیمت تتر در پاسخ منبع پیدا نشد");
    }
    const spreadMatches = buyPrice !== null && sellPrice !== null && buyPrice === sellPrice;
    return buildQuote(id, name, buyPrice, sellPrice, {
      midPrice,
      status: spreadMatches ? "degraded" : "available",
      errorMessage: spreadMatches ? "API عمومی خرید و فروش یکسان برگرداند" : undefined
    });
  } catch (error) {
    return unavailable(id, name, error instanceof Error ? error.message : "منبع در دسترس نیست");
  }
}

async function exir(): Promise<DomesticQuote> {
  const id = "exir";
  const name = "اکسیر";
  try {
    // Exir (HollaEx) public ticker — usdt-irt is quoted in Toman
    const data = await fetchJson<{ last?: number; close?: number }>(
      "https://api.exir.io/v1/ticker?symbol=usdt-irt",
      9_000
    );
    const midPrice = toToman(data.last ?? data.close);
    if (midPrice === null) {
      return unavailable(id, name, "داده قیمت تتر در پاسخ منبع پیدا نشد");
    }
    return buildQuote(id, name, null, null, {
      midPrice,
      status: "degraded",
      errorMessage: "API عمومی فقط قیمت آخر را می‌دهد؛ خرید و فروش دریافت نشد"
    });
  } catch (error) {
    return unavailable(id, name, error instanceof Error ? error.message : "منبع در دسترس نیست");
  }
}

const providers: Provider[] = [
  { id: "nobitex", name: "نوبیتکس", fetchQuote: nobitex },
  { id: "wallex", name: "والکس", fetchQuote: wallex },
  { id: "bitpin", name: "بیت‌پین", fetchQuote: bitpin },
  { id: "tabdeal", name: "تبدیل", fetchQuote: tabdeal },
  { id: "ramzinex", name: "رمزینکس", fetchQuote: ramzinex },
  { id: "abantether", name: "آبان‌تتر", fetchQuote: abanTether },
  { id: "ompfinex", name: "OMPFinex", fetchQuote: ompFinex },
  { id: "exir", name: "اکسیر", fetchQuote: exir },
  { id: "tetherland", name: "تترلند", fetchQuote: tetherland }
];

export async function getDomesticQuotes(settings: DeskSettings): Promise<DomesticQuote[]> {
  return Promise.all(
    providers.map(async (provider) => {
      if (settings.enabledSources[provider.id] === false) {
        return unavailable(provider.id, provider.name, "این منبع در تنظیمات غیرفعال است");
      }
      return provider.fetchQuote();
    })
  );
}
