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

/* -------------------------------------------------------------------------- */
/* New domestic sources: Bit24, OK-EX, Arzinja                                  */
/* -------------------------------------------------------------------------- */

const NEW_SOURCE_MIN_FETCH_MS = 2.5 * 60 * 1000;
const NEW_SOURCE_STALE_TTL_MS = 10 * 60 * 1000;

type SimpleQuoteCache = { quote: DomesticQuote; fetchedAt: number };
let bit24MemCache: SimpleQuoteCache | null = null;
let okexIrMemCache: SimpleQuoteCache | null = null;
let arzinjaMemCache: SimpleQuoteCache | null = null;

function fromSimpleCache(cache: SimpleQuoteCache | null, now: number, minMs: number): DomesticQuote | null {
  if (!cache || now - cache.fetchedAt >= minMs) return null;
  if (cache.quote.buyPrice === null && cache.quote.sellPrice === null && cache.quote.midPrice === null) return null;
  return cache.quote;
}

function staleSimpleCache(
  cache: SimpleQuoteCache | null,
  now: number,
  staleMs: number,
  message: string
): DomesticQuote | null {
  if (!cache || now - cache.fetchedAt >= staleMs) return null;
  if (cache.quote.buyPrice === null && cache.quote.sellPrice === null && cache.quote.midPrice === null) return null;
  return { ...cache.quote, sourceStatus: "degraded", errorMessage: message };
}

/**
 * Bit24 (بیت۲۴)
 * Official public spot order book used by the trade UI (pro API, no auth):
 * GET https://pro.bit24.cash/api/v3/markets/USDT-IRT/order-books
 * Response: data.buy_orders[] / data.sell_orders[] with { price, amount, ... }
 * buy_orders are bids (highest first), sell_orders are asks (lowest first).
 * Quote coin IRT is Toman on Bit24 — convert once via toToman (unit=toman).
 * Desk mapping: buyPrice = highest bid, sellPrice = lowest ask, mid = average.
 */
async function bit24(): Promise<DomesticQuote> {
  const id = "bit24";
  const name = "بیت۲۴";
  const now = Date.now();
  const hit = fromSimpleCache(bit24MemCache, now, NEW_SOURCE_MIN_FETCH_MS);
  if (hit) return hit;

  try {
    const data = await fetchJson<{
      success?: boolean;
      data?: {
        buy_orders?: Array<{ price?: string | number }>;
        sell_orders?: Array<{ price?: string | number }>;
      };
    }>("https://pro.bit24.cash/api/v3/markets/USDT-IRT/order-books", 8_000, {
      headers: {
        "user-agent": BROWSER_UA,
        accept: "application/json",
        origin: "https://bit24.cash",
        referer: "https://bit24.cash/trade/usdt_irt/"
      }
    });

    if (data.success === false) {
      throw new ProviderError("پاسخ order-books بیت۲۴ ناموفق بود");
    }

    const buyOrders = data.data?.buy_orders ?? [];
    const sellOrders = data.data?.sell_orders ?? [];

    // Highest valid bid / lowest valid ask — scan top levels in case of null/zero rows
    let buyPrice: number | null = null;
    for (const row of buyOrders) {
      const p = toToman(row.price);
      if (p !== null && p > 0) {
        buyPrice = buyPrice === null ? p : Math.max(buyPrice, p);
        // book is sorted highest-first; first valid is enough, but max is safe
        break;
      }
    }
    let sellPrice: number | null = null;
    for (const row of sellOrders) {
      const p = toToman(row.price);
      if (p !== null && p > 0) {
        sellPrice = sellPrice === null ? p : Math.min(sellPrice, p);
        break;
      }
    }

    if (buyPrice === null || sellPrice === null) {
      throw new ProviderError("دفتر سفارش عمومی بیت۲۴ خرید/فروش معتبر برنگرداند");
    }
    if (buyPrice > sellPrice) {
      throw new ProviderError("دفتر سفارش بیت۲۴ نامعتبر است (bid > ask)");
    }

    const quote = buildQuote(id, name, buyPrice, sellPrice);
    bit24MemCache = { quote, fetchedAt: now };
    return quote;
  } catch (error) {
    const stale = staleSimpleCache(bit24MemCache, now, NEW_SOURCE_STALE_TTL_MS, "آخرین قیمت معتبر بیت۲۴ نمایش داده می‌شود");
    if (stale) return stale;
    return unavailable(id, name, error instanceof Error ? error.message : "منبع در دسترس نیست");
  }
}

