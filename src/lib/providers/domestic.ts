import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BROWSER_UA, fetchJson, numeric, ProviderError } from "@/lib/http";
import { createProviderCache, ttlFromMinutes } from "@/lib/providerCache";
import type { DeskSettings, DomesticQuote, SourceStatus } from "@/lib/types";

const dataDir = path.join(process.cwd(), ".data");
const ompCachePath = path.join(dataDir, "ompfinex-cache.json");

const OMP_USDT_MARKET_ID = 9;
const OMP_MIN_FETCH_MS = 5 * 60_000;
const OMP_STALE_TTL_MS = 30 * 60_000;
const OMP_RATE_LIMIT_BACKOFF_MS = 10 * 60_000;

const ABAN_CACHE_PATH = path.join(dataDir, "abantether-cache.json");
const ABAN_MIN_FETCH_MS = 2.5 * 60 * 1000;
const ABAN_STALE_TTL_MS = 10 * 60 * 1000;
const ABAN_RATE_LIMIT_BACKOFF_MS = 60 * 1000;

const DESK_UA = "TraderBot/OTCDesk";

type OmpCacheEntry = {
  quote: DomesticQuote;
  fetchedAt: number;
  rateLimitedUntil?: number;
};

let ompMemCache: OmpCacheEntry | null = null;

type AbanCacheEntry = {
  quote: DomesticQuote;
  fetchedAt: number;
  rateLimitedUntil?: number;
};

let abanMemCache: AbanCacheEntry | null = null;

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
    }>("https://apiv2.nobitex.ir/market/stats?srcCurrency=usdt&dstCurrency=rls", 12_000, {
      headers: { "user-agent": DESK_UA }
    });

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

// Bitpin ticker only exposes last price — use official public order book for bid/ask.
// Endpoint (verified live): GET https://api.bitpin.ir/api/v1/mth/orderbook/USDT_IRT/
// Response: { bids: [[price, amount], ...], asks: [[price, amount], ...] }
// bids[0] = highest bid, asks[0] = lowest ask; prices are already in Toman (IRT).
const BITPIN_ORDERBOOK_URL = "https://api.bitpin.ir/api/v1/mth/orderbook/USDT_IRT/";
const BITPIN_ORDERBOOK_URL_FALLBACK = "https://api.bitpin.org/api/v1/mth/orderbook/USDT_IRT/";
const BITPIN_MIN_FETCH_MS = 2.5 * 60 * 1000;
const BITPIN_STALE_TTL_MS = 10 * 60 * 1000;
type BitpinCacheEntry = { quote: DomesticQuote; fetchedAt: number };
let bitpinMemCache: BitpinCacheEntry | null = null;

async function fetchBitpinOrderbook(): Promise<{ bids: Array<[string | number, string | number]>; asks: Array<[string | number, string | number]> }> {
  try {
    return await fetchJson(BITPIN_ORDERBOOK_URL, 8_000, {
      headers: { "user-agent": BROWSER_UA, accept: "application/json" }
    });
  } catch {
    return await fetchJson(BITPIN_ORDERBOOK_URL_FALLBACK, 8_000, {
      headers: { "user-agent": BROWSER_UA, accept: "application/json" }
    });
  }
}

