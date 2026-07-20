import { BROWSER_UA, fetchJson, numeric, outboundFetch, ProviderError } from "@/lib/http";
import { createProviderCache, ttlFromMinutes } from "@/lib/providerCache";
import {
  clearProviderSlot,
  runAllIsolatedProviders,
  runIsolatedProvider,
  snapshotProviderHealth,
  type DomesticProviderHealth,
  type IsolatedProviderDef
} from "@/lib/providers/domesticRunner";
import type { DeskSettings, DomesticQuote, SourceStatus } from "@/lib/types";

const DESK_UA = "TraderBot/OTCDesk";

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
  if (parsed === null) return null;
  return unit === "rial" ? parsed / 10 : parsed;
}

/** Absolute USDT/IRT Toman sanity — reject garbage without inventing. */
function assertRealisticUsdtIrt(buy: number | null, sell: number | null, mid: number | null): void {
  const ref = mid ?? (buy !== null && sell !== null ? (buy + sell) / 2 : buy ?? sell);
  if (ref === null || !Number.isFinite(ref)) {
    throw new ProviderError("قیمت USDT/IRT معتبر نیست");
  }
  // Domestic USDT/IRT has been ~50k–500k Toman for years of relevant history; outside = wrong unit/asset
  if (ref < 20_000 || ref > 1_000_000) {
    throw new ProviderError(`قیمت USDT/IRT خارج از بازه معقول است (${Math.round(ref)})`);
  }
  if (buy !== null && sell !== null && buy > sell * 1.05) {
    throw new ProviderError("دفتر سفارش نامعتبر است (bid >> ask)");
  }
}

/* -------------------------------------------------------------------------- */
/* Live fetchers (no shared cache — isolation runner owns cache/stale/retry)  */
/* -------------------------------------------------------------------------- */

async function liveNobitex(): Promise<DomesticQuote> {
  const id = "nobitex";
  const name = "نوبیتکس";
  const data = await fetchJson<{
    stats?: Record<string, { bestBuy?: string; bestSell?: string; volumeSrc?: string }>;
  }>("https://apiv2.nobitex.ir/market/stats?srcCurrency=usdt&dstCurrency=rls", 12_000, {
    headers: { "user-agent": DESK_UA }
  });
  const stats = data.stats?.["usdt-rls"] ?? data.stats?.USDT_RLS;
  const buyPrice = toToman(stats?.bestBuy, "rial");
  const sellPrice = toToman(stats?.bestSell, "rial");
  if (buyPrice === null && sellPrice === null) {
    throw new ProviderError("داده قیمت تتر در پاسخ منبع پیدا نشد");
  }
  assertRealisticUsdtIrt(buyPrice, sellPrice, null);
  return buildQuote(id, name, buyPrice, sellPrice, { volume: numeric(stats?.volumeSrc) });
}

async function liveWallex(): Promise<DomesticQuote> {
  const id = "wallex";
  const name = "والکس";
  const data = await fetchJson<{
    result?: { symbols?: Record<string, { stats?: { bidPrice?: string; askPrice?: string } }> };
  }>("https://api.wallex.ir/v1/markets", 9_000);
  const stats = data.result?.symbols?.USDTTMN?.stats;
  const buyPrice = toToman(stats?.bidPrice);
  const sellPrice = toToman(stats?.askPrice);
  if (buyPrice === null && sellPrice === null) {
    throw new ProviderError("داده قیمت تتر در پاسخ منبع پیدا نشد");
  }
  assertRealisticUsdtIrt(buyPrice, sellPrice, null);
  return buildQuote(id, name, buyPrice, sellPrice);
}

const BITPIN_ORDERBOOK_URL = "https://api.bitpin.ir/api/v1/mth/orderbook/USDT_IRT/";
const BITPIN_ORDERBOOK_URL_FALLBACK = "https://api.bitpin.org/api/v1/mth/orderbook/USDT_IRT/";

async function liveBitpin(): Promise<DomesticQuote> {
  const id = "bitpin";
  const name = "بیت‌پین";
  let data: { bids?: Array<[string | number, string | number]>; asks?: Array<[string | number, string | number]> };
  try {
    data = await fetchJson(BITPIN_ORDERBOOK_URL, 8_000, {
      headers: { "user-agent": BROWSER_UA, accept: "application/json" }
    });
  } catch {
    data = await fetchJson(BITPIN_ORDERBOOK_URL_FALLBACK, 8_000, {
      headers: { "user-agent": BROWSER_UA, accept: "application/json" }
    });
  }
  const buyPrice = toToman(data.bids?.[0]?.[0]);
  const sellPrice = toToman(data.asks?.[0]?.[0]);
  if (buyPrice === null || sellPrice === null) {
    throw new ProviderError("دفتر سفارش بیت‌پین خرید/فروش معتبر ندارد");
  }
  assertRealisticUsdtIrt(buyPrice, sellPrice, null);
  return buildQuote(id, name, buyPrice, sellPrice);
}

async function liveTabdeal(): Promise<DomesticQuote> {
  const id = "tabdeal";
  const name = "تبدیل";
  const data = await fetchJson<{ asks?: Array<[string, string]>; bids?: Array<[string, string]> }>(
    "https://api1.tabdeal.org/r/api/v1/depth?symbol=USDTIRT&limit=1",
    9_000
  );
  const buyPrice = toToman(data.bids?.[0]?.[0]);
  const sellPrice = toToman(data.asks?.[0]?.[0]);
  if (buyPrice === null && sellPrice === null) {
    throw new ProviderError("داده دفتر سفارش تتر دریافت نشد");
  }
  assertRealisticUsdtIrt(buyPrice, sellPrice, null);
  return buildQuote(id, name, buyPrice, sellPrice);
}

