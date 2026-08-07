/**
 * Exir public market API helpers (main Monitoring module).
 *
 * Official public surface (Hollaex / Exir):
 *   GET https://api.exir.io/v2/orderbook?symbol=<pair>
 *   GET https://api.exir.io/v2/orderbooks
 *   GET https://api.exir.io/v2/tickers
 *   GET https://api.exir.io/v2/constants
 *
 * v1 `/v1/orderbook` is obsolete and returns HTTP 403 (nginx/CloudFront HTML)
 * for all User-Agents — not a symbol/header bug.
 */
import { shouldUseOutboundProxy } from "@/lib/http";

/** Known official pair code for USDT quoted in IRT (Toman prices). */
export const EXIR_USDT_IRT_SYMBOL = "usdt-irt";

/** Obsolete path still referenced by older adapters — always 403 in the field. */
export const EXIR_V1_ORDERBOOK_PATH = "/v1/orderbook";

/** Current public orderbook base (v2). */
export const EXIR_V2_ORDERBOOK_URL = "https://api.exir.io/v2/orderbook";
export const EXIR_V2_ORDERBOOKS_URL = "https://api.exir.io/v2/orderbooks";
export const EXIR_V2_TICKERS_URL = "https://api.exir.io/v2/tickers";
export const EXIR_V2_CONSTANTS_URL = "https://api.exir.io/v2/constants";

export function exirOrderbookUrl(symbol: string = EXIR_USDT_IRT_SYMBOL): string {
  const sym = symbol.trim().toLowerCase() || EXIR_USDT_IRT_SYMBOL;
  return `${EXIR_V2_ORDERBOOK_URL}?symbol=${encodeURIComponent(sym)}`;
}

export type ExirBookLevels = {
  bids?: Array<[number | string, number | string] | number[] | string[]>;
  asks?: Array<[number | string, number | string] | number[] | string[]>;
};

export type ExirOrderbookPayload = Record<string, ExirBookLevels | unknown> & ExirBookLevels;

export type ExirBestBidAsk = {
  symbol: string;
  bestBid: number;
  bestAsk: number;
  bidSize: number | null;
  askSize: number | null;
  bidLevels: number;
  askLevels: number;
};

function asLevelPrice(row: unknown): number | null {
  if (row == null) return null;
  if (Array.isArray(row)) {
    const p = Number(row[0]);
    return Number.isFinite(p) && p > 0 ? p : null;
  }
  if (typeof row === "object") {
    const o = row as Record<string, unknown>;
    const p = Number(o.price ?? o[0]);
    return Number.isFinite(p) && p > 0 ? p : null;
  }
  const p = Number(row);
  return Number.isFinite(p) && p > 0 ? p : null;
}

function asLevelSize(row: unknown): number | null {
  if (!Array.isArray(row) || row.length < 2) return null;
  const s = Number(row[1]);
  return Number.isFinite(s) && s >= 0 ? s : null;
}

/** Extract the book object for a symbol from a v2 payload (nested or flat). */
export function extractExirBook(
  data: ExirOrderbookPayload | null | undefined,
  symbol: string = EXIR_USDT_IRT_SYMBOL
): ExirBookLevels | null {
  if (!data || typeof data !== "object") return null;
  const key = symbol.toLowerCase();
  const nested = data[key];
  if (nested && typeof nested === "object") {
    const book = nested as ExirBookLevels;
    if (Array.isArray(book.bids) || Array.isArray(book.asks)) return book;
  }
  // Flat single-book response
  if (Array.isArray(data.bids) || Array.isArray(data.asks)) {
    return { bids: data.bids, asks: data.asks };
  }
  return null;
}

/**
 * Best bid = max bid price, best ask = min ask price (do not assume sort).
 * Prices are Toman for usdt-irt on Exir public books.
 */
export function parseExirBestBidAsk(
  data: ExirOrderbookPayload | null | undefined,
  symbol: string = EXIR_USDT_IRT_SYMBOL
): ExirBestBidAsk {
  const book = extractExirBook(data, symbol);
  if (!book) {
    throw new Error("EXIR_BOOK_MISSING");
  }
  const bids = book.bids ?? [];
  const asks = book.asks ?? [];
  if (!bids.length || !asks.length) {
    throw new Error("EXIR_BOOK_EMPTY");
  }

  let bestBid: number | null = null;
  let bestBidSize: number | null = null;
  let bestAsk: number | null = null;
  let bestAskSize: number | null = null;

  for (const row of bids) {
    const p = asLevelPrice(row);
    if (p === null) continue;
    if (bestBid === null || p > bestBid) {
      bestBid = p;
      bestBidSize = asLevelSize(row);
    }
  }
  for (const row of asks) {
    const p = asLevelPrice(row);
    if (p === null) continue;
    if (bestAsk === null || p < bestAsk) {
      bestAsk = p;
      bestAskSize = asLevelSize(row);
    }
  }

  if (bestBid === null || bestAsk === null) {
    throw new Error("EXIR_BOOK_INVALID_LEVELS");
  }
  if (!(bestBid > 0) || !(bestAsk > 0)) {
    throw new Error("EXIR_BOOK_ZERO");
  }
  // Fail-closed on crossed / inverted book (allow tiny float noise only via caller).
  if (bestBid > bestAsk) {
    throw new Error("EXIR_BOOK_CROSSED");
  }

  return {
    symbol: symbol.toLowerCase(),
    bestBid,
    bestAsk,
    bidSize: bestBidSize,
    askSize: bestAskSize,
    bidLevels: bids.length,
    askLevels: asks.length
  };
}