async function bitpin(): Promise<DomesticQuote> {
  const id = "bitpin";
  const name = "بیت‌پین";
  const now = Date.now();

  if (bitpinMemCache && now - bitpinMemCache.fetchedAt < BITPIN_MIN_FETCH_MS) {
    if (bitpinMemCache.quote.buyPrice !== null || bitpinMemCache.quote.sellPrice !== null) {
      return bitpinMemCache.quote;
    }
  }

  try {
    const data = await fetchBitpinOrderbook();
    const bids = data.bids ?? [];
    const asks = data.asks ?? [];
    // highest bid / lowest ask (arrays are best-first on Bitpin public book)
    const buyPrice = toToman(bids[0]?.[0]);
    const sellPrice = toToman(asks[0]?.[0]);
    if (buyPrice === null || sellPrice === null) {
      throw new ProviderError("دفتر سفارش بیت‌پین خرید/فروش معتبر ندارد");
    }
    const quote = buildQuote(id, name, buyPrice, sellPrice);
    bitpinMemCache = { quote, fetchedAt: now };
    return quote;
  } catch (error) {
    if (
      bitpinMemCache &&
      now - bitpinMemCache.fetchedAt < BITPIN_STALE_TTL_MS &&
      (bitpinMemCache.quote.buyPrice !== null || bitpinMemCache.quote.sellPrice !== null)
    ) {
      return {
        ...bitpinMemCache.quote,
        sourceStatus: "degraded",
        errorMessage: "آخرین قیمت معتبر بیت‌پین نمایش داده می‌شود"
      };
    }
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

async function fetchAbanTetherLive(): Promise<DomesticQuote> {
  const id = "abantether";
  const name = "آبان‌تتر";

  const data = await fetchJson<{
    data?: {
      markets?: Record<string, {
        symbol?: string;
        buy_price?: string | number;
        sell_price?: string | number;
        active?: boolean;
      }>;
    };
  }>("https://api.abantether.com/api/v1/manager/otc/ticker", 8000, {
    headers: {
      "user-agent": BROWSER_UA,
      accept: "application/json",
    }
  });

  const markets = data.data?.markets || {};
  // Prefer USDTIRT which is USDT vs IRT (toman)
  let usdt = markets.USDTIRT || markets["USDTIRT"];
  if (!usdt) {
    // fallback search
    const found = Object.values(markets).find((m: unknown) => {
      const mm = m as { symbol?: string; buy_price?: string | number };
      return (mm.symbol === "USDT" || mm.symbol === "USDTIRT") && mm.buy_price;
    });
    if (found) usdt = found;
  }
  if (!usdt || !usdt.buy_price || !usdt.sell_price) {
    throw new ProviderError("داده قیمت تتر در پاسخ تیکِر آبان‌تتر پیدا نشد");
  }
  const buyPrice = toToman(usdt.buy_price);
  const sellPrice = toToman(usdt.sell_price);
  if (buyPrice === null && sellPrice === null) {
    throw new ProviderError("قیمت‌های خرید/فروش تتر معتبر نیستند");
  }
  return buildQuote(id, name, buyPrice, sellPrice);
}

async function abanTether(): Promise<DomesticQuote> {
  const id = "abantether";
  const name = "آبان‌تتر";
  const now = Date.now();
  const cache = await readAbanCache();

  if (cache?.rateLimitedUntil && now < cache.rateLimitedUntil) {
    if (cache.quote.buyPrice !== null || cache.quote.sellPrice !== null || cache.quote.midPrice !== null) {
      return abanQuoteFromCache(cache, true);
    }
    return unavailable(id, name, "محدودیت نرخ آبان‌تتر؛ بعداً دوباره تلاش کنید");
  }

  if (cache && now - cache.fetchedAt < ABAN_MIN_FETCH_MS) {
    if (cache.quote.buyPrice !== null || cache.quote.sellPrice !== null || cache.quote.midPrice !== null) {
      return cache.quote;
    }
  }

  try {
    const quote = await fetchAbanTetherLive();
    await writeAbanCache({ quote, fetchedAt: now });
    return quote;
  } catch (error) {
    const isRateLimited = error instanceof ProviderError && /429|rate|limit/i.test(error.message);
    if (isRateLimited) {
      const nextCache: AbanCacheEntry = {
        quote: cache?.quote ?? unavailable(id, name, "محدودیت نرخ آبان‌تتر"),
        fetchedAt: cache?.fetchedAt ?? now,
        rateLimitedUntil: now + ABAN_RATE_LIMIT_BACKOFF_MS
      };
      await writeAbanCache(nextCache);
      if (cache && (cache.quote.buyPrice !== null || cache.quote.sellPrice !== null || cache.quote.midPrice !== null)) {
        return abanQuoteFromCache(cache, true);
      }
      return unavailable(id, name, "محدودیت نرخ آبان‌تتر؛ بعداً دوباره تلاش کنید");
    }

    if (cache && now - cache.fetchedAt < ABAN_STALE_TTL_MS) {
      if (cache.quote.buyPrice !== null || cache.quote.sellPrice !== null || cache.quote.midPrice !== null) {
        return abanQuoteFromCache(cache, true);
      }
    }

    return unavailable(id, name, error instanceof Error ? error.message : "منبع در دسترس نیست");
  }
}

async function readOmpCache(): Promise<OmpCacheEntry | null> {
  if (ompMemCache) return ompMemCache;
  try {
    const raw = await readFile(ompCachePath, "utf8");
    ompMemCache = JSON.parse(raw) as OmpCacheEntry;
    return ompMemCache;
  } catch {
    return null;
  }
}

async function writeOmpCache(entry: OmpCacheEntry): Promise<void> {
  ompMemCache = entry;
  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(ompCachePath, JSON.stringify(entry), "utf8");
  } catch {
    // best-effort
  }
}

async function readAbanCache(): Promise<AbanCacheEntry | null> {
  if (abanMemCache) return abanMemCache;
  try {
    const raw = await readFile(ABAN_CACHE_PATH, "utf8");
    abanMemCache = JSON.parse(raw) as AbanCacheEntry;
    return abanMemCache;
  } catch {
    return null;
  }
}

async function writeAbanCache(entry: AbanCacheEntry): Promise<void> {
  abanMemCache = entry;
  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(ABAN_CACHE_PATH, JSON.stringify(entry), "utf8");
  } catch {
    // best-effort
  }
}