/** Ramzinex USDT/IRR pair id (tether/rial). Prefer single-pair API — full /pairs is ~0.5MB+ and often hits timeouts. */
const RAMZINEX_USDT_IRR_PAIR_ID = 11;
const RAMZINEX_PAIR_URL = `https://publicapi.ramzinex.com/exchange/api/v1.0/exchange/pairs/${RAMZINEX_USDT_IRR_PAIR_ID}`;
const RAMZINEX_PAIRS_LIST_URL = "https://publicapi.ramzinex.com/exchange/api/v1.0/exchange/pairs";

type RamzinexPairRow = {
  pair_id?: number;
  base_currency_symbol?: { en?: string };
  quote_currency_symbol?: { en?: string };
  buy?: number;
  sell?: number;
};

async function liveRamzinex(): Promise<DomesticQuote> {
  const id = "ramzinex";
  const name = "رمزینکس";

  let item: RamzinexPairRow | undefined;

  // 1) Fast path: single pair (~1KB) — avoids downloading the full market list
  try {
    const single = await fetchJson<{ data?: RamzinexPairRow }>(RAMZINEX_PAIR_URL, 12_000);
    if (single.data && (single.data.buy != null || single.data.sell != null)) {
      item = single.data;
    }
  } catch {
    // fall through to full list
  }

  // 2) Fallback: full pairs list (large payload; longer timeout)
  if (!item) {
    const data = await fetchJson<{ data?: RamzinexPairRow[] }>(RAMZINEX_PAIRS_LIST_URL, 15_000);
    item = data.data?.find(
      (entry) =>
        entry.pair_id === RAMZINEX_USDT_IRR_PAIR_ID ||
        (entry.base_currency_symbol?.en?.toLowerCase() === "usdt" &&
          entry.quote_currency_symbol?.en?.toLowerCase() === "irr")
    );
  }

  const buyPrice = toToman(item?.buy, "rial");
  const sellPrice = toToman(item?.sell, "rial");
  if (buyPrice === null && sellPrice === null) {
    throw new ProviderError("داده قیمت تتر در پاسخ منبع پیدا نشد");
  }
  assertRealisticUsdtIrt(buyPrice, sellPrice, null);
  return buildQuote(id, name, buyPrice, sellPrice);
}

async function liveAbanTether(): Promise<DomesticQuote> {
  const id = "abantether";
  const name = "آبان‌تتر";
  const data = await fetchJson<{
    data?: {
      markets?: Record<
        string,
        { symbol?: string; buy_price?: string | number; sell_price?: string | number }
      >;
    };
  }>("https://api.abantether.com/api/v1/manager/otc/ticker", 8_000, {
    headers: { "user-agent": BROWSER_UA, accept: "application/json" }
  });

  const markets = data.data?.markets || {};
  let usdt = markets.USDTIRT || markets["USDTIRT"];
  if (!usdt) {
    const found = Object.values(markets).find((m) => {
      return (m.symbol === "USDT" || m.symbol === "USDTIRT") && m.buy_price;
    });
    if (found) usdt = found;
  }
  if (!usdt?.buy_price || !usdt?.sell_price) {
    throw new ProviderError("داده قیمت تتر در پاسخ تیکِر آبان‌تتر پیدا نشد");
  }
  // OTC user-facing: buy_price = user buys USDT (ask), sell_price = user sells USDT (bid)
  // Desk: buyPrice = highest bid, sellPrice = lowest ask
  const buyPrice = toToman(usdt.sell_price);
  const sellPrice = toToman(usdt.buy_price);
  if (buyPrice === null && sellPrice === null) {
    throw new ProviderError("قیمت‌های خرید/فروش تتر معتبر نیستند");
  }
  assertRealisticUsdtIrt(buyPrice, sellPrice, null);
  return buildQuote(id, name, buyPrice, sellPrice);
}

const OMP_USDT_MARKET_ID = 9;

async function liveOmpFinex(): Promise<DomesticQuote> {
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
  assertRealisticUsdtIrt(buyPrice, sellPrice, null);
  return buildQuote(id, name, buyPrice, sellPrice);
}

/**
 * Tetherland official public market board (used by tetherland.com homepage JS):
 *   GET https://market.tetherland.com/prices → data.markets.USDTTMN.{bids,asks}[{price,amount}]
 *
 * Field names are inverted vs standard CLOB (verified against live book + mid ≈ domestic median):
 *   API.asks  → bid side (buy USDT interest), best bid = max(price)
 *   API.bids  → ask side (sell USDT interest), best ask = min(price)
 * Junk far levels exist; filter with absolute toman sanity + optional anchor band.
 *
 * Fallback: GET https://api.tetherland.com/currencies (single reference price only —
 * buy_price === sell_price === price). Never duplicate that into fake bid/ask.
 */
const TETHERLAND_MARKET_PRICES_URL = "https://market.tetherland.com/prices";
const TETHERLAND_CURRENCIES_URL = "https://api.tetherland.com/currencies";

const TETHERLAND_HEADERS = {
  "user-agent": BROWSER_UA,
  accept: "application/json, text/plain, */*",
  "accept-language": "fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7",
  origin: "https://tetherland.com",
  referer: "https://tetherland.com/"
} as const;

type TetherlandLevel = { price?: number | string; amount?: number | string };