/**
 * OK-EX / اوکی اکسچنج
 * Official public OTC ticker list used by https://ok-ex.io frontend:
 * GET https://azapi.ok-ex.io/api/v1/asset/otc/tickers
 * USDT row: buyAmt / sellAmt in IRT (Toman).
 * Field meaning (user-facing OTC): buyAmt = قیمت خرید کاربر (ask), sellAmt = قیمت فروش کاربر (bid).
 * Dashboard mapping (same as order-book convention): buyPrice=bid=sellAmt, sellPrice=ask=buyAmt.
 */
async function okexIr(): Promise<DomesticQuote> {
  const id = "okex_ir";
  const name = "اوکی اکسچنج";
  const now = Date.now();
  const hit = fromSimpleCache(okexIrMemCache, now, NEW_SOURCE_MIN_FETCH_MS);
  if (hit) return hit;

  try {
    const data = await fetchJson<
      Array<{
        asset?: string;
        buyAmt?: string | number;
        sellAmt?: string | number;
        nameFa?: string;
      }>
    >("https://azapi.ok-ex.io/api/v1/asset/otc/tickers", 8_000, {
      headers: { "user-agent": BROWSER_UA, accept: "application/json" }
    });
    const usdt = data.find((row) => (row.asset ?? "").toUpperCase() === "USDT");
    if (!usdt) throw new ProviderError("ردیف USDT در تیکر OTC اوکی اکسچنج پیدا نشد");

    // User-facing: buyAmt = price to buy USDT, sellAmt = price to sell USDT
    const userBuy = toToman(usdt.buyAmt); // ask side
    const userSell = toToman(usdt.sellAmt); // bid side
    // Desk convention: buyPrice = highest bid, sellPrice = lowest ask
    const buyPrice = userSell;
    const sellPrice = userBuy;
    if (buyPrice === null && sellPrice === null) {
      throw new ProviderError("قیمت خرید/فروش USDT اوکی اکسچنج معتبر نیست");
    }
    const quote = buildQuote(id, name, buyPrice, sellPrice, {
      status:
        buyPrice !== null && sellPrice !== null && buyPrice === sellPrice ? "degraded" : "available",
      errorMessage:
        buyPrice !== null && sellPrice !== null && buyPrice === sellPrice
          ? "API عمومی OTC خرید و فروش یکسان برگرداند"
          : undefined
    });
    okexIrMemCache = { quote, fetchedAt: now };
    return quote;
  } catch (error) {
    const stale = staleSimpleCache(okexIrMemCache, now, NEW_SOURCE_STALE_TTL_MS, "آخرین قیمت معتبر اوکی اکسچنج نمایش داده می‌شود");
    if (stale) return stale;
    return unavailable(id, name, error instanceof Error ? error.message : "منبع در دسترس نیست");
  }
}

const ARZINJA_API_HEADERS = {
  "user-agent": BROWSER_UA,
  accept: "application/json, text/plain;q=0.8, */*;q=0.5",
  "accept-language": "fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7",
  origin: "https://arzinja.ir",
  referer: "https://arzinja.ir/tether"
} as const;

const ARZINJA_ORDERBOOK_URL =
  "https://api-v2.arzinja.ir/api/v1/trade/p2p/orderbook?pair=USDTIRT";
const ARZINJA_ALL_MARKET_URL =
  "https://api-v2.arzinja.ir/api/v1/market/all-market?page=1&base_asset=USDT&provider_type=p2p";

type ArzinjaFetchDiag = {
  finalUrl: string;
  status: number | null;
  contentType: string | null;
  responseLength: number;
  errorType: string | null;
};

function logArzinjaDiag(diag: ArzinjaFetchDiag & { attempt?: number; path?: string }): void {
  // Safe structured log for Vercel — no secrets, no bodies
  console.info(
    "[arzinja-fetch]",
    JSON.stringify({
      path: diag.path ?? null,
      status: diag.status,
      finalUrl: diag.finalUrl,
      contentType: diag.contentType,
      responseLength: diag.responseLength,
      errorType: diag.errorType,
      attempt: diag.attempt ?? null,
      vercel: Boolean(process.env.VERCEL),
      region: process.env.VERCEL_REGION ?? null
    })
  );
}

/**
 * Vercel-safe Arzinja HTTP GET.
 * Uses native fetch first (avoids IP-pin hangs to Arvan from EU regions),
 * with retry/backoff. On non-Vercel, falls back to shared fetchJson (DoH path).
 * Never uses persistent disk — only the returned JSON.
 */