/**
 * Discover USDT/IRT pair code from official constants/tickers payloads.
 * Prefer active `usdt-irt`; never invent synthetic prices.
 */
export function discoverExirUsdtIrtSymbol(input: {
  constants?: { pairs?: Record<string, { pair_base?: string; pair_2?: string; code?: string; active?: boolean }> };
  tickers?: Record<string, { symbol?: string; last?: number | string }>;
  orderbooks?: Record<string, ExirBookLevels>;
}): string {
  const fromConstants = input.constants?.pairs;
  if (fromConstants && typeof fromConstants === "object") {
    const exact = fromConstants["usdt-irt"];
    if (exact && exact.active !== false) return "usdt-irt";
    for (const [code, meta] of Object.entries(fromConstants)) {
      const base = (meta.pair_base ?? "").toLowerCase();
      const quote = (meta.pair_2 ?? "").toLowerCase();
      if (base === "usdt" && quote === "irt" && meta.active !== false) {
        return (meta.code ?? code).toLowerCase();
      }
    }
  }

  const tickers = input.tickers;
  if (tickers && typeof tickers === "object") {
    if (tickers["usdt-irt"]) return "usdt-irt";
    for (const [code, t] of Object.entries(tickers)) {
      if (code.toLowerCase() === "usdt-irt") return "usdt-irt";
      const sym = (t.symbol ?? code).toLowerCase();
      if (sym === "usdt-irt" || (sym.includes("usdt") && sym.includes("irt"))) {
        const last = Number(t.last);
        if (Number.isFinite(last) && last > 0) return sym;
      }
    }
  }

  const books = input.orderbooks;
  if (books && typeof books === "object") {
    if (books["usdt-irt"] && ((books["usdt-irt"].bids?.length ?? 0) > 0)) return "usdt-irt";
    for (const [code, book] of Object.entries(books)) {
      if (code.toLowerCase().includes("usdt") && code.toLowerCase().includes("irt")) {
        if ((book?.bids?.length ?? 0) > 0 && (book?.asks?.length ?? 0) > 0) return code.toLowerCase();
      }
    }
  }

  return EXIR_USDT_IRT_SYMBOL;
}

export type ExirHttpClass =
  | "ok"
  | "forbidden_obsolete_or_waf"
  | "not_found"
  | "rate_limited"
  | "client_error"
  | "server_error"
  | "network"
  | "unknown";

/** Classify transport outcome for ops messaging (no secrets). */
export function classifyExirHttp(status: number | null, bodySnippet?: string): ExirHttpClass {
  if (status === 200) return "ok";
  if (status === 403) return "forbidden_obsolete_or_waf";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status !== null && status >= 400 && status < 500) return "client_error";
  if (status !== null && status >= 500) return "server_error";
  if (status === null) return "network";
  if (bodySnippet && /403 Forbidden|cloudfront|nginx/i.test(bodySnippet)) {
    return "forbidden_obsolete_or_waf";
  }
  return "unknown";
}

export function exirPersianError(kind: ExirHttpClass, detail?: string): string {
  switch (kind) {
    case "forbidden_obsolete_or_waf":
      return "اکسیر: دسترسی رد شد (endpoint قدیمی v1 یا مسدودسازی WAF) — از API عمومی v2 استفاده کنید";
    case "rate_limited":
      return "اکسیر: محدودیت نرخ درخواست (۴۲۹) — بعداً تلاش شود";
    case "not_found":
      return "اکسیر: مسیر یا نماد پیدا نشد";
    case "server_error":
      return "اکسیر: خطای سرور بالادست";
    case "network":
      return "اکسیر: خطای شبکه یا قطع اتصال";
    default:
      return detail ? `اکسیر: ${detail}` : "اکسیر: خطای نامشخص";
  }
}

/**
 * Whether Monitoring should force the configured outbound proxy for api.exir.io.
 * Only when hostname is on PROXY_HOSTS (or *) and a proxy URL exists — never invent one.
 */
export function exirShouldUseConfiguredProxy(hostname = "api.exir.io"): boolean {
  return shouldUseOutboundProxy(hostname);
}

/** Reject stale provider snapshots for health (fail-closed). */
export function isExirQuoteFresh(
  lastUpdatedIso: string | null | undefined,
  nowMs: number,
  maxAgeMs: number
): boolean {
  if (!lastUpdatedIso) return false;
  const t = Date.parse(lastUpdatedIso);
  if (!Number.isFinite(t)) return false;
  return nowMs - t <= maxAgeMs;
}