/** Pure parser for tests + live path. Returns null when no valid executable book. */
export function parseTetherlandUsdtBook(
  payload: unknown,
  anchorToman: number | null = null
): { buyPrice: number; sellPrice: number } | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as {
    status?: boolean | number | string;
    data?: { markets?: Record<string, { bids?: TetherlandLevel[]; asks?: TetherlandLevel[] }> };
  };
  const market =
    root.data?.markets?.USDTTMN ??
    root.data?.markets?.USDTIRT ??
    root.data?.markets?.USDT_TMN ??
    null;
  if (!market) return null;

  const toPrices = (levels: TetherlandLevel[] | undefined): number[] => {
    const out: number[] = [];
    for (const row of levels ?? []) {
      const p = toToman(row.price);
      if (p !== null && p >= 20_000 && p <= 1_000_000) out.push(p);
    }
    return out;
  };

  // API field names are inverted relative to standard bid/ask (see comment above).
  const bidCandidates = toPrices(market.asks);
  const askCandidates = toPrices(market.bids);
  if (!bidCandidates.length || !askCandidates.length) return null;

  const bandFilter = (prices: number[], anchor: number, band: number): number[] =>
    prices.filter((p) => Math.abs(p - anchor) / anchor <= band);

  const tryPick = (bids: number[], asks: number[]): { buyPrice: number; sellPrice: number } | null => {
    if (!bids.length || !asks.length) return null;
    const buyPrice = Math.max(...bids);
    const sellPrice = Math.min(...asks);
    if (!(buyPrice > 0 && sellPrice > 0)) return null;
    if (buyPrice > sellPrice) return null;
    if (buyPrice > sellPrice * 1.05) return null;
    return { buyPrice, sellPrice };
  };

  // Prefer levels near anchor (reference or mid of near-market levels).
  const all = [...bidCandidates, ...askCandidates];
  const coarseMid =
    anchorToman && Number.isFinite(anchorToman)
      ? anchorToman
      : all.reduce((a, b) => a + b, 0) / all.length;

  for (const band of [0.02, 0.035, 0.05, 0.08]) {
    const picked = tryPick(bandFilter(bidCandidates, coarseMid, band), bandFilter(askCandidates, coarseMid, band));
    if (picked) {
      try {
        assertRealisticUsdtIrt(picked.buyPrice, picked.sellPrice, null);
        return picked;
      } catch {
        /* try wider band */
      }
    }
  }

  // Website top-of-book style: first 7 asks (desc bids) + reverse(bids) first 7 (near asks)
  const topBids = bidCandidates.slice(0, 12);
  const topAsks = [...askCandidates].reverse().slice(0, 12);
  const topPick = tryPick(topBids, topAsks);
  if (topPick) {
    try {
      assertRealisticUsdtIrt(topPick.buyPrice, topPick.sellPrice, null);
      return topPick;
    } catch {
      /* fall through */
    }
  }
  return null;
}

async function liveTetherlandReferenceOnly(): Promise<DomesticQuote> {
  const id = "tetherland";
  const name = "تترلند";
  const data = await fetchJson<{
    data?: { currencies?: { USDT?: { buy_price?: number; sell_price?: number; price?: number } } };
  }>(TETHERLAND_CURRENCIES_URL, 9_000, { headers: { ...TETHERLAND_HEADERS } });

  const usdt = data.data?.currencies?.USDT;
  const ref = toToman(usdt?.price ?? usdt?.buy_price ?? usdt?.sell_price);
  if (ref === null) {
    throw new ProviderError("داده قیمت تتر در پاسخ منبع پیدا نشد");
  }
  // Official currencies fields are identical (last/reference only) — never duplicate into fake bid/ask
  const buyField = toToman(usdt?.buy_price);
  const sellField = toToman(usdt?.sell_price);
  if (
    buyField !== null &&
    sellField !== null &&
    buyField !== sellField &&
    Math.abs(buyField - sellField) / Math.max(buyField, sellField) > 0.0001
  ) {
    const buyPrice = Math.min(buyField, sellField);
    const sellPrice = Math.max(buyField, sellField);
    assertRealisticUsdtIrt(buyPrice, sellPrice, null);
    return buildQuote(id, name, buyPrice, sellPrice);
  }

  assertRealisticUsdtIrt(null, null, ref);
  return buildQuote(id, name, null, null, {
    midPrice: ref,
    status: "degraded",
    errorMessage: "فقط قیمت مرجع عمومی؛ bid/ask اجرایی جدا در دسترس نیست"
  });
}