function ompQuoteFromCache(entry: OmpCacheEntry, stale = false): DomesticQuote {
  return {
    ...entry.quote,
    sourceStatus: stale ? "degraded" : entry.quote.sourceStatus,
    errorMessage: stale ? "آخرین قیمت معتبر OMPFinex نمایش داده می‌شود" : entry.quote.errorMessage
  };
}

function abanQuoteFromCache(entry: AbanCacheEntry, stale = false): DomesticQuote {
  return {
    ...entry.quote,
    sourceStatus: stale ? "degraded" : entry.quote.sourceStatus,
    errorMessage: stale ? "آخرین قیمت معتبر آبان‌تتر نمایش داده می‌شود" : entry.quote.errorMessage
  };
}

function isOmpRateLimited(error: unknown): boolean {
  return error instanceof ProviderError && error.message.includes("429");
}

async function fetchOmpFinexLive(): Promise<DomesticQuote> {
  const id = "ompfinex";
  const name = "OMPFinex";
  const data = await fetchJson<{
    data?: { bids?: Array<[string, string]>; asks?: Array<[string, string]> };
  }>(`https://api.ompfinex.com/v1/market/${OMP_USDT_MARKET_ID}/depth`, 12_000, {
    headers: { "user-agent": DESK_UA }
  });

  const buyPrice = toToman(data.data?.bids?.[0]?.[0], "rial");
  const sellPrice = toToman(data.data?.asks?.[0]?.[0], "rial");
  if (buyPrice === null && sellPrice === null) {
    throw new ProviderError("داده دفتر سفارش تتر دریافت نشد");
  }
  return buildQuote(id, name, buyPrice, sellPrice);
}