async function arzinjaHttpGetJson(url: string, timeoutMs: number): Promise<unknown> {
  const attempts = process.env.VERCEL ? 3 : 2;
  let lastError: ProviderError | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) {
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }

    const diag: ArzinjaFetchDiag = {
      finalUrl: url,
      status: null,
      contentType: null,
      responseLength: 0,
      errorType: null
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        cache: "no-store",
        signal: controller.signal,
        headers: { ...ARZINJA_API_HEADERS }
      });
      const text = await response.text();
      diag.status = response.status;
      diag.contentType = response.headers.get("content-type");
      diag.responseLength = text.length;
      diag.finalUrl = response.url || url;

      if (!response.ok) {
        diag.errorType = `HTTP ${response.status}`;
        logArzinjaDiag({ ...diag, attempt, path: "fetch" });
        lastError = new ProviderError(`HTTP ${response.status}`);
        // Retry 403/429/5xx; do not retry other 4xx
        if (response.status === 403 || response.status === 429 || response.status >= 500) {
          continue;
        }
        throw lastError;
      }
      if (!text.trim()) {
        diag.errorType = "empty";
        logArzinjaDiag({ ...diag, attempt, path: "fetch" });
        lastError = new ProviderError("پاسخ خالی بود");
        continue;
      }
      try {
        const json: unknown = JSON.parse(text);
        logArzinjaDiag({ ...diag, attempt, path: "fetch", errorType: null });
        return json;
      } catch {
        diag.errorType = "invalid_json";
        logArzinjaDiag({ ...diag, attempt, path: "fetch" });
        lastError = new ProviderError("پاسخ JSON معتبر نبود");
        continue;
      }
    } catch (error) {
      if (error instanceof ProviderError) {
        lastError = error;
      } else if (error instanceof Error && error.name === "AbortError") {
        diag.errorType = "timeout";
        lastError = new ProviderError("زمان پاسخ‌دهی منبع تمام شد");
      } else {
        diag.errorType = error instanceof Error ? error.name : "network";
        lastError = new ProviderError(error instanceof Error ? error.message : "خطای شبکه");
      }
      logArzinjaDiag({ ...diag, attempt, path: "fetch" });
    } finally {
      clearTimeout(timer);
    }
  }

  // Local/dev only: try DoH+IP-pin helper as last resort (can hang from Vercel EU — skip there)
  if (!process.env.VERCEL) {
    try {
      return await fetchJson(url, Math.min(timeoutMs, 10_000), {
        headers: { ...ARZINJA_API_HEADERS }
      });
    } catch (error) {
      lastError =
        error instanceof ProviderError
          ? error
          : new ProviderError(error instanceof Error ? error.message : "خطای شبکه");
    }
  }

  throw lastError ?? new ProviderError("اتصال به ارزینجا برقرار نشد");
}

/**
 * Parse executable bid/ask from Arzinja P2P order book levels [price, amount].
 * Desk mapping: buyPrice = highest bid, sellPrice = lowest ask.
 * IRT quote is Toman on Arzinja (enQuoteAsset: "Toman") — toToman once, unit=toman.
 */
function arzinjaBidAskFromOrderBook(data: {
  success?: boolean;
  result?: {
    symbol?: string;
    bids?: Array<[string | number, string | number] | (string | number)[]>;
    asks?: Array<[string | number, string | number] | (string | number)[]>;
  };
}): { buyPrice: number; sellPrice: number } | null {
  if (data.success === false) return null;
  const symbol = (data.result?.symbol ?? "").toUpperCase().replace(/[_/-]/g, "");
  if (symbol && symbol !== "USDTIRT") return null;

  let buyPrice: number | null = null;
  for (const row of data.result?.bids ?? []) {
    const p = toToman(Array.isArray(row) ? row[0] : null);
    if (p !== null && p > 0) {
      buyPrice = p;
      break;
    }
  }
  let sellPrice: number | null = null;
  for (const row of data.result?.asks ?? []) {
    const p = toToman(Array.isArray(row) ? row[0] : null);
    if (p !== null && p > 0) {
      sellPrice = p;
      break;
    }
  }
  if (buyPrice === null || sellPrice === null || buyPrice <= 0 || sellPrice <= 0) return null;
  if (buyPrice > sellPrice) return null;
  if (buyPrice < 10_000 || sellPrice < 10_000 || buyPrice > 2_000_000 || sellPrice > 2_000_000) return null;
  return { buyPrice, sellPrice };
}

/**
 * Fallback: P2P market stats from official all-market list (same USDT/IRT pair).
 * stats.bidPrice / stats.askPrice are best bid/ask in Toman.
 */