async function liveTetherland(): Promise<DomesticQuote> {
  const id = "tetherland";
  const name = "تترلند";

  // Optional anchor from currencies API (single reference — not used as fake bid/ask).
  let anchor: number | null = null;
  try {
    const refData = await fetchJson<{
      data?: { currencies?: { USDT?: { price?: number; buy_price?: number; sell_price?: number } } };
    }>(TETHERLAND_CURRENCIES_URL, 6_000, { headers: { ...TETHERLAND_HEADERS } });
    anchor = toToman(
      refData.data?.currencies?.USDT?.price ??
        refData.data?.currencies?.USDT?.buy_price ??
        refData.data?.currencies?.USDT?.sell_price
    );
  } catch {
    // anchor optional
  }

  try {
    const book = await fetchJson<unknown>(TETHERLAND_MARKET_PRICES_URL, 9_000, {
      headers: { ...TETHERLAND_HEADERS }
    });
    const parsed = parseTetherlandUsdtBook(book, anchor);
    if (parsed) {
      assertRealisticUsdtIrt(parsed.buyPrice, parsed.sellPrice, null);
      return buildQuote(id, name, parsed.buyPrice, parsed.sellPrice);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : "";
    // 429 → let runner backoff; still try reference
    if (/HTTP 429|rate/i.test(msg)) {
      try {
        return await liveTetherlandReferenceOnly();
      } catch {
        throw error instanceof ProviderError ? error : new ProviderError(msg || "محدودیت نرخ تترلند");
      }
    }
    // other book errors fall through to reference
  }

  return liveTetherlandReferenceOnly();
}

const EXIR_ORDERBOOK_URL = "https://api.exir.io/v1/orderbook?symbol=usdt-irt";

async function liveExir(): Promise<DomesticQuote> {
  const id = "exir";
  const name = "اکسیر";
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
  const buyPrice = toToman(book.bids?.[0]?.[0]);
  const sellPrice = toToman(book.asks?.[0]?.[0]);
  if (buyPrice === null || sellPrice === null) {
    throw new ProviderError("دفتر سفارش اکسیر خرید/فروش معتبر ندارد");
  }
  assertRealisticUsdtIrt(buyPrice, sellPrice, null);
  return buildQuote(id, name, buyPrice, sellPrice);
}

const BIT24_ORDERBOOK_URL = "https://pro.bit24.cash/api/v3/markets/USDT-IRT/order-books";

async function liveBit24(): Promise<DomesticQuote> {
  const id = "bit24";
  const name = "بیت۲۴";
  const data = await fetchJson<{
    success?: boolean;
    data?: {
      buy_orders?: Array<{ price?: string | number }>;
      sell_orders?: Array<{ price?: string | number }>;
    };
  }>(BIT24_ORDERBOOK_URL, 8_000, {
    headers: {
      "user-agent": BROWSER_UA,
      accept: "application/json",
      origin: "https://bit24.cash",
      referer: "https://bit24.cash/trade/usdt_irt/"
    }
  });
  if (data.success === false) throw new ProviderError("پاسخ order-books بیت۲۴ ناموفق بود");

  let buyPrice: number | null = null;
  for (const row of data.data?.buy_orders ?? []) {
    const p = toToman(row.price);
    if (p !== null && p > 0) {
      buyPrice = p;
      break;
    }
  }
  let sellPrice: number | null = null;
  for (const row of data.data?.sell_orders ?? []) {
    const p = toToman(row.price);
    if (p !== null && p > 0) {
      sellPrice = p;
      break;
    }
  }
  if (buyPrice === null || sellPrice === null) {
    throw new ProviderError("دفتر سفارش عمومی بیت۲۴ خرید/فروش معتبر برنگرداند");
  }
  if (buyPrice > sellPrice) throw new ProviderError("دفتر سفارش بیت۲۴ نامعتبر است (bid > ask)");
  assertRealisticUsdtIrt(buyPrice, sellPrice, null);
  return buildQuote(id, name, buyPrice, sellPrice);
}

/**
 * OK-EX (اوکی اکسچنج) — official public SPOT market API (docs.ok-ex.io):
 *   GET https://api.ok-ex.io/api/v1/spot/public/books?symbol=USDT-IRT&limit=20
 * Alternate host: https://sapi.ok-ex.io/... (same path)
 * Pair list confirms symbol "USDT-IRT", quote IRT, prices in Toman (not Rial).
 * Public market endpoints do NOT require an API key (trading APIs under /hapi do).
 *
 * Mapping: best bid → buyPrice; best ask → sellPrice (separate fields).
 *
 * Legacy OTC tickers (azapi.ok-ex.io/.../otc/tickers) often return identical buyAmt/sellAmt
 * (reference only). Some production server IPs receive HTTP 403 from Cloudflare WAF —
 * that requires official IP allowlisting; do not invent prices or bypass WAF.
 */
const OKEX_IR_BOOK_URLS = [
  "https://api.ok-ex.io/api/v1/spot/public/books?symbol=USDT-IRT&limit=20",
  "https://sapi.ok-ex.io/api/v1/spot/public/books?symbol=USDT-IRT&limit=20"
] as const;
const OKEX_IR_TICKERS_URL = "https://azapi.ok-ex.io/api/v1/asset/otc/tickers";

const OKEX_IR_HEADERS = {
  "user-agent": BROWSER_UA,
  accept: "application/json, text/plain, */*",
  "accept-language": "fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7",
  origin: "https://ok-ex.io",
  referer: "https://ok-ex.io/trade/USDT-IRT"
} as const;

/** Surfaced when Cloudflare/WAF blocks the server egress IP (common in production Docker). */
export const OKEX_IR_HTTP_403_MESSAGE =
  "HTTP 403 — Cloudflare/WAF دسترسی IP سرور به API عمومی اوکی اکسچنج را مسدود کرده است. " +
  "endpoint عمومی books نیاز به API key ندارد؛ برای production باید IP سرور allowlist شود " +
  "(api.ok-ex.io / sapi.ok-ex.io / azapi.ok-ex.io).";

function firstPositiveBookPrice(
  levels: Array<[number | string, number | string] | (number | string)[]> | undefined
): number | null {
  for (const row of levels ?? []) {
    if (!Array.isArray(row) || row.length < 1) continue;
    const p = toToman(row[0]);
    // Reject zero / negative / non-finite; prices are already Toman (no /10).
    if (p !== null && Number.isFinite(p) && p > 0) return p;
  }
  return null;
}

/** Pure parser for OK-EX spot books JSON (public /books payload). */
export function parseOkexIrSpotBook(payload: unknown): { buyPrice: number; sellPrice: number } | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  // Official shape is top-level { bids, asks }; tolerate rare wrappers.
  const nested =
    root.data && typeof root.data === "object"
      ? (root.data as Record<string, unknown>)
      : root.result && typeof root.result === "object"
        ? (root.result as Record<string, unknown>)
        : root;
  const book = nested as {
    bids?: Array<[number | string, number | string] | (number | string)[]>;
    asks?: Array<[number | string, number | string] | (number | string)[]>;
  };
  const buyPrice = firstPositiveBookPrice(book.bids);
  const sellPrice = firstPositiveBookPrice(book.asks);
  if (buyPrice === null || sellPrice === null) return null;
  // Crossed book is invalid — never invent or swap.
  if (buyPrice > sellPrice) return null;
  return { buyPrice, sellPrice };
}