async function ompFinex(): Promise<DomesticQuote> {
  const id = "ompfinex";
  const name = "OMPFinex";
  const now = Date.now();
  const cache = await readOmpCache();

  if (cache?.rateLimitedUntil && now < cache.rateLimitedUntil) {
    if (cache.quote.buyPrice !== null || cache.quote.sellPrice !== null || cache.quote.midPrice !== null) {
      return ompQuoteFromCache(cache, true);
    }
    return unavailable(id, name, "محدودیت نرخ OMPFinex؛ بعداً دوباره تلاش کنید");
  }

  if (cache && now - cache.fetchedAt < OMP_MIN_FETCH_MS) {
    if (cache.quote.buyPrice !== null || cache.quote.sellPrice !== null || cache.quote.midPrice !== null) {
      return cache.quote;
    }
  }

  try {
    const quote = await fetchOmpFinexLive();
    await writeOmpCache({ quote, fetchedAt: now });
    return quote;
  } catch (error) {
    if (isOmpRateLimited(error)) {
      const nextCache: OmpCacheEntry = {
        quote: cache?.quote ?? unavailable(id, name, "محدودیت نرخ OMPFinex"),
        fetchedAt: cache?.fetchedAt ?? now,
        rateLimitedUntil: now + OMP_RATE_LIMIT_BACKOFF_MS
      };
      await writeOmpCache(nextCache);
      if (cache && (cache.quote.buyPrice !== null || cache.quote.sellPrice !== null || cache.quote.midPrice !== null)) {
        return ompQuoteFromCache(cache, true);
      }
      return unavailable(id, name, "محدودیت نرخ OMPFinex؛ بعداً دوباره تلاش کنید");
    }

    if (cache && now - cache.fetchedAt < OMP_STALE_TTL_MS) {
      if (cache.quote.buyPrice !== null || cache.quote.sellPrice !== null || cache.quote.midPrice !== null) {
        return ompQuoteFromCache(cache, true);
      }
    }

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

// Exir ticker only exposes last/close — use official public order book for bid/ask.
// Endpoint (verified live): GET https://api.exir.io/v1/orderbook?symbol=usdt-irt
// Response: { "usdt-irt": { bids: [[price, amount], ...], asks: [[price, amount], ...] } }
// bids[0] = highest bid, asks[0] = lowest ask; prices are already in Toman.
const EXIR_ORDERBOOK_URL = "https://api.exir.io/v1/orderbook?symbol=usdt-irt";
const EXIR_MIN_FETCH_MS = 2.5 * 60 * 1000;
const EXIR_STALE_TTL_MS = 10 * 60 * 1000;
type ExirCacheEntry = { quote: DomesticQuote; fetchedAt: number };
let exirMemCache: ExirCacheEntry | null = null;

async function exir(): Promise<DomesticQuote> {
  const id = "exir";
  const name = "اکسیر";
  const now = Date.now();

  if (exirMemCache && now - exirMemCache.fetchedAt < EXIR_MIN_FETCH_MS) {
    if (exirMemCache.quote.buyPrice !== null || exirMemCache.quote.sellPrice !== null) {
      return exirMemCache.quote;
    }
  }

  try {
    const data = await fetchJson<{
      "usdt-irt"?: {
        bids?: Array<[number | string, number | string]>;
        asks?: Array<[number | string, number | string]>;
      };
      bids?: Array<[number | string, number | string]>;
      asks?: Array<[number | string, number | string]>;
    }>(EXIR_ORDERBOOK_URL, 8_000, {
      headers: { "user-agent": BROWSER_UA, accept: "application/json" }
    });
    const book = data["usdt-irt"] ?? data;
    const bids = book.bids ?? [];
    const asks = book.asks ?? [];
    const buyPrice = toToman(bids[0]?.[0]);
    const sellPrice = toToman(asks[0]?.[0]);
    if (buyPrice === null || sellPrice === null) {
      throw new ProviderError("دفتر سفارش اکسیر خرید/فروش معتبر ندارد");
    }
    const quote = buildQuote(id, name, buyPrice, sellPrice);
    exirMemCache = { quote, fetchedAt: now };
    return quote;
  } catch (error) {
    if (
      exirMemCache &&
      now - exirMemCache.fetchedAt < EXIR_STALE_TTL_MS &&
      (exirMemCache.quote.buyPrice !== null || exirMemCache.quote.sellPrice !== null)
    ) {
      return {
        ...exirMemCache.quote,
        sourceStatus: "degraded",
        errorMessage: "آخرین قیمت معتبر اکسیر نمایش داده می‌شود"
      };
    }
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

const domesticCache = createProviderCache<DomesticQuote[]>();

function domesticCacheKey(settings: DeskSettings): string {
  return providers.map((provider) => `${provider.id}:${settings.enabledSources[provider.id] === false ? 0 : 1}`).join("|");
}

async function fetchDomesticQuotes(settings: DeskSettings): Promise<DomesticQuote[]> {
  return Promise.all(
    providers.map(async (provider) => {
      if (settings.enabledSources[provider.id] === false) {
        return unavailable(provider.id, provider.name, "این منبع در تنظیمات غیرفعال است");
      }
      try {
        return await provider.fetchQuote();
      } catch (error) {
        return unavailable(
          provider.id,
          provider.name,
          error instanceof Error ? error.message : "منبع در دسترس نیست"
        );
      }
    })
  );
}

export async function getDomesticQuotes(settings: DeskSettings): Promise<DomesticQuote[]> {
  const key = domesticCacheKey(settings);
  const ttlMs = ttlFromMinutes(settings.priceRefreshMinutes);
  return domesticCache.get(key, ttlMs, () => fetchDomesticQuotes(settings));
}