function arzinjaBidAskFromAllMarket(data: {
  success?: boolean;
  result?: Array<Record<string, {
    pair?: string;
    baseAsset?: string;
    quoteAsset?: string;
    faQuoteAsset?: string;
    stats?: { bidPrice?: string | number; askPrice?: string | number; lastPrice?: string | number };
  }>>;
}): { buyPrice: number; sellPrice: number } | null {
  if (data.success === false) return null;
  for (const row of data.result ?? []) {
    const market =
      row.USDTIRT ??
      Object.values(row).find(
        (m) =>
          (m?.pair ?? "").toUpperCase().replace(/[_/-]/g, "") === "USDTIRT" ||
          ((m?.baseAsset ?? "").toUpperCase() === "USDT" && (m?.quoteAsset ?? "").toUpperCase() === "IRT")
      );
    if (!market) continue;
    if ((market.baseAsset ?? "USDT").toUpperCase() !== "USDT") continue;
    if ((market.quoteAsset ?? "IRT").toUpperCase() !== "IRT") continue;

    const buyPrice = toToman(market.stats?.bidPrice);
    const sellPrice = toToman(market.stats?.askPrice);
    if (buyPrice === null || sellPrice === null || buyPrice <= 0 || sellPrice <= 0) continue;
    if (buyPrice > sellPrice) continue;
    if (buyPrice < 10_000 || sellPrice < 10_000 || buyPrice > 2_000_000 || sellPrice > 2_000_000) continue;
    return { buyPrice, sellPrice };
  }
  return null;
}

/**
 * Arzinja (ارزینجا) — live official API used by https://arzinja.ir
 *
 * Primary (executable book):
 *   GET https://api-v2.arzinja.ir/api/v1/trade/p2p/orderbook?pair=USDTIRT
 *   result.bids[0][0] = best bid, result.asks[0][0] = best ask (Toman)
 *
 * Fallback:
 *   GET https://api-v2.arzinja.ir/api/v1/market/all-market?page=1&base_asset=USDT&provider_type=p2p
 *   result[].USDTIRT.stats.bidPrice / askPrice
 *
 * Vercel: prefer region sin1 (Arvan IR edges are often unreachable from fra1/EU).
 * Uses native fetch + retries on Vercel; never invents prices; mem-cache only (no .data).
 * Legacy https://arzinja.app/prices is frozen/stale (~60k) and must not be used.
 */
async function arzinja(): Promise<DomesticQuote> {
  const id = "arzinja";
  const name = "ارزینجا";
  const now = Date.now();
  // Drop any previously cached stale ~60k quotes from the old /prices feed
  if (
    arzinjaMemCache &&
    arzinjaMemCache.quote.midPrice !== null &&
    arzinjaMemCache.quote.midPrice < 100_000
  ) {
    arzinjaMemCache = null;
  }
  const hit = fromSimpleCache(arzinjaMemCache, now, NEW_SOURCE_MIN_FETCH_MS);
  if (hit) return hit;

  const timeoutMs = process.env.VERCEL ? 10_000 : 12_000;
  let lastDiagHint = "";

  try {
    let bidAsk: { buyPrice: number; sellPrice: number } | null = null;

    try {
      const book = (await arzinjaHttpGetJson(ARZINJA_ORDERBOOK_URL, timeoutMs)) as {
        success?: boolean;
        result?: {
          symbol?: string;
          bids?: Array<[string | number, string | number] | (string | number)[]>;
          asks?: Array<[string | number, string | number] | (string | number)[]>;
        };
      };
      bidAsk = arzinjaBidAskFromOrderBook(book);
      if (!bidAsk) lastDiagHint = "orderbook without valid bid/ask";
    } catch (error) {
      lastDiagHint = error instanceof Error ? error.message : "orderbook fetch failed";
      bidAsk = null;
    }

    if (!bidAsk) {
      try {
        const markets = (await arzinjaHttpGetJson(ARZINJA_ALL_MARKET_URL, timeoutMs)) as {
          success?: boolean;
          result?: Array<
            Record<
              string,
              {
                pair?: string;
                baseAsset?: string;
                quoteAsset?: string;
                faQuoteAsset?: string;
                stats?: { bidPrice?: string | number; askPrice?: string | number; lastPrice?: string | number };
              }
            >
          >;
        };
        bidAsk = arzinjaBidAskFromAllMarket(markets);
        if (!bidAsk) lastDiagHint = "all-market without valid bid/ask";
      } catch (error) {
        lastDiagHint = error instanceof Error ? error.message : "all-market fetch failed";
        bidAsk = null;
      }
    }

    if (!bidAsk) {
      const region = process.env.VERCEL_REGION ? ` region=${process.env.VERCEL_REGION}` : "";
      throw new ProviderError(
        `قیمت زنده USDT/IRT ارزینجا در دسترس نیست (${lastDiagHint || "no data"}${region})`
      );
    }

    const quote = buildQuote(id, name, bidAsk.buyPrice, bidAsk.sellPrice);
    arzinjaMemCache = { quote, fetchedAt: now };
    return quote;
  } catch (error) {
    const stale = staleSimpleCache(arzinjaMemCache, now, NEW_SOURCE_STALE_TTL_MS, "آخرین قیمت معتبر ارزینجا نمایش داده می‌شود");
    if (stale) return stale;
    return unavailable(id, name, error instanceof Error ? error.message : "منبع در دسترس نیست");
  }
}