function normalizeOkexHttpError(error: unknown): ProviderError {
  const msg = error instanceof Error ? error.message : String(error);
  if (/HTTP 403/.test(msg)) return new ProviderError(OKEX_IR_HTTP_403_MESSAGE);
  return error instanceof ProviderError ? error : new ProviderError(msg);
}

/**
 * Hostname-first fetch for OK-EX (SNI/Host as browser), then shared fetchJson (IP-resolved).
 * Does not spoof cookies, solve challenges, or route through unauthorized proxies.
 */
async function fetchOkexJsonOnce<T>(url: string, timeoutMs: number): Promise<T> {
  const headers = { ...OKEX_IR_HEADERS };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await outboundFetch(url, {
      cache: "no-store",
      headers,
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      const snippet = text.replace(/\s+/g, " ").slice(0, 120);
      if (response.status === 403) {
        console.info(
          "[okex-fetch]",
          JSON.stringify({
            status: 403,
            url,
            bodySnippet: snippet || null,
            note: "WAF/IP block — public books need no API key"
          })
        );
        throw new ProviderError(OKEX_IR_HTTP_403_MESSAGE);
      }
      throw new ProviderError(`HTTP ${response.status}${snippet ? ` — ${snippet}` : ""}`);
    }
    if (!text.trim()) throw new ProviderError("پاسخ خالی بود");
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ProviderError("پاسخ JSON معتبر نبود");
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError("زمان پاسخ‌دهی منبع تمام شد");
    }
    // Fall through to IP-resolved path used by other providers.
  } finally {
    clearTimeout(timer);
  }

  try {
    return await fetchJson<T>(url, timeoutMs, { headers });
  } catch (error) {
    throw normalizeOkexHttpError(error);
  }
}

async function fetchOkexJsonWithRetry<T>(url: string, timeoutMs: number, attempts = 2): Promise<T> {
  let lastError: ProviderError | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 300 * attempt));
    try {
      return await fetchOkexJsonOnce<T>(url, timeoutMs);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      lastError = error instanceof ProviderError ? error : new ProviderError(msg);
      // Honor rate limit — surface 429 to isolation runner backoff
      if (/HTTP 429/.test(msg)) throw lastError;
      // Retry 403/5xx once (WAF blips); final 403 still throws (allowlist, not bypass)
      if (!/HTTP 403|HTTP 5\d\d|زمان پاسخ/.test(msg) || attempt === attempts) {
        if (attempt === attempts) throw lastError;
      }
    }
  }
  throw lastError ?? new ProviderError("اتصال به اوکی اکسچنج برقرار نشد");
}

async function liveOkexIrFromOtcTickers(): Promise<DomesticQuote> {
  const id = "okex_ir";
  const name = "اوکی اکسچنج";
  const data = await fetchOkexJsonWithRetry<
    Array<{
      asset?: string;
      buyAmt?: string | number;
      sellAmt?: string | number;
      priceDollar?: string | number;
    }>
  >(OKEX_IR_TICKERS_URL, 8_000, 1);
  if (!Array.isArray(data)) {
    throw new ProviderError("فرمت تیکر OTC اوکی اکسچنج نامعتبر است");
  }
  const usdt = data.find((row) => (row.asset ?? "").toUpperCase() === "USDT");
  if (!usdt) throw new ProviderError("ردیف USDT در تیکر OTC اوکی اکسچنج پیدا نشد");

  const userBuy = toToman(usdt.buyAmt);
  const userSell = toToman(usdt.sellAmt);
  const last = toToman(usdt.priceDollar ?? usdt.buyAmt ?? usdt.sellAmt);

  // Reject zero / non-positive OTC levels
  const validUserBuy = userBuy !== null && userBuy > 0 ? userBuy : null;
  const validUserSell = userSell !== null && userSell > 0 ? userSell : null;
  const validLast = last !== null && last > 0 ? last : null;

  if (
    validUserBuy !== null &&
    validUserSell !== null &&
    validUserBuy !== validUserSell &&
    Math.abs(validUserBuy - validUserSell) / Math.max(validUserBuy, validUserSell) > 0.0001
  ) {
    // Distinct OTC sides: desk buyPrice = bid = user sell, sellPrice = ask = user buy
    const buyPrice = validUserSell;
    const sellPrice = validUserBuy;
    const bid = Math.min(buyPrice, sellPrice);
    const ask = Math.max(buyPrice, sellPrice);
    assertRealisticUsdtIrt(bid, ask, null);
    return buildQuote(id, name, bid, ask);
  }

  // Identical buyAmt/sellAmt (observed live) = reference-only — never duplicate into fake bid/ask.
  const ref = validLast ?? validUserBuy ?? validUserSell;
  if (ref === null) {
    throw new ProviderError("قیمت خرید/فروش USDT اوکی اکسچنج معتبر نیست");
  }
  assertRealisticUsdtIrt(null, null, ref);
  return buildQuote(id, name, null, null, {
    midPrice: ref,
    status: "degraded",
    errorMessage: "فقط قیمت مرجع OTC؛ دفتر سفارش اسپات در دسترس نبود"
  });
}

async function liveOkexIr(): Promise<DomesticQuote> {
  const id = "okex_ir";
  const name = "اوکی اکسچنج";
  let lastBookError: string | null = null;

  for (const url of OKEX_IR_BOOK_URLS) {
    try {
      const data = await fetchOkexJsonWithRetry<unknown>(url, 8_000, 2);
      const parsed = parseOkexIrSpotBook(data);
      if (!parsed) {
        lastBookError = "دفتر سفارش USDT-IRT خالی یا نامعتبر";
        continue;
      }
      assertRealisticUsdtIrt(parsed.buyPrice, parsed.sellPrice, null);
      // Successful recovery clears any previous HTTP 403 / stale error via fresh quote.
      return buildQuote(id, name, parsed.buyPrice, parsed.sellPrice);
    } catch (error) {
      lastBookError = error instanceof Error ? error.message : "خطای شبکه";
      // try next host
    }
  }

  // Spot book blocked/failed — try OTC tickers as reference-only or distinct OTC sides.
  try {
    return await liveOkexIrFromOtcTickers();
  } catch (error) {
    const otcMsg = error instanceof Error ? error.message : "OTC failed";
    const combined = lastBookError ?? otcMsg;
    if (/HTTP 403/.test(combined) || /HTTP 403/.test(otcMsg)) {
      throw new ProviderError(OKEX_IR_HTTP_403_MESSAGE);
    }
    throw new ProviderError(combined || "اوکی اکسچنج در دسترس نیست");
  }
}

const ARZINJA_API_HEADERS = {
  "user-agent": BROWSER_UA,
  accept: "application/json, text/plain;q=0.8, */*;q=0.5",
  "accept-language": "fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7",
  origin: "https://arzinja.ir",
  referer: "https://arzinja.ir/tether"
} as const;

export const ARZINJA_ORDERBOOK_URL =
  "https://api-v2.arzinja.ir/api/v1/trade/p2p/orderbook?pair=USDTIRT";
const ARZINJA_ALL_MARKET_URL =
  "https://api-v2.arzinja.ir/api/v1/market/all-market?page=1&base_asset=USDT&provider_type=p2p";

async function arzinjaHttpGetJson(url: string, timeoutMs: number): Promise<unknown> {
  const attempts = process.env.VERCEL ? 3 : 2;
  let lastError: ProviderError | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 250 * attempt));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await outboundFetch(url, {
        cache: "no-store",
        signal: controller.signal,
        headers: { ...ARZINJA_API_HEADERS }
      });
      const text = await response.text();
      console.info(
        "[arzinja-fetch]",
        JSON.stringify({
          status: response.status,
          finalUrl: response.url || url,
          contentType: response.headers.get("content-type"),
          responseLength: text.length,
          errorType: response.ok ? null : `HTTP ${response.status}`,
          attempt,
          vercel: Boolean(process.env.VERCEL),
          region: process.env.VERCEL_REGION ?? null
        })
      );
      if (!response.ok) {
        lastError = new ProviderError(`HTTP ${response.status}`);
        if (response.status === 403 || response.status === 429 || response.status >= 500) continue;
        throw lastError;
      }
      if (!text.trim()) {
        lastError = new ProviderError("پاسخ خالی بود");
        continue;
      }
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof ProviderError) lastError = error;
      else if (error instanceof Error && error.name === "AbortError") {
        lastError = new ProviderError("زمان پاسخ‌دهی منبع تمام شد");
      } else {
        lastError = new ProviderError(error instanceof Error ? error.message : "خطای شبکه");
      }
    } finally {
      clearTimeout(timer);
    }
  }

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

async function liveArzinja(): Promise<DomesticQuote> {
  const id = "arzinja";
  const name = "ارزینجا";
  const timeoutMs = process.env.VERCEL ? 10_000 : 12_000;

  let buyPrice: number | null = null;
  let sellPrice: number | null = null;
  let lastHint = "";

  try {
    const book = (await arzinjaHttpGetJson(ARZINJA_ORDERBOOK_URL, timeoutMs)) as {
      success?: boolean;
      result?: {
        symbol?: string;
        bids?: Array<[string | number, string | number] | (string | number)[]>;
        asks?: Array<[string | number, string | number] | (string | number)[]>;
      };
    };
    if (book.success !== false) {
      const symbol = (book.result?.symbol ?? "").toUpperCase().replace(/[_/-]/g, "");
      if (!symbol || symbol === "USDTIRT") {
        for (const row of book.result?.bids ?? []) {
          const p = toToman(Array.isArray(row) ? row[0] : null);
          if (p !== null && p > 0) {
            buyPrice = p;
            break;
          }
        }
        for (const row of book.result?.asks ?? []) {
          const p = toToman(Array.isArray(row) ? row[0] : null);
          if (p !== null && p > 0) {
            sellPrice = p;
            break;
          }
        }
      }
    }
    if (buyPrice === null || sellPrice === null) lastHint = "orderbook incomplete";
  } catch (error) {
    lastHint = error instanceof Error ? error.message : "orderbook failed";
  }

  if (buyPrice === null || sellPrice === null) {
    const markets = (await arzinjaHttpGetJson(ARZINJA_ALL_MARKET_URL, timeoutMs)) as {
      success?: boolean;
      result?: Array<
        Record<
          string,
          {
            pair?: string;
            baseAsset?: string;
            quoteAsset?: string;
            stats?: { bidPrice?: string | number; askPrice?: string | number };
          }
        >
      >;
    };
    if (markets.success !== false) {
      for (const row of markets.result ?? []) {
        const market =
          row.USDTIRT ??
          Object.values(row).find(
            (m) =>
              (m?.pair ?? "").toUpperCase().replace(/[_/-]/g, "") === "USDTIRT" ||
              ((m?.baseAsset ?? "").toUpperCase() === "USDT" && (m?.quoteAsset ?? "").toUpperCase() === "IRT")
          );
        if (!market) continue;
        buyPrice = toToman(market.stats?.bidPrice);
        sellPrice = toToman(market.stats?.askPrice);
        if (buyPrice !== null && sellPrice !== null) break;
      }
    }
    if (buyPrice === null || sellPrice === null) {
      throw new ProviderError(`قیمت زنده USDT/IRT ارزینجا در دسترس نیست (${lastHint || "no data"})`);
    }
  }

  if (buyPrice === null || sellPrice === null || buyPrice > sellPrice) {
    throw new ProviderError("قیمت خرید/فروش ارزینجا نامعتبر است");
  }
  assertRealisticUsdtIrt(buyPrice, sellPrice, null);
  return buildQuote(id, name, buyPrice, sellPrice);
}