/** Median of finite numbers (sorted). */
function simpleMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Arzinja-only gate: if mid differs >10% from the median of other valid domestic
 * sources, mark unavailable. Does not rewrite prices to the median.
 */
function applyArzinjaMedianGate(quotes: DomesticQuote[]): DomesticQuote[] {
  const arzinjaIdx = quotes.findIndex((q) => q.exchangeId === "arzinja");
  if (arzinjaIdx < 0) return quotes;

  const arzinjaQuote = quotes[arzinjaIdx];
  if (
    arzinjaQuote.sourceStatus === "unavailable" ||
    arzinjaQuote.midPrice === null ||
    !Number.isFinite(arzinjaQuote.midPrice)
  ) {
    return quotes;
  }

  const peerMids = quotes
    .filter(
      (q) =>
        q.exchangeId !== "arzinja" &&
        q.sourceStatus !== "unavailable" &&
        q.midPrice !== null &&
        Number.isFinite(q.midPrice) &&
        q.midPrice > 0
    )
    .map((q) => q.midPrice as number);

  const peerMedian = simpleMedian(peerMids);
  if (peerMedian === null || peerMedian <= 0) {
    return quotes;
  }

  const deviation = Math.abs(arzinjaQuote.midPrice - peerMedian) / peerMedian;
  if (deviation > 0.1) {
    const next = [...quotes];
    next[arzinjaIdx] = unavailable(
      "arzinja",
      "ارزینجا",
      "قیمت ارزینجا بیش از ۱۰٪ از میانه داخلی فاصله دارد (قیمت اصلاح یا جعل نمی‌شود)"
    );
    return next;
  }

  return quotes;
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
  { id: "tetherland", name: "تترلند", fetchQuote: tetherland },
  { id: "bit24", name: "بیت۲۴", fetchQuote: bit24 },
  { id: "okex_ir", name: "اوکی اکسچنج", fetchQuote: okexIr },
  { id: "arzinja", name: "ارزینجا", fetchQuote: arzinja }
];

const domesticCache = createProviderCache<DomesticQuote[]>();

function domesticCacheKey(settings: DeskSettings): string {
  return providers.map((provider) => `${provider.id}:${settings.enabledSources[provider.id] === false ? 0 : 1}`).join("|");
}

async function fetchDomesticQuotes(settings: DeskSettings): Promise<DomesticQuote[]> {
  const quotes = await Promise.all(
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
  return applyArzinjaMedianGate(quotes);
}

export async function getDomesticQuotes(settings: DeskSettings): Promise<DomesticQuote[]> {
  const key = domesticCacheKey(settings);
  const ttlMs = ttlFromMinutes(settings.priceRefreshMinutes);
  return domesticCache.get(key, ttlMs, () => fetchDomesticQuotes(settings));
}

/**
 * Public diagnostic for Vercel: fetch Arzinja only (no settings, no disk).
 * Used by GET /api/auth/login to verify datacenter reachability without session.
 */
export async function probeArzinjaQuote(): Promise<{
  exchangeId: string;
  buyPrice: number | null;
  sellPrice: number | null;
  midPrice: number | null;
  sourceStatus: SourceStatus;
  errorMessage?: string;
  region: string | null;
  vercel: boolean;
  endpoint: string;
}> {
  // Bypass short mem-cache for a true connectivity probe
  arzinjaMemCache = null;
  const quote = await arzinja();
  return {
    exchangeId: quote.exchangeId,
    buyPrice: quote.buyPrice,
    sellPrice: quote.sellPrice,
    midPrice: quote.midPrice,
    sourceStatus: quote.sourceStatus,
    errorMessage: quote.errorMessage,
    region: process.env.VERCEL_REGION ?? null,
    vercel: Boolean(process.env.VERCEL),
    endpoint: ARZINJA_ORDERBOOK_URL
  };
}