/* -------------------------------------------------------------------------- */
/* Isolated provider registry                                                   */
/* -------------------------------------------------------------------------- */

const MIN_FETCH = 2.5 * 60_000;
const STALE_TTL = 10 * 60_000;
const RATE_BACKOFF = 5 * 60_000;
const OMP_MIN = 5 * 60_000;
const OMP_STALE = 30 * 60_000;
const OMP_BACKOFF = 10 * 60_000;

const providerDefs: IsolatedProviderDef[] = [
  {
    id: "nobitex",
    name: "نوبیتکس",
    endpoint: "https://apiv2.nobitex.ir/market/stats?srcCurrency=usdt&dstCurrency=rls",
    timeoutMs: 12_000,
    minFetchMs: MIN_FETCH,
    staleTtlMs: STALE_TTL,
    maxRetries: 1,
    rateLimitBackoffMs: RATE_BACKOFF,
    live: liveNobitex
  },
  {
    id: "wallex",
    name: "والکس",
    endpoint: "https://api.wallex.ir/v1/markets",
    timeoutMs: 9_000,
    minFetchMs: MIN_FETCH,
    staleTtlMs: STALE_TTL,
    maxRetries: 1,
    rateLimitBackoffMs: RATE_BACKOFF,
    live: liveWallex
  },
  {
    id: "bitpin",
    name: "بیت‌پین",
    endpoint: BITPIN_ORDERBOOK_URL,
    timeoutMs: 8_000,
    minFetchMs: MIN_FETCH,
    staleTtlMs: STALE_TTL,
    maxRetries: 1,
    rateLimitBackoffMs: RATE_BACKOFF,
    live: liveBitpin
  },
  {
    id: "tabdeal",
    name: "تبدیل",
    endpoint: "https://api1.tabdeal.org/r/api/v1/depth?symbol=USDTIRT&limit=1",
    timeoutMs: 9_000,
    minFetchMs: MIN_FETCH,
    staleTtlMs: STALE_TTL,
    maxRetries: 1,
    rateLimitBackoffMs: RATE_BACKOFF,
    live: liveTabdeal
  },
  {
    id: "ramzinex",
    name: "رمزینکس",
    endpoint: RAMZINEX_PAIR_URL,
    // Hard timeout must cover single-pair fetch (and rare list fallback). Was 9s on full ~0.5MB /pairs → frequent timeouts.
    timeoutMs: 16_000,
    minFetchMs: MIN_FETCH,
    staleTtlMs: STALE_TTL,
    maxRetries: 1,
    rateLimitBackoffMs: RATE_BACKOFF,
    live: liveRamzinex
  },
  {
    id: "abantether",
    name: "آبان‌تتر",
    endpoint: "https://api.abantether.com/api/v1/manager/otc/ticker",
    timeoutMs: 8_000,
    minFetchMs: MIN_FETCH,
    staleTtlMs: STALE_TTL,
    maxRetries: 1,
    rateLimitBackoffMs: RATE_BACKOFF,
    live: liveAbanTether
  },
  {
    id: "ompfinex",
    name: "OMPFinex",
    endpoint: `https://api.ompfinex.com/v1/market/${OMP_USDT_MARKET_ID}/depth`,
    timeoutMs: 12_000,
    minFetchMs: OMP_MIN,
    staleTtlMs: OMP_STALE,
    maxRetries: 0,
    rateLimitBackoffMs: OMP_BACKOFF,
    live: liveOmpFinex
  },
  {
    id: "exir",
    name: "اکسیر",
    endpoint: EXIR_ORDERBOOK_URL,
    timeoutMs: 8_000,
    minFetchMs: MIN_FETCH,
    staleTtlMs: STALE_TTL,
    maxRetries: 1,
    rateLimitBackoffMs: RATE_BACKOFF,
    live: liveExir
  },
  {
    id: "tetherland",
    name: "تترلند",
    endpoint: TETHERLAND_MARKET_PRICES_URL,
    timeoutMs: 9_000,
    minFetchMs: MIN_FETCH,
    staleTtlMs: STALE_TTL,
    maxRetries: 1,
    rateLimitBackoffMs: RATE_BACKOFF,
    live: liveTetherland
  },
  {
    id: "bit24",
    name: "بیت۲۴",
    endpoint: BIT24_ORDERBOOK_URL,
    timeoutMs: 8_000,
    minFetchMs: MIN_FETCH,
    staleTtlMs: STALE_TTL,
    maxRetries: 1,
    rateLimitBackoffMs: RATE_BACKOFF,
    live: liveBit24
  },
  {
    id: "okex_ir",
    name: "اوکی اکسچنج",
    endpoint: OKEX_IR_BOOK_URLS[0],
    timeoutMs: 8_000,
    minFetchMs: MIN_FETCH,
    staleTtlMs: STALE_TTL,
    maxRetries: 1,
    rateLimitBackoffMs: RATE_BACKOFF,
    live: liveOkexIr
  },
  {
    id: "arzinja",
    name: "ارزینجا",
    endpoint: ARZINJA_ORDERBOOK_URL,
    timeoutMs: process.env.VERCEL ? 10_000 : 12_000,
    minFetchMs: MIN_FETCH,
    staleTtlMs: STALE_TTL,
    maxRetries: 1,
    rateLimitBackoffMs: RATE_BACKOFF,
    live: liveArzinja
  }
];

function simpleMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Hard gate: if a source mid differs >10% from the median of other healthy sources,
 * mark it unavailable (do not rewrite price). Applies to every domestic source.
 */
function applyHardMedianGate(quotes: DomesticQuote[]): DomesticQuote[] {
  return quotes.map((q) => {
    if (q.sourceStatus === "unavailable" || q.midPrice === null || !Number.isFinite(q.midPrice)) {
      return q;
    }
    const others = quotes
      .filter(
        (o) =>
          o.exchangeId !== q.exchangeId &&
          o.sourceStatus !== "unavailable" &&
          o.midPrice !== null &&
          Number.isFinite(o.midPrice)
      )
      .map((o) => o.midPrice as number);
    if (others.length < 2) return q;
    const peerMedian = simpleMedian(others);
    if (peerMedian === null || peerMedian <= 0) return q;
    const deviation = Math.abs(q.midPrice - peerMedian) / peerMedian;
    if (deviation > 0.1) {
      return unavailable(
        q.exchangeId,
        q.exchangeName,
        "قیمت بیش از ۱۰٪ از میانه داخلی فاصله دارد (جعل/اصلاح نمی‌شود)"
      );
    }
    return q;
  });
}

const domesticCache = createProviderCache<DomesticQuote[]>();

function domesticCacheKey(settings: DeskSettings): string {
  return providerDefs.map((p) => `${p.id}:${settings.enabledSources[p.id] === false ? 0 : 1}`).join("|");
}

async function fetchDomesticQuotes(settings: DeskSettings): Promise<DomesticQuote[]> {
  const quotes = await runAllIsolatedProviders(providerDefs, settings.enabledSources);
  return applyHardMedianGate(quotes);
}

export async function getDomesticQuotes(settings: DeskSettings): Promise<DomesticQuote[]> {
  const key = domesticCacheKey(settings);
  const ttlMs = ttlFromMinutes(settings.priceRefreshMinutes);
  return domesticCache.get(key, ttlMs, () => fetchDomesticQuotes(settings));
}

/** Clear process-local list cache so the next getDomesticQuotes hits providers. */
export function clearDomesticQuotesCache(): void {
  domesticCache.clear();
}

/** Snapshot health for all domestic providers (memory slots only). */
export function getDomesticProviderHealth(): DomesticProviderHealth[] {
  return snapshotProviderHealth(providerDefs);
}

/**
 * Force-refresh all providers (bypasses short list cache) and return health + quotes.
 * Used by unauthenticated diagnostic probe.
 */
export async function probeDomesticHealth(settings?: DeskSettings): Promise<{
  region: string | null;
  vercel: boolean;
  commit: string | null;
  providers: DomesticProviderHealth[];
  quotes: DomesticQuote[];
}> {
  // Clear list-level cache so this is a real multi-provider refresh
  domesticCache.clear();
  const enabled = settings?.enabledSources ?? Object.fromEntries(providerDefs.map((p) => [p.id, true]));
  const quotes = await runAllIsolatedProviders(providerDefs, enabled);
  const gated = applyHardMedianGate(quotes);
  return {
    region: process.env.VERCEL_REGION ?? null,
    vercel: Boolean(process.env.VERCEL),
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    providers: snapshotProviderHealth(providerDefs).map((h) => {
      const q = gated.find((g) => g.exchangeId === h.id);
      if (!q) return h;
      return {
        ...h,
        status: q.sourceStatus,
        buyPrice: q.buyPrice,
        sellPrice: q.sellPrice,
        midPrice: q.midPrice,
        error: q.errorMessage ?? h.error
      };
    }),
    quotes: gated
  };
}

/** Public diagnostic for Vercel: Arzinja only. */
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
  clearProviderSlot("arzinja");
  const def = providerDefs.find((p) => p.id === "arzinja")!;
  const quote = await runIsolatedProvider(def);
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

/** Public diagnostic: OK-EX only (clears slot then live-fetches). */
export async function probeOkexIrQuote(): Promise<{
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
  clearProviderSlot("okex_ir");
  const def = providerDefs.find((p) => p.id === "okex_ir")!;
  const quote = await runIsolatedProvider(def);
  return {
    exchangeId: quote.exchangeId,
    buyPrice: quote.buyPrice,
    sellPrice: quote.sellPrice,
    midPrice: quote.midPrice,
    sourceStatus: quote.sourceStatus,
    errorMessage: quote.errorMessage,
    region: process.env.VERCEL_REGION ?? null,
    vercel: Boolean(process.env.VERCEL),
    endpoint: OKEX_IR_BOOK_URLS[0]
  };
}

export type { DomesticProviderHealth };
